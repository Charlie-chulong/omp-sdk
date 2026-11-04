import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// This fixture is intentionally executable by plain Node: no Bun imports or globals.
assert.equal(typeof globalThis.Bun, "undefined");
const root = process.cwd();
if (process.argv.includes("--terminal")) {
	assert.equal(process.env.DAP_FIXTURE_ENV, "terminal-env-value");
	assert.equal(path.basename(root), "terminal cwd");
	await fs.writeFile(path.join(root, "terminal.json"), JSON.stringify({ pid: process.pid, cwd: root }));
	process.stdout.write("terminal stdout: café 世界\n");
	// Stay alive until the adapter has validated the runInTerminal processId.
	const deadline = Date.now() + 5_000;
	while (
		!(await fs.access(path.join(root, "terminal-ack")).then(
			() => true,
			() => false,
		))
	) {
		assert.ok(Date.now() < deadline, "adapter did not acknowledge the terminal child");
		await delay(20);
	}
	process.exit(0);
}

const mode = process.argv.find(arg => arg.startsWith("--mode="))?.slice(7) ?? "stdio";
const behavior = process.argv.find(arg => arg.startsWith("--behavior="))?.slice(11) ?? "lifecycle";
const unixPath = process.argv.find(arg => arg.startsWith("--listen=unix:"))?.slice(14);
const clientAddr = process.argv.find(arg => arg.startsWith("--client-addr="))?.slice(14);
const port = Number(process.argv.find(arg => arg.startsWith("--port="))?.slice(7));
await fs.writeFile(
	path.join(root, "adapter.json"),
	JSON.stringify({ pid: process.pid, mode, unixPath, clientAddr, port }),
);
const watchdog = setTimeout(() => process.exit(91), 20_000);
let server;
let socket;
async function cleanup() {
	clearTimeout(watchdog);
	socket?.destroy();
	server?.close();
	if (unixPath) await fs.rm(unixPath, { force: true });
}
process.on("SIGTERM", () => void cleanup().finally(() => process.exit(0)));
process.on("SIGINT", () => void cleanup().finally(() => process.exit(0)));
if (behavior === "early-exit") {
	process.stderr.write("fixture adapter exited before initialization\n");
	process.exit(23);
}
if (behavior === "no-callback") {
	// Do not open the Unix socket or connect to the reverse TCP listener.
	await delay(19_000);
	process.exit(92);
}

