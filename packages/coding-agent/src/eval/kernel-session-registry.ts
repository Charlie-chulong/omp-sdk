import * as path from "node:path";

import { logger } from "@oh-my-pi/pi-utils";
import {
	attachSessionOwner,
	type CancelledErrorClass,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	type SessionOwners,
	waitForPromiseWithCancellation,
} from "./executor-base";

interface KernelSessionRegistryOptions {
	sessionId?: string;
	kernelOwnerId?: string;
	interpreter?: string;
	reset?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
	bridge?: unknown;
	bridgeSessionId?: string;
}

interface RegistryKernelShutdownResult {
	confirmed?: boolean;
}

interface RegistryKernel {
	isAlive(): boolean;
	readonly liveHandleCount?: number;
	shutdown(options?: { timeoutMs: number }): Promise<RegistryKernelShutdownResult>;
}

export interface KernelSession<TKernel extends RegistryKernel> extends SessionOwners {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: TKernel;
	activeExecutions: number;
}

interface StartingKernelSession<TSession> extends SessionOwners {
	promise: Promise<TSession>;
}

export interface KernelSessionRegistryContext<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	TSession extends KernelSession<TKernel>,
> {
	sessions: Map<string, TSession>;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	replaceSessionKernel: (session: TSession, cwd: string, options: TOptions) => Promise<TKernel>;
	retainDetachedSession: (session: TSession) => () => void;
}

interface KernelSessionRegistryDescriptor<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	R,
	TSession extends KernelSession<TKernel>,
> {
	languageLabel: string;
	cancelledErrorClass: CancelledErrorClass;
	buildSessionKey: (sessionId: string, cwd: string, interpreter: string | undefined) => string;
	createSession: (session: KernelSession<TKernel>) => TSession;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	executeWithKernel: (kernel: TKernel, code: string, options: TOptions) => Promise<R>;
	waitForStartup?: (promise: Promise<TSession>, options: TOptions) => Promise<TSession>;
	replaceSessionKernel?: (
		session: TSession,
		cwd: string,
		options: TOptions,
		context: KernelSessionRegistryContext<TKernel, TOptions, TSession>,
	) => Promise<TKernel>;
	acquireLiveSessionKernel?: (
		session: TSession,
		cwd: string,
		options: TOptions,
		context: KernelSessionRegistryContext<TKernel, TOptions, TSession>,
	) => Promise<TKernel>;
	invalidateSession?: (session: TSession) => void;
	shutdownSession?: (session: TSession, resetting: boolean) => Promise<RegistryKernelShutdownResult>;
	clearResetsOnDisposeAll?: boolean;
	logBeforeReplacement?: boolean;
	isCancellation?: (error: unknown) => boolean;
	isTimedOutCancellation?: (error: unknown, signal?: AbortSignal) => boolean;
	validateKernel?: (session: TSession, kernel: TKernel) => boolean;
}

interface KernelSessionRegistry<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	R,
	TSession extends KernelSession<TKernel>,
> {
	disposeAll(): Promise<void>;
	disposeByOwner(ownerId: string, options?: { requireStopped?: boolean }): Promise<void>;
	getOwnedSessions(ownerId: string): TSession[];
	getStartingOwnerCount(ownerId: string): number;
	reapOrphans(): Promise<void>;
	releaseOwnedKernel(ownerId: string, predicate: (session: TSession) => boolean): Promise<void>;
	retainDetachedSession(session: TSession): () => void;
	executeOnSession(code: string, cwd: string, options: TOptions): Promise<R>;
	peekLiveKernel(cwd: string, options: TOptions): TKernel | undefined;
	getPresentSession(cwd: string, options: TOptions): TSession | undefined;
}

export function normalizeKernelSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

export function requireRemainingKernelTimeoutMs(
	deadlineMs: number | undefined,
	cancelledErrorClass: CancelledErrorClass,
): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new cancelledErrorClass(true);
	}
	return remainingMs;
}

