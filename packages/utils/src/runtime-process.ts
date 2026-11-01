import {
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type ChildProcess,
	type StdioOptions,
} from "node:child_process";
import { createServer, ServerResponse, type IncomingMessage } from "node:http";
import { constants as osConstants } from "node:os";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type * as Ws from "ws";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { createRequire } from "node:module";
import { openSync, closeSync } from "node:fs";
import { fromWebByteStream, toWebByteStream } from "./runtime-readable";

const bun = typeof Bun === "undefined" ? undefined : Bun;

export interface RuntimeFileSink {
	write(data: string | Uint8Array | ArrayBuffer): number | Promise<number>;
	flush(): number | Promise<number>;
	end(data?: string | Uint8Array): number | Promise<number>;
}

export interface RuntimeSubprocess {
	readonly pid: number;
	readonly stdin: RuntimeFileSink | undefined;
	readonly stdout: ReadableStream<Uint8Array> | undefined;
	readonly stderr: ReadableStream<Uint8Array> | undefined;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	readonly killed: boolean;
	kill(signal?: NodeJS.Signals | number): void;
	ref(): void;
	unref(): void;
	send(message: unknown): void;
	disconnect(): void;
}

type SpawnOptions = {
	cmd?: readonly string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: unknown;
	stdout?: unknown;
	stderr?: unknown;
	stdio?: readonly unknown[] | "ignore" | "inherit" | "pipe";
	detached?: boolean;
	windowsHide?: boolean;
	windowsVerbatimArguments?: boolean;
	serialization?: "json" | "advanced";
	signal?: AbortSignal;
	timeout?: number;
	killSignal?: NodeJS.Signals | number;
	ipc?: (message: unknown, process: RuntimeSubprocess) => void;
	onExit?: (process: RuntimeSubprocess, code: number | null, signal: NodeJS.Signals | null, error?: Error) => void;
};

