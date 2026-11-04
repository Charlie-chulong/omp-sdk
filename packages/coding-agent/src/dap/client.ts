import * as fs from "node:fs/promises";
import { createConnection, createServer, type NetConnectOpts, type Server, type Socket } from "node:net";
import { isEnoent, logger, ptree, runtime } from "@oh-my-pi/pi-utils";
import { toWebByteStream } from "@oh-my-pi/pi-utils/runtime-readable";
import { NON_INTERACTIVE_ENV } from "../exec/non-interactive-env";
import { encodeMessageFrame, MessageFramer } from "../jsonrpc/message-framing";
import { ToolAbortError } from "../tools/tool-errors";
import type {
	DapCapabilities,
	DapClientState,
	DapEventMessage,
	DapInitializeArguments,
	DapPendingRequest,
	DapRequestMessage,
	DapResolvedAdapter,
	DapResponseMessage,
} from "./types";

interface DapSpawnOptions {
	adapter: DapResolvedAdapter;
	cwd: string;
	/**
	 * Cap on how long the socket-mode helpers wait for the adapter to open its
	 * socket (unix) or dial back into our listener (TCP). Exposed for tests;
	 * production callers rely on the default.
	 *
	 * @internal
	 */
	socketReadyTimeoutMs?: number;
}

/** Byte-counting write interface shared by process pipes and network sockets. */
interface DapWriteSink {
	write(data: string | Uint8Array): number | Promise<number>;
	flush(): number | Promise<number> | undefined;
}

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type DapReverseRequestHandler = (args: unknown) => unknown | Promise<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Hard cap on a single message write. A wedged adapter stdin used to hang the
 * whole client forever; on hitting this cap the client disposes itself so the
 * next request fails fast instead of piling more work onto a broken adapter.
 */
const WRITE_MESSAGE_TIMEOUT_MS = 30_000;
/** Default wait for socket-mode adapters to become reachable. */
const SOCKET_READY_TIMEOUT_MS = 10_000;

function toErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value);
}

export class DapClient {
	readonly adapter: DapResolvedAdapter;
	readonly cwd: string;
	readonly proc: DapClientState["proc"];
	/** TCP server port reused by child DAP sessions. */
	readonly port?: number;
	/** ReadableStream of DAP bytes — from proc.stdout (stdio) or a socket (socket mode). */
	readonly #readable: ReadableStream<Uint8Array>;
	/** Write sink — proc.stdin (stdio) or a socket (socket mode). */
	readonly #writeSink: DapWriteSink;
	/** Optional socket to close on dispose (socket mode only). */
	readonly #socket?: { end(): void };
	#requestSeq = 0;
	#pendingRequests = new Map<number, DapPendingRequest>();
	#isReading = false;
	#disposed = false;
	#lastActivity = Date.now();
	#capabilities?: DapCapabilities;
	#eventHandlers = new Map<string, Set<DapEventHandler>>();
	#anyEventHandlers = new Set<DapEventHandler>();
	#reverseRequestHandlers = new Map<string, DapReverseRequestHandler>();
	#adapterExited = false;
	#pendingWriteExitRejectors = new Set<() => void>();
	#writeQueue: Promise<void> = Promise.resolve();
	/** Rejectors for in-flight {@link waitForEvent} calls, woken when the
	 *  transport closes so an event that can never arrive fails fast instead of
	 *  waiting out its own timeout. */
	#eventWaiterRejectors = new Set<(error: Error) => void>();

	constructor(
		adapter: DapResolvedAdapter,
		cwd: string,
		proc: DapClientState["proc"],
		options?: {
			readable?: ReadableStream<Uint8Array>;
			writeSink?: DapWriteSink;
			socket?: { end(): void };
			port?: number;
		},
	) {
		this.adapter = adapter;
		this.cwd = cwd;
		this.proc = proc;
		this.#readable = options?.readable ?? (proc.stdout as ReadableStream<Uint8Array>);
		this.#writeSink = options?.writeSink ?? proc.stdin;
		this.#socket = options?.socket;
		this.port = options?.port;
		this.proc.exited.then(
			() => this.#rejectPendingWritesForExit(),
			() => this.#rejectPendingWritesForExit(),
		);
	}

