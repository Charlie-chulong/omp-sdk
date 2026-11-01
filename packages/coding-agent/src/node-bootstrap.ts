import { fileURLToPath } from "node:url";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils/env";
import { setNodeWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { setNodeSdkModuleMap } from "./extensibility/plugins/node-module-map";
import { initializeNodeSdkProfile } from "./sdk-profile";

/** Initialize the Node backend without changing Bun CLI worker ownership. */
export function initializeNodeSdk(entryUrl: string): void {
	initializeNodeSdkProfile(entryUrl);
	setTerminalHeadless(true);
	setNodeWorkerHostEntry(fileURLToPath(new URL("./host.mjs", entryUrl)));
	setNodeSdkModuleMap(entryUrl);
}
