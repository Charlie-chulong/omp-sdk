import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}
async function waitUntil(predicate, message) {
	const deadline = Date.now() + 3_000;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, message);
		await delay(20);
	}
}
async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function runDebugScenario(BUILTIN_TOOLS, Settings, mode, behavior) {
	assert.equal(typeof globalThis.Bun, "undefined", "must execute in real Node without a Bun shim");
	const root = process.cwd();
	const adapter = fileURLToPath(new URL("./dap-node-adapter.mjs", import.meta.url));
	const program = path.join(root, "target.fixture");
	await fs.writeFile(program, "deterministic DAP debug target\n");
	await fs.mkdir(path.join(root, "terminal cwd"));
	await fs.writeFile(
		path.join(root, "dap.json"),
		JSON.stringify({
			adapters: {
				"node-fixture": {
					command: process.execPath,
					args: [
						adapter,
						`--mode=${mode}`,
						`--behavior=${behavior}`,
						...(mode === "tcp" ? ["--port=${port}"] : []),
					],
					connectMode: mode,
					fileTypes: [".fixture"],
				},
			},
		}),
	);
	const tool = await BUILTIN_TOOLS.debug({
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "debug.enabled": true }),
	});
	assert.ok(tool, "explicit debug.enabled must create the debug tool under Node");
	const call = (action, params = {}) => tool.execute("node-dap-regression", { action, timeout: 3, ...params });
	try {
		if (behavior !== "lifecycle") {
			const started = Date.now();
			await assert.rejects(
				call("launch", { adapter: "node-fixture", program, args: ["argument with spaces", "世界"] }),
				behavior === "early-exit"
					? /exited before connecting|(?:adapter|process).*exited|connection closed/i
					: /timed out|timeout|did not connect|not ready after/i,
			);
			assert.ok(Date.now() - started < 15_000, "transport failure must have a bounded deadline");
			const { pid } = await readJson(path.join(root, "adapter.json"));
			await waitUntil(() => !isAlive(pid), `failed ${mode} adapter ${pid} leaked`);
			assert.deepEqual((await call("sessions")).details.sessions, []);
			process.stdout.write(`${JSON.stringify({ mode, behavior, cleaned: true })}\n`);
			return;
		}

		const launched = (
			await call("launch", { adapter: "node-fixture", program, args: ["argument with spaces", "世界"] })
		).details;
		assert.equal(launched.success, true);
		assert.equal(launched.snapshot.status, "stopped");
		assert.equal(launched.snapshot.stopReason, "entry");
		assert.equal(launched.snapshot.frameId, 17);
		assert.equal(launched.snapshot.line, 7);
		assert.equal(launched.snapshot.source.path, program);
		assert.equal(launched.snapshot.needsConfigurationDone, false);
		const stack = (await call("stack_trace", { levels: 5 })).details;
		assert.equal(stack.stackFrames.length, 1);
		assert.equal(stack.stackFrames[0].name, "fixtureMain");
		assert.equal(stack.stackFrames[0].id, 17);
		const evaluation = (await call("evaluate", { expression: "answer + 1", context: "watch" })).details;
		assert.deepEqual(evaluation.evaluation, { result: "42", type: "number", variablesReference: 0 });
		await assert.rejects(call("evaluate", { expression: "missing" }), /fixture unknown expression: missing/);
		const state = (await call("custom_request", { command: "fixtureState" })).details.customBody;
		assert.equal(state.mode, mode);
		assert.equal(state.configured, true);
		assert.ok(state.commands.includes("configurationDone"));
		assert.ok(state.commands.includes("stackTrace"));
		assert.ok(isAlive(state.pid), "adapter must remain alive while stopped");
		if (mode === "tcp") assert.ok(state.port > 0);
		if (mode === "socket") {
			if (process.platform === "linux") assert.ok(state.unixPath?.startsWith("/tmp/dap-"));
			else assert.match(state.clientAddr, /^127\.0\.0\.1:\d+$/);
		}
		await waitUntil(
			async () => (await call("output")).details.output.includes("terminal stdout: café 世界"),
			"runInTerminal stdout was not captured",
		);
		const output = (await call("output")).details;
		assert.ok(output.output.includes(`adapter ${mode}: café 世界`));
		assert.ok(output.snapshot.outputBytes >= Buffer.byteLength(output.output));
		const terminal = await readJson(path.join(root, "terminal cwd", "terminal.json"));
		assert.equal(terminal.pid, state.terminalPid, "reverse response must carry the real terminal child PID");
		assert.equal(terminal.cwd, path.join(root, "terminal cwd"));
		await waitUntil(() => !isAlive(terminal.pid), `terminal child ${terminal.pid} leaked`);
		await call("terminate");
		await waitUntil(() => !isAlive(state.pid), `terminated ${mode} adapter ${state.pid} leaked`);
		const disconnected = await readJson(path.join(root, "disconnected.json"));
		assert.ok(disconnected.commands.includes("terminate"));
		assert.ok(disconnected.commands.includes("disconnect"));
		assert.deepEqual((await call("sessions")).details.sessions, []);
		process.stdout.write(`${JSON.stringify({ mode, behavior, cleaned: true, output: output.output })}\n`);
	} finally {
		await call("terminate").catch(() => {});
		for (const file of ["adapter.json", path.join("terminal cwd", "terminal.json")]) {
			const record = await readJson(path.join(root, file)).catch(() => null);
			if (record?.pid && isAlive(record.pid)) {
				try {
					process.kill(record.pid, "SIGKILL");
				} catch {}
			}
			if (record?.unixPath) await fs.rm(record.unixPath, { force: true });
		}
	}
}
