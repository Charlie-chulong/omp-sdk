import { describe, expect, it } from "bun:test";
import { JsonLexer, QUOTE } from "@oh-my-pi/pi-utils/json-lexer";
import { parseStreamingJson } from "@oh-my-pi/pi-utils/json-parse";

/**
 * Exact decoding and incremental progress for escape-dense strings, sibling
 * values, cursor rollback, and split escapes. Performance measurements live in
 * bench/json-lexer-string-scan.bench.ts rather than depending on CI wall time.
 */
describe("JsonLexer string scan", () => {
	it.each([
		["`", 0x60],
		["「", 0x300c],
	] as const)("honors a nonstandard %s delimiter after a long run", (delimiter, quote) => {
		const prefix = "prefix: ";
		const value = "abc".repeat(32);
		const lexer = new JsonLexer(`${prefix}${delimiter}${value}${delimiter},next`, "strict", prefix.length);

		expect(lexer.string(quote)).toEqual({ value, complete: true, stableLen: value.length });
		expect(lexer.src.slice(lexer.pos)).toBe(",next");
	});

	it("does not reinterpret a wrapped delimiter as an escape while streaming", () => {
		const value = `${"abc".repeat(32)}\`,next`;
		const lexer = new JsonLexer(`\`${value}`, "incoming");
		expect(lexer.string(0x10060)).toEqual({ value, complete: false, stableLen: value.length });
	});

	it("decodes adjacent escaped slashes and reports complete stable progress", () => {
		const escapes = 4096;
		const src = `"${"\\\\".repeat(escapes)}${"x".repeat(64)}"`;
		expect(new JsonLexer(src, "strict").string(QUOTE)).toEqual({
			value: `${"\\".repeat(escapes)}${"x".repeat(64)}`,
			complete: true,
			stableLen: escapes + 64,
		});
	});

	it("decodes long mixed escapes before a distant closing quote", () => {
		const src = `"${`${"a".repeat(64)}\\n`.repeat(4096)}${"x".repeat(64)}"`;
		expect(new JsonLexer(src, "strict").string(QUOTE).value).toBe(JSON.parse(src));
	});

	it("preserves every escape-free sibling value in an incomplete object", () => {
		const entries = Array.from({ length: 512 }, (_, k) => [`key${k}`, `value number ${k}`] as const);
		const json = JSON.stringify(Object.fromEntries(entries));
		// Drop the closing `}` so the lexer parses it, not the JSON.parse fast path.
		const parsed = parseStreamingJson<Record<string, string>>(json.slice(0, -1));
		expect(parsed).toEqual(Object.fromEntries(entries));
	});

	it("re-searches backslashes when the cursor moves before the cached range", () => {
		const first = '"a\\nb"';
		const src = `${first} "${"x".repeat(64)}"`;
		const lexer = new JsonLexer(src, "strict", first.length + 1);
		expect(lexer.string(QUOTE).value).toBe("x".repeat(64));

		lexer.pos = 0;
		expect(lexer.string(QUOTE)).toEqual({ value: "a\nb", complete: true, stableLen: 3 });
	});

	it("decodes long mixed runs of text and escapes", () => {
		const body = 'C:\\\\Users\\\\me\\\\file \\"quoted\\" \\n line \\u00e9 '.repeat(400);
		const src = `"${body}"`;
		expect(new JsonLexer(src, "strict").string(QUOTE).value).toBe(JSON.parse(src));
	});

	it("keeps a trailing split escape unstable after skipping a long run", () => {
		const prefix = "x".repeat(128);
		expect(new JsonLexer(`"${prefix}\\uD83D`, "incoming").string(QUOTE)).toEqual({
			value: `${prefix}\ud83d`,
			stableLen: prefix.length,
			complete: false,
		});
		// No closing `"}`: complete JSON would take the JSON.parse fast path.
		expect(parseStreamingJson<{ text: string }>(`{"text":"${prefix}\\uD83D\\uDE00`)).toEqual({
			text: `${prefix}😀`,
		});
	});

	it("preserves inner quote recovery and following fields after a long run", () => {
		const prefix = "x".repeat(128);
		expect(
			parseStreamingJson<{ text: string; next: number }>(`{"text":"${prefix}say "hello" again", "next": 1}`),
		).toEqual({
			text: `${prefix}say "hello" again`,
			next: 1,
		});
	});
});
