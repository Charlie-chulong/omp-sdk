import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadMnemopiConfig } from "../src/mnemopi/config";
import { MnemopiEmbedClient } from "../src/mnemopi/embed-client";
import { ensureSmolLmWeights } from "../src/predict/smollm-weights";
import { initializeNodeSdkProfile } from "../src/sdk-profile";
import { AuthStorage } from "../src/session/auth-storage";
import { SttClient } from "../src/stt/asr-client";
import { TinyTitleClient } from "../src/tiny/title-client";
import { TtsClient } from "../src/tts/tts-client";

describe("loaded Node SDK profile", () => {
	let directory: TempDir;

	async function select(profile?: "core" | "full"): Promise<void> {
		await Bun.write(
			path.join(directory.path(), "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", ...(profile ? { ompNodeSdk: { profile } } : {}) }),
		);
		initializeNodeSdkProfile(pathToFileURL(path.join(directory.path(), "dist", "node", "sdk.mjs")).href);
	}

	beforeEach(async () => {
		directory = TempDir.createSync("@sdk-profile-");
		await fs.mkdir(path.join(directory.path(), "dist", "node"), { recursive: true });
	});

	afterEach(async () => {
		initializeNodeSdkProfile(import.meta.url);
		await directory.remove();
	});

	test("local model discovery follows the loaded profile and returns after switching back to full", async () => {
		const auth = await AuthStorage.create(":memory:");
		const registry = () => new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
		try {
			await select();
			expect(registry().find("local", "kokoro")?.api).toBe("local-inference");
			await select("core");
			const core = registry();
			expect(core.getAll("all").some(model => model.api === "local-inference")).toBe(false);
			expect(core.getAll("all").some(model => model.api === "openai-speech")).toBe(true);
			expect(core.find("local", "kokoro")).toBeUndefined();
			await select("full");
			expect(registry().find("local", "kokoro")?.api).toBe("local-inference");
		} finally {
			auth.close();
		}
	});

	test("core rejects offline operations before any worker or download", async () => {
		await select("core");
		const unsupported = /core Node SDK profile.*remote.*full SDK profile/;
		await expect(new TinyTitleClient().chat("lfm2.5-350m", [])).rejects.toThrow(unsupported);
		await expect(new TinyTitleClient().downloadModel("lfm2.5-350m")).rejects.toThrow(unsupported);
		await expect(new TtsClient().synthesize("kokoro", "hello")).rejects.toThrow(unsupported);
		await expect(new TtsClient().downloadModel("kokoro")).rejects.toThrow(unsupported);
		await expect(new SttClient().transcribe("whisper-base", new Float32Array())).rejects.toThrow(unsupported);
		await expect(new MnemopiEmbedClient().load("fast-bge-base-en-v1.5", undefined)).rejects.toThrow(unsupported);
		await expect(ensureSmolLmWeights()).rejects.toThrow(unsupported);
	});

	test("core rejects memory configurations that would load excluded local runtimes", async () => {
		await select("core");
		expect(() => loadMnemopiConfig(Settings.isolated({}), directory.path())).toThrow(/embeddingApiUrl/);
		expect(() =>
			loadMnemopiConfig(
				Settings.isolated({ "mnemopi.embeddingApiUrl": "https://embeddings.example/v1" }),
				directory.path(),
			),
		).toThrow(/mnemopi.llmMode/);
	});
});
