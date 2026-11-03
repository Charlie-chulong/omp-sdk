import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Hash names, contents and file kinds; timestamps are deliberately not cache keys. */
export async function fingerprintPaths(paths, { exclude = [".git", "node_modules"] } = {}) {
	const records = [];
	const exclusions = exclude.map(entry => entry.replaceAll("\\", "/").replace(/\/$/u, ""));
	function excluded(relative) {
		return exclusions.some(entry =>
			entry.includes("/")
				? relative === entry || relative.startsWith(`${entry}/`)
				: relative.split("/").includes(entry),
		);
	}
	async function visit(file, relative, ancestors) {
		if (relative && excluded(relative)) return;
		let info;
		try {
			info = await fs.lstat(file);
		} catch (error) {
			if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
			records.push({ file, kind: "missing" });
			return;
		}
		if (info.isSymbolicLink()) {
			records.push({ file, kind: "symlink", target: await fs.readlink(file) });
			try {
				info = await fs.stat(file);
			} catch (error) {
				if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
				records.push({ file, kind: "missing-target" });
				return;
			}
		}
		if (info.isDirectory()) {
			const real = await fs.realpath(file);
			if (ancestors.has(real)) throw new Error(`Circular SDK build input: ${file}`);
			const next = new Set(ancestors).add(real);
			records.push({ file, kind: "directory" });
			for (const name of (await fs.readdir(file)).sort()) {
				await visit(path.join(file, name), relative ? `${relative}/${name}` : name, next);
			}
		} else if (info.isFile()) {
			records.push({ file, kind: "file", size: info.size, mode: info.mode & 0o777 });
		} else {
			throw new Error(`Unsupported SDK build input: ${file}`);
		}
	}
	for (const file of [...new Set(paths.map(file => path.resolve(file)))].sort()) {
		await visit(file, "", new Set());
	}
	const digests = new Array(records.length);
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(16, records.length) }, async () => {
			while (cursor < records.length) {
				const index = cursor++;
				const record = records[index];
				let content;
				if (record.kind === "file") {
					const hash = createHash("sha256");
					if (record.size <= 128 * 1024) hash.update(await fs.readFile(record.file));
					else for await (const chunk of createReadStream(record.file)) hash.update(chunk);
					content = hash.digest("hex");
				}
				digests[index] = JSON.stringify([record.file, record.kind, record.mode, record.target, content]);
			}
		}),
	);
	const hash = createHash("sha256");
	for (const digest of digests) hash.update(digest).update("\n");
	return hash.digest("hex");
}

export async function readCache(file) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError || error.code === "ENOENT" || error.code === "ENOTDIR") return null;
		throw error;
	}
}

export async function writeCache(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

async function outputsExist(outputs) {
	for (const output of outputs) {
		try {
			await fs.stat(output);
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
			throw error;
		}
	}
	return true;
}

export async function cachedOutputMatches(file, inputKey, outputs) {
	const cached = await readCache(file);
	return (
		cached?.version === 1 &&
		cached.inputKey === inputKey &&
		typeof cached.outputKey === "string" &&
		(await outputsExist(outputs)) &&
		cached.outputKey === (await fingerprintPaths(outputs, { exclude: [] }))
	);
}

export async function cacheOutput(file, inputKey, outputs) {
	if (!(await outputsExist(outputs))) throw new Error("SDK build did not produce all required outputs.");
	await writeCache(file, {
		version: 1,
		inputKey,
		outputKey: await fingerprintPaths(outputs, { exclude: [] }),
	});
}
