/**
 * Escape-dense string scan: equal encoded work at two input sizes.
 * Reports the original best-of-five cost ratio without a CI wall-time gate.
 *
 * Run: bun packages/utils/bench/json-lexer-string-scan.bench.ts
 */
import { JsonLexer, QUOTE } from "../src/json-lexer";

const UNIT = "a\\\\";
let decodedCharacters = 0;

function lexCost(units: number, runs: number): number {
	const src = `"${UNIT.repeat(units)}"`;
	let best = Number.POSITIVE_INFINITY;
	for (let trial = 0; trial < 5; trial++) {
		const start = Bun.nanoseconds();
		for (let run = 0; run < runs; run++) decodedCharacters += new JsonLexer(src, "strict").string(QUOTE).value.length;
		best = Math.min(best, (Bun.nanoseconds() - start) / 1e6);
	}
	return best;
}

lexCost(2_048, 8);
lexCost(16_384, 1);
const short = lexCost(2_048, 64);
const long = lexCost(16_384, 8);
console.log(`2048 units x64: ${short.toFixed(3)}ms`);
console.log(`16384 units x8: ${long.toFixed(3)}ms`);
console.log(`Long/short equal-work ratio: ${(long / short).toFixed(3)} (informational)`);
console.log(`Decoded characters consumed: ${decodedCharacters}`);
