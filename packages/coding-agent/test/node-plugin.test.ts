import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const packageDir = fileURLToPath(new URL("../", import.meta.url));

// Artifact contracts run after gen:bundle:node / gen:bundle:desktop, never build inside the test suite.
for (const artifact of ["node", "node-desktop"]) {
	const artifactDir = path.join(packageDir, "dist", artifact);
	describe.skipIf(!fs.existsSync(path.join(artifactDir, "plugins.mjs")))(`${artifact} plugin command entry`, () => {
		test("links and lists through the existing plugin store in one-shot Node processes", async () => {
			using root = TempDir.createSync("@node-plugin-command-");
			const pluginDir = root.join("plugin");
			await Bun.write(
				path.join(pluginDir, "package.json"),
				JSON.stringify({ name: "node-entry-fixture", version: "1.0.0", omp: {} }),
			);
			const entryUrl = pathToFileURL(path.join(artifactDir, "plugins.mjs")).href;
			const specifier = artifact === "node" ? "@oh-my-pi/pi-coding-agent/sdk/plugins" : entryUrl;
			async function run(args: readonly string[]) {
				return ptree.exec(
					[
						"node",
						"--input-type=module",
						"-e",
						`import { runNodePluginCommand } from ${JSON.stringify(specifier)};
process.chdir(${JSON.stringify(root.path())});
await runNodePluginCommand(Object.freeze(process.argv.slice(1)));`,
						...args,
					],
					{
						cwd: packageDir,
						env: {
							...Bun.env,
							HOME: root.path(),
							PI_CONFIG_DIR: ".omp",
							PI_CODING_AGENT_DIR: root.join("agent"),
							PI_PROFILE: "",
							XDG_DATA_HOME: root.join("data"),
							XDG_STATE_HOME: root.join("state"),
							XDG_CACHE_HOME: root.join("cache"),
							NO_COLOR: "1",
						},
						timeout: 15_000,
						allowNonZero: true,
					},
				);
			}

			const linked = await run(["plugin", "link", pluginDir, "--json"]);
			expect(linked.exitCode, linked.stderr).toBe(0);
			expect(JSON.parse(linked.stdout).name).toBe("node-entry-fixture");
			const listed = await run(["plugin", "list", "--json"]);
			expect(listed.exitCode, listed.stderr).toBe(0);
			expect(JSON.parse(listed.stdout).npm).toContainEqual(
				expect.objectContaining({ name: "node-entry-fixture", version: "1.0.0" }),
			);
			const text = await run(["plugin"]);
			expect(text.exitCode, text.stderr).toBe(0);
			expect(text.stdout).toContain("node-entry-fixture");
			const invalid = await run(["plugin", "not-a-command"]);
			expect(invalid.exitCode).toBe(1);
			expect(invalid.stderr).toContain("not-a-command");
			expect(fs.existsSync(root.join("agent", "sessions"))).toBe(false);
		});
	});
}
