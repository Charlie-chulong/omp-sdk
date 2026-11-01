import fastGlob from "fast-glob";
import picomatch from "picomatch";

export interface RuntimeGlobScanOptions {
	cwd?: string;
	dot?: boolean;
	absolute?: boolean;
	followSymlinks?: boolean;
	throwErrorOnBrokenSymlink?: boolean;
	onlyFiles?: boolean;
}

export class RuntimeGlob {
	readonly #pattern: string;
	readonly #match: ((path: string) => boolean) | undefined;
	readonly #bun: Bun.Glob | undefined;
	constructor(pattern: string) {
		this.#pattern = pattern;
		this.#bun = typeof Bun === "undefined" ? undefined : new Bun.Glob(pattern);
		if (!this.#bun) this.#match = picomatch(pattern, { dot: true });
	}
	match(path: string): boolean {
		return this.#bun ? this.#bun.match(path) : this.#match!(path);
	}
	async *scan(optionsOrCwd?: string | RuntimeGlobScanOptions): AsyncIterableIterator<string> {
		if (this.#bun) {
			yield* this.#bun.scan(optionsOrCwd);
			return;
		}
		const options = typeof optionsOrCwd === "string" ? { cwd: optionsOrCwd } : (optionsOrCwd ?? {});
		for await (const entry of fastGlob.stream(this.#pattern, {
			cwd: options.cwd,
			dot: options.dot ?? false,
			absolute: options.absolute ?? false,
			followSymbolicLinks: options.followSymlinks ?? false,
			throwErrorOnBrokenSymbolicLink: options.throwErrorOnBrokenSymlink ?? false,
			onlyFiles: options.onlyFiles ?? true,
		}))
			yield String(entry);
	}
	*scanSync(optionsOrCwd?: string | RuntimeGlobScanOptions): IterableIterator<string> {
		if (this.#bun) {
			yield* this.#bun.scanSync(optionsOrCwd);
			return;
		}
		const options = typeof optionsOrCwd === "string" ? { cwd: optionsOrCwd } : (optionsOrCwd ?? {});
		yield* fastGlob.sync(this.#pattern, {
			cwd: options.cwd,
			dot: options.dot ?? false,
			absolute: options.absolute ?? false,
			followSymbolicLinks: options.followSymlinks ?? false,
			throwErrorOnBrokenSymbolicLink: options.throwErrorOnBrokenSymlink ?? false,
			onlyFiles: options.onlyFiles ?? true,
		});
	}
}
