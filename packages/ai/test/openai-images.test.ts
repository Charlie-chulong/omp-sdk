import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { generateOpenAIImage } from "../src/images/openai-images";
import type { FetchImpl } from "../src/types";

const IMAGE_DATA = Buffer.from("image bytes").toString("base64");
const INPUT_IMAGE = { data: IMAGE_DATA, mimeType: "image/png" };

function imageModel(provider: string, id: string) {
	return buildModel({
		id,
		name: id,
		api: "openai-images",
		provider,
		baseUrl: `https://${provider}.example/v1`,
		kind: "image",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} satisfies ModelSpec<"openai-images">);
}

function imageResponse(status = 200): Response {
	const body =
		status === 200
			? { data: [{ b64_json: IMAGE_DATA }] }
			: { error: { message: "UnsupportedParamsError: response_format is not supported" } };
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenAI-compatible image response_format", () => {
	test("GPT Image generation of a dated snapshot succeeds through a strict gateway", async () => {
		const model = imageModel("gateway", "gpt-image-2.5-2026-08-01");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			const requestBody: Record<string, unknown> = JSON.parse(String(init?.body));
			body = requestBody;
			return imageResponse("response_format" in requestBody ? 400 : 200);
		};

		const result = await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });

		expect(body?.model).toBe("gpt-image-2.5-2026-08-01");
		expect(body).not.toHaveProperty("response_format");
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("ChatGPT Image JSON edits omit the unsupported parameter", async () => {
		const model = imageModel("gateway", "chatgpt-image-latest");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			const requestBody: Record<string, unknown> = JSON.parse(String(init?.body));
			body = requestBody;
			return imageResponse("response_format" in requestBody ? 400 : 200);
		};

		const result = await generateOpenAIImage(
			model,
			{ prompt: "paint this", inputImages: [INPUT_IMAGE] },
			{ apiKey: "test", fetch },
		);

		expect(body?.input_references).toEqual([{ type: "image_url", url: `data:image/png;base64,${IMAGE_DATA}` }]);
		expect(body).not.toHaveProperty("response_format");
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("OpenAI GPT Image multipart edits omit the unsupported form field", async () => {
		const model = imageModel("openai", "gpt-image-1");
		let form: FormData | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart image edit");
			form = init.body;
			return imageResponse(form.has("response_format") ? 400 : 200);
		};

		const result = await generateOpenAIImage(
			model,
			{ prompt: "paint this", inputImages: [INPUT_IMAGE] },
			{ apiKey: "test", fetch },
		);

		expect(form?.get("model")).toBe("gpt-image-1");
		expect(form?.get("image")).toBeInstanceOf(File);
		expect(form?.has("response_format")).toBe(false);
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("non-GPT image generation and JSON edits retain response_format", async () => {
		const model = imageModel("gateway", "flux-1");
		const bodies: Array<Record<string, unknown>> = [];
		const fetch: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return imageResponse();
		};

		await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });
		await generateOpenAIImage(model, { prompt: "paint", inputImages: [INPUT_IMAGE] }, { apiKey: "test", fetch });

		expect(bodies[0]?.response_format).toBe("b64_json");
		expect(bodies[1]?.response_format).toBe("b64_json");
	});

	test("xAI image generation retains response_format", async () => {
		const model = imageModel("xai", "grok-imagine-image");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return imageResponse();
		};

		await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });

		expect(body?.response_format).toBe("b64_json");
		expect(body?.resolution).toBe("1k");
	});

	test("DALL-E multipart edits retain response_format", async () => {
		const model = imageModel("openai", "dall-e-2");
		let form: FormData | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart image edit");
			form = init.body;
			return imageResponse();
		};

		await generateOpenAIImage(model, { prompt: "paint", inputImages: [INPUT_IMAGE] }, { apiKey: "test", fetch });

		expect(form?.get("response_format")).toBe("b64_json");
	});
});

describe("OpenAI image edit multipart wire contract", () => {
	test.each([
		{ name: "single DALL-E reference", modelId: "dall-e-2", count: 1, imageField: "image" },
		{ name: "multiple GPT Image references", modelId: "gpt-image-2.6-sunburst", count: 2, imageField: "image[]" },
	])(
		"$name reaches a strict multipart endpoint without losing image bytes",
		async ({ modelId, count, imageField }) => {
			const inputs = [
				INPUT_IMAGE,
				{ data: Buffer.from("second original image").toString("base64"), mimeType: "image/png" },
			].slice(0, count);
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (!request.headers.get("content-type")?.startsWith("multipart/form-data;")) {
						return Response.json({ error: { message: "Multipart image edit required" } }, { status: 415 });
					}
					const form = await request.formData();
					const files = form.getAll(imageField);
					const otherField = imageField === "image[]" ? "image" : "image[]";
					if (files.length !== count || form.has(otherField)) {
						return Response.json({ error: { message: "Invalid image array parameter" } }, { status: 400 });
					}
					for (let index = 0; index < files.length; index++) {
						const file = files[index];
						if (
							!(file instanceof File) ||
							!Buffer.from(await file.arrayBuffer()).equals(Buffer.from(inputs[index]!.data, "base64"))
						) {
							return Response.json({ error: { message: "Reference image bytes changed" } }, { status: 400 });
						}
					}
					return imageResponse();
				},
			});
			try {
				const model = { ...imageModel("openai", modelId), baseUrl: `${server.url.href}v1` };
				const result = await generateOpenAIImage(
					model,
					{ prompt: "Refine these references", inputImages: inputs },
					{ apiKey: "fixture-key", signal: AbortSignal.timeout(5000) },
				);
				expect(result.images[0]?.data).toBe(IMAGE_DATA);
			} finally {
				await server.stop(true);
			}
		},
	);
});
