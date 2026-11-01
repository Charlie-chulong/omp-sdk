/**
 * Content-based binary/text classification for files that are about to be
 * decoded as UTF-8 text and shown to a model or user.
 *
 * The read tool and `@file` auto-read both materialize file bytes as UTF-8
 * strings. For a binary file (font, object, archive, packed blob) that decode
 * is lossy: NUL bytes and invalid sequences survive as control characters and
 * U+FFFD replacements, which corrupt terminal rendering and waste the context
 * window with mojibake. Sniff the header first and refuse instead.
 *
 * @example
 * if (await isProbablyBinary(path)) return "[binary file omitted]";
 * const text = await Bun.file(path).text();
 */
import { Buffer } from "node:buffer";
import { peekFile, peekFileSync } from "./peek-file";

/** Encode only the visible bytes, without copying the backing buffer. */
export function encodeBase64(bytes: Uint8Array): string {
	return (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).toString(
		"base64",
	);
}

const BASE64_BYTES = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
const BASE64URL_BYTES = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?)?$/;

/** Decode with Uint8Array.fromBase64's default loose final-quantum syntax. */
export function decodeBase64Bytes(data: string, alphabet: "base64" | "base64url" = "base64"): Buffer<ArrayBuffer> {
	const compact = data.replace(/[\t\n\f\r ]/g, "");
	if (!(alphabet === "base64url" ? BASE64URL_BYTES : BASE64_BYTES).test(compact)) {
		throw new SyntaxError("Invalid base64 data");
	}
	return Buffer.from(compact, alphabet);
}

/**
 * Header window sniffed for the binary heuristic; mirrors git's 8000-byte scan.
 * Exported so callers that already hold the whole file in memory can sniff the
 * identical prefix through {@link isProbablyBinaryHeader} instead of reopening.
 */
export const BINARY_SNIFF_BYTES = 8192;

/**
 * Classify an in-memory byte header as binary (non-UTF-8-text).
 *
 * Binary when the header contains a NUL byte (true binary, plus UTF-16/UTF-32
 * text whose ASCII range is NUL-padded) or when it is not valid UTF-8. The
 * decode runs in streaming mode so a multibyte sequence truncated at the header
 * boundary is tolerated, while any genuinely invalid byte still fails — matching
 * the strict `fatal` decode the `local://`/`ssh://` read paths already use.
 */
export function isProbablyBinaryHeader(header: Uint8Array): boolean {
	if (header.indexOf(0) !== -1) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(header, { stream: true });
		return false;
	} catch {
		return true;
	}
}

/**
 * Sniff the first {@link BINARY_SNIFF_BYTES} of `filePath` and report whether it
 * is binary (non-UTF-8-text). See {@link isProbablyBinaryHeader} for the rule.
 */
export function isProbablyBinary(filePath: string, maxBytes = BINARY_SNIFF_BYTES): Promise<boolean> {
	return peekFile(filePath, maxBytes, isProbablyBinaryHeader);
}

/** Synchronous {@link isProbablyBinary}. */
export function isProbablyBinarySync(filePath: string, maxBytes = BINARY_SNIFF_BYTES): boolean {
	return peekFileSync(filePath, maxBytes, isProbablyBinaryHeader);
}
