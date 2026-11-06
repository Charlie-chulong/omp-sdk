import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { generateImage } from "../src/images";
import { portableFetch } from "../src/utils/node-fetch";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("portable fetch uploads host FormData as binary multipart instead of text/plain", async () => {
	const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (!request.headers.get("content-type")?.startsWith("multipart/form-data;")) {
				return Response.json({ error: "Expected multipart upload" }, { status: 415 });
			}
			const form = await request.formData();
			const file = form.get("file");
			if (!(file instanceof File)) return Response.json({ error: "Missing file" }, { status: 400 });
			return Response.json({
				title: form.get("title"),
				filename: file.name,
				mimeType: file.type,
				bytes: [...new Uint8Array(await file.arrayBuffer())],
				authorization: request.headers.get("authorization"),
			});
		},
	});
	try {
		const form = new FormData();
		form.set("title", "原始图片");
		form.set("file", new File([bytes], "参考.png", { type: "image/png" }));
		const response = await portableFetch()(server.url, {
			method: "POST",
			headers: { Authorization: "Bearer fixture-key" },
			body: form,
			signal: AbortSignal.timeout(5000),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			title: "原始图片",
			filename: "参考.png",
			mimeType: "image/png",
			bytes: [...bytes],
			authorization: "Bearer fixture-key",
		});
	} finally {
		await server.stop(true);
	}
});

test("Codex image edits preserve subscription routing, account headers, and streamed images", async () => {
	const sessionId = "fixture-session";
	const apiKey = `fixture.${Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
	).toString("base64url")}.signature`;
	const inputImages = [
		{ data: PNG_DATA, mimeType: "image/png" },
		{
			data: Buffer.concat([Buffer.from(PNG_DATA, "base64"), Buffer.from([42])]).toString("base64"),
			mimeType: "image/png",
		},
	];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST" || new URL(request.url).pathname !== "/backend-api/codex/responses") {
				return Response.json({ error: "Invalid subscription route" }, { status: 404 });
			}
			if (
				request.headers.get("authorization") !== `Bearer ${apiKey}` ||
				request.headers.get("chatgpt-account-id") !== "fixture-account" ||
				request.headers.get("session_id") !== sessionId ||
				request.headers.get("conversation_id") !== sessionId ||
				request.headers.get("openai-beta") !== "responses=experimental"
			) {
				return Response.json({ error: "Missing subscription request headers" }, { status: 401 });
			}
			if (!request.headers.get("content-type")?.startsWith("application/json")) {
				return Response.json({ error: "Subscription requests require JSON" }, { status: 415 });
			}
			const body = (await request.json()) as {
				model?: string;
				stream?: boolean;
				store?: boolean;
				tool_choice?: { type?: string };
				tools?: Array<{ type?: string; action?: string; model?: string }>;
				input?: Array<{ content?: Array<{ type?: string; image_url?: string }> }>;
			};
			const references = body.input?.[0]?.content?.filter(part => part.type === "input_image");
			if (
				body.model !== "gpt-6.1-sol" ||
				body.stream !== true ||
				body.store !== false ||
				body.tool_choice?.type !== "image_generation" ||
				body.tools?.[0]?.type !== "image_generation" ||
				body.tools[0].action !== "edit" ||
				body.tools[0].model !== undefined ||
				references?.length !== inputImages.length ||
				references.some(
					(reference, index) => reference.image_url !== `data:image/png;base64,${inputImages[index]!.data}`,
				)
			) {
				return Response.json({ error: "Invalid hosted subscription edit" }, { status: 400 });
			}
			const events = [
				{
					type: "response.output_item.done",
					item: { type: "image_generation_call", result: PNG_DATA, size: "1024x1536", quality: "high" },
				},
				{
					type: "response.completed",
					response: {
						output: [],
						tools: [{ type: "image_generation", model: "host-selected-image" }],
					},
				},
			];
			const data = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
			const bodyStream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(data.subarray(0, 17));
					controller.enqueue(data.subarray(17));
					controller.close();
				},
			});
			return new Response(bodyStream, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	try {
		const carrier = buildModel({
			provider: "openai-codex",
			id: "gpt-6.1-sol",
			name: "fixture subscription carrier",
			api: "openai-codex-responses",
			baseUrl: `${server.url.href}backend-api`,
			kind: "chat",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		});
		const imageModel = buildModel({ ...carrier, id: "gpt-image-2", name: "fixture image model", kind: "image" });
		const result = await generateImage(
			imageModel,
			{
				prompt: "Refine the reference image",
				imageSize: "1024x1536",
				inputImages,
			},
			{ apiKey, carrier, sessionId, signal: AbortSignal.timeout(5000) },
		);
		expect(result.images).toEqual([{ data: PNG_DATA, mimeType: "image/png", size: "1024x1536", quality: "high" }]);
		expect(result.model).toBe("host-selected-image");
	} finally {
		await server.stop(true);
	}
});
