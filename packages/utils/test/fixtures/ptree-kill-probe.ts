import { mock } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as nativeModule from "@oh-my-pi/pi-natives";
import type { Process } from "@oh-my-pi/pi-natives";
import { spawn, TimeoutError } from "../../src/ptree";

const actualNative = { ...nativeModule };
const { ProcessStatus } = actualNative;
const nativeFromPid = actualNative.Process.fromPid.bind(actualNative.Process);
let lookupProcess = nativeFromPid;

// NAPI methods can be read-only. Replace this probe's isolated module binding,
// retaining real handles and native behavior for every uncontrolled lookup.
class ProbeProcess {
	static fromPid(pid: number) {
		return lookupProcess(pid);
	}
}
mock.module("@oh-my-pi/pi-natives", () => ({ ...actualNative, Process: ProbeProcess }));

const STUBBORN_CHILD = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';

async function checkNativeHandleFailure(mode: "lookup-throws" | "termination-rejects"): Promise<void> {
	using child = spawn([process.execPath, "-e", STUBBORN_CHILD]);
	try {
		const reader = child.stdout.getReader();
		try {
			const ready = await reader.read();
			assert.equal(new TextDecoder().decode(ready.value).trim(), "ready");
		} finally {
			reader.releaseLock();
		}
		// Fault injection belongs to this probe's own process and its one child.
		lookupProcess = pid => {
			if (pid !== child.pid) return nativeFromPid(pid);
			if (mode === "lookup-throws") throw new Error("Value is not an instance of class `Process`");
			return { terminate: () => Promise.reject(new Error("terminate failed")) } as unknown as Process;
		};
		child.kill(undefined, 50);
		await child.exited;
		assert.equal(child.proc.signalCode, "SIGKILL");
	} finally {
		lookupProcess = nativeFromPid;
		child.kill();
		await child.proc.exited;
	}
}

async function checkSubreaperRace(testRoot: string): Promise<void> {
	const pidFile = path.join(testRoot, "ready.json");
	const controller = new AbortController();
	using child = spawn([process.execPath, import.meta.path, "subreaper-command", pidFile], {
		signal: controller.signal,
		subreaper: true,
	});
	const cleanupProcesses: Process[] = [];
	try {
		const subreaper = nativeFromPid(child.pid);
		assert.ok(subreaper, "the supervisor must be a real process");
		cleanupProcesses.push(subreaper);
		// The worker publishes its own identity only after detached spawn has completed.
		// The atomic rename keeps a partial readiness record invisible to the reader.
		const pidFileExists = () =>
			fs.stat(pidFile).then(
				() => true,
				error => {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
					throw error;
				},
			);
		const setupDeadline = Date.now() + 2_000;
		while (!(await pidFileExists()) && Date.now() < setupDeadline) await Bun.sleep(10);
		assert.ok(await pidFileExists(), `the worker must publish readiness; stderr: ${child.peekStderr()}`);
		const ready: unknown = await Bun.file(pidFile).json();
		assert.ok(ready !== null && typeof ready === "object" && "commandPid" in ready && "workerPid" in ready);
		assert.ok(typeof ready.commandPid === "number" && typeof ready.workerPid === "number");
		const command = nativeFromPid(ready.commandPid);
		const worker = nativeFromPid(ready.workerPid);
		assert.ok(command, "the reported command must be a real process");
		assert.ok(worker, "the ready worker must be a real process");
		cleanupProcesses.push(command, worker);
		assert.equal(command.ppid, subreaper.pid, "the command must belong to the supervisor");
		assert.ok(
			subreaper.children().some(process => process.pid === command.pid),
			"the supervisor must enumerate its command",
		);
		assert.equal(worker.ppid, command.pid, "the worker must initially belong to the supervised command");
		assert.equal(worker.groupId(), worker.pid, "the worker must have escaped the command's process group");

		const killOnly = (pid: number): number => {
			try {
				process.kill(pid, "SIGKILL");
				return 1;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ESRCH") return 0;
				throw error;
			}
		};
		const commandSnapshot = { killTree: () => killOnly(command.pid) } as unknown as Process;
		const pendingAdoption = { killTree: () => 0 } as unknown as Process;
		let snapshots = 0;
		let observedAdoption = false;
		const controlledSubreaper = {
			children: (): Process[] => {
				snapshots++;
				if (snapshots === 1) return [commandSnapshot];
				if (subreaper.status() !== ProcessStatus.Running || worker.status() !== ProcessStatus.Running) return [];
				if (worker.ppid !== subreaper.pid) return [pendingAdoption];
				observedAdoption = true;
				return [worker];
			},
			killTree: () => killOnly(subreaper.pid),
			terminate: () => Promise.resolve(killOnly(subreaper.pid) > 0),
		} as unknown as Process;
		lookupProcess = pid => (pid === child.pid ? controlledSubreaper : nativeFromPid(pid));
		child.kill(new TimeoutError(1, ""), -1);
		controller.abort("concurrent abort");

		// No stream cutoff timer is attached: wait must see real EOF on both inherited pipes.
		const result = await child.wait({ allowAbort: true });
		assert.ok(result.exitError instanceof TimeoutError);
		assert.ok(observedAdoption, "the worker must reparent to the live subreaper during cleanup");
		for (const handle of [worker, command, subreaper]) {
			assert.notEqual(handle.status(), ProcessStatus.Running, `process ${handle.pid} survived cleanup`);
		}
	} finally {
		lookupProcess = nativeFromPid;
		for (const handle of cleanupProcesses.reverse()) handle.killTree(9);
		child.kill();
		await child.proc.exited;
	}
}

const mode = process.argv[2];
switch (mode) {
	case "lookup-throws":
	case "termination-rejects":
		await checkNativeHandleFailure(mode);
		break;
	case "subreaper-race": {
		const testRoot = process.argv[3];
		if (!testRoot) throw new Error("Missing subreaper probe directory");
		await checkSubreaperRace(testRoot);
		break;
	}
	case "subreaper-command": {
		const pidFile = process.argv[3];
		if (!pidFile) throw new Error("Missing worker readiness path");
		const worker = Bun.spawn([process.execPath, import.meta.path, "subreaper-worker", pidFile], {
			detached: true,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
		process.exitCode = await worker.exited;
		break;
	}
	case "subreaper-worker": {
		const pidFile = process.argv[3];
		if (!pidFile) throw new Error("Missing worker readiness path");
		await Bun.write(`${pidFile}.tmp`, JSON.stringify({ commandPid: process.ppid, workerPid: process.pid }));
		await fs.rename(`${pidFile}.tmp`, pidFile);
		// Only the tested timeout sweep or explicit failure cleanup may stop this worker.
		setInterval(() => {}, 1_000);
		break;
	}
	default:
		throw new Error(`Unknown process-tree probe mode: ${mode}`);
}
