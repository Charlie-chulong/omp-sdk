import { createRequire } from "node:module";
import type sharp from "sharp";
import type { Sharp, KernelEnum } from "sharp";

export interface ImageMetadata {
	width: number;
	height: number;
	format: string;
}
export interface ImageOptions {
	maxPixels?: number;
}
export interface ImageResizeOptions {
	filter?: keyof KernelEnum;
}

// Bun's optional native class is an in-process runtime boundary.
const host = globalThis as unknown as { Bun?: { Image?: typeof Image } };
const bunImage = host.Bun?.Image;
const require = createRequire(import.meta.url);
let nodeSharp: typeof sharp | undefined;

/** Image operations use the native Bun pipeline or sharp's real Node image codec. */
export class Image {
	#pipeline!: Sharp;
	constructor(input: Uint8Array | ArrayBuffer, options?: ImageOptions) {
		if (bunImage) return new bunImage(input, options);
		nodeSharp ??= require("sharp") as typeof sharp;
		const bytes =
			input instanceof ArrayBuffer
				? Buffer.from(input)
				: Buffer.from(input.buffer, input.byteOffset, input.byteLength);
		this.#pipeline = nodeSharp(bytes, { limitInputPixels: options?.maxPixels });
	}
	async metadata(): Promise<ImageMetadata> {
		const metadata = await this.#pipeline.metadata();
		if (metadata.width === undefined || metadata.height === undefined || metadata.format === undefined) {
			throw new Error("Image decoder did not return dimensions and format");
		}
		return { width: metadata.width, height: metadata.height, format: metadata.format };
	}
	resize(width: number, height: number, options?: ImageResizeOptions): this {
		this.#pipeline = this.#pipeline.resize(width, height, { fit: "fill", kernel: options?.filter ?? "lanczos3" });
		return this;
	}
	png(options?: { compressionLevel?: number }): this {
		// The RGBA readback consumer requires RGBA8 rows with PNG filter 0.
		this.#pipeline = this.#pipeline.toColourspace("srgb").ensureAlpha().png({
			compressionLevel: options?.compressionLevel,
			adaptiveFiltering: false,
			palette: false,
			force: true,
		});
		return this;
	}
	jpeg(options?: { quality?: number }): this {
		this.#pipeline = this.#pipeline.jpeg(options);
		return this;
	}
	webp(options?: { quality?: number }): this {
		this.#pipeline = this.#pipeline.webp(options);
		return this;
	}
	gif(): this {
		this.#pipeline = this.#pipeline.gif();
		return this;
	}
	async bytes(): Promise<Uint8Array> {
		return this.#pipeline.toBuffer();
	}
	async toBuffer(): Promise<Buffer> {
		return this.#pipeline.toBuffer();
	}
	async toBase64(): Promise<string> {
		return (await this.#pipeline.toBuffer()).toString("base64");
	}
}
