import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Blob as NativeBlob } from "node:buffer";
import { toWebByteStream } from "./runtime-readable";
import { fileURLToPath } from "node:url";
import mime from "mime";
import { hashBytes, type HashInput } from "./runtime-hash";

export interface RuntimeFileSink {
	write(data: HashInput): number | Promise<number>;
	flush(): number | Promise<number>;
	end(error?: Error): number | Promise<number>;
}
export interface RuntimeFile {
	readonly name: string;
	readonly lastModified: number;
	readonly size: number;
	readonly type: string;
	stream(): ReadableStream<Uint8Array>;
	bytes(): Promise<Uint8Array<ArrayBuffer>>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
	exists(): Promise<boolean>;
	stat(): Promise<fs.Stats>;
	json<T = unknown>(): Promise<T>;
	writer(options?: { highWaterMark?: number }): RuntimeFileSink;
	write(data: RuntimeWriteData): Promise<number>;
	unlink(): Promise<void>;
	slice(start?: number, end?: number, contentType?: string): RuntimeFile;
}
export type RuntimeWriteData = HashInput | Blob | RuntimeFile | Response | Request | ReadableStream<Uint8Array>;
export type RuntimeFilePath = string | URL | number;

/** A synchronous sink: writes complete before returning, including partial OS writes. */
class NodeFileSink implements RuntimeFileSink {
	#fd: number;
	#ownsFd: boolean;
	#ended = false;
	#unflushed = 0;
	constructor(target: RuntimeFilePath, createPath = true) {
		this.#ownsFd = typeof target !== "number";
		if (typeof target === "number") this.#fd = target;
		else {
			const filename = target instanceof URL ? fileURLToPath(target) : target;
			if (createPath) fs.mkdirSync(path.dirname(filename), { recursive: true });
			this.#fd = fs.openSync(filename, "w");
		}
	}
	write(data: HashInput): number {
		if (this.#ended) throw new Error("Cannot write to an ended file sink");
		const bytes = hashBytes(data);
		let offset = 0;
		while (offset < bytes.length) {
			const written = fs.writeSync(this.#fd, bytes, offset, bytes.length - offset);
			if (written === 0) throw new Error("File sink write made no progress");
			offset += written;
		}
		this.#unflushed += offset;
		return offset;
	}
	flush(): number {
		const written = this.#unflushed;
		this.#unflushed = 0;
		return written;
	}
	end(error?: Error): number {
		if (this.#ended) return 0;
		this.#ended = true;
		let written: number;
		try {
			written = this.flush();
		} finally {
			if (this.#ownsFd) fs.closeSync(this.#fd);
		}
		if (error) throw error;
		return written;
	}
}
let standardInputStream: ReadableStream<Uint8Array> | undefined;

export class NodeRuntimeFile implements RuntimeFile {
	readonly target: RuntimeFilePath;
	readonly type: string;
	readonly #start: number;
	readonly #end: number | undefined;
	constructor(target: RuntimeFilePath, options?: { type?: string }, start = 0, end?: number) {
		this.type =
			options?.type ??
			(typeof target === "number"
				? "application/octet-stream"
				: (mime.getType(target instanceof URL ? target.pathname : target) ?? "application/octet-stream"));
		this.target = target;
		this.#start = start;
		this.#end = end;
	}
	get name(): string {
		return typeof this.target === "number"
			? String(this.target)
			: this.target instanceof URL
				? fileURLToPath(this.target)
				: this.target;
	}
	get size(): number {
		try {
			const size = typeof this.target === "number" ? fs.fstatSync(this.target).size : fs.statSync(this.target).size;
			return Math.max(0, Math.min(size, this.#end ?? size) - Math.min(size, this.#start));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
	}
	get lastModified(): number {
		return (typeof this.target === "number" ? fs.fstatSync(this.target) : fs.statSync(this.target)).mtimeMs;
	}
	async exists(): Promise<boolean> {
		try {
			const stat = await this.stat();
			return stat.isFile() || stat.isFIFO();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return false;
			throw error;
		}
	}
	async stat(): Promise<fs.Stats> {
		if (typeof this.target !== "number") return fsp.stat(this.target);
		const { promise, resolve, reject } = Promise.withResolvers<fs.Stats>();
		fs.fstat(this.target, (error, stat) => (error ? reject(error) : resolve(stat)));
		return promise;
	}
	stream(): ReadableStream<Uint8Array> {
		// fs.read on an idle stdin descriptor can block libuv workers and process.exit().
		// Share one stream so extension readers cannot bypass RPC's stdin lock.
		if (this.target === 0 && this.#start === 0 && this.#end === undefined)
			return (standardInputStream ??= toWebByteStream(process.stdin));
		const options = {
			...(typeof this.target === "number" ? { fd: this.target, autoClose: false } : {}),
			...(typeof this.target !== "number" || this.#start !== 0 || this.#end !== undefined
				? { start: this.#start }
				: {}),
			...(this.#end === undefined ? {} : { end: this.#end - 1 }),
		};
		if (this.#end !== undefined && this.#end <= this.#start)
			return new ReadableStream({
				start(controller) {
					controller.close();
				},
			});
		return toWebByteStream(fs.createReadStream(typeof this.target === "number" ? "" : this.target, options));
	}
	async bytes(): Promise<Uint8Array<ArrayBuffer>> {
		if (this.#start === 0 && this.#end === undefined && typeof this.target !== "number")
			return fsp.readFile(this.target);
		return new Uint8Array(await new Response(this.stream()).arrayBuffer());
	}
	async arrayBuffer(): Promise<ArrayBuffer> {
		const bytes = await this.bytes();
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	}
	async text(): Promise<string> {
		return new TextDecoder().decode(await this.bytes());
	}
	async json<T = unknown>(): Promise<T> {
		return JSON.parse(await this.text()) as T;
	}
	slice(start = 0, end = this.size, contentType = ""): RuntimeFile {
		const size = this.size;
		const relativeStart = Math.min(size, start < 0 ? Math.max(size + start, 0) : start);
		const relativeEnd = Math.min(size, end < 0 ? Math.max(size + end, 0) : end);
		return new NodeRuntimeFile(
			this.target,
			{ type: contentType },
			this.#start + relativeStart,
			this.#start + Math.max(relativeStart, relativeEnd),
		);
	}
	async nativeBlob(): Promise<Blob> {
		if (typeof this.target === "number") return new Blob([await this.arrayBuffer()], { type: this.type });
		const blob = await fs.openAsBlob(this.target, { type: this.type });
		return this.#start === 0 && this.#end === undefined
			? blob
			: NativeBlob.prototype.slice.call(blob, this.#start, this.#end, this.type);
	}
	writer(_options?: { highWaterMark?: number }): RuntimeFileSink {
		return new NodeFileSink(this.target);
	}
	write(data: RuntimeWriteData): Promise<number> {
		return writeNodeFile(this, data);
	}
	async unlink(): Promise<void> {
		if (typeof this.target === "number") throw new TypeError("Cannot unlink a file descriptor");
		await fsp.unlink(this.target);
	}
}

/** Convert a lazy runtime file to a genuine native Blob for FormData or Blob composition. */
export async function fileBlob(file: RuntimeFile): Promise<Blob> {
	if (file instanceof Blob) return file;
	if (file instanceof NodeRuntimeFile) return file.nativeBlob();
	return new Blob([await file.arrayBuffer()], { type: file.type });
}

export async function writeNodeFile(
	destination: RuntimeFilePath | RuntimeFile,
	data: RuntimeWriteData,
	options?: { mode?: number; createPath?: boolean },
): Promise<number> {
	const target =
		destination instanceof NodeRuntimeFile
			? destination.target
			: typeof destination === "string" || typeof destination === "number" || destination instanceof URL
				? destination
				: destination.name;
	if (typeof target !== "number" && options?.createPath !== false) {
		await fsp.mkdir(path.dirname(target instanceof URL ? fileURLToPath(target) : target), { recursive: true });
	}
	const sink = new NodeFileSink(target, options?.createPath !== false);
	let total = 0;
	try {
		if (data instanceof Response || data instanceof Request) data = data.body ?? new Uint8Array(0);
		if (typeof data === "object" && "stream" in data) data = data.stream();
		if (data instanceof ReadableStream) {
			for await (const chunk of data) total += sink.write(chunk);
		} else total = sink.write(data);
	} finally {
		sink.end();
	}
	if (options?.mode !== undefined && typeof target !== "number") await fsp.chmod(target, options.mode);
	return total;
}
