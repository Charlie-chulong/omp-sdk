#!/usr/bin/env node
import "./node-platform";
import { initializeNodeSdk } from "./node-bootstrap";
import { declareWorkerHostEntry, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import { runWorkerEntrypoint } from "./cli/worker-dispatch";
import { run } from "@oh-my-pi/pi-utils/cli";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import BrowserRelay from "./commands/browser-relay";

initializeNodeSdk(import.meta.url);
// Node SDK workers re-enter this host using the same selectors as the Bun CLI.
declareWorkerHostEntry();
const selector = process.argv[2];
if (selector === "browser-relay") {
	await run({
		bin: "omp-desktop",
		version: VERSION,
		argv: process.argv.slice(2),
		commands: [{ name: "browser-relay", load: async () => BrowserRelay }],
	});
} else if (!isWorkerHostSelector(selector) || !(await runWorkerEntrypoint(selector))) {
	process.stderr.write(`Unknown Node SDK worker selector: ${selector ?? "(missing)"}\n`);
	process.exitCode = 1;
}
