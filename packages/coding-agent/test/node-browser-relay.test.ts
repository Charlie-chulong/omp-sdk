import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TempDir } from "@oh-my-pi/pi-utils";
import { findFreeCdpPort } from "../src/tools/browser/attach";

const packageDir = fileURLToPath(new URL("../", import.meta.url));

interface RelayConsumer {
	child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	stderr: Promise<string>;
	ready: Promise<void>;
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	// Real child processes and sockets cannot be advanced with fake timers.
	const deadline = Date.now() + timeoutMs;
	do {
		if (await condition()) return true;
		await Bun.sleep(50);
	} while (Date.now() < deadline);
	return false;
}

// Artifact tests run after bundling, without building or needing a Chrome extension.
for (const artifact of ["node", "node-desktop"]) {
	const artifactDir = path.join(packageDir, "dist", artifact);
	describe.skipIf(!fs.existsSync(path.join(artifactDir, "sdk.mjs")))(`${artifact} embedded browser relay`, () => {
		test("Node host status identifies missing, waiting, conflicting and incompatible listeners without modifying them", async () => {
			const port = await findFreeCdpPort();
			const endpoint = `http://127.0.0.1:${port}`;
			const host = path.join(artifactDir, "host.mjs");
			async function command(action: string) {
				const child = Bun.spawn(
					[
						"node",
						host,
						"browser-relay",
						action,
						"--port",
						String(port),
						...(action === "status" ? ["--json"] : []),
					],
					{
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [code, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				return { code, stdout, stderr };
			}
			const absent = await command("status");
			expect(absent.code, absent.stderr).toBe(0);
			expect(JSON.parse(absent.stdout).outcome).toBe("unreachable");
			let body: Record<string, unknown> = { ok: true };
			let httpStatus = 200;
			const listener = Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch: () => Response.json(body, { status: httpStatus }),
			});
			try {
				for (httpStatus of [200, 503]) {
					expect(JSON.parse((await command("status")).stdout).outcome).toBe("not-relay");
					expect((await command("serve")).code).not.toBe(0);
					expect((await fetch(`${endpoint}/json/version`)).status).toBe(httpStatus);
				}
				body = {
					ompRelayVersion: "18.14.0",
					ompRelayDiscardedTabsProtocol: "1",
					ompExtensionDiscardedTabsProtocol: "0",
					extensionSeen: false,
					uptimeMs: 60_000,
					ompRelayCdpClients: 0,
				};
				const waiting = await command("status");
				expect(JSON.parse(waiting.stdout).outcome).toBe("no-extension");
				expect((await command("serve")).code).toBe(0);
				expect((await fetch(`${endpoint}/json/version`)).status).toBe(503);
				body.ompRelayDiscardedTabsProtocol = "999";
				expect(JSON.parse((await command("status")).stdout).outcome).toBe("outdated-relay");
				expect((await command("serve")).code).not.toBe(0);
			} finally {
				listener.stop(true);
			}
		}, 30_000);

		test("auto-starts from the Node SDK and keeps the relay until the last consumer exits", async () => {
			using root = TempDir.createSync("@node-browser-relay-");
			const cdpUrl = `http://127.0.0.1:${await findFreeCdpPort()}`;
			const sdkUrl = pathToFileURL(path.join(artifactDir, "sdk.mjs")).href;
			const script = `
import { createBrowserPrelude, Settings } from ${JSON.stringify(sdkUrl)};
const session = {
	cwd: process.cwd(), hasUI: false, getSessionFile: () => null,
	settings: Settings.isolated({ "browser.relayUrl": ${JSON.stringify(cdpUrl)} }),
};
const prelude = createBrowserPrelude(session);
// Let the real extension-handshake wait settle before signalling readiness:
// observing an existing port alone does not prove this consumer holds a lease.
await prelude.invoke({ action: "open", app: { relay: true }, timeout: 45 }, {
	session, toolCallId: "node-relay-regression",
}).catch(error => {
	// No extension connects to this isolated test port; unexpected failures
	// must still surface instead of being mistaken for a ready consumer.
	if (error?.name !== "ToolError") throw error;
});
process.stdout.write("ready\\n");
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
`;
			const consumers: RelayConsumer[] = [];
			function spawnConsumer(project: string) {
				const cwd = root.join(project);
				fs.mkdirSync(cwd);
				const child = Bun.spawn(["node", "--input-type=module", "-e", script], {
					cwd,
					env: {
						...process.env,
						HOME: root.path(),
						USERPROFILE: root.path(),
						PI_CONFIG_DIR: ".omp",
						PI_CODING_AGENT_DIR: root.join("agent"),
						XDG_DATA_HOME: root.join("data"),
						XDG_STATE_HOME: root.join("state"),
						XDG_CACHE_HOME: root.join("cache"),
						OMP_DAEMON_IDLE_GRACE_MS: "200",
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				const stderr = new Response(child.stderr).text();
				const ready = (async () => {
					for await (const chunk of child.stdout) {
						if (new TextDecoder().decode(chunk).includes("ready\n")) return;
					}
					throw new Error(`Node relay consumer exited: ${await stderr}`);
				})();
				const consumer = { child, stderr, ready };
				consumers.push(consumer);
				return consumer;
			}
			async function status() {
				try {
					const response = await fetch(`${cdpUrl}/json/version`);
					return { status: response.status, body: await response.json() };
				} catch {
					return null;
				}
			}
			async function stop(consumer: RelayConsumer) {
				consumer.child.stdin.end();
				expect(await consumer.child.exited, await consumer.stderr).toBe(0);
			}
			try {
				const first = spawnConsumer("first");
				await first.ready;
				const initial = await status();
				expect(initial?.status).toBe(503);
				expect(initial?.body).toMatchObject({
					extensionSeen: false,
					ompRelayVersion: JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version,
				});
				const second = spawnConsumer("second");
				await second.ready;
				await stop(first);
				// Exceed the real broker's idle grace with the second lease held.
				await Bun.sleep(500);
				expect((await status())?.status).toBe(503);
				await stop(second);
				expect(await waitUntil(async () => (await status()) === null)).toBe(true);
			} finally {
				for (const { child, ready } of consumers) {
					if (child.exitCode === null) child.kill();
					await Promise.allSettled([child.exited, ready]);
				}
				await waitUntil(async () => (await status()) === null);
			}
		}, 60_000);
	});
}
