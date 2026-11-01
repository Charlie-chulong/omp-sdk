import * as fs from "node:fs";
import { z } from "@oh-my-pi/omptype/zod";

const nodeSdkModuleMapSchema = z.object({
	version: z.literal(1),
	modules: z.record(z.string(), z.string()),
});

let mapUrl: URL | undefined;
let modulePaths: Record<string, string> | undefined;

/** Register the packaged entry location without evaluating extension modules. */
export function setNodeSdkModuleMap(entryUrl: string): void {
	const next = new URL("./modules.json", entryUrl);
	if (mapUrl?.href === next.href) return;
	mapUrl = next;
	modulePaths = undefined;
}

/** Resolve an extension import to the host's shared, compiled module instance. */
export function resolveNodeSdkModule(specifier: string): string | null {
	if (!mapUrl) return null;
	if (!modulePaths) {
		const manifest = nodeSdkModuleMapSchema.parse(JSON.parse(fs.readFileSync(mapUrl, "utf8")));
		modulePaths = manifest.modules;
	}
	const target = modulePaths[specifier];
	if (target === undefined) return null;
	return new URL(target, mapUrl).href;
}
