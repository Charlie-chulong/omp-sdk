import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import JSON5Parser from "json5";
import { compare, satisfies } from "semver";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hashBytes, type HashInput } from "./runtime-hash";

const bun = typeof Bun === "undefined" ? undefined : Bun;
export const semver = {
	order: (left: string, right: string): number => (bun ? bun.semver.order(left, right) : compare(left, right)),
	satisfies: (version: string, range: string): boolean =>
		bun ? bun.semver.satisfies(version, range) : satisfies(version, range),
};
export const YAML = {
	parse: (text: string): unknown => (bun ? bun.YAML.parse(text) : parseYaml(text)),
	stringify(value: unknown, replacer?: null, space?: number): string {
		return bun ? bun.YAML.stringify(value, replacer, space) : stringifyYaml(value, { indent: space ?? 2 });
	},
};
export const TOML = {
	parse: (text: string): object => (bun ? bun.TOML.parse(text) : parseToml(text)),
	stringify: stringifyToml,
};
export const JSON5 = { parse: JSON5Parser.parse, stringify: JSON5Parser.stringify };
export const JSONC = {
	parse(text: string): unknown {
		if (bun) return bun.JSONC.parse(text);
		const errors: ParseError[] = [];
		const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
		if (errors.length) {
			const error = errors[0];
			throw new SyntaxError(`${printParseErrorCode(error.error)} at offset ${error.offset}`);
		}
		return value;
	},
};

export interface JsonlChunkResult {
	values: unknown[];
	read: number;
	done: boolean;
	error: SyntaxError | null;
}

/** Parses complete JSON values while keeping original byte/character offsets at a streaming edge. */
export function parseJsonlChunk(input: HashInput, start = 0, end?: number): JsonlChunkResult {
	const source = typeof input === "string" ? input : hashBytes(input);
	const length = source.length;
	const limit = Math.min(end ?? length, length);
	let cursor = start;
	const values: unknown[] = [];
	const code =
		typeof source === "string" ? (offset: number) => source.charCodeAt(offset) : (offset: number) => source[offset];
	while (cursor < limit) {
		while (
			cursor < limit &&
			(code(cursor) === 32 || code(cursor) === 9 || code(cursor) === 13 || code(cursor) === 10)
		)
			cursor++;
		if (cursor === limit) break;
		const valueStart = cursor;
		const first = code(cursor);
		let depth = 0;
		let quoted = false;
		let escaped = false;
		const container = first === 123 || first === 91;
		const string = first === 34;
		for (; cursor < limit; cursor++) {
			const character = code(cursor);
			if (quoted) {
				if (escaped) escaped = false;
				else if (character === 92) escaped = true;
				else if (character === 34) {
					quoted = false;
					if (string && depth === 0) {
						cursor++;
						break;
					}
				}
			} else {
				if (character === 34) quoted = true;
				else if (character === 123 || character === 91) depth++;
				else if (character === 125 || character === 93) {
					depth--;
					if (container && depth <= 0) {
						cursor++;
						break;
					}
				} else if (
					!container &&
					!string &&
					(character === 32 || character === 9 || character === 13 || character === 10)
				)
					break;
			}
		}
		const text =
			typeof source === "string" ? source.slice(valueStart, cursor) : source.toString("utf8", valueStart, cursor);
		try {
			values.push(JSON.parse(text));
		} catch (error) {
			const syntax = error instanceof SyntaxError ? error : new SyntaxError(String(error));
			const atEdge = cursor === limit;
			const position = /position (\d+)/.exec(syntax.message);
			const incomplete =
				atEdge &&
				(/Unexpected (?:end|EOF)|Unterminated string/i.test(syntax.message) ||
					(position !== null && Number(position[1]) >= text.length) ||
					["t", "tr", "tru", "f", "fa", "fal", "fals", "n", "nu", "nul", "-"].includes(text));
			return { values, read: valueStart, done: false, error: incomplete ? null : syntax };
		}
	}
	return { values, read: cursor, done: cursor === limit, error: null };
}

export const JSONL = {
	parseChunk(input: HashInput, start?: number, end?: number): JsonlChunkResult {
		return bun
			? bun.JSONL.parseChunk(typeof input === "string" ? input : hashBytes(input), start, end)
			: parseJsonlChunk(input, start, end);
	},
	parse(input: HashInput): unknown[] {
		if (bun) return bun.JSONL.parse(typeof input === "string" ? input : hashBytes(input));
		const result = parseJsonlChunk(input);
		if (result.error && result.values.length === 0) throw result.error;
		return result.values;
	},
};
