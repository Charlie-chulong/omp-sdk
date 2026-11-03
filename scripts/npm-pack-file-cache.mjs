import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { fingerprintPaths, readCache, writeCache } from "./sdk-build-cache.mjs";

const CACHE_SCHEMA = 1;
const CONFIGURATION_FILES = new Set([
	"package.json",
	".npmrc",
	".npmignore",
	".gitignore",
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
]);

function fileListDigest(files) {
	return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

async function configurationPaths(directories) {
	const visited = new Set();
	const inputs = new Set([fileURLToPath(new URL(".", import.meta.url))]);
	for (const directory of directories) {
		for (let current = directory; !visited.has(current); current = path.dirname(current)) {
			visited.add(current);
			for (const entry of await readdir(current, { withFileTypes: true })) {
				if (CONFIGURATION_FILES.has(entry.name) || (entry.name === "scripts" && entry.isDirectory()))
					inputs.add(path.join(current, entry.name));
			}
			if (path.dirname(current) === current) break;
		}
	}
	return [...inputs].sort();
}

/** Cache npm's source-package selection, never the staged file contents. */
export function createNpmPackFileCache({ source, cacheDir, target, npm, safeRelativePath }) {
	const directory = cacheDir ?? path.join(os.tmpdir(), "omp-node-sdk-packlists");
	const inputs = new Map();
	const contexts = new Map();
	let npmVersion;
	return async function packageFiles(pkg, cwd) {
		npmVersion ??= npm(["--version"], cwd, { parseJson: false }).trim();
		let context = contexts.get(pkg.directory);
		if (!context) {
			context = Promise.all(
				(await configurationPaths([source, pkg.directory])).map(file => {
					if (!inputs.has(file)) inputs.set(file, fingerprintPaths([file]));
					return inputs.get(file);
				}),
			);
			contexts.set(pkg.directory, context);
		}
		const [configuration, content] = await Promise.all([
			context,
			fingerprintPaths([pkg.directory], { exclude: [".git"] }),
		]);
		const key = JSON.stringify({
			schemaVersion: CACHE_SCHEMA,
			directory: pkg.directory,
			name: pkg.manifest.name,
			version: pkg.manifest.version,
			configuration,
			content,
			platform: target.platform,
			arch: target.arch,
			node: process.version,
			npm: npmVersion,
			npmExecPath: process.env.npm_execpath ?? null,
		});
		const file = path.join(directory, "npm-pack-files", `${content}.json`);
		const cached = await readCache(file);
		const validFiles = files =>
			Array.isArray(files) && files.length > 0 && files.includes("package.json") && files.every(safeRelativePath);
		if (cached?.key === key && validFiles(cached.files) && cached.filesSha256 === fileListDigest(cached.files))
			return cached.files;
		const packed = npm(["pack", pkg.directory, "--dry-run", "--ignore-scripts", "--json"], cwd);
		const files = packed?.[0]?.files?.map(entry => entry?.path);
		if (!validFiles(files)) throw new Error(`Unsafe or invalid npm package file list: ${pkg.directory}`);
		if (content === (await fingerprintPaths([pkg.directory], { exclude: [".git"] })))
			await writeCache(file, { key, files, filesSha256: fileListDigest(files) });
		return files;
	};
}
