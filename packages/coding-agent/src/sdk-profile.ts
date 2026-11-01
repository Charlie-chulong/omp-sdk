import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type NodeSdkProfile = "core" | "full";

let profile: NodeSdkProfile = "full";

/** Read the loaded SDK's own package, never the launcher's environment or working directory. */
export function initializeNodeSdkProfile(entryUrl: string): void {
	let directory = path.dirname(fileURLToPath(entryUrl));
	for (;;) {
		let manifest: { name?: string; ompNodeSdk?: { profile?: string } } | undefined;
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		if (manifest?.name === "@oh-my-pi/pi-coding-agent") {
			profile = manifest.ompNodeSdk?.profile === "core" ? "core" : "full";
			return;
		}
		const parent = path.dirname(directory);
		if (parent === directory) throw new Error(`Cannot locate the Node SDK package for ${entryUrl}`);
		directory = parent;
	}
}

/** Source/Bun and ordinary SDK packages retain all optional local capabilities. */
export function isCoreSdk(): boolean {
	return profile === "core";
}

export function assertLocalRuntimeAvailable(feature: string): void {
	if (isCoreSdk()) {
		throw new Error(
			`${feature} is unavailable in the core Node SDK profile. Configure a remote model/service or use the full SDK profile for offline inference.`,
		);
	}
}
