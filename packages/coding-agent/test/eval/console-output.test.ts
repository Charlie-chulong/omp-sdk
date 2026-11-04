import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AsyncResource } from "node:async_hooks";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";

let runtime: JsRuntime;

function collect(): {
	hooks: RuntimeHooks;
	displays: EvalDisplayOutput[];
	texts: string[];
} {
	const displays: EvalDisplayOutput[] = [];
	const texts: string[] = [];
	const hooks: RuntimeHooks = {
		onText: (chunk: string) => {
			texts.push(chunk);
		},
		onDisplay: (output: EvalDisplayOutput) => {
			displays.push(output);
		},
		callTool: async () => undefined,
	};
	return { hooks, displays, texts };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
const PNG_IMAGE: ImageContent = { type: "image", data: PNG_BASE64, mimeType: "image/png" };

describe("JS console output", () => {
	beforeAll(() => {
		runtime = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "console-output-test",
		});
	});

	afterAll(() => {
		runtime.dispose();
	});

	it("prints a long plain object as inspect text and a JSON view of that exact text", async () => {
		const { hooks, displays, texts } = collect();
		await runtime.run(
			"console.log('rows:', { items: Array.from({ length: 12 }, (_, i) => ({ id: i })), total: 12n });",
			undefined,
			hooks,
		);
		const printed = texts.join("");
		expect(printed.startsWith("rows: {")).toBe(true);
		expect(displays).toHaveLength(1);
		const [output] = displays;
		if (output?.type !== "view") throw new Error("expected a JSON view");
		expect(printed).toContain(output.text);
		expect(output.text.startsWith("{")).toBe(true);
		expect(output.view).toEqual({
			kind: "json",
			value: { items: Array.from({ length: 12 }, (_, i) => ({ id: i })), total: "12" },
		});
	});

	it("prints JSON text as text plus a JSON view, other long strings as text only", async () => {
		const { hooks, displays, texts } = collect();
		const value = { items: Array.from({ length: 30 }, (_, i) => i) };
		const text = JSON.stringify(value);
		await runtime.run(`console.log(${JSON.stringify(text)}); console.log('{' + 'x'.repeat(100));`, undefined, hooks);
		expect(texts.join("")).toBe(`${text}\n{${"x".repeat(100)}\n`);
		expect(displays).toEqual([{ type: "view", text, view: { kind: "json", value } }]);
	});

	it("keeps short objects and class instances as text only", async () => {
		const { hooks, displays, texts } = collect();
		await runtime.run(
			"console.log({ a: 1 }); console.log(new Map(Array.from({ length: 20 }, (_, i) => [i, 'value']))); ",
			undefined,
			hooks,
		);
		expect(texts[0]).toBe("{ a: 1 }\n");
		expect(displays).toEqual([]);
	});

	it("echoes a final expression exactly as console.log does", async () => {
		const value = "({ nested: { list: Array.from({ length: 30 }, (_, i) => i) }, label: 'x' })";
		const logged = collect();
		await runtime.run(`console.log(${value});`, undefined, logged.hooks);
		const echoed = collect();
		runtime.echo(await runtime.run(value, undefined, echoed.hooks), echoed.hooks);
		expect(echoed.texts).toEqual(logged.texts);
		expect(echoed.displays).toEqual(logged.displays);
		expect(echoed.displays[0]?.type).toBe("view");

		const nothing = collect();
		runtime.echo(undefined, nothing.hooks);
		expect(nothing.texts).toEqual([]);
		expect(nothing.displays).toEqual([]);
	});

	it("routes overlapping async cells to their own output and final values", async () => {
		const firstGate = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		const firstReady = Promise.withResolvers<void>();
		const secondReady = Promise.withResolvers<void>();
		const first = collect();
		const second = collect();
		const concurrent = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "console-async-context",
			extraGlobals: { firstGate: firstGate.promise, secondGate: secondGate.promise },
		});
		try {
			first.hooks.onEvaluate = () => firstReady.resolve();
			second.hooks.onEvaluate = () => secondReady.resolve();
			const a = concurrent.run("await firstGate; print('first'); ({ cell: 'first' })", undefined, first.hooks);
			const b = concurrent.run(
				"await secondGate; console.log('second'); ({ cell: 'second' })",
				undefined,
				second.hooks,
			);
			await Promise.all([firstReady.promise, secondReady.promise]);
			secondGate.resolve();
			expect(await b).toEqual({ cell: "second" });
			expect(second.texts).toEqual(["second\n"]);
			expect(first.texts).toEqual([]);
			firstGate.resolve();
			expect(await a).toEqual({ cell: "first" });
			expect(first.texts).toEqual(["first\n"]);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
			concurrent.dispose();
		}
	});

	it("rejects output from a detached async context instead of silently succeeding", async () => {
		const detached = new AsyncResource("detached-eval-output");
		const isolated = new JsRuntime({
			initialCwd: process.cwd(),
			sessionId: "console-missing-context",
			extraGlobals: { detachedOutput: (callback: () => unknown) => detached.runInAsyncScope(callback) },
		});
		const { hooks, texts } = collect();
		try {
			await expect(isolated.run("detachedOutput(() => print('lost'))", undefined, hooks)).rejects.toThrow(
				"JS Eval async context is unavailable",
			);
			expect(texts).toEqual([]);
			await isolated.run("await Promise.resolve(); print('recovered');", undefined, hooks);
			expect(texts).toEqual(["recovered\n"]);
		} finally {
			detached.emitDestroy();
			isolated.dispose();
		}
	});

	it("prints an image record as a placeholder and emits the image with its metadata", async () => {
		const { hooks, displays, texts } = collect();
		runtime.echo({ ...PNG_IMAGE, detail: "high", url: "https://images.example/a.png" }, hooks);
		expect(texts).toEqual(["<image image/png>\n"]);
		expect(displays).toEqual([
			{
				type: "image",
				data: PNG_BASE64,
				mimeType: "image/png",
				detail: "high",
				url: "https://images.example/a.png",
			},
		]);
	});

	it.each<[string, unknown]>([
		["Uint8Array", PNG_BYTES],
		["ArrayBuffer", PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength)],
		// The puppeteer footgun: `uint8array.toString("base64")` falls through to Array.toString.
		["decimal CSV", Array.from(PNG_BYTES).toString()],
		["JSON-serialized Buffer", JSON.parse(JSON.stringify(Buffer.from(PNG_BYTES)))],
	])("base64-encodes %s image data", (_label, data) => {
		const { hooks, displays } = collect();
		runtime.echo({ type: "image", data, mimeType: "image/png" }, hooks);
		expect(displays).toEqual([PNG_IMAGE]);
	});

	it("prints records whose image data is unusable as plain text", () => {
		// Padding mid-string is not strict base64; the Anthropic API rejects it.
		for (const data of [{ not: "a buffer" }, "abcd=efg"]) {
			const { hooks, displays, texts } = collect();
			runtime.echo({ type: "image", data, mimeType: "image/png" }, hooks);
			expect(displays).toEqual([]);
			expect(texts.join("")).toContain("type: 'image'");
		}
	});
});
