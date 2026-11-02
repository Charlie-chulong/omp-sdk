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

	describe.skipIf(!fs.existsSync(path.join(artifactDir, "sdk.mjs")))(`${artifact} JavaScript plugins`, () => {
		async function run(root: TempDir, script: string) {
			const result = await ptree.exec(
				[
					"node",
					"--input-type=module",
					"-e",
					`import { loadExtensions, discoverExtensionPaths, discoverCustomToolPaths, loadCustomTools, discoverCustomTSCommands } from ${JSON.stringify(pathToFileURL(path.join(artifactDir, "sdk.mjs")).href)};
					${script}`,
				],
				{
					cwd: root.path(),
					env: {
						...Bun.env,
						HOME: root.join("home"),
						PI_CONFIG_DIR: ".omp",
						PI_CODING_AGENT_DIR: root.join("agent"),
						PI_PROFILE: "",
						XDG_DATA_HOME: root.join("data"),
						XDG_STATE_HOME: root.join("state"),
						XDG_CACHE_HOME: root.join("cache"),
					},
					timeout: 15_000,
					allowNonZero: true,
				},
			);
			expect(result.exitCode, result.stderr).toBe(0);
			return JSON.parse(result.stdout);
		}

		test("loads host aliases, text and JSON assets, and reloads JavaScript dependencies", async () => {
			using root = TempDir.createSync("@node-plugin-js-");
			await Bun.write(root.join("package.json"), JSON.stringify({ type: "module" }));
			await Bun.write(root.join("dep.js"), "export const value = 1;");
			await Bun.write(root.join("cdep.cjs"), "module.exports = { value: 1 };");
			await Bun.write(
				root.join("legacy.cjs"),
				`const dep = require('./cdep.cjs');
				module.exports = { value: dep.value, shared: dep === require('./cdep.cjs') };`,
			);
			await Bun.write(
				root.join("entry.cjs"),
				`const { value } = require('./cdep.cjs');
				module.exports = function () { globalThis.commonjsValues.push(value); };`,
			);
			await Bun.write(root.join("asset.ts"), "globalThis.sourceExecuted = true; export const value: number = 9;");
			await Bun.write(root.join("data.json"), JSON.stringify({ value: 3 }));
			await Bun.write(
				root.join("entry.mjs"),
				`import { value } from './dep';
				import legacy from './legacy.cjs';
				import source from './asset.ts' with { type: 'text' };
				import data from './data.json' with { type: 'json' };
				import { loadExtensions as host } from '@oh-my-pi/pi-coding-agent';
				import { loadExtensions as legacyHost } from '@mariozechner/pi-coding-agent';
				export default function () {
					globalThis.values.push({ value, commonjs: legacy.value, shared: legacy.shared,
						host: host === globalThis.hostLoader && legacyHost === host, source, json: data.value });
				}`,
			);
			const result = await run(
				root,
				`import { writeFileSync } from 'node:fs';
				globalThis.hostLoader = loadExtensions;
				globalThis.values = [];
				globalThis.commonjsValues = [];
				const first = await loadExtensions(['./entry.mjs', './entry.cjs'], process.cwd());
				writeFileSync('./dep.js', 'export const value = 2;');
				writeFileSync('./cdep.cjs', 'module.exports = { value: 2 };');
				const second = await loadExtensions(['./entry.mjs', './entry.cjs'], process.cwd());
				console.log(JSON.stringify({ errors: [...first.errors, ...second.errors], values: globalThis.values,
					commonjsValues: globalThis.commonjsValues, sourceExecuted: globalThis.sourceExecuted === true }));`,
			);
			expect(result.errors).toEqual([]);
			expect(result.values).toEqual([
				{
					value: 1,
					commonjs: 1,
					shared: true,
					host: true,
					source: await Bun.file(root.join("asset.ts")).text(),
					json: 3,
				},
				{
					value: 2,
					commonjs: 2,
					shared: true,
					host: true,
					source: await Bun.file(root.join("asset.ts")).text(),
					json: 3,
				},
			]);
			expect(result.commonjsValues).toEqual([1, 2]);
			expect(result.sourceExecuted).toBe(false);
		});

		test("rejects source plugins and transitive import/require dependencies without executing them", async () => {
			using root = TempDir.createSync("@node-plugin-source-");
			const entries: string[] = [];
			for (const extension of ["ts", "tsx", "mts", "cts", "jsx"]) {
				const source = root.join(`source.${extension}`);
				await Bun.write(source, "globalThis.sourceExecuted = true; export default function () {}");
				const imported = root.join(`import-${extension}.mjs`);
				await Bun.write(imported, `import './source.${extension}'; export default function () {}`);
				const required = root.join(`require-${extension}.cjs`);
				await Bun.write(required, `require('./source.${extension}'); module.exports = function () {};`);
				entries.push(source, imported, required);
			}
			await fs.promises.symlink(root.join("source.ts"), root.join("disguised.mjs"));
			entries.push(root.join("disguised.mjs"));
			const result = await run(
				root,
				`const result = await loadExtensions(${JSON.stringify(entries)}, process.cwd());
				console.log(JSON.stringify({ loaded: result.extensions.length, errors: result.errors,
					sourceExecuted: globalThis.sourceExecuted === true }));`,
			);
			expect(result.loaded).toBe(0);
			expect(result.sourceExecuted).toBe(false);
			expect(result.errors).toHaveLength(entries.length);
			for (const { error } of result.errors) {
				expect(error).toMatch(/precompil/i);
				expect(error).toContain(".js");
				expect(error).toContain(".mjs");
				expect(error).toContain(".cjs");
			}
		});

		test("does not resolve missing JavaScript imports to TypeScript sources", async () => {
			using root = TempDir.createSync("@node-plugin-resolution-");
			const entries: string[] = [];
			for (const [requested, available] of [
				["dep", "dep.ts"],
				["dep.js", "dep.tsx"],
				["dep.mjs", "dep.mts"],
				["dep.cjs", "dep.cts"],
			] as const) {
				const dir = root.join(available);
				await Bun.write(path.join(dir, available), "globalThis.sourceExecuted = true; export const value = 1;");
				const entry = path.join(dir, "entry.mjs");
				await Bun.write(entry, `import './${requested}'; export default function () {}`);
				entries.push(entry);
			}
			const result = await run(
				root,
				`const result = await loadExtensions(${JSON.stringify(entries)}, process.cwd());
				console.log(JSON.stringify({ loaded: result.extensions.length, errors: result.errors,
					sourceExecuted: globalThis.sourceExecuted === true }));`,
			);
			expect(result.loaded).toBe(0);
			expect(result.errors).toHaveLength(entries.length);
			expect(result.sourceExecuted).toBe(false);
		});

		test("discovers only JavaScript by default and reports explicitly configured source-only directories", async () => {
			using root = TempDir.createSync("@node-plugin-discovery-");
			for (const file of [
				"plain.ts",
				"source-only/index.ts",
				"mixed/index.ts",
				"mixed/index.js",
				"module/index.mjs",
				"common/index.cjs",
			]) {
				await Bun.write(root.join(".omp", "extensions", file), "export default function () {}");
			}
			await Bun.write(
				root.join("configured", "index.tsx"),
				"globalThis.sourceExecuted = true; export default function () {}",
			);
			await Bun.write(root.join("manifest", "package.json"), JSON.stringify({ omp: { extensions: ["./src"] } }));
			await Bun.write(root.join("manifest", "src", "index.cts"), "globalThis.sourceExecuted = true;");
			const result = await run(
				root,
				`import { relative } from 'node:path';
				const defaults = await discoverExtensionPaths([], process.cwd());
				const explicit = await discoverExtensionPaths(['./configured', './manifest'], process.cwd(), undefined, { ambient: false });
				const result = await loadExtensions(explicit, process.cwd());
				console.log(JSON.stringify({ defaults: defaults.map(p => relative(process.cwd(), p)).sort(),
					explicit: explicit.map(p => relative(process.cwd(), p)).sort(), errors: result.errors,
					sourceExecuted: globalThis.sourceExecuted === true }));`,
			);
			expect(result.defaults).toEqual([
				".omp/extensions/common/index.cjs",
				".omp/extensions/mixed/index.js",
				".omp/extensions/module/index.mjs",
			]);
			expect(result.explicit).toEqual(["configured/index.tsx", "manifest/src/index.cts"]);
			expect(result.errors).toHaveLength(2);
			for (const { error } of result.errors) expect(error).toMatch(/precompil/i);
			expect(result.sourceExecuted).toBe(false);
		});

		test("uses JavaScript tool and command defaults while rejecting configured source tools and command dependencies", async () => {
			using root = TempDir.createSync("@node-plugin-tool-command-");
			for (const file of [
				"plain.ts",
				"source-only/index.ts",
				"mixed/index.ts",
				"mixed/index.js",
				"direct.mjs",
				"common/index.cjs",
			]) {
				await Bun.write(root.join(".omp", "tools", file), "export default function () {}");
			}
			await Bun.write(root.join("explicit.ts"), "globalThis.sourceExecuted = true; export default function () {}");
			await Bun.write(root.join(".omp", "commands", "source-only", "index.ts"), "globalThis.sourceExecuted = true;");
			await Bun.write(root.join(".omp", "commands", "mixed", "index.ts"), "globalThis.sourceExecuted = true;");
			await Bun.write(
				root.join(".omp", "commands", "mixed", "index.cjs"),
				"module.exports = () => ({ name: 'js-command', description: 'JavaScript command', execute() {} });",
			);
			await Bun.write(
				root.join(".omp", "commands", "dependent", "dependency.ts"),
				"globalThis.sourceExecuted = true;",
			);
			await Bun.write(root.join(".omp", "commands", "dependent", "index.cjs"), "require('./dependency.ts');");
			const result = await run(
				root,
				`import { relative } from 'node:path';
				const defaults = await discoverCustomToolPaths([], process.cwd());
				const configured = await discoverCustomToolPaths(['./explicit.ts'], process.cwd());
				const tools = await loadCustomTools(configured.filter(p => p.path.endsWith('/explicit.ts')), process.cwd(), []);
				const commands = await discoverCustomTSCommands(process.cwd());
				console.log(JSON.stringify({ defaults: defaults.map(p => relative(process.cwd(), p.path)).sort(),
					toolErrors: tools.errors, commandErrors: commands.errors,
					commands: commands.commands.filter(c => !c.path.startsWith('bundled:')).map(c => c.command.name),
					sourceExecuted: globalThis.sourceExecuted === true }));`,
			);
			expect(result.defaults).toEqual([
				".omp/tools/common/index.cjs",
				".omp/tools/direct.mjs",
				".omp/tools/mixed/index.js",
			]);
			expect(result.commands).toEqual(["js-command"]);
			expect(result.toolErrors).toHaveLength(1);
			expect(result.commandErrors).toHaveLength(1);
			expect(result.toolErrors[0].error).toMatch(/precompil/i);
			expect(result.commandErrors[0].error).toMatch(/precompil/i);
			expect(result.sourceExecuted).toBe(false);
		});
	});
}