export function formatSessionTimeoutAnnotation(timeoutMs?: number): string {
	if (timeoutMs === undefined) return "Command timed out";
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds`;
}

export function formatSessionKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const secs = timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000));
	if (kernelKilled) {
		return "eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.";
	}
	const duration = secs === undefined ? "the configured timeout" : `${secs}s`;
	return `eval cell timed out after ${duration}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

export function createKernelSessionRegistry<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	R extends { cancelled: boolean },
	TSession extends KernelSession<TKernel>,
>(
	descriptor: KernelSessionRegistryDescriptor<TKernel, TOptions, R, TSession>,
): KernelSessionRegistry<TKernel, TOptions, R, TSession> {
	const sessions = new Map<string, TSession>();
	const orphanedSessions = new Set<TSession>();
	const startingSessions = new Map<string, StartingKernelSession<TSession>>();
	const resettingSessions = new Map<string, Promise<void>>();
	const replacingSessionKernels = new Map<TSession, { kernel: TKernel; promise: Promise<TKernel> }>();

	const context: KernelSessionRegistryContext<TKernel, TOptions, TSession> = {
		sessions,
		startKernel: descriptor.startKernel,
		replaceSessionKernel,
		retainDetachedSession: session => {
			orphanedSessions.add(session);
			return () => {
				orphanedSessions.delete(session);
			};
		},
	};

	function waitForStartup(promise: Promise<TSession>, options: TOptions): Promise<TSession> {
		return descriptor.waitForStartup?.(promise, options) ?? promise;
	}

	function throwIfCallerCancelled(options: TOptions): void {
		if (!options.signal?.aborted) return;
		const timedOut =
			descriptor.isTimedOutCancellation?.(options.signal.reason, options.signal) ??
			isTimedOutCancellation(options.signal.reason, descriptor.cancelledErrorClass, options.signal);
		throw new descriptor.cancelledErrorClass(timedOut);
	}

	function isCurrent(session: TSession, kernel?: TKernel): boolean {
		return (
			sessions.get(session.sessionKey) === session &&
			(kernel === undefined || descriptor.validateKernel?.(session, kernel) !== false)
		);
	}

	async function acquireSession(
		sessionKey: string,
		sessionId: string,
		cwd: string,
		options: TOptions,
	): Promise<TSession> {
		const existing = sessions.get(sessionKey);
		if (existing) {
			attachSessionOwner(existing, sessionId, options.kernelOwnerId);
			return existing;
		}
		const starting = startingSessions.get(sessionKey);
		if (starting) {
			attachSessionOwner(starting, sessionId, options.kernelOwnerId);
			return await waitForStartup(starting.promise, options);
		}
		// oxlint-disable-next-line prefer-const -- captured by the startup closure before assignment
		let startingSession!: StartingKernelSession<TSession>;
		// Kernels are shared by every owner of the key, so the readers and timers a
		// kernel starts carry no caller's log context.
		const startup = logger.withoutContext(async () => {
			const kernel = await descriptor.startKernel(cwd, options);
			const session = descriptor.createSession({
				sessionKey,
				sessionId,
				cwd,
				kernel,
				activeExecutions: 0,
				ownerIds: new Set(startingSession.ownerIds),
				hasFallbackOwner: startingSession.hasFallbackOwner,
			});
			if (startingSessions.get(sessionKey) === startingSession) {
				sessions.set(sessionKey, session);
			}
			return session;
		});
		startingSession = {
			ownerIds: new Set(),
			hasFallbackOwner: false,
			promise: startup,
		};
		attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
		startingSessions.set(sessionKey, startingSession);
		try {
			return await waitForStartup(startup, options);
		} finally {
			if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
		}
	}

	async function replaceSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		const replace = descriptor.replaceSessionKernel;
		if (replace) {
			return await logger.withoutContext(() => replace(session, cwd, options, context));
		}
		if (descriptor.logBeforeReplacement) {
			logger.warn(`${descriptor.languageLabel} subprocess died or is unresponsive; spawning fresh process`, {
				sessionKey: session.sessionKey,
			});
		}
		const old = session.kernel;
		const remaining = getRemainingTimeoutMs(options.deadlineMs);
		const stopped = await old.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined);
		if (stopped.confirmed === false)
			throw new Error(`${descriptor.languageLabel} kernel replacement shutdown not confirmed`);
		if (sessions.get(session.sessionKey) !== session) {
			throw new descriptor.cancelledErrorClass(false);
		}
		requireRemainingKernelTimeoutMs(options.deadlineMs, descriptor.cancelledErrorClass);
		const next = await logger.withoutContext(() => descriptor.startKernel(cwd, options));
		if (sessions.get(session.sessionKey) !== session) {
			const detached = { ...session, kernel: next, ownerIds: new Set(session.ownerIds), activeExecutions: 0 };
			const forget = context.retainDetachedSession(detached);
			const stopped = await next.shutdown();
			if (stopped.confirmed === false)
				throw new Error(`${descriptor.languageLabel} cancelled replacement shutdown not confirmed`);
			forget();
			throw new descriptor.cancelledErrorClass(false);
		}
		session.kernel = next;
		return next;
	}

	async function acquireDefaultReplacementKernel(
		session: TSession,
		kernel: TKernel,
		cwd: string,
		options: TOptions,
	): Promise<TKernel> {
		const existing = replacingSessionKernels.get(session);
		if (existing?.kernel === kernel) {
			return await waitForPromiseWithCancellation(existing.promise, options, descriptor.cancelledErrorClass);
		}
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		if (session.kernel !== kernel) {
			const currentKernel = session.kernel;
			if (currentKernel.isAlive()) return currentKernel;
			return await acquireDefaultReplacementKernel(session, currentKernel, cwd, options);
		}
		const replacement = {
			kernel,
			promise: replaceSessionKernel(session, cwd, {
				...options,
				signal: undefined,
				deadlineMs: undefined,
			}),
		};
		replacingSessionKernels.set(session, replacement);
		const release = (): void => {
			if (replacingSessionKernels.get(session) === replacement) {
				replacingSessionKernels.delete(session);
			}
		};
		void replacement.promise.then(release, release);
		return await waitForPromiseWithCancellation(replacement.promise, options, descriptor.cancelledErrorClass);
	}

	async function acquireLiveSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		if (descriptor.acquireLiveSessionKernel) {
			return await descriptor.acquireLiveSessionKernel(session, cwd, options, context);
		}
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		const kernel = session.kernel;
		if (!kernel.isAlive()) await acquireDefaultReplacementKernel(session, kernel, cwd, options);
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		return session.kernel;
	}

	async function shutdownSession(session: TSession, resetting: boolean): Promise<RegistryKernelShutdownResult> {
		const replacement = replacingSessionKernels.get(session)?.promise;
		if (replacement)
			await replacement.catch(error => {
				if (!(error instanceof descriptor.cancelledErrorClass)) throw error;
			});
		return await (descriptor.shutdownSession?.(session, resetting) ?? session.kernel.shutdown());
	}
	async function settleShutdown(
		session: TSession,
		resetting: boolean,
	): Promise<PromiseSettledResult<RegistryKernelShutdownResult>> {
		return await shutdownSession(session, resetting).then(
			value => ({ status: "fulfilled", value }),
			reason => ({ status: "rejected", reason }),
		);
	}

	async function resetSession(sessionKey: string): Promise<void> {
		const existing =
			sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
		if (!existing) return;
		descriptor.invalidateSession?.(existing);
		const result = await shutdownSession(existing, true);
		if (result.confirmed === false)
			throw new Error(`${descriptor.languageLabel} kernel reset shutdown not confirmed`);
		if (sessions.get(sessionKey) === existing) sessions.delete(sessionKey);
	}

	async function disposeAll(): Promise<void> {
		const pending = [...startingSessions.values()].map(starting => starting.promise);
		startingSessions.clear();
		if (descriptor.clearResetsOnDisposeAll) resettingSessions.clear();
		const all = [...new Set([...sessions.values(), ...orphanedSessions])].map(
			session => [session.sessionKey, session] as const,
		);
		orphanedSessions.clear();
		for (const [id, session] of all) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(id) === session) sessions.delete(id);
		}
		const shutdowns = all.map(([, session]) => settleShutdown(session, false));
		const started = await Promise.allSettled(pending);
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			if (all.some(([, session]) => session === result.value)) continue;
			const session = result.value;
			all.push([session.sessionKey, session]);
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			shutdowns.push(settleShutdown(session, false));
		}
		const results = await Promise.all(shutdowns);
		for (let i = 0; i < all.length; i += 1) {
			const [id, session] = all[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
				kernelSessionId: session.sessionId,
				sessionKey: id,
				cwd: session.cwd,
				reason,
			});
			if (!sessions.has(id)) sessions.set(id, session);
			else if (sessions.get(id) !== session) orphanedSessions.add(session);
		}
	}

	async function disposeByOwner(ownerId: string, options?: { requireStopped?: boolean }): Promise<void> {
		const toShutdown: TSession[] = [];
		const startingToShutdown: StartingKernelSession<TSession>[] = [];
		const failures: unknown[] = [];
		for (const session of getOwnedSessions(ownerId)) {
			if (session.ownerIds.size === 1) {
				toShutdown.push(session);
				continue;
			}
			if (options?.requireStopped)
				failures.push(
					new Error(`${descriptor.languageLabel} kernel is shared with another owner; cannot stop it safely`),
				);
			else session.ownerIds.delete(ownerId);
		}
		for (const [sessionKey, starting] of Array.from(startingSessions.entries())) {
			if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
			if (starting.ownerIds.size === 1) {
				startingSessions.delete(sessionKey);
				startingToShutdown.push(starting);
				continue;
			}
			if (options?.requireStopped)
				failures.push(
					new Error(
						`${descriptor.languageLabel} kernel startup is shared with another owner; cannot stop it safely`,
					),
				);
			else starting.ownerIds.delete(ownerId);
		}
		for (const session of toShutdown) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		}
		const shutdowns = toShutdown.map(session => settleShutdown(session, false));
		const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			const session = result.value;
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			toShutdown.push(session);
			shutdowns.push(settleShutdown(session, false));
		}
		const results = await Promise.all(shutdowns);
		for (let i = 0; i < toShutdown.length; i += 1) {
			const session = toShutdown[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) {
				session.ownerIds.delete(ownerId);
				orphanedSessions.delete(session);
				continue;
			}
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
				kernelSessionId: session.sessionId,
				sessionKey: session.sessionKey,
				cwd: session.cwd,
				reason,
			});
			if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
			else if (sessions.get(session.sessionKey) !== session) orphanedSessions.add(session);
			failures.push(
				result.status === "rejected"
					? result.reason
					: new Error(`${descriptor.languageLabel} kernel shutdown not confirmed`),
			);
		}
		if (failures.length > 0) throw new AggregateError(failures, `${descriptor.languageLabel} owner shutdown failed`);
	}

	function getOwnedSessions(ownerId: string): TSession[] {
		return [...new Set([...sessions.values(), ...orphanedSessions])].filter(session => session.ownerIds.has(ownerId));
	}

	function getStartingOwnerCount(ownerId: string): number {
		let count = 0;
		for (const starting of startingSessions.values()) if (starting.ownerIds.has(ownerId)) count++;
		return count;
	}

	async function reapOrphans(): Promise<void> {
		const orphans = [...new Set([...sessions.values(), ...orphanedSessions])].filter(
			session =>
				session.ownerIds.size === 0 &&
				!session.hasFallbackOwner &&
				session.activeExecutions === 0 &&
				(session.kernel.liveHandleCount ?? 0) === 0,
		);
		for (const session of orphans) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			orphanedSessions.add(session);
			const result = await shutdownSession(session, false);
			if (result.confirmed === false) throw new Error(`${descriptor.languageLabel} orphan shutdown not confirmed`);
			orphanedSessions.delete(session);
		}
	}

	async function releaseOwnedKernel(ownerId: string, predicate: (session: TSession) => boolean): Promise<void> {
		const session = getOwnedSessions(ownerId).find(predicate);
		if (!session) throw new Error(`${descriptor.languageLabel} kernel not found for this owner`);
		if (session.activeExecutions > 0 || (session.kernel.liveHandleCount ?? 0) > 0)
			throw new Error("Kernel has live execution; stop it before releasing variables");
		if (session.ownerIds.size !== 1) throw new Error("Kernel is shared with another owner; cannot release it safely");
		descriptor.invalidateSession?.(session);
		// Hold the key until exit is confirmed so a concurrent cell cannot start an untracked replacement.
		const shutdown = shutdownSession(session, false).then(result => {
			if (result.confirmed === false) throw new Error("Kernel shutdown not confirmed");
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			session.ownerIds.delete(ownerId);
			orphanedSessions.delete(session);
		});
		resettingSessions.set(session.sessionKey, shutdown);
		try {
			await shutdown;
		} finally {
			if (resettingSessions.get(session.sessionKey) === shutdown) resettingSessions.delete(session.sessionKey);
		}
	}

	function peekLiveKernel(cwd: string, options: TOptions): TKernel | undefined {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		const sessionKey = descriptor.buildSessionKey(sessionId, cwd, options.interpreter);
		const kernel = sessions.get(sessionKey)?.kernel;
		return kernel?.isAlive() ? kernel : undefined;
	}

	function getPresentSession(cwd: string, options: TOptions): TSession | undefined {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		return sessions.get(descriptor.buildSessionKey(sessionId, cwd, options.interpreter));
	}

	async function executeOnSession(code: string, cwd: string, options: TOptions): Promise<R> {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		const sessionKey = descriptor.buildSessionKey(sessionId, cwd, options.interpreter);
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = sessionId;
		}
		if (options.reset) {
			const inFlight = resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
			else {
				const resetPromise = resetSession(sessionKey);
				resettingSessions.set(
					sessionKey,
					resetPromise.then(() => undefined),
				);
				try {
					await resetPromise;
				} finally {
					resettingSessions.delete(sessionKey);
				}
			}
		} else {
			const inFlight = resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
		}
		const session = await acquireSession(sessionKey, sessionId, cwd, options);
		throwIfCallerCancelled(options);
		const kernel = await acquireLiveSessionKernel(session, cwd, options);
		if (!isCurrent(session, kernel)) throw new descriptor.cancelledErrorClass(false);
		throwIfCallerCancelled(options);
		const runOptions = { ...options, cwd };
		let result: R;
		try {
			session.activeExecutions++;
			result = await descriptor.executeWithKernel(kernel, code, runOptions);
		} catch (err) {
			if (
				descriptor.isCancellation?.(err) ||
				isCancellationError(err, descriptor.cancelledErrorClass) ||
				options.signal?.aborted
			)
				throw err;
			if (kernel.isAlive()) throw err;
			throw new Error(
				`${descriptor.languageLabel} kernel died during execution; completion is uncertain and the cell was not replayed. The next call will start a fresh kernel.`,
				{ cause: err },
			);
		} finally {
			session.activeExecutions--;
		}
		return result;
	}

	return {
		disposeAll,
		disposeByOwner,
		getOwnedSessions,
		getStartingOwnerCount,
		reapOrphans,
		releaseOwnedKernel,
		retainDetachedSession: context.retainDetachedSession,
		executeOnSession,
		peekLiveKernel,
		getPresentSession,
	};
}
