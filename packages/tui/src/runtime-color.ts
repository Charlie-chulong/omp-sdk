import type { RGB } from "@oh-my-pi/pi-utils/color";
import { converter, formatCss } from "culori";

// Bun keeps its native color parser; Desktop Node uses the CSS Color 4 parser.
const toRgb = converter("rgb");

type Rgba = RGB & { a: number };
type ColorFormat = "css" | "ansi-16m" | "ansi-256" | "{rgb}" | "{rgba}";

function ansi256(r: number, g: number, b: number): number {
	if (r === g && g === b) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

/** Parse a CSS color and produce terminal SGR or byte-valued RGB channels. */
export function runtimeColor(input: string, format: "{rgb}"): RGB | null;
export function runtimeColor(input: string, format: "{rgba}"): Rgba | null;
export function runtimeColor(input: string, format: "css" | "ansi-16m" | "ansi-256"): string | null;
export function runtimeColor(input: string, format: ColorFormat): RGB | Rgba | string | null {
	if (typeof Bun !== "undefined") {
		if (format === "{rgb}") return Bun.color(input, "{rgb}");
		if (format === "{rgba}") return Bun.color(input, "{rgba}");
		return Bun.color(input, format);
	}
	const parsed = toRgb(input);
	if (!parsed) return null;
	const byte = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * 255);
	const r = byte(parsed.r);
	const g = byte(parsed.g);
	const b = byte(parsed.b);
	switch (format) {
		case "{rgb}":
			return { r, g, b };
		case "{rgba}":
			return { r, g, b, a: parsed.alpha ?? 1 };
		case "css":
			return formatCss(parsed);
		case "ansi-16m":
			return `\x1b[38;2;${r};${g};${b}m`;
		case "ansi-256":
			return `\x1b[38;5;${ansi256(r, g, b)}m`;
	}
}
