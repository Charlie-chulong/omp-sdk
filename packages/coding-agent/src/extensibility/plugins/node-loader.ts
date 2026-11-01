import * as fs from "node:fs";
import { createRequire } from "node:module";
import type * as NodeModule from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as CompilerModule from "@ts-morph/common";

const hostRequire = createRequire(import.meta.url);
let installed = false;
let compiler: typeof CompilerModule.ts | undefined;
const owned = new Set<string>();

function sourcePath(url: string): string | undefined {
	return url.startsWith("file:") ? fileURLToPath(url) : undefined;
}

function resolveFile(specifier: string, parentURL: string): string | undefined {
	const target = fileURLToPath(new URL(specifier, parentURL));
	const extension = path.extname(target);
	const sourceAlternatives =
		extension === ".js"
			? [target.slice(0, -3) + ".ts", target.slice(0, -3) + ".tsx"]
			: extension === ".mjs"
				? [target.slice(0, -4) + ".mts"]
				: extension === ".cjs"
					? [target.slice(0, -4) + ".cts"]
					: [];
	for (const candidate of [
		target,
		...sourceAlternatives,
		...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map(ext => target + ext),
		...["index.ts", "index.tsx", "index.js"].map(name => path.join(target, name)),
	]) {
		try {
			if (fs.statSync(candidate).isFile()) return pathToFileURL(candidate).href;
		} catch {
			/* Continue normal extension resolution. */
		}
	}
	return undefined;
}

/** Install synchronous Node hooks; real module evaluation stays in Node's loader. */
function installNodeHooks(resolveHost: (specifier: string) => string | null): void {
	if (installed) return;
	const { registerHooks }: typeof NodeModule = hostRequire("node:module");
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const host = resolveHost(specifier);
			if (host) {
				return nextResolve(host.startsWith("#") ? hostRequire.resolve(host) : host, {
					...context,
					parentURL: import.meta.url,
				});
			}
			let result;
			try {
				result = nextResolve(specifier, context);
			} catch (error) {
				if (!context.parentURL || !specifier.startsWith(".")) throw error;
				const candidate = resolveFile(specifier, context.parentURL);
				if (!candidate) throw error;
				result = { url: candidate, shortCircuit: true };
			}
			const parentPath = context.parentURL && sourcePath(context.parentURL);
			const targetPath = sourcePath(result.url);
			if (parentPath && owned.has(parentPath) && targetPath) {
				owned.add(targetPath);
				const tag = new URL(context.parentURL!).searchParams.get("mtime");
				if (tag) {
					const target = new URL(result.url);
					target.searchParams.set("mtime", tag);
					result = { ...result, url: target.href };
				}
			}
			return result;
		},
		load(url, context, nextLoad) {
			const filename = sourcePath(url);
			if (!filename) return nextLoad(url, context);
			if (context.importAttributes?.type === "text") {
				return {
					format: "module",
					source: `export default ${JSON.stringify(fs.readFileSync(filename, "utf8"))};`,
					shortCircuit: true,
				};
			}
			if (!/\.(?:ts|tsx|mts|cts|jsx)$/.test(filename)) return nextLoad(url, context);
			if (!compiler) {
				// The installed package exposes the compiler API through its typed namespace.
				const module: typeof CompilerModule = hostRequire("@ts-morph/common");
				compiler = module.ts;
			}
			const commonjs = filename.endsWith(".cts") || context.format?.startsWith("commonjs") === true;
			const result = compiler.transpileModule(fs.readFileSync(filename, "utf8"), {
				fileName: filename,
				compilerOptions: {
					target: compiler.ScriptTarget.ESNext,
					module: commonjs ? compiler.ModuleKind.CommonJS : compiler.ModuleKind.ESNext,
					jsx: compiler.JsxEmit.ReactJSX,
					inlineSourceMap: true,
					inlineSources: true,
				},
			});
			return { format: commonjs ? "commonjs" : "module", source: result.outputText, shortCircuit: true };
		},
	});
	installed = true;
}

export async function loadNodeExtensionModule(
	filename: string,
	tag: string | undefined,
	resolveHost: (specifier: string) => string | null,
): Promise<unknown> {
	installNodeHooks(resolveHost);
	const realPath = fs.realpathSync(filename);
	owned.add(realPath);
	if (tag) {
		for (const key of Object.keys(hostRequire.cache)) {
			if (owned.has(key)) delete hostRequire.cache[key];
		}
	}
	const url = pathToFileURL(realPath);
	if (tag) url.searchParams.set("mtime", tag);
	return import(url.href);
}
