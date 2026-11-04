/**
 * Broker-owned browser relay daemon.
 *
 * The MV3 extension can only dial OUT (service workers cannot listen on
 * sockets), so a native process must own the relay port. Instead of making
 * the user run `omp browser-relay` by hand, the relay kind lazily starts one
 * under a profile-independent, machine-global daemon broker. Every relay
 * consumer holds a connection to that broker, so one project exiting cannot
 * tear down the fixed-port singleton while another project still uses it.
 *
 * A manually started relay may already own the port. Consumers still acquire
 * the global broker lease before probing, then adopt that external server
 * without attempting another bind.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { daemonClientForGlobal } from "../../../launch/client";
import { describeQuietly, waitReady } from "../../../launch/ensure";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../../../subprocess/worker-client";
import { throwIfAborted } from "../../tool-errors";
import { DEFAULT_RELAY_URL } from "./kind";
import { probeRelayStatus } from "./probe";

const DEFAULT_RELAY_PORT = new URL(DEFAULT_RELAY_URL).port;

/** Broker daemon name for the relay on `port`; one per port, so relays on different ports never replace each other. */
function relayDaemonName(port: string): string {
	return port === DEFAULT_RELAY_PORT ? "omp.browser.relay" : `omp.browser.relay.${port}`;
}

function relayPort(cdpUrl: string): string | null {
	try {
		return String(new URL(cdpUrl).port || 80);
	} catch {
		return null;
	}
}

const RELAY_BROKER_SCOPE = "browser-relay";
/** Matches the serve banner (`omp browser relay listening on http://…`). */
const READY_LOG_PATTERN = String.raw`browser relay listening on http://\S+`;
const READY_TIMEOUT_MS = 15_000;
/** probe→describe→start rounds; bounds cross-process start races without replacing live services. */
const ENSURE_ATTEMPTS = 3;

/** True only for an identified OMP relay, including one waiting for its extension or requiring an upgrade. */
export async function probeRelayServer(cdpUrl: string): Promise<boolean> {
	const status = await probeRelayStatus(cdpUrl);
	return status.version !== "";
}

/** Auto-start is only safe for endpoints this machine can own. */
export function isLoopbackRelayUrl(cdpUrl: string): boolean {
	try {
		const { hostname } = new URL(cdpUrl);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

/**
 * Ensure a relay server answers at `cdpUrl`, starting the broker-owned daemon
 * when nothing is serving. Returns true once the HTTP endpoint responds — the
 * extension handshake (503 → 200) is the caller's wait. False when the relay
 * could not be started (broker unavailable or start rounds exhausted).
 */
export async function ensureRelayDaemon(opts: { cdpUrl: string; signal?: AbortSignal }): Promise<boolean> {
	const port = relayPort(opts.cdpUrl);
	if (port === null) return false;
	const name = relayDaemonName(port);
	// Open the lazy client before probing. Merely caching SocketDaemonClient
	// would not create the broker connection (and therefore would hold no lease).
	const client = await daemonClientForGlobal(RELAY_BROKER_SCOPE);
	throwIfAborted(opts.signal);
	await client.request({ op: "ping" }, opts.signal);
	const initial = await probeRelayStatus(opts.cdpUrl, opts.signal);
	if (initial.version) return true;
	if (initial.outcome !== "unreachable") return false;
	const spawn = resolveWorkerSpawnCmd("browser-relay");
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);
		// A manual serve or concurrent global-broker start may have won the
		// port since the last round; adopt it instead of fighting the bind.
		const status = await probeRelayStatus(opts.cdpUrl, opts.signal);
		if (status.version) return true;
		if (status.outcome !== "unreachable") return false;
		const existing = await describeQuietly(client, name, "Browser relay", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) await waitReady(client, name, "Browser relay", opts.signal);
			if (await probeRelayServer(opts.cdpUrl)) return true;
			// A live service belongs to all its consumers, even while its listener
			// is not ready. Do not stop another session's process to recover ours.
			return false;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name,
						application: spawn.cmd[0]!,
						args: [...spawn.cmd.slice(1), "--port", port],
						env: workerEnvFromParent(),
						cwd: spawn.cwd ?? client.projectDir,
						pty: false,
						ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				opts.signal,
			);
			if (started.op !== "start") continue;
			if (await probeRelayServer(opts.cdpUrl)) return true;
			return false;
		} catch (error) {
			throwIfAborted(opts.signal);
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("Browser relay start contention", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return false;
}
