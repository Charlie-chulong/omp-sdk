import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type * as Ws from "ws";
import { $, serve, spawn, spawnSync } from "../../src/runtime-process";
import { NodeRuntimeFile } from "../../src/runtime-file";

if (process.argv[2] === "unref-probe") {
	const child = spawn([process.execPath, "-e", "process.on('message', () => {}); setInterval(() => {}, 1000)"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		ipc() {},
		timeout: 30_000,
	});
	child.unref();
	process.stdout.write(`${child.pid}\n`);
} else if (process.argv[2] === "ref-probe") {
	const child = spawn([process.execPath, "-e", "setTimeout(() => process.stdout.write('done'), 100)"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	child.unref();
	child.ref();
	process.stdout.write(await new Response(child.stdout).text());
	await child.exited;
} else if (process.argv[2] === "stdin-probe") {
	const reader = new NodeRuntimeFile(0).stream().getReader();
	void reader.read();
	assert.throws(() => new NodeRuntimeFile(0).stream().getReader(), TypeError);
	setTimeout(() => process.exit(7), 25);
} else {
	// CLI ref/unref probes must not initialize node:test's harness or its handles.
	const { test } = await import("node:test");
	assert.equal(typeof Bun, "undefined");
	assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node 24+ is required");

	test("retains exclusive RPC stdin ownership without blocking process shutdown", { timeout: 5_000 }, async () => {
		const child = spawn([process.execPath, fileURLToPath(import.meta.url), "stdin-probe"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const deadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
		try {
			const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			assert.equal(code, 7, `RPC stdin blocked shutdown or lost exclusive ownership: ${errors}`);
		} finally {
			clearTimeout(deadline);
			child.kill("SIGKILL");
		}
	});

	test("drains both streams and feeds backpressured stdin completely", { timeout: 10_000 }, async () => {
		const size = 2 * 1024 * 1024;
		const child = spawn(
			[
				process.execPath,
				"-e",
				"process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.stderr.write('final stderr'))",
			],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		try {
			const output = new Response(child.stdout).arrayBuffer();
			const errors = new Response(child.stderr).text();
			const write = child.stdin.write(new Uint8Array(size).fill(97));
			assert.equal(typeof write, "object", "large writes apply backpressure");
			assert.equal(await write, size);
			await child.stdin.flush();
			await child.stdin.write("tail");
			await child.stdin.end();
			assert.equal(await child.exited, 0);
			const bytes = Buffer.from(await output);
			assert.equal(bytes.length, size + 4);
			assert.equal(
				bytes.subarray(0, size).every(byte => byte === 97),
				true,
			);
			assert.equal(bytes.subarray(size).toString(), "tail");
			assert.equal(await errors, "final stderr");
			assert.throws(() => child.stdin.write("late"));
		} finally {
			child.kill("SIGKILL");
		}
	});

	test("streams Blob input and cancels an unfinished producer on child exit", { timeout: 5_000 }, async () => {
		const bytes = new Uint8Array(256 * 1024).fill(42);
		const child = spawn([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], {
			stdin: new Blob([bytes]),
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			assert.deepEqual(Buffer.from(await new Response(child.stdout).arrayBuffer()), Buffer.from(bytes));
			assert.equal(await child.exited, 0);
		} finally {
			child.kill("SIGKILL");
		}
		const cancelled = Promise.withResolvers<void>();
		const source = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise<void>(() => {});
			},
			cancel() {
				cancelled.resolve();
			},
		});
		const early = spawn([process.execPath, "-e", "process.exit(0)"], {
			stdin: source,
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			assert.equal(await early.exited, 0);
			await cancelled.promise;
		} finally {
			early.kill("SIGKILL");
		}
	});

	test("stdio overrides stdin data in both asynchronous and synchronous spawn", { timeout: 5_000 }, async () => {
		const child = spawn<"pipe" | Uint8Array, "pipe", "pipe">(
			[process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
			{ stdio: ["pipe", "pipe", "pipe"], stdin: Buffer.from("ignored") },
		);
		try {
			assert.ok(child.stdin && typeof child.stdin !== "number");
			await child.stdin.write("manual");
			await child.stdin.end();
			assert.equal(await new Response(child.stdout).text(), "manual");
			assert.equal(await child.exited, 0);
		} finally {
			child.kill("SIGKILL");
		}
		const sync = spawnSync<"pipe" | Uint8Array, "pipe", "pipe">(
			[process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
			{ stdio: ["pipe", "pipe", "pipe"], stdin: Buffer.from("ignored") },
		);
		assert.equal(sync.stdout.toString(), "");
	});

	test("preserves advanced IPC and waits for actual exit after disconnect", { timeout: 5_000 }, async () => {
		const reply = Promise.withResolvers<unknown>();
		const child = spawn(
			[process.execPath, "-e", "process.on('message', value => process.send(value, () => process.disconnect()))"],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				ipc(message) {
					reply.resolve(message);
				},
			},
		);
		try {
			const value = { count: 3n, bytes: Buffer.from([0, 255]), map: new Map([["key", 2]]) };
			child.send(value);
			assert.deepEqual(await reply.promise, value);
			assert.equal(await child.exited, 0);
			assert.throws(() => child.send("late"), /closed/);
			child.disconnect();
		} finally {
			child.kill("SIGKILL");
		}
	});

	test("supplies Electron run-as-Node only for its own executable", { timeout: 5_000 }, async () => {
		const original = Object.getOwnPropertyDescriptor(process.versions, "electron");
		Object.defineProperty(process.versions, "electron", { value: "probe", configurable: true });
		try {
			const script = "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? 'missing')";
			const child = spawn([process.execPath, "-e", script], { env: {}, stdout: "pipe", stderr: "pipe" });
			try {
				assert.equal(await new Response(child.stdout).text(), "1");
				assert.equal(await child.exited, 0);
			} finally {
				child.kill("SIGKILL");
			}
			assert.equal(
				spawnSync([process.execPath, "-e", script], { env: { ELECTRON_RUN_AS_NODE: "0" } }).stdout.toString(),
				"0",
			);
		} finally {
			if (original) Object.defineProperty(process.versions, "electron", original);
			else Reflect.deleteProperty(process.versions, "electron");
		}
	});

	test("aborts with the chosen signal and rejects spawn failure once", { timeout: 5_000 }, async () => {
		const controller = new AbortController();
		const child = spawn([process.execPath, "-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
			killSignal: "SIGKILL",
		});
		try {
			const reader = child.stdout.getReader();
			assert.equal(Buffer.from((await reader.read()).value!).toString(), "ready");
			controller.abort();
			assert.equal(await child.exited, 137);
			assert.equal(child.signalCode, "SIGKILL");
			reader.releaseLock();
		} finally {
			child.kill("SIGKILL");
		}
		let calls = 0;
		const missing = spawn([path.join(os.tmpdir(), `omp-missing-command-${process.pid}`)], {
			stdout: "pipe",
			stderr: "pipe",
			onExit(_child, _code, _signal, error) {
				calls++;
				assert.ok(error);
			},
		});
		await assert.rejects(missing.exited, { code: "ENOENT" });
		assert.equal(calls, 1);
	});

	test("ref and unref cover pipes, IPC and the timeout handle", { timeout: 5_000 }, async () => {
		const script = fileURLToPath(import.meta.url);
		const unref = spawn([process.execPath, script, "unref-probe"], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 2_000,
		});
		let detachedPid = 0;
		try {
			detachedPid = Number((await new Response(unref.stdout).text()).trim());
			assert.equal(await unref.exited, 0);
			assert.ok(detachedPid > 0);
		} finally {
			unref.kill("SIGKILL");
			if (detachedPid) process.kill(detachedPid, "SIGKILL");
		}
		const ref = spawn([process.execPath, script, "ref-probe"], { stdout: "pipe", stderr: "pipe", timeout: 2_000 });
		try {
			assert.equal(await new Response(ref.stdout).text(), "done");
			assert.equal(await ref.exited, 0);
		} finally {
			ref.kill("SIGKILL");
		}
	});

	test("implements the used shell chain without interpolation execution", { timeout: 5_000 }, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-probe-"));
		try {
			const attack = `a'"; $(touch ${path.join(directory, "injected")}) \`touch ${path.join(directory, "injected")}\` & | $HOME %PATH% !PATH!`;
			const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
			assert.deepEqual(
				await $`${process.execPath} -e ${script} ${attack} "${attack}" ${["one two", "three'four"]}`.json(),
				[attack, attack, "one two", "three'four"],
			);
			if (process.platform !== "win32")
				assert.deepEqual(await $`${process.execPath} -e ${script} '${attack}'`.json(), [attack]);
			await assert.rejects(fs.stat(path.join(directory, "injected")), { code: "ENOENT" });
			const result =
				await $`${process.execPath} -e ${"process.stdout.write(JSON.stringify([process.cwd(), process.env.OMP_SHELL_PROBE])); process.stderr.write('failure'); process.exitCode = 7"}`
					.cwd(directory)
					.env({ ...process.env, OMP_SHELL_PROBE: "present" })
					.quiet()
					.nothrow();
			assert.deepEqual(result.json(), [await fs.realpath(directory), "present"]);
			assert.equal(result.stderr.toString(), "failure");
			assert.equal(result.exitCode, 7);
			assert.equal(await $`${process.execPath} -e ${"process.stdout.write('text')"}`.text(), "text");
			await assert.rejects(Promise.resolve($`${process.execPath} -e ${"process.exit(9)"}`.quiet()), { exitCode: 9 });
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("streams HTTP uploads, preserves cookies and cancels HEAD bodies", { timeout: 5_000 }, async () => {
		const headCancelled = Promise.withResolvers<void>();
		const server = await serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request, adapter) {
				assert.equal(adapter.requestIP(request)?.address, "127.0.0.1");
				if (request.method === "HEAD")
					return new Response(
						new ReadableStream({
							cancel() {
								headCancelled.resolve();
							},
						}),
					);
				return new Response(await request.arrayBuffer(), {
					headers: [
						["set-cookie", "one=1"],
						["set-cookie", "two=2"],
					],
				});
			},
		});
		try {
			const response = await fetch(server.url, { method: "POST", body: new Uint8Array(256 * 1024).fill(35) });
			assert.equal((await response.arrayBuffer()).byteLength, 256 * 1024);
			assert.deepEqual(response.headers.getSetCookie(), ["one=1", "two=2"]);
			assert.equal((await fetch(server.url, { method: "HEAD" })).status, 200);
			await headCancelled.promise;
		} finally {
			await server.stop(true);
		}
	});

	test("per-request timeout zero keeps SSE alive and client abort cancels its body", { timeout: 5_000 }, async () => {
		const aborted = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		let didAbort = false;
		const server = await serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0.03,
			fetch(request, adapter) {
				adapter.timeout(request, 0);
				request.signal.addEventListener(
					"abort",
					() => {
						didAbort = true;
						aborted.resolve();
					},
					{ once: true },
				);
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(Buffer.from("ready\n"));
						},
						cancel() {
							cancelled.resolve();
						},
					}),
				);
			},
		});
		try {
			const controller = new AbortController();
			const response = await fetch(server.url, { signal: controller.signal });
			const reader = response.body!.getReader();
			assert.equal(Buffer.from((await reader.read()).value!).toString(), "ready\n");
			await delay(120);
			assert.equal(didAbort, false);
			controller.abort();
			await Promise.all([aborted.promise, cancelled.promise]);
			reader.releaseLock();
		} finally {
			await server.stop(true);
		}
	});

	test("per-request nonzero timeout aborts and cancels a stalled response", { timeout: 5_000 }, async () => {
		const cancelled = Promise.withResolvers<void>();
		const server = await serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch(request, adapter) {
				adapter.timeout(request, 0.05);
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(Buffer.from("ready"));
						},
						cancel() {
							cancelled.resolve();
						},
					}),
				);
			},
		});
		try {
			const response = await fetch(server.url);
			await assert.rejects(response.text());
			await cancelled.promise;
		} finally {
			await server.stop(true);
		}
	});

	test("WebSockets outlive the HTTP timeout, echo bytes and await graceful shutdown", { timeout: 5_000 }, async () => {
		const { WebSocket } = createRequire(import.meta.url)("ws") as typeof Ws;
		const aborted = Promise.withResolvers<void>();
		const server = await serve<{ value: number }>({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0.03,
			fetch(request, adapter) {
				request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				if (adapter.upgrade(request, { data: { value: 7 } })) return undefined;
				return new Response("rejected", { status: 400 });
			},
			websocket: {
				message(socket, message) {
					assert.equal(socket.data.value, 7);
					socket.send(message);
				},
			},
		});
		const client = new WebSocket(new URL("/", server.url).href.replace("http:", "ws:"));
		try {
			await once(client, "open");
			await delay(120);
			const text = once(client, "message");
			client.send("hello");
			assert.equal((await text)[0].toString(), "hello");
			const binary = once(client, "message");
			client.send(Buffer.from([0, 255]));
			assert.deepEqual((await binary)[0], Buffer.from([0, 255]));
			const closed = once(client, "close");
			const stopping = server.stop();
			assert.equal((await closed)[0], 1001);
			await Promise.all([stopping, aborted.promise]);
		} finally {
			client.terminate();
			await server.stop(true);
		}
	});

	test("rejects invalid upgrades as regular HTTP and force-closes pending upgrades", { timeout: 5_000 }, async () => {
		const pending = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const server = await serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, adapter) {
				if (new URL(request.url).pathname === "/pending") {
					request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					pending.resolve();
					return new Promise<Response>(() => {});
				}
				assert.equal(adapter.upgrade(request), false);
				return new Response("rejected", {
					status: 401,
					headers: { "content-length": "8", "set-cookie": "denied=1" },
				});
			},
			websocket: {},
		});
		try {
			const request = httpRequest(server.url, {
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-key": "invalid",
					"sec-websocket-version": "13",
				},
			});
			const received = once(request, "response");
			request.end();
			const [response] = await received;
			const chunks: Buffer[] = [];
			for await (const chunk of response) chunks.push(chunk);
			assert.equal(response.statusCode, 401);
			assert.equal(Buffer.concat(chunks).toString(), "rejected");
			assert.deepEqual(response.headers["set-cookie"], ["denied=1"]);
			const socket = connect(server.port, "127.0.0.1");
			try {
				await once(socket, "connect");
				socket.write(
					"GET /pending HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
				);
				await pending.promise;
				const closed = once(socket, "close");
				await server.stop(true);
				await Promise.all([aborted.promise, closed]);
			} finally {
				socket.destroy();
			}
		} finally {
			await server.stop(true);
		}
	});
}
