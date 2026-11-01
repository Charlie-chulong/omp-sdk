import { runtime } from "@oh-my-pi/pi-utils/runtime";
import { resolveExecutablePath } from "../../subprocess/worker-client";

/** Exit code and captured output of one Bun package-manager invocation. */
export interface BunCliResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Lockfile written by the package manager selected for this runtime. */
export function pluginPackageLockFilename(): string {
	return typeof Bun !== "undefined" || runtime.which("bun") ? "bun.lock" : "package-lock.json";
}

/**
 * Runs the selected package manager for plugin install/update/uninstall.
 *
 * Re-enters the running executable with `BUN_BE_BUN=1` instead of resolving
 * `bun` from `$PATH`: source and bundle installs already run under Bun, and the
 * standalone `omp` binary embeds Bun, so plugin installs never require a
 * separately installed Bun (#15480). Same mechanism as
 * `eval/js/package-installer.ts` and `@oh-my-pi/pi-utils` runtime installs.
 * Node SDKs use a real Bun on PATH when available, otherwise npm; Bun's
 * manifest-cache bypass flag is translated to npm's online-fetch policy.
 */
export async function runBunCli(args: readonly string[], cwd: string): Promise<BunCliResult> {
	const bun = typeof Bun !== "undefined" ? resolveExecutablePath() : runtime.which("bun");
	const executable = bun ?? runtime.which(process.platform === "win32" ? "npm.cmd" : "npm");
	if (!executable) throw new Error("Plugin package management requires npm or Bun installed on PATH.");
	const commandArgs = bun ? args : args.map(arg => (arg === "--no-cache" ? "--prefer-online" : arg));
	const proc = runtime.spawn([executable, ...commandArgs], {
		cwd,
		env: bun ? { ...process.env, BUN_BE_BUN: "1" } : process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	// Drain both pipes concurrently with exit: awaiting `exited` first deadlocks
	// once a chatty install fills the OS pipe buffer.
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