class NodeFileSink implements RuntimeFileSink {
	#pending = 0;
	#flushing: PromiseWithResolvers<number> | undefined;
	#draining: PromiseWithResolvers<void> | undefined;
	#ending: PromiseWithResolvers<number> | undefined;
	#error: Error | undefined;
	constructor(readonly stream: Writable) {
		stream.on("error", error => this.#fail(error));
		stream.on("drain", () => {
			this.#draining?.resolve();
			this.#draining = undefined;
		});
		stream.on("finish", () => {
			this.#draining?.resolve();
			this.#draining = undefined;
		});
		stream.on("close", () => {
			if (!stream.writableFinished)
				this.#fail(Object.assign(new Error("Subprocess stdin closed"), { code: "ERR_STREAM_DESTROYED" }));
		});
	}
	#fail(error: Error): void {
		this.#error ??= error;
		this.#flushing?.reject(error);
		this.#draining?.reject(error);
		this.#ending?.reject(error);
		this.#flushing = undefined;
		this.#draining = undefined;
	}
	write(data: string | Uint8Array | ArrayBuffer): number | Promise<number> {
		if (this.#error) throw this.#error;
		if (this.stream.writableEnded || this.stream.destroyed) throw new Error("Subprocess stdin is closed");
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
		const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
		this.#pending++;
		let ready: boolean;
		try {
			ready = this.stream.write(bytes, error => {
				this.#pending--;
				if (error) this.#fail(error);
				else if (this.#pending === 0) {
					this.#flushing?.resolve(0);
					this.#flushing = undefined;
				}
			});
		} catch (error) {
			this.#pending--;
			throw error;
		}
		if (this.#error) throw this.#error;
		if (ready) return size;
		this.#draining ??= Promise.withResolvers<void>();
		return this.#draining.promise.then(() => size);
	}
	flush(): number | Promise<number> {
		if (this.#error) throw this.#error;
		if (this.#pending === 0) return 0;
		this.#flushing ??= Promise.withResolvers<number>();
		return this.#flushing.promise;
	}
	end(data?: string | Uint8Array): number | Promise<number> {
		if (this.#error) throw this.#error;
		if (this.#ending) {
			if (data !== undefined) throw new Error("Subprocess stdin is already ending");
			return this.#ending.promise;
		}
		this.#ending = Promise.withResolvers<number>();
		this.stream.end(data, (error?: Error | null) => (error ? this.#fail(error) : this.#ending!.resolve(0)));
		return this.#ending.promise;
	}
}

function stdioValue(
	value: unknown,
	fallback: "pipe" | "ignore" | "inherit",
	owned: number[],
	input: boolean,
): "pipe" | "ignore" | "inherit" | number {
	if (value === undefined) return fallback;
	if (value === null) return "ignore";
	if (typeof value === "number" || value === "pipe" || value === "ignore" || value === "inherit") return value;
	if (typeof value === "object" && value !== null) {
		if ("fd" in value && typeof value.fd === "number") return value.fd;
		const target = "target" in value ? value.target : "name" in value ? value.name : undefined;
		if (typeof target === "number") return target;
		if (typeof target === "string" || target instanceof URL) {
			const descriptor = openSync(target, input ? "r" : "w");
			owned.push(descriptor);
			return descriptor;
		}
	}
	if (
		input &&
		(typeof value === "string" ||
			value instanceof Uint8Array ||
			value instanceof ArrayBuffer ||
			value instanceof ReadableStream ||
			value instanceof Blob)
	)
		return "pipe";
	throw new TypeError(`Unsupported subprocess ${input ? "stdin" : "output"} value`);
}

function nodeProcess(command: readonly string[], options: SpawnOptions): RuntimeSubprocess {
	if (!command.length) throw new TypeError("spawn requires a command");
	options.signal?.throwIfAborted();
	const io = options.stdio;
	const input = Array.isArray(io) ? io[0] : typeof io === "string" ? io : options.stdin;
	const owned: number[] = [];
	let child: ChildProcess;
	try {
		const stdio: StdioOptions = [0, 1, 2].map(index =>
			stdioValue(
				Array.isArray(io)
					? io[index]
					: typeof io === "string"
						? io
						: options[(["stdin", "stdout", "stderr"] as const)[index]!],
				index === 0 ? "ignore" : index === 2 ? "inherit" : "pipe",
				owned,
				index === 0,
			),
		);
		if (options.ipc) stdio.push("ipc");
		const env =
			process.versions.electron && command[0] === process.execPath
				? { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: options.env?.ELECTRON_RUN_AS_NODE ?? "1" }
				: options.env;
		child = nodeSpawn(command[0]!, command.slice(1), {
			cwd: options.cwd,
			env,
			detached: options.detached,
			windowsHide: options.windowsHide,
			windowsVerbatimArguments: options.windowsVerbatimArguments,
			serialization: options.serialization ?? "advanced",
			stdio,
		});
	} finally {
		for (const descriptor of owned) closeSync(descriptor);
	}
	let timer: NodeJS.Timeout | undefined;
	let failure: Error | undefined;
	let operationError: Error | undefined;
	let spawned = false;
	const { promise: exited, resolve, reject } = Promise.withResolvers<number>();
	// onExit consumers do not necessarily await exited; retain rejection for awaiters.
	void exited.catch(() => {});
	const reference = (ref: boolean): void => {
		if (ref) child.ref();
		else child.unref();
		for (const stream of child.stdio) {
			const handle = stream as unknown as { ref?: () => void; unref?: () => void } | null;
			if (ref) handle?.ref?.();
			else handle?.unref?.();
		}
		if (ref) {
			child.channel?.ref();
			timer?.ref();
		} else {
			child.channel?.unref();
			timer?.unref();
		}
	};
	const proc: RuntimeSubprocess = {
		get pid() {
			return child.pid ?? 0;
		},
		stdin: child.stdin ? new NodeFileSink(child.stdin) : undefined,
		stdout: child.stdout ? toWebByteStream(child.stdout) : undefined,
		stderr: child.stderr ? toWebByteStream(child.stderr) : undefined,
		exited,
		get exitCode() {
			return child.exitCode;
		},
		get signalCode() {
			return child.signalCode;
		},
		get killed() {
			return child.killed;
		},
		kill(signal = "SIGTERM") {
			child.kill(signal);
		},
		ref() {
			reference(true);
		},
		unref() {
			reference(false);
		},
		send(message) {
			if (!child.connected || !child.send) throw new Error("Subprocess IPC channel is closed");
			child.send(message as Parameters<NonNullable<ChildProcess["send"]>>[0]);
		},
		disconnect() {
			if (!options.ipc) throw new Error("Subprocess IPC is not enabled");
			if (child.connected) child.disconnect();
		},
	};
	const abort = (): void => proc.kill(options.killSignal ?? "SIGTERM");
	const cleanup = (): void => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	};
	child.once("spawn", () => {
		spawned = true;
	});
	child.on("error", error => {
		if (spawned) operationError = error;
		else failure = error;
	});
	child.once("exit", cleanup);
	// exit precedes the final stdio data/EOF events; close preserves those bytes.
	child.once("close", (code, signal) => {
		cleanup();
		if (failure) reject(failure);
		else resolve(code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0));
		options.onExit?.(proc, code, signal, failure ?? operationError);
	});
	child.on("message", message => options.ipc?.(message, proc));
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	if (options.timeout && options.timeout > 0) timer = setTimeout(abort, options.timeout);
	const source = input instanceof Blob ? input.stream() : input instanceof ReadableStream ? input : undefined;
	if (
		child.stdin &&
		(source ||
			(typeof input === "string" && !["pipe", "ignore", "inherit"].includes(input)) ||
			input instanceof Uint8Array ||
			input instanceof ArrayBuffer)
	) {
		const stdin = child.stdin;
		const reader = source?.getReader();
		const cancel = (): void => {
			void reader?.cancel().catch(error => {
				operationError ??= error instanceof Error ? error : new Error(String(error));
			});
		};
		stdin.once("close", cancel);
		void (async () => {
			try {
				if (reader) {
					while (!stdin.destroyed) {
						const { done, value } = await reader.read();
						if (done || stdin.destroyed) break;
						await proc.stdin!.write(value);
					}
				} else await proc.stdin!.write(input as string | Uint8Array | ArrayBuffer);
				if (!stdin.destroyed) await proc.stdin!.end();
			} catch (error) {
				if (!stdin.destroyed) {
					failure = error instanceof Error ? error : new Error(String(error));
					child.kill();
					await reader?.cancel(failure).catch(error => {
						operationError ??= error instanceof Error ? error : new Error(String(error));
					});
				}
			} finally {
				stdin.off("close", cancel);
				reader?.releaseLock();
			}
		})();
	}
	return proc;
}

export const spawn: typeof Bun.spawn = ((command: readonly string[] | SpawnOptions, options: SpawnOptions = {}) => {
	if (bun)
		return Array.isArray(command) ? bun.spawn(command as string[], options as never) : bun.spawn(command as never);
	return Array.isArray(command)
		? nodeProcess(command, options)
		: nodeProcess((command as SpawnOptions).cmd ?? [], command as SpawnOptions);
}) as typeof Bun.spawn;

export const spawnSync: typeof Bun.spawnSync = ((
	command: readonly string[] | SpawnOptions,
	options: SpawnOptions = {},
) => {
	if (bun)
		return Array.isArray(command)
			? bun.spawnSync(command as string[], options as never)
			: bun.spawnSync(command as never);
	if (!Array.isArray(command)) {
		options = command as SpawnOptions;
		command = options.cmd ?? [];
	}
	const argv = command as readonly string[];
	if (!argv.length) throw new TypeError("spawnSync requires a command");
	options.signal?.throwIfAborted();
	const stdin = Array.isArray(options.stdio)
		? options.stdio[0]
		: typeof options.stdio === "string"
			? options.stdio
			: options.stdin;
	const owned: number[] = [];
	let result;
	try {
		const stdio: StdioOptions = [0, 1, 2].map(index =>
			stdioValue(
				Array.isArray(options.stdio)
					? options.stdio[index]
					: typeof options.stdio === "string"
						? options.stdio
						: options[(["stdin", "stdout", "stderr"] as const)[index]!],
				index === 0 ? "ignore" : "pipe",
				owned,
				index === 0,
			),
		);
		const env =
			process.versions.electron && argv[0] === process.execPath
				? { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: options.env?.ELECTRON_RUN_AS_NODE ?? "1" }
				: options.env;
		const nodeOptions = {
			cwd: options.cwd,
			env,
			detached: options.detached,
			windowsHide: options.windowsHide,
			windowsVerbatimArguments: options.windowsVerbatimArguments,
			timeout: options.timeout,
			killSignal: options.killSignal as NodeJS.Signals,
			maxBuffer: Number.MAX_SAFE_INTEGER,
			stdio,
			input:
				(typeof stdin === "string" && !["pipe", "ignore", "inherit"].includes(stdin)) || stdin instanceof Uint8Array
					? stdin
					: stdin instanceof ArrayBuffer
						? new Uint8Array(stdin)
						: undefined,
		};
		result = nodeSpawnSync(argv[0]!, argv.slice(1), nodeOptions);
	} finally {
		for (const descriptor of owned) closeSync(descriptor);
	}
	if (result.error) throw result.error;
	return {
		pid: result.pid,
		stdout: result.stdout ?? Buffer.alloc(0),
		stderr: result.stderr ?? Buffer.alloc(0),
		exitCode: result.status ?? 128 + (result.signal ? (osConstants.signals[result.signal] ?? 0) : 0),
		signalCode: result.signal,
		success: result.status === 0,
	};
}) as typeof Bun.spawnSync;

export interface RuntimeServerWebSocket<T = unknown> {
	readonly data: T;
	readonly readyState: number;
	readonly remoteAddress: string;
	send(data: string | Uint8Array | ArrayBuffer): number;
	ping(data?: string | Uint8Array): number;
	close(code?: number, reason?: string): void;
	terminate(): void;
}

export interface RuntimeServer<T = unknown> {
	readonly hostname: string;
	readonly port: number;
	readonly url: URL;
	requestIP(request: Request): { address: string; family: string; port: number } | null;
	timeout(request: Request, seconds: number): void;
	upgrade(request: Request, options?: { data?: T }): boolean;
	stop(closeActiveConnections?: boolean): Promise<void> | void;
	ref(): void;
	unref(): void;
}
export interface RuntimeServeOptions<T = unknown> {
	hostname?: string;
	port?: number;
	unix?: string;
	idleTimeout?: number;
	reusePort?: boolean;
	fetch(request: Request, server: RuntimeServer<T>): Response | undefined | Promise<Response | undefined>;
	error?(error: Error): Response | Promise<Response>;
	websocket?: {
		maxPayloadLength?: number;
		idleTimeout?: number;
		open?(socket: RuntimeServerWebSocket<T>): void;
		message?(socket: RuntimeServerWebSocket<T>, message: string | Buffer): void;
		close?(socket: RuntimeServerWebSocket<T>, code: number, reason: string): void;
		ping?(socket: RuntimeServerWebSocket<T>, data: Buffer): void;
		pong?(socket: RuntimeServerWebSocket<T>, data: Buffer): void;
		error?(socket: RuntimeServerWebSocket<T>, error: Error): void;
	};
}

export function serve<T = unknown>(options: RuntimeServeOptions<T>): RuntimeServer<T> | Promise<RuntimeServer<T>> {
	if (bun) return bun.serve(options as never) as unknown as RuntimeServer<T>;
	const { promise, resolve, reject } = Promise.withResolvers<RuntimeServer<T>>();
	const hostname = options.hostname ?? "0.0.0.0";
	let adapter!: RuntimeServer<T>;
	let stopping: Promise<void> | undefined;
	const upgrades = new WeakMap<
		Request,
		{ incoming: IncomingMessage; socket: Duplex; head: Buffer; accepted: boolean }
	>();
	const pendingUpgrades = new Set<Duplex>();
	const connections = new Set<Socket>();
	const requests = new WeakMap<Request, IncomingMessage>();
	const websocket = options.websocket
		? new (createRequire(import.meta.url)("ws") as typeof Ws).WebSocketServer({
				noServer: true,
				maxPayload: options.websocket.maxPayloadLength,
			})
		: undefined;
	const makeRequest = (incoming: IncomingMessage, signal: AbortSignal): Request => {
		const headers = new Headers();
		for (let i = 0; i < incoming.rawHeaders.length; i += 2)
			headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
		const init: RequestInit & { duplex?: "half" } = { method: incoming.method, headers, signal };
		if (incoming.method !== "GET" && incoming.method !== "HEAD") {
			init.body = toWebByteStream(incoming);
			init.duplex = "half";
		}
		const request = new Request(new URL(incoming.url ?? "/", adapter.url).href, init);
		requests.set(request, incoming);
		return request;
	};
	const fetchRequest = async (request: Request): Promise<Response | undefined> => {
		try {
			return await options.fetch(request, adapter);
		} catch (error) {
			if (!options.error) throw error;
			return await options.error(error instanceof Error ? error : new Error(String(error)));
		}
	};
	const writeResponse = async (request: Request, response: Response, outgoing: ServerResponse): Promise<void> => {
		if (request.signal.aborted || outgoing.destroyed) {
			await response.body?.cancel(request.signal.reason);
			return;
		}
		outgoing.statusCode = response.status;
		if (response.statusText) outgoing.statusMessage = response.statusText;
		response.headers.forEach((value, key) => {
			if (key !== "set-cookie") outgoing.setHeader(key, value);
		});
		const cookies = response.headers.getSetCookie();
		if (cookies.length) outgoing.setHeader("set-cookie", cookies);
		if (response.body && request.method !== "HEAD") {
			await pipeline(fromWebByteStream(response.body), outgoing, { signal: request.signal });
		} else {
			await response.body?.cancel();
			outgoing.end();
		}
	};
	const http = createServer((incoming, outgoing) => {
		const controller = new AbortController();
		const abort = (): void => {
			controller.abort();
		};
		incoming.once("aborted", abort);
		outgoing.once("close", () => {
			incoming.off("aborted", abort);
			if (!outgoing.writableFinished) abort();
		});
		outgoing.on("error", abort);
		void (async () => {
			const request = makeRequest(incoming, controller.signal);
			const response = await fetchRequest(request);
			if (!response) throw new Error("HTTP handler returned no response without upgrading");
			await writeResponse(request, response, outgoing);
		})().catch(() => outgoing.destroy());
	});
	http.on("connection", socket => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
	});
	http.on("upgrade", (incoming, socket, head) => {
		const controller = new AbortController();
		const abort = (): void => {
			controller.abort();
		};
		socket.on("error", abort);
		socket.once("close", () => {
			pendingUpgrades.delete(socket);
			abort();
		});
		incoming.once("aborted", abort);
		pendingUpgrades.add(socket);
		void (async () => {
			const request = makeRequest(incoming, controller.signal);
			const pending = { incoming, socket, head, accepted: false };
			upgrades.set(request, pending);
			try {
				const response = await fetchRequest(request);
				if (pending.accepted) {
					await response?.body?.cancel();
					return;
				}
				if (!response) throw new Error("WebSocket handler returned no response without upgrading");
				const outgoing = new ServerResponse(incoming);
				outgoing.on("error", abort);
				outgoing.assignSocket(socket as Socket);
				outgoing.shouldKeepAlive = false;
				outgoing.once("finish", () => socket.end());
				await writeResponse(request, response, outgoing);
			} finally {
				upgrades.delete(request);
				incoming.off("aborted", abort);
			}
		})().catch(() => socket.destroy());
	});
	http.once("error", reject);
	http.timeout = (options.idleTimeout ?? 10) * 1000;
	http.listen(
		options.unix
			? { path: options.unix }
			: { port: options.port ?? 3000, host: hostname, reusePort: options.reusePort },
		() => {
			http.off("error", reject);
			const address = http.address();
			if (!address) {
				http.close();
				reject(new Error("HTTP server has no bound address"));
				return;
			}
			const port = typeof address === "string" ? 0 : address.port;
			adapter = {
				hostname,
				port,
				url: new URL(`http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`),
				requestIP(request) {
					const socket = requests.get(request)?.socket;
					return socket?.remoteAddress
						? { address: socket.remoteAddress, family: socket.remoteFamily ?? "", port: socket.remotePort ?? 0 }
						: null;
				},
				timeout(request, seconds) {
					requests.get(request)?.socket.setTimeout(seconds * 1000);
				},
				upgrade(request, upgradeOptions) {
					const pending = upgrades.get(request);
					if (!websocket || !pending || pending.accepted || pending.socket.destroyed || stopping) return false;
					const headers = pending.incoming.headers;
					if (
						pending.incoming.method !== "GET" ||
						headers.upgrade?.toLowerCase() !== "websocket" ||
						!headers.connection?.split(",").some(token => token.trim().toLowerCase() === "upgrade") ||
						typeof headers["sec-websocket-key"] !== "string" ||
						!/^[+/0-9A-Za-z]{22}==$/.test(headers["sec-websocket-key"]) ||
						headers["sec-websocket-version"] !== "13"
					)
						return false;
					pending.accepted = true;
					pendingUpgrades.delete(pending.socket);
					// HTTP's socket timeout must not close an otherwise healthy WebSocket.
					pending.incoming.socket.setTimeout(0);
					websocket.handleUpgrade(pending.incoming, pending.socket, pending.head, (socket: Ws.WebSocket) => {
						const ws: RuntimeServerWebSocket<T> = {
							data: upgradeOptions?.data as T,
							get readyState() {
								return socket.readyState;
							},
							remoteAddress: pending.incoming.socket.remoteAddress ?? "",
							send(data) {
								if (socket.readyState !== 1) return 0;
								touch();
								socket.send(data);
								return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
							},
							ping(data) {
								if (socket.readyState !== 1) return 0;
								touch();
								socket.ping(data);
								return typeof data === "string" ? Buffer.byteLength(data) : (data?.byteLength ?? 0);
							},
							close(code, reason) {
								socket.close(code, reason);
							},
							terminate() {
								socket.terminate();
							},
						};
						let idle: NodeJS.Timeout | undefined;
						const touch = () => {
							clearTimeout(idle);
							if (options.websocket?.idleTimeout) {
								idle = setTimeout(
									() => socket.close(1001, "Idle timeout"),
									options.websocket.idleTimeout * 1000,
								);
								idle.unref();
							}
						};
						socket.on("message", (data, binary) => {
							touch();
							options.websocket?.message?.(
								ws,
								binary
									? Buffer.isBuffer(data)
										? data
										: Array.isArray(data)
											? Buffer.concat(data)
											: Buffer.from(data)
									: data.toString(),
							);
						});
						socket.on("ping", data => {
							touch();
							options.websocket?.ping?.(ws, data);
						});
						socket.on("pong", data => {
							touch();
							options.websocket?.pong?.(ws, data);
						});
						socket.on("close", (code, reason) => {
							clearTimeout(idle);
							options.websocket?.close?.(ws, code, reason.toString());
						});
						socket.on("error", error => {
							if (options.websocket?.error) options.websocket.error(ws, error);
							else process.emitWarning(error);
						});
						touch();
						options.websocket?.open?.(ws);
					});
					return true;
				},
				stop(force) {
					if (!stopping) {
						const httpClosed = Promise.withResolvers<void>();
						const websocketClosed = Promise.withResolvers<void>();
						http.close(error => (error ? httpClosed.reject(error) : httpClosed.resolve()));
						if (websocket)
							websocket.close(error => (error ? websocketClosed.reject(error) : websocketClosed.resolve()));
						else websocketClosed.resolve();
						stopping = Promise.all([httpClosed.promise, websocketClosed.promise]).then(() => {});
						for (const socket of pendingUpgrades) socket.destroy();
						if (!force) for (const client of websocket?.clients ?? []) client.close(1001, "Server stopping");
					}
					if (force) {
						for (const client of websocket?.clients ?? []) client.terminate();
						for (const socket of connections) socket.destroy();
					}
					return stopping;
				},
				ref() {
					http.ref();
				},
				unref() {
					http.unref();
				},
			};
			resolve(adapter);
		},
	);
	return promise;
}

export interface RuntimeShellResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number;
	text(encoding?: BufferEncoding): string;
	json(): unknown;
}

export type RuntimeShellExpression = string | number | bigint | boolean | { raw: string } | RuntimeShellExpression[];

export interface RuntimeShellPromise extends PromiseLike<RuntimeShellResult> {
	cwd(value: string): this;
	env(value: Record<string, string | undefined> | undefined): this;
	quiet(value?: boolean): this;
	nothrow(): this;
	throws(value?: boolean): this;
	text(encoding?: BufferEncoding): Promise<string>;
	json(): Promise<unknown>;
}

class NodeShell implements RuntimeShellPromise {
	#cwd: string | undefined;
	#env: Record<string, string | undefined> | undefined;
	#quiet = false;
	#throws = true;
	#promise: Promise<RuntimeShellResult> | undefined;
	constructor(
		readonly command: string,
		readonly variables: Record<string, string>,
	) {}
	cwd(value: string): this {
		this.#cwd = value;
		return this;
	}
	env(value: Record<string, string | undefined> | undefined): this {
		this.#env = value;
		return this;
	}
	quiet(value = true): this {
		this.#quiet = value;
		return this;
	}
	nothrow(): this {
		this.#throws = false;
		return this;
	}
	throws(value = true): this {
		this.#throws = value;
		return this;
	}
	async text(encoding?: BufferEncoding): Promise<string> {
		this.quiet();
		return (await this).text(encoding);
	}
	async json(): Promise<unknown> {
		this.quiet();
		return (await this).json();
	}
	// oxlint-disable-next-line unicorn/no-thenable -- Tagged shell commands must preserve the awaitable shell API.
	then<T = RuntimeShellResult, E = never>(
		yes?: ((value: RuntimeShellResult) => T | PromiseLike<T>) | null,
		no?: ((error: unknown) => E | PromiseLike<E>) | null,
	): Promise<T | E> {
		this.#promise ??= this.#run();
		return this.#promise.then(yes, no);
	}
	async #run(): Promise<RuntimeShellResult> {
		const windows = process.platform === "win32";
		const argv = windows
			? [process.env.ComSpec ?? "cmd.exe", "/d", "/v:on", "/s", "/c", `"${this.command}"`]
			: ["/bin/sh", "-c", this.command];
		const proc = nodeProcess(argv, {
			cwd: this.#cwd,
			env: { ...(this.#env ?? process.env), ...this.variables },
			windowsVerbatimArguments: windows,
			stdin: "inherit",
			stdout: "pipe",
			stderr: "pipe",
		});
		const capture = async (stream: ReadableStream<Uint8Array>, destination: NodeJS.WriteStream): Promise<Buffer> => {
			const chunks: Buffer[] = [];
			for await (const chunk of stream) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
				if (!this.#quiet && !destination.write(chunk)) {
					const drained = Promise.withResolvers<void>();
					const cleanup = () => {
						destination.off("drain", drain);
						destination.off("error", fail);
						destination.off("close", close);
					};
					const drain = () => {
						cleanup();
						drained.resolve();
					};
					const fail = (error: Error) => {
						cleanup();
						drained.reject(error);
					};
					const close = () => fail(new Error("Shell output closed"));
					destination.once("drain", drain);
					destination.once("error", fail);
					destination.once("close", close);
					await drained.promise;
				}
			}
			return Buffer.concat(chunks);
		};
		const [stdout, stderr, exitCode] = await Promise.all([
			capture(proc.stdout!, process.stdout),
			capture(proc.stderr!, process.stderr),
			proc.exited,
		]).catch(error => {
			proc.kill();
			throw error;
		});
		const result: RuntimeShellResult = {
			stdout,
			stderr,
			exitCode,
			text: (encoding = "utf8") => stdout.toString(encoding),
			json: () => JSON.parse(stdout.toString()),
		};
		if (exitCode && this.#throws)
			throw Object.assign(new Error(`Shell command exited with code ${exitCode}`), result);
		return result;
	}
}

export function $(strings: TemplateStringsArray, ...values: RuntimeShellExpression[]): RuntimeShellPromise {
	if (bun) return bun.$(strings, ...values);
	const windows = process.platform === "win32";
	const variables: Record<string, string> = {};
	let command = "";
	let quoted: "'" | '"' | undefined;
	let escaped = false;
	let count = 0;
	const literal = (text: string): string => {
		for (const char of text) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === (windows ? "^" : "\\") && quoted !== "'") {
				escaped = true;
				continue;
			}
			if (char === quoted) quoted = undefined;
			else if (!quoted && (char === '"' || (!windows && char === "'"))) quoted = char;
		}
		return text;
	};
	const interpolate = (value: RuntimeShellExpression): string => {
		if (Array.isArray(value)) return value.map(interpolate).join(" ");
		if (typeof value === "object") return literal(value.raw);
		const key = `__OMP_SHELL_ARG_${count++}`;
		const text = String(value);
		// Values expand only after the shell parses its syntax, even inside quotes.
		// Never embed untrusted text in the command language.
		variables[key] = windows ? text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") : text;
		if (windows) return quoted === '"' ? `!${key}!` : `"!${key}!"`;
		const reference = `\${${key}}`;
		return quoted === "'" ? `'"${reference}"'` : quoted === '"' ? reference : `"${reference}"`;
	};
	for (let i = 0; i < strings.length; i++) {
		command += literal(strings[i]!);
		if (i < values.length) command += interpolate(values[i]!);
	}
	return new NodeShell(command, variables);
}
export const shell = $;