let sequence = 100;
let writeQueue = Promise.resolve();
let writer;
let launch;
let configured = false;
let terminalStarted = false;
let terminalPid;
let finished = false;
let program;
const commands = [];
function send(message) {
	const body = Buffer.from(JSON.stringify({ seq: ++sequence, ...message }));
	const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
	// Exercise fragmented headers/body and UTF-8 payloads over every real transport.
	writeQueue = writeQueue.then(async () => {
		writer.write(frame.subarray(0, 11));
		await delay(1);
		const { promise, resolve, reject } = Promise.withResolvers();
		writer.write(frame.subarray(11), error => (error ? reject(error) : resolve()));
		await promise;
	});
	return writeQueue;
}
function respond(request, body = {}) {
	return send({ type: "response", request_seq: request.seq, command: request.command, success: true, body });
}
function event(name, body = {}) {
	return send({ type: "event", event: name, body });
}
async function finishLaunch() {
	if (!launch || !configured || !terminalStarted || finished) return;
	finished = true;
	await respond(launch);
	await event("output", { category: "stdout", output: `adapter ${mode}: café 世界\n` });
	await event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
}
async function handle(message) {
	if (message.type === "response") {
		assert.equal(message.request_seq, 90_000);
		assert.equal(message.command, "runInTerminal");
		assert.equal(message.success, true, JSON.stringify(message));
		terminalPid = message.body.processId;
		assert.ok(Number.isInteger(terminalPid) && terminalPid > 0);
		process.kill(terminalPid, 0);
		await fs.writeFile(path.join(root, "terminal cwd", "terminal-ack"), "");
		terminalStarted = true;
		await finishLaunch();
		return;
	}
	assert.equal(message.type, "request");
	commands.push(message.command);
	switch (message.command) {
		case "initialize":
			assert.equal(message.arguments.supportsRunInTerminalRequest, true);
			await respond(message, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
			await event("initialized");
			break;
		case "launch":
			launch = message;
			program = message.arguments.program;
			assert.deepEqual(message.arguments.args, ["argument with spaces", "世界"]);
			await send({
				seq: 90_000,
				type: "request",
				command: "runInTerminal",
				arguments: {
					kind: "integrated",
					cwd: "terminal cwd",
					args: [process.execPath, fileURLToPath(import.meta.url), "--terminal"],
					env: { DAP_FIXTURE_ENV: "terminal-env-value", DAP_FIXTURE_IGNORED: null },
				},
			});
			break;
		case "configurationDone":
			configured = true;
			await respond(message);
			await finishLaunch();
			break;
		case "threads":
			await respond(message, { threads: [{ id: 1, name: "fixture main" }] });
			break;
		case "stackTrace":
			assert.equal(message.arguments.threadId, 1);
			await respond(message, {
				stackFrames: [{ id: 17, name: "fixtureMain", source: { path: program }, line: 7, column: 3 }],
				totalFrames: 1,
			});
			break;
		case "evaluate":
			assert.equal(message.arguments.frameId, 17);
			if (message.arguments.expression === "missing") {
				await send({
					type: "response",
					request_seq: message.seq,
					command: "evaluate",
					success: false,
					message: "fixture unknown expression: missing",
				});
			} else {
				assert.equal(message.arguments.expression, "answer + 1");
				await respond(message, { result: "42", type: "number", variablesReference: 0 });
			}
			break;
		case "fixtureState":
			await respond(message, {
				pid: process.pid,
				terminalPid,
				configured,
				commands,
				mode,
				unixPath,
				clientAddr,
				port,
			});
			break;
		case "terminate":
			await respond(message);
			break;
		case "disconnect":
			assert.equal(message.arguments.terminateDebuggee, true);
			await fs.writeFile(path.join(root, "disconnected.json"), JSON.stringify({ commands, terminalPid }));
			await respond(message);
			await cleanup();
			process.exit(0);
			break;
		default:
			throw new Error(`Unexpected DAP command: ${message.command}`);
	}
}
function connect(readable, writable) {
	writer = writable;
	let buffer = Buffer.alloc(0);
	let work = Promise.resolve();
	readable.on("data", chunk => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = buffer.subarray(0, headerEnd).toString("ascii");
			const match = /^Content-Length: (\d+)$/im.exec(header);
			assert.ok(match, header);
			const length = Number(match[1]);
			if (buffer.length < headerEnd + 4 + length) return;
			const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
			buffer = buffer.subarray(headerEnd + 4 + length);
			work = work
				.then(() => handle(message))
				.catch(error => {
					process.stderr.write(`${error.stack}\n`);
					process.exit(93);
				});
		}
	});
	readable.on("error", error => {
		process.stderr.write(`${error.stack}\n`);
		process.exit(94);
	});
}
if (mode === "stdio") {
	connect(process.stdin, process.stdout);
} else if (mode === "socket" && clientAddr) {
	const separator = clientAddr.lastIndexOf(":");
	socket = net.createConnection({
		host: clientAddr.slice(0, separator),
		port: Number(clientAddr.slice(separator + 1)),
	});
	connect(socket, socket);
} else {
	assert.ok(mode === "tcp" ? port > 0 : unixPath);
	server = net.createServer(connection => {
		assert.equal(socket, undefined, "only one DAP connection is expected");
		socket = connection;
		connect(connection, connection);
	});
	server.on("error", error => {
		process.stderr.write(`${error.stack}\n`);
		process.exit(95);
	});
	server.listen(mode === "tcp" ? { host: "127.0.0.1", port } : { path: unixPath }, () => {
		if (mode === "tcp") process.stdout.write(`DAP fixture listening on ${port}\n`);
	});
}
