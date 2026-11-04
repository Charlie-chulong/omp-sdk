import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const probe = new URL("../fixtures/dap-node-runtime-probe.mjs", import.meta.url).href;

interface FixtureProcess {
	pid: number;
	unixPath?: string;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

// Also clean detached adapters when the Node probe itself times out or fails an assertion.
async function cleanupFixtures(root: TempDir): Promise<void> {
	for (const file of [root.join("adapter.json"), root.join("terminal cwd", "terminal.json")]) {
		let record: FixtureProcess;
		try {
			record = JSON.parse(await fs.promises.readFile(file, "utf8")) as FixtureProcess;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (isAlive(record.pid)) {
			try {
				process.kill(record.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			const deadline = Date.now() + 2_000;
			while (isAlive(record.pid) && Date.now() < deadline) await delay(20);
		}
		if (record.unixPath) await fs.promises.rm(record.unixPath, { force: true });
	}
}

// Build artifacts beforehand with gen:bundle:node / gen:bundle:desktop, just like
// node-rpc-tools.test.ts. Never bundle a test-only implementation of the DAP client.
for (const artifact of ["node", "node-desktop"]) {
	const entry = path.join(packageDir, "dist", artifact, "sdk.mjs");
	describe.skipIf(!fs.existsSync(entry))(`${artifact} DAP lifecycle in real Node`, () => {
		for (const mode of ["stdio", "tcp", "socket"]) {
			for (const behavior of ["lifecycle", "early-exit", ...(mode === "socket" ? ["no-callback"] : [])]) {
				const name =
					behavior === "lifecycle"
						? `${mode}: launches, handles runInTerminal, inspects state and terminates without leaked processes`
						: `${mode}: cleans up after ${behavior}`;
				test(
					name,
					async () => {
						using root = TempDir.createSync("@node-dap-runtime-");
						const source = `
import { BUILTIN_TOOLS, Settings } from ${JSON.stringify(pathToFileURL(entry).href)};
import { runDebugScenario } from ${JSON.stringify(probe)};
await runDebugScenario(BUILTIN_TOOLS, Settings, ${JSON.stringify(mode)}, ${JSON.stringify(behavior)});`;
						try {
							const result = await ptree.exec(["node", "--input-type=module", "-e", source], {
								cwd: root.path(),
								env: {
									...process.env,
									HOME: root.path(),
									USERPROFILE: root.path(),
									PI_CONFIG_DIR: ".omp",
									PI_CODING_AGENT_DIR: root.join("agent"),
									PI_PROFILE: "",
									XDG_DATA_HOME: root.join("data"),
									XDG_STATE_HOME: root.join("state"),
									XDG_CACHE_HOME: root.join("cache"),
									OMP_PLUGIN_DIR: "",
									OMP_MARKETPLACE_DIR: "",
									NO_COLOR: "1",
								},
								timeout: 18_000,
								allowNonZero: true,
								allowAbort: true,
							});
							expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
							const report = JSON.parse(result.stdout);
							expect(report).toMatchObject({ mode, behavior, cleaned: true });
							if (behavior === "lifecycle") {
								expect(report.output).toContain(`adapter ${mode}: café 世界`);
								expect(report.output).toContain("terminal stdout: café 世界");
							}
						} finally {
							await cleanupFixtures(root);
						}
					},
					25_000,
				);
			}
		}
	});
}
