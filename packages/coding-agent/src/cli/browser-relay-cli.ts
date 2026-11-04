/**
 * `omp browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { probeRelayServer } from "../tools/browser/relay/daemon";
import { defaultRelayExtensionDir, writeRelayExtension } from "../tools/browser/relay/extension-files";
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { browserRelayCommand, probeRelayStatus } from "../tools/browser/relay/probe";
import { type RelayServer, startRelayServer } from "../tools/browser/relay/server";

export const BROWSER_RELAY_ACTIONS = ["serve", "status", "install"] as const;
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	token?: string;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Gather tabs the agent actively drives into an 'omp' Chrome tab group (default true). */
	group?: boolean;
	verbose?: boolean;
	json?: boolean;
}

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	if (args.action === "status") {
		const endpoint = `http://127.0.0.1:${args.port}`;
		const status = await probeRelayStatus(endpoint);
		if (args.json) console.log(JSON.stringify({ endpoint, ...status }));
		else {
			console.log(`OMP Browser Relay at ${endpoint}: ${status.outcome}`);
			if (status.version)
				console.log(
					`  relay ${status.version}; protocol ${status.relayProtocol ?? "missing"}; extension protocol ${status.extensionProtocol ?? "missing"}; CDP clients ${status.cdpClients ?? "unknown"}`,
				);
			if (status.outcome === "unreachable")
				console.log(`Start it with \`${browserRelayCommand()} serve --port ${args.port}\`.`);
			if (status.outcome === "no-extension" || status.outcome === "extension-gone")
				console.log("Load and enable the OMP Browser Relay extension in your existing Chrome profile.");
			if (status.outcome === "not-relay")
				console.log("The port belongs to another HTTP service; it was not modified.");
		}
		return;
	}
	if (args.action === "install") {
		await runInstall(args.dir);
		return;
	}
	await runServe(args);
}

async function runInstall(dirOverride: string | undefined): Promise<void> {
	const dir = dirOverride ? path.resolve(dirOverride) : defaultRelayExtensionDir();
	await writeRelayExtension(dir, VERSION);
	console.log(`Installed the OMP Browser Relay extension to ${dir}`);
	console.log("");
	console.log("Finish setup in Chrome:");
	console.log("  1. Open chrome://extensions and enable Developer mode.");
	console.log(`  2. Click "Load unpacked" and select: ${dir}`);
	if (typeof Bun === "undefined") console.log("  3. Set PI_BROWSER_RELAY=1 in the Desktop OMP provider environment.");
	else console.log("  3. Enable the mode:  omp config set browser.relay true");
	console.log("");
	console.log("The browser prelude starts the relay automatically when needed;");
	console.log(`run \`${browserRelayCommand()} serve\` yourself only for --token or --no-group.`);
	console.log("The extension badge shows 'on' once it reaches a relay.");
	if (!dirOverride) console.log("Newer omp versions update the extension in this folder and reload it on their own.");
	console.log(
		"Old connection-refused entries in chrome://extensions > Errors may persist after reconnect; use Clear all.",
	);
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
			}
		: undefined;
	let relay: RelayServer;
	try {
		relay = await startRelayServer({ port: args.port, token: args.token, group: args.group !== false, log });
	} catch (err) {
		// The port is machine-global while relays can be started by any project's
		// broker (or by hand): losing the bind to a live relay is success.
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			const endpoint = `http://127.0.0.1:${args.port}`;
			if (await probeRelayServer(endpoint)) {
				const status = await probeRelayStatus(endpoint);
				console.log(
					`OMP browser relay already running on ${endpoint}: ${status.outcome}; existing service left unchanged.`,
				);
				if (status.outcome === "outdated-relay" || status.outcome === "outdated-extension") process.exitCode = 1;
				return;
			}
			throw new Error(
				`Port ${args.port} is in use by something that is not an OMP browser relay. Existing service left unchanged; run \`${browserRelayCommand()} status --port ${args.port}\`.`,
			);
		}
		throw err;
	}

	console.log(`omp browser relay listening on http://127.0.0.1:${args.port}`);
	console.log(`  extension endpoint  ws://127.0.0.1:${args.port}/ext${args.token ? "?token=***" : ""}`);
	if (typeof Bun === "undefined") {
		console.log(`  Desktop relay URL   http://127.0.0.1:${args.port}`);
	} else if (args.port === DEFAULT_RELAY_PORT) {
		console.log("  enable with         omp config set browser.relay true");
	} else {
		console.log(
			`  enable with         omp config set browser.relay true && omp config set browser.relayUrl http://127.0.0.1:${args.port}`,
		);
	}
	console.log(`Waiting for the OMP Browser Relay extension to connect (${browserRelayCommand()} install)...`);

	let announced = false;
	const readiness = setInterval(() => {
		if (relay.bridge.ready && !announced) {
			announced = true;
			console.log("Extension connected. The omp browser prelude can now drive your tabs.");
		} else if (!relay.bridge.ready && announced) {
			announced = false;
			console.log("Extension disconnected; waiting for it to reconnect...");
		}
	}, 500);

	const shutdown = () => {
		clearInterval(readiness);
		relay.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await Promise.withResolvers<never>().promise;
}
