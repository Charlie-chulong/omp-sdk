import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** Convert byte-mode Node streams without replacing native backpressure or cancellation. */
export function toWebByteStream(stream: Readable): ReadableStream<Uint8Array> {
	if (stream.readableEncoding !== null) throw new TypeError("A byte stream must not have a text encoding");
	// DOM and node:stream/web declarations disagree on BYOB overloads; the native
	// adapter returns the same WHATWG ReadableStream used by Node's global API.
	return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/** The inverse native adapter preserves response cancellation and backpressure. */
export function fromWebByteStream(stream: ReadableStream<Uint8Array>): Readable {
	return Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>);
}
