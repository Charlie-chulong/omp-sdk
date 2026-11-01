import * as native from "@oh-my-pi/pi-natives";

/** Optional features compiled into the loaded native addon, independent of SDK profile. */
export interface NativeCapabilities {
	smollm: boolean;
	liveVoice: boolean;
	wasmGrammars: boolean;
}

/** Query the addon itself; an old addon must be rebuilt, not guessed to support a feature. */
export function readNativeCapabilities(): NativeCapabilities {
	const query = (native as typeof native & { nativeCapabilities?: () => NativeCapabilities }).nativeCapabilities;
	if (typeof query !== "function") {
		throw new Error(
			"The native addon cannot report its build capabilities. Rebuild with `bun --cwd=packages/natives run build:bindings` (full) or `build:desktop` (Desktop), then restage the SDK.",
		);
	}
	return query();
}

export function assertNativeCapability(capability: keyof NativeCapabilities, feature: string): void {
	if (!readNativeCapabilities()[capability]) {
		throw new Error(
			`${feature} is unavailable in this native build. Use the full native SDK/CLI build for this feature; Desktop omits SmolLM, native WebRTC/Opus live voice, and WASM grammars.`,
		);
	}
}
