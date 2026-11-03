import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const packageDir = fileURLToPath(new URL("../", import.meta.url));

for (const artifact of ["node", "node-desktop"]) {
	const pluginEntry = path.join(packageDir, "dist", artifact, "plugins.mjs");
	describe.skipIf(!fs.existsSync(pluginEntry))(`${artifact} plugin startup checks`, () => {
		test("disables load failures, preserves healthy and disabled plugins, and skips disabled features on the next startup", async () => {
			using root = TempDir.createSync("@plugin-startup-");
			const pluginsRoot = root.join(".omp", "plugins");
			const sources = {
				healthy: {
					omp: {
						extensions: ["entry.mjs"],
						features: { optional: { extensions: ["missing.mjs"], default: false } },
					},
					file: "export default pi => pi.registerCommand('healthy', { handler: async () => {} });",
				},
				throwing: {
					omp: { extensions: ["entry.mjs"] },
					file: "export default () => { throw new Error('broken factory'); };",
				},
				source: { omp: { extensions: ["entry.ts"] }, file: "export default () => {};", filename: "entry.ts" },
				missing: { omp: { extensions: ["missing.mjs"] }, file: "export default () => {};" },
				tool: { omp: { tools: "entry.mjs" }, file: "export default () => ({ name: 'broken-tool' });" },
				disabled: { omp: { extensions: ["entry.mjs"] }, file: "throw new Error('disabled plugin was evaluated');" },
			};
			for (const [name, plugin] of Object.entries(sources)) {
				const dir = path.join(pluginsRoot, "node_modules", name);
				await Bun.write(
					path.join(dir, "package.json"),
					JSON.stringify({ name, version: "1.0.0", type: "module", omp: plugin.omp }),
				);
				await Bun.write(path.join(dir, "filename" in plugin ? plugin.filename : "entry.mjs"), plugin.file);
			}
			await Bun.write(
				path.join(pluginsRoot, "package.json"),
				JSON.stringify({ dependencies: Object.fromEntries(Object.keys(sources).map(name => [name, "1.0.0"])) }),
			);
			const lockPath = path.join(pluginsRoot, "omp-plugins.lock.json");
			await Bun.write(
				lockPath,
				JSON.stringify({
					plugins: Object.fromEntries(
						Object.keys(sources).map(name => [
							name,
							{ version: "1.0.0", enabled: name !== "disabled", enabledFeatures: null },
						]),
					),
					settings: { healthy: { token: "keep-secret" } },
				}),
			);
			async function run(args: string[]) {
				const result = await ptree.exec(
					[
						"node",
						"--input-type=module",
						"-e",
						`import { runNodePluginCommand } from ${JSON.stringify(pathToFileURL(pluginEntry).href)}; await runNodePluginCommand(process.argv.slice(1));`,
						...args,
					],
					{
						cwd: root.path(),
						env: {
							...Bun.env,
							HOME: root.path(),
							PI_CONFIG_DIR: ".omp",
							PI_CODING_AGENT_DIR: root.join("agent"),
							PI_PROFILE: "",
							XDG_DATA_HOME: root.join("data"),
							XDG_STATE_HOME: root.join("state"),
							XDG_CACHE_HOME: root.join("cache"),
						},
						timeout: 30_000,
						allowNonZero: true,
					},
				);
				expect(result.exitCode, result.stderr).toBe(0);
				return JSON.parse(result.stdout);
			}
			const preview = await run(["plugin", "check", "--json"]);
			expect(
				preview
					.filter((check: { errors: string[] }) => check.errors.length)
					.map((check: { name: string }) => check.name)
					.sort(),
			).toEqual(["missing", "source", "throwing", "tool"]);
			expect((await Bun.file(lockPath).json()).plugins.throwing.enabled).toBe(true);
			const checked = await run(["plugin", "check", "--fix", "--json"]);
			expect(
				checked
					.filter((check: { disabled: boolean }) => check.disabled)
					.map((check: { name: string }) => check.name)
					.sort(),
			).toEqual(["missing", "source", "throwing", "tool"]);
			const lock = await Bun.file(lockPath).json();
			expect(Object.fromEntries(Object.keys(sources).map(name => [name, lock.plugins[name].enabled]))).toEqual({
				healthy: true,
				throwing: false,
				source: false,
				missing: false,
				tool: false,
				disabled: false,
			});
			expect(lock.settings).toEqual({ healthy: { token: "keep-secret" } });
			const next = await run(["plugin", "check", "--fix", "--json"]);
			expect(next.map((check: { name: string }) => check.name)).toEqual(["healthy"]);
			expect(next[0].errors).toEqual([]);
			expect(fs.existsSync(root.join("agent", "sessions"))).toBe(false);
		});

		test("disables only the project copy and synchronizes its marketplace registry without disabling a shadowed user copy", async () => {
			using root = TempDir.createSync("@plugin-startup-scope-");
			const project = root.join("project");
			const userRoot = root.join(".omp", "plugins");
			const projectRoot = root.join("project", ".omp", "plugins");
			for (const [pluginsRoot, throwing] of [
				[userRoot, false],
				[projectRoot, true],
			] as const) {
				const pluginDir = path.join(pluginsRoot, "node_modules", "@demo", "shared");
				await Bun.write(
					path.join(pluginDir, "package.json"),
					JSON.stringify({
						name: "@demo/shared",
						version: "1.0.0",
						type: "module",
						omp: { extensions: ["entry.mjs"] },
					}),
				);
				await Bun.write(
					path.join(pluginDir, "entry.mjs"),
					throwing ? "throw new Error('project module failed');" : "export default () => {};",
				);
				await Bun.write(
					path.join(pluginsRoot, "omp-plugins.lock.json"),
					JSON.stringify({
						plugins: { "@demo/shared": { version: "1.0.0", enabled: true, enabledFeatures: [] } },
						settings: {},
					}),
				);
			}
			const registryPath = path.join(projectRoot, "installed_plugins.json");
			await Bun.write(
				registryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"shared@demo": [
							{
								scope: "project",
								installPath: path.join(projectRoot, "node_modules", "@demo", "shared"),
								version: "1.0.0",
								installedAt: "2026-01-01T00:00:00Z",
								enabled: true,
							},
						],
					},
				}),
			);
			const result = await ptree.exec(
				[
					"node",
					"--input-type=module",
					"-e",
					`import { runNodePluginCommand } from ${JSON.stringify(pathToFileURL(pluginEntry).href)}; await runNodePluginCommand(['plugin', 'check', '--fix', '--json']);`,
				],
				{
					cwd: project,
					env: {
						...Bun.env,
						HOME: root.path(),
						PI_CONFIG_DIR: ".omp",
						PI_CODING_AGENT_DIR: root.join("agent"),
						PI_PROFILE: "",
						XDG_DATA_HOME: root.join("data"),
						XDG_STATE_HOME: root.join("state"),
						XDG_CACHE_HOME: root.join("cache"),
					},
					timeout: 30_000,
					allowNonZero: true,
				},
			);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual([
				expect.objectContaining({ name: "@demo/shared", scope: "project", disabled: true }),
			]);
			expect(
				(await Bun.file(path.join(userRoot, "omp-plugins.lock.json")).json()).plugins["@demo/shared"].enabled,
			).toBe(true);
			expect(
				(await Bun.file(path.join(projectRoot, "omp-plugins.lock.json")).json()).plugins["@demo/shared"].enabled,
			).toBe(false);
			expect((await Bun.file(registryPath).json()).plugins["shared@demo"][0].enabled).toBe(false);
		});
	});
}