	static async spawn({ adapter, cwd, socketReadyTimeoutMs }: DapSpawnOptions): Promise<DapClient> {
		if (adapter.connectMode === "socket") {
			return DapClient.#spawnSocket({ adapter, cwd, socketReadyTimeoutMs });
		}
		if (adapter.connectMode === "tcp") {
			return DapClient.#spawnTcp({ adapter, cwd, socketReadyTimeoutMs });
		}
		// Merge non-interactive env and start in a new session (detached → setsid)
		// so the adapter process tree has no controlling terminal. Without this,
		// debuggee children can reach /dev/tty and trigger SIGTTIN, suspending
		// the parent harness under shell job control.
		const env = {
			...process.env,
			...NON_INTERACTIVE_ENV,
		};
		const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args], {
			cwd,
			stdin: "pipe",
			env,
			detached: true,
		});
		const client = new DapClient(adapter, cwd, proc);
		proc.exited.then(() => {
			client.#handleProcessExit();
		});
		void client.#startMessageReader();
		return client;
	}

	/** Connect to another session on an existing TCP DAP server. */
	static async connect({
		adapter,
		cwd,
		host,
		port,
	}: {
		adapter: DapResolvedAdapter;
		cwd: string;
		host: string;
		port: number;
	}): Promise<DapClient> {
		const exited = Promise.withResolvers<void>();
		const { readable, writeSink, socket } = await connectTransport({ host, port }, SOCKET_READY_TIMEOUT_MS, () =>
			exited.resolve(),
		);
		const proc = {
			exited: exited.promise,
			exitCode: null,
			stdin: { write: () => 0, flush: () => undefined },
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill: () => {
				socket.end();
				exited.resolve();
				return true;
			},
		} as unknown as DapClientState["proc"];
		const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket, port });
		exited.promise.then(() => client.#handleProcessExit());
		void client.#startMessageReader();
		return client;
	}

	/** Spawn an adapter that listens on a caller-selected TCP port. */
	static async #spawnTcp({ adapter, cwd, socketReadyTimeoutMs }: DapSpawnOptions): Promise<DapClient> {
		const host = "127.0.0.1";
		const reservation = createServer(socket => socket.destroy());
		const port = await listenOnLoopback(reservation);
		await closeServer(reservation);
		const args = adapter.args.map(arg => arg.replaceAll("$" + "{port}", String(port)));
		const proc = ptree.spawn([adapter.resolvedCommand, ...args], {
			cwd,
			stdin: "pipe",
			env: {
				...process.env,
				...NON_INTERACTIVE_ENV,
			},
			detached: true,
		});

		try {
			// Wait for the adapter to announce it is listening on `port` before
			// connecting. Without this gate the first connect can land in the
			// window where a just-released reservation port still accepts
			// connections (WSL2 mirrored networking, issue #6055): the transport
			// then binds to a ghost of the reservation listener instead of the
			// adapter. Draining stdout here also avoids a pipe-buffer deadlock —
			// in tcp mode the DAP protocol flows over the socket, so nothing else
			// consumes the adapter's stdout.
			const readyTimeoutMs = socketReadyTimeoutMs ?? SOCKET_READY_TIMEOUT_MS;
			await waitForTcpServerListening(proc, port, readyTimeoutMs);
			const { readable, writeSink, socket } = await waitForTcpTransport(host, port, readyTimeoutMs, proc);
			const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket, port });
			proc.exited.then(() => client.#handleProcessExit());
			void client.#startMessageReader();
			return client;
		} catch (error) {
			try {
				proc.kill();
			} catch {
				/* proc may already be dead */
			}
			throw error;
		}
	}

	/**
	 * Spawn a socket-mode adapter (e.g. dlv).
	 * Linux: connect to a unix domain socket via --listen=unix:<path>
	 * macOS/other: the adapter dials into our TCP listener via --client-addr
	 */
	static async #spawnSocket({ adapter, cwd, socketReadyTimeoutMs }: DapSpawnOptions): Promise<DapClient> {
		const env = {
			...process.env,
			...NON_INTERACTIVE_ENV,
		};
		const timeoutMs = socketReadyTimeoutMs ?? SOCKET_READY_TIMEOUT_MS;
		const isLinux = process.platform === "linux";

		if (isLinux) {
			return DapClient.#spawnSocketUnix({ adapter, cwd, env, timeoutMs });
		}
		return DapClient.#spawnSocketClientAddr({ adapter, cwd, env, timeoutMs });
	}

	/** Linux: spawn adapter with --listen=unix:<path>, then connect to the socket. */
	static async #spawnSocketUnix({
		adapter,
		cwd,
		env,
		timeoutMs,
	}: {
		adapter: DapResolvedAdapter;
		cwd: string;
		env: Record<string, string | undefined>;
		timeoutMs: number;
	}): Promise<DapClient> {
		const socketPath = `/tmp/dap-${adapter.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;
		const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args, `--listen=unix:${socketPath}`], {
			cwd,
			stdin: "pipe",
			env,
			detached: true,
		});
		void proc.exited
			.then(() => fs.rm(socketPath, { force: true }))
			.catch(error => {
				logger.debug("Failed to remove DAP unix socket", { socketPath, error: toErrorMessage(error) });
			});
		void drainAdapterStdout(proc.stdout);

		// If waitForCondition throws (timeout, or adapter exited early) or the
		// socket connect fails, we must not leak the detached adapter process.
		try {
			const deadline = Date.now() + timeoutMs;
			await waitForCondition(() => isUnixSocketReady(socketPath), timeoutMs, proc);
			const controller = abortOnProcessExit(proc);
			const { readable, writeSink, socket } = await connectTransport(
				{ path: socketPath },
				Math.max(1, deadline - Date.now()),
				undefined,
				controller.signal,
			);
			const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket });
			proc.exited.then(() => client.#handleProcessExit());
			void client.#startMessageReader();
			return client;
		} catch (error) {
			try {
				proc.kill();
			} catch {
				/* proc may already be dead */
			}
			throw error;
		}
	}

	/** macOS/other: listen on a random TCP port, spawn adapter with --client-addr, accept connection. */
	static async #spawnSocketClientAddr({
		adapter,
		cwd,
		env,
		timeoutMs,
	}: {
		adapter: DapResolvedAdapter;
		cwd: string;
		env: Record<string, string | undefined>;
		timeoutMs: number;
	}): Promise<DapClient> {
		const connection = Promise.withResolvers<Socket>();
		connection.promise.catch(() => {});
		let accepted: Socket | undefined;
		let proc: DapClientState["proc"] | undefined;
		let transferred = false;
		let timer: NodeJS.Timeout | undefined;
		const server = createServer({ pauseOnConnect: true }, socket => {
			// An accepted peer can fail before the awaiting continuation wraps it.
			socket.on("error", () => {});
			if (accepted) {
				socket.destroy();
				return;
			}
			accepted = socket;
			// Stop accepting immediately, without waiting for this socket to close.
			server.close();
			connection.resolve(socket);
		});
		server.on("error", error => connection.reject(error));
		try {
			const port = await listenOnLoopback(server);
			proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args, `--client-addr=127.0.0.1:${port}`], {
				cwd,
				stdin: "pipe",
				env,
				detached: true,
			});
			void drainAdapterStdout(proc.stdout);
			proc.exited.then(
				() => connection.reject(new Error(`${adapter.name} exited before connecting`)),
				error => connection.reject(error),
			);
			timer = setTimeout(
				() => connection.reject(new Error(`${adapter.name} did not connect within ${timeoutMs}ms`)),
				timeoutMs,
			);
			const rawSocket = await connection.promise;
			if (proc.exitCode !== null) throw new Error(`${adapter.name} exited before connecting`);
			const { readable, writeSink, socket } = wrapSocket(rawSocket);
			const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket });
			proc.exited.then(() => client.#handleProcessExit());
			void client.#startMessageReader();
			transferred = true;
			return client;
		} catch (error) {
			try {
				proc?.kill();
			} catch {
				/* proc may already be dead */
			}
			throw error;
		} finally {
			clearTimeout(timer);
			// A queued accept after timeout is rejected instead of orphaning a socket.
			server.removeAllListeners("connection");
			server.on("connection", socket => socket.destroy());
			if (server.listening) server.close();
			if (!transferred) accepted?.destroy();
		}
	}

	get capabilities(): DapCapabilities | undefined {
		return this.#capabilities;
	}

	get lastActivity(): number {
		return this.#lastActivity;
	}

	isAlive(): boolean {
		return !this.#disposed && this.proc.exitCode === null;
	}

	async initialize(args: DapInitializeArguments, signal?: AbortSignal, timeoutMs?: number): Promise<DapCapabilities> {
		const body = (await this.sendRequest("initialize", args, signal, timeoutMs)) as DapCapabilities | undefined;
		this.#capabilities = body ?? {};
		return this.#capabilities;
	}

	onEvent(event: string, handler: DapEventHandler): () => void {
		const handlers = this.#eventHandlers.get(event) ?? new Set<DapEventHandler>();
		handlers.add(handler);
		this.#eventHandlers.set(event, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.#eventHandlers.delete(event);
			}
		};
	}

	onAnyEvent(handler: DapEventHandler): () => void {
		this.#anyEventHandlers.add(handler);
		return () => {
			this.#anyEventHandlers.delete(handler);
		};
	}

	onReverseRequest(command: string, handler: DapReverseRequestHandler): () => void {
		this.#reverseRequestHandlers.set(command, handler);
		return () => {
			if (this.#reverseRequestHandlers.get(command) === handler) {
				this.#reverseRequestHandlers.delete(command);
			}
		};
	}

	async waitForEvent<TBody>(
		event: string,
		predicate?: (body: TBody) => boolean,
		signal?: AbortSignal,
		timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<TBody> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		}
		if (this.#disposed) throw new Error(`DAP adapter ${this.adapter.name} is not running`);
		const { promise, resolve, reject } = Promise.withResolvers<TBody>();
		const cleanup = () => {
			unsubscribe();
			this.#eventWaiterRejectors.delete(closeHandler);
			if (timeout) clearTimeout(timeout);
			if (signal) {
				signal.removeEventListener("abort", abortHandler);
			}
		};
		const abortHandler = () => {
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new ToolAbortError());
		};
		const closeHandler = (error: Error) => {
			cleanup();
			reject(error);
		};
		const unsubscribe = this.onEvent(event, body => {
			const typedBody = body as TBody;
			if (predicate && !predicate(typedBody)) {
				return;
			}
			cleanup();
			resolve(typedBody);
		});
		this.#eventWaiterRejectors.add(closeHandler);
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`DAP event ${event} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		return promise;
	}

	async sendRequest<TBody = unknown>(
		command: string,
		args?: unknown,
		signal?: AbortSignal,
		timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<TBody> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		}
		if (this.#disposed) {
			throw new Error(`DAP adapter ${this.adapter.name} is not running`);
		}
		const requestSeq = ++this.#requestSeq;
		const request: DapRequestMessage = {
			seq: requestSeq,
			type: "request",
			command,
			arguments: args,
		};
		const { promise, resolve, reject } = Promise.withResolvers<TBody>();
		// Suppress "unhandled rejection" if the request timer or abort fires
		// before the caller's `await` subscribes — e.g. while #writeMessage is
		// still racing a wedged stdin flush. The caller's own `await` still
		// receives the rejection normally; this handler is a passive guard.
		promise.catch(() => {});

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			if (signal) {
				signal.removeEventListener("abort", abortHandler);
			}
		};
		const abortHandler = () => {
			this.#pendingRequests.delete(requestSeq);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new ToolAbortError());
		};
		const timeout = setTimeout(() => {
			if (!this.#pendingRequests.has(requestSeq)) return;
			this.#pendingRequests.delete(requestSeq);
			cleanup();
			reject(new Error(`DAP request ${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		this.#pendingRequests.set(requestSeq, {
			command,
			resolve: body => {
				cleanup();
				resolve(body as TBody);
			},
			reject: error => {
				cleanup();
				reject(error);
			},
		});
		this.#lastActivity = Date.now();
		// Fire the write in the background. Awaiting it here would let a wedged
		// stdin flush block the caller's `timeoutMs`; if it fails, propagate the
		// failure into `promise` — the timer or abort may still win the race.
		void this.#writeMessage(request).catch(error => {
			if (!this.#pendingRequests.has(requestSeq)) return;
			this.#pendingRequests.delete(requestSeq);
			cleanup();
			reject(error);
		});
		return promise;
	}

	async sendResponse(request: DapRequestMessage, success: boolean, body?: unknown, message?: string): Promise<void> {
		const response: DapResponseMessage = {
			seq: ++this.#requestSeq,
			type: "response",
			request_seq: request.seq,
			success,
			command: request.command,
			...(message ? { message } : {}),
			...(body !== undefined ? { body } : {}),
		};
		await this.#writeMessage(response);
	}

	/**
	 * Framed write to the adapter, bounded by {@link WRITE_MESSAGE_TIMEOUT_MS}
	 * and by adapter exit. Without this bound a wedged adapter stdin used to
	 * hang the whole client forever. On a failed write (EPIPE), timeout, or
	 * exit-before-flush the client disposes itself and rethrows.
	 */
	async #writeMessage(message: DapRequestMessage | DapResponseMessage): Promise<void> {
		const frame = encodeMessageFrame(message);
		// A partial pipe write must finish before another frame can start.
		const write = this.#writeQueue.then(() => this.#writeFrame(frame));
		this.#writeQueue = write.catch(() => {});
		return write;
	}

	async #writeFrame(frame: Uint8Array): Promise<void> {
		if (this.#disposed || this.#adapterExited) {
			throw new Error(`DAP adapter ${this.adapter.name} exited before write completed`);
		}

		const { promise: guardPromise, reject: guardReject, resolve: guardResolve } = Promise.withResolvers<void>();
		const timer = setTimeout(
			() =>
				guardReject(
					new Error(`DAP adapter ${this.adapter.name} write timed out after ${WRITE_MESSAGE_TIMEOUT_MS}ms`),
				),
			WRITE_MESSAGE_TIMEOUT_MS,
		);
		const rejectOnExit = () => {
			guardReject(new Error(`DAP adapter ${this.adapter.name} exited before write completed`));
		};
		this.#pendingWriteExitRejectors.add(rejectOnExit);

		try {
			const writeFrame = async () => {
				let offset = 0;
				while (offset < frame.byteLength) {
					if (this.#disposed || this.#adapterExited) {
						throw new Error(`DAP adapter ${this.adapter.name} exited before write completed`);
					}
					const chunk = offset === 0 ? frame : frame.subarray(offset);
					const write = this.#writeSink.write(chunk);
					// Observe rejection before flush(), which may throw synchronously.
					if (write instanceof Promise) write.catch(() => {});
					const flush = this.#writeSink.flush();
					const [consumed] = await Promise.all([write, flush]);
					if (!Number.isInteger(consumed) || consumed < 0 || consumed > chunk.byteLength) {
						throw new Error(`DAP adapter ${this.adapter.name} returned an invalid write byte count`);
					}
					offset += consumed;
					if (consumed === 0) await runtime.sleep(1);
				}
			};
			await Promise.race([writeFrame(), guardPromise]);
		} catch (error) {
			// The client is now known-broken. Kick off dispose in the background;
			// callers will see subsequent sendRequest calls fail fast.
			void this.dispose();
			throw error;
		} finally {
			clearTimeout(timer);
			this.#pendingWriteExitRejectors.delete(rejectOnExit);
			// Release the guard so any late timeout callback becomes a no-op.
			guardResolve();
		}
	}

	#rejectPendingWritesForExit(): void {
		this.#adapterExited = true;
		for (const reject of this.#pendingWriteExitRejectors) {
			reject();
		}
		this.#pendingWriteExitRejectors.clear();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#rejectPendingWritesForExit();
		this.#failConnection(new Error(`DAP adapter ${this.adapter.name} disposed`));
		try {
			this.#socket?.end();
		} catch {
			/* socket may already be closed */
		}
		try {
			this.proc.kill();
		} catch (error) {
			logger.debug("Failed to kill DAP adapter", {
				adapter: this.adapter.name,
				error: toErrorMessage(error),
			});
		}
		await this.proc.exited.catch(() => {});
	}

	async #startMessageReader(): Promise<void> {
		if (this.#isReading) return;
		this.#isReading = true;
		const reader = this.#readable.getReader();

		const framer = new MessageFramer(Buffer.alloc(0));

		let closeError: Error | undefined;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				framer.push(value);

				// Drain every complete message currently buffered.
				for (const messageText of framer.drain(headerText => {
					// Non-protocol bytes (e.g. an adapter printing to stdout).
					// Drop past the bogus terminator and resync instead of
					// stalling on the same junk header forever.
					logger.warn("DAP framing resync: header block without Content-Length", {
						adapter: this.adapter.name,
						header: headerText.slice(0, 200),
					});
				})) {
					this.#lastActivity = Date.now();

					// A malformed message must not kill the reader — later
					// messages are still well-framed.
					try {
						const message = JSON.parse(messageText) as DapResponseMessage | DapEventMessage | DapRequestMessage;
						if (message.type === "response") {
							this.#handleResponse(message);
						} else if (message.type === "event") {
							await this.#dispatchEvent(message);
						} else {
							await this.#handleAdapterRequest(message);
						}
					} catch (error) {
						logger.warn("DAP message handling failed", {
							adapter: this.adapter.name,
							error: toErrorMessage(error),
						});
					}
				}
			}
		} catch (error) {
			closeError = new Error(`DAP connection closed: ${toErrorMessage(error)}`);
		} finally {
			reader.releaseLock();
			this.#isReading = false;
		}
		// The transport is gone once the reader loop exits — on a thrown error
		// or a clean stream end (a socket the peer dropped after we wrote, e.g.
		// the WSL2-mirrored ghost-accept race in issue #6055). Fail every
		// in-flight request and event waiter so callers see an immediate error
		// instead of waiting out their own timeout.
		this.#failConnection(closeError ?? new Error(`DAP connection closed: ${this.adapter.name} transport ended`));
		await this.dispose().catch(error => {
			logger.warn("Failed to dispose DAP adapter after transport closed", {
				adapter: this.adapter.name,
				error: toErrorMessage(error),
			});
		});
	}

	#handleResponse(message: DapResponseMessage): void {
		const pending = this.#pendingRequests.get(message.request_seq);
		if (!pending) {
			return;
		}
		this.#pendingRequests.delete(message.request_seq);
		if (message.success) {
			pending.resolve(message.body);
			return;
		}
		const errorMessage = message.message ?? `DAP request ${pending.command} failed`;
		pending.reject(new Error(errorMessage));
	}

	async #dispatchEvent(message: DapEventMessage): Promise<void> {
		const handlers = Array.from(this.#eventHandlers.get(message.event) ?? []);
		const anyHandlers = Array.from(this.#anyEventHandlers);
		for (const handler of [...handlers, ...anyHandlers]) {
			try {
				await handler(message.body, message);
			} catch (error) {
				logger.warn("DAP event handler failed", {
					adapter: this.adapter.name,
					event: message.event,
					error: toErrorMessage(error),
				});
			}
		}
	}

	async #handleAdapterRequest(message: DapRequestMessage): Promise<void> {
		try {
			const handler = this.#reverseRequestHandlers.get(message.command);
			if (handler) {
				try {
					const body = await handler(message.arguments);
					await this.sendResponse(message, true, body);
				} catch (error) {
					const errorMessage = toErrorMessage(error);
					await this.sendResponse(
						message,
						false,
						{
							error: {
								id: 1,
								format: errorMessage,
							},
						},
						errorMessage,
					);
				}
				return;
			}
			const errorMessage = `Unsupported DAP request: ${message.command}`;
			await this.sendResponse(
				message,
				false,
				{
					error: {
						id: 1,
						format: errorMessage,
					},
				},
				errorMessage,
			);
		} catch (error) {
			logger.warn("Failed to answer DAP adapter request", {
				adapter: this.adapter.name,
				command: message.command,
				error: toErrorMessage(error),
			});
		}
	}

	#handleProcessExit(): void {
		if (this.#disposed) return;
		const stderr = this.proc.peekStderr().trim();
		const exitCode = this.proc.exitCode;
		const error = new Error(
			stderr
				? `DAP adapter exited (code ${exitCode}): ${stderr}`
				: `DAP adapter exited unexpectedly (code ${exitCode})`,
		);
		this.#failConnection(error);
		void this.dispose();
	}

	/** Reject every in-flight request and wake every event waiter with `error`.
	 *  Called when the transport dies (reader end, socket close, adapter exit)
	 *  so nothing sits pending until its own timeout. */
	#failConnection(error: Error): void {
		this.#rejectPendingRequests(error);
		const waiters = Array.from(this.#eventWaiterRejectors);
		this.#eventWaiterRejectors.clear();
		for (const reject of waiters) {
			reject(error);
		}
	}

	#rejectPendingRequests(error: Error): void {
		for (const pending of this.#pendingRequests.values()) {
			pending.reject(error);
		}
		this.#pendingRequests.clear();
	}
}

async function isUnixSocketReady(socketPath: string): Promise<boolean> {
	try {
		return (await fs.stat(socketPath)).isSocket();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Poll a condition until it returns true, or timeout/process exit. */
async function waitForCondition(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	proc: { exitCode: number | null },
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error("Adapter process exited before socket was ready");
		if (await check()) return;
		await runtime.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
	}
	throw new Error(`Socket not ready after ${timeoutMs}ms`);
}

function abortOnProcessExit(proc: DapClientState["proc"]): AbortController {
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Adapter process exited before socket was ready"));
	if (proc.exitCode !== null) abort();
	else void proc.exited.then(abort, abort);
	return controller;
}

/** Wait until a loopback listener owns its assigned port. */
async function listenOnLoopback(server: Server): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const onError = (error: Error) => {
		server.removeListener("listening", onListening);
		reject(error);
	};
	const onListening = () => {
		server.removeListener("error", onError);
		const address = server.address();
		if (!address || typeof address === "string") {
			reject(new Error("DAP listener did not receive a TCP port"));
			return;
		}
		resolve(address.port);
	};
	server.once("error", onError);
	server.once("listening", onListening);
	try {
		server.listen(0, "127.0.0.1");
	} catch (error) {
		server.removeListener("error", onError);
		server.removeListener("listening", onListening);
		throw error;
	}
	return promise;
}

async function closeServer(server: Server): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.close(error => (error ? reject(error) : resolve()));
	return promise;
}

/** Wait for a TCP DAP server and retain the first successful connection. */
async function waitForTcpTransport(
	host: string,
	port: number,
	timeoutMs: number,
	proc: DapClientState["proc"],
): Promise<SocketTransport> {
	const deadline = Date.now() + timeoutMs;
	const controller = abortOnProcessExit(proc);
	while (Date.now() < deadline) {
		controller.signal.throwIfAborted();
		try {
			return await connectTransport(
				{ host, port },
				Math.max(1, deadline - Date.now()),
				undefined,
				controller.signal,
			);
		} catch {
			controller.signal.throwIfAborted();
			await runtime.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
		}
	}
	throw new Error(`TCP port ${host}:${port} was not ready after ${timeoutMs}ms`);
}

/** Non-stdio adapters can print indefinitely; never leave their stdout pipe blocked. */
async function drainAdapterStdout(
	stdout: ReadableStream<Uint8Array>,
	onChunk?: (chunk: Uint8Array) => void,
): Promise<void> {
	try {
		for await (const chunk of stdout) onChunk?.(chunk);
	} catch {
		/* The process/transport path reports the actual failure. */
	}
}

/**
 * Wait for an adapter's stdout to mention its reserved port before connecting,
 * avoiding the WSL2 mirrored-networking ghost-reservation race. Adapters without
 * a banner proceed after the timeout. Keep draining stdout after the gate opens
 * so a chatty adapter cannot deadlock on its pipe.
 */
export async function waitForTcpServerListening(
	proc: { stdout: ReadableStream<Uint8Array>; exitCode: number | null },
	port: number,
	timeoutMs: number,
): Promise<void> {
	const ready = Promise.withResolvers<void>();
	const decoder = new TextDecoder();
	const portText = String(port);
	let buffered = "";
	let matched = false;
	void drainAdapterStdout(proc.stdout, chunk => {
		if (matched) return;
		buffered += decoder.decode(chunk, { stream: true });
		if (buffered.includes(portText)) {
			matched = true;
			buffered = "";
			ready.resolve();
		} else if (buffered.length > 4096) {
			buffered = buffered.slice(-1024);
		}
	}).then(() => ready.resolve());
	const timer = setTimeout(() => {
		matched = true;
		buffered = "";
		ready.resolve();
	}, timeoutMs);
	try {
		if (proc.exitCode === null) await ready.promise;
	} finally {
		clearTimeout(timer);
	}
}

interface SocketTransport {
	readable: ReadableStream<Uint8Array>;
	writeSink: DapWriteSink;
	socket: { end(): void };
}

/** A Node write buffers the entire chunk even when it returns false. */
function socketToSink(socket: Socket): DapWriteSink {
	return {
		write(data) {
			if (socket.destroyed || socket.writableEnded) throw new Error("DAP socket is closed");
			const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
			const { promise, resolve, reject } = Promise.withResolvers<number>();
			const cleanup = () => {
				socket.removeListener("error", onError);
				socket.removeListener("close", onClose);
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onClose = () => onError(new Error("DAP socket closed before write completed"));
			socket.once("error", onError);
			socket.once("close", onClose);
			try {
				// The callback confirms the whole chunk was consumed; a false return
				// is backpressure, not zero bytes or a partial write to retry.
				socket.write(data, error => {
					cleanup();
					if (error) reject(error);
					else resolve(size);
				});
			} catch (error) {
				cleanup();
				reject(error);
			}
			return promise;
		},
		flush() {
			// write() already waits for the native writable callback.
			return undefined;
		},
	};
}

/**
 * Connect to a Unix-domain socket, rejecting immediately on a dead socket or
 * after timeout. Timed-out/aborted attempts are destroyed, including late opens.
 */
export async function connectSocket(options: { unix: string }, timeoutMs: number): Promise<SocketTransport> {
	return connectTransport({ path: options.unix }, timeoutMs);
}

function connectTransport(
	options: NetConnectOpts,
	timeoutMs: number,
	onClose?: () => void,
	signal?: AbortSignal,
): Promise<SocketTransport> {
	signal?.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<SocketTransport>();
	const rawSocket = createConnection(options);
	let settled = false;
	const cleanup = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		rawSocket.removeListener("connect", onConnect);
		rawSocket.removeListener("close", onEarlyClose);
	};
	const fail = (error: unknown) => {
		if (settled) return;
		settled = true;
		cleanup();
		rawSocket.destroy();
		reject(error);
	};
	const onAbort = () => fail(signal?.reason ?? new ToolAbortError());
	const onEarlyClose = () => fail(new Error("DAP socket closed before opening"));
	const onConnect = () => {
		if (settled) {
			rawSocket.destroy();
			return;
		}
		settled = true;
		cleanup();
		resolve(wrapSocket(rawSocket, onClose));
	};
	// Keep an error listener through destroy/close, even after a failed attempt.
	rawSocket.on("error", fail);
	rawSocket.once("connect", onConnect);
	rawSocket.once("close", onEarlyClose);
	const timer = setTimeout(
		() => fail(new Error(`Timed out connecting to DAP socket after ${timeoutMs}ms`)),
		timeoutMs,
	);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	return promise;
}

/** Native stream adaptation preserves socket read backpressure and cancellation. */
function wrapSocket(rawSocket: Socket, onClose?: () => void): SocketTransport {
	// Also cover errors after the readable adapter has detached its listeners.
	rawSocket.on("error", () => {});
	if (onClose) rawSocket.once("close", onClose);
	return {
		readable: toWebByteStream(rawSocket),
		writeSink: socketToSink(rawSocket),
		// A half-close can leave an uncooperative adapter alive indefinitely.
		socket: { end: () => void rawSocket.destroy() },
	};
}
