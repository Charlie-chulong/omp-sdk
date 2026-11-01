import * as fs from "node:fs/promises";
import * as path from "node:path";
import manifest from "../package.json" with { type: "json" };
import { createNodeSourceMetadataPlugin } from "./node-source-metadata";

const packageDir = path.resolve(import.meta.dirname, "..");
const defaultOutDir = path.join(packageDir, "dist", "node");

/** Build the concrete Node adapters in their owning package's dependency scope. */
export async function bundleNodeRuntime(outDir: string = defaultOutDir): Promise<void> {
	await fs.rm(outDir, { recursive: true, force: true });
	const result = await Bun.build({
		entrypoints: ["runtime.ts", "runtime-image.ts", "sqlite-driver.ts"].map(file =>
			path.join(packageDir, "src", file),
		),
		root: path.join(packageDir, "src"),
		outdir: outDir,
		target: "node",
		format: "esm",
		splitting: true,
		naming: { entry: "[name].mjs", chunk: "chunks/[name]-[hash].mjs" },
		external: [...Object.keys(manifest.dependencies), "bun", "bun:ffi", "bun:sqlite"],
		plugins: [await createNodeSourceMetadataPlugin([packageDir])],
		minify: { whitespace: true, syntax: true, identifiers: true, keepNames: true },
		throw: false,
	});
	if (!result.success)
		throw new Error(`Node runtime bundle failed:\n${result.logs.map(log => log.message).join("\n")}`);
	process.stdout.write(`Bundled Node runtime adapters to ${outDir}\n`);
}

if (import.meta.main) await bundleNodeRuntime();
