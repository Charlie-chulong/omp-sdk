import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";

test("normal CLI startup keeps computer worker modules lazy", async () => {
	using tempDir = TempDir.createSync("@omp-cli-computer-lazy-");
	const cliUrl = new URL("../src/cli.ts", import.meta.url).href;
	const probePath = tempDir.join("probe.ts");
	// Import by file URL inside the child so only that fresh process evaluates the CLI graph.
	await Bun.write(
		probePath,
		[
			`import { runCli } from ${JSON.stringify(cliUrl)};`,
			"process.stdout.write = () => true;",
			'await runCli(["--version"]);',
		].join("\n"),
	);

	// `--no-addons` is a process-local sentinel: evaluating the computer worker graph
	// attempts to load the desktop addon and fails, while prelude registration must not.
	const child = Bun.spawn([process.execPath, "--no-addons", probePath], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(exitCode, stderr).toBe(0);
});

test("a capability request still loads and validates the native addon", async () => {
	using tempDir = TempDir.createSync("@omp-cli-native-capability-");
	const capabilityUrl = new URL("../src/native-capabilities.ts", import.meta.url).href;
	const probePath = tempDir.join("probe.ts");
	await Bun.write(
		probePath,
		[
			`import { assertNativeCapability } from ${JSON.stringify(capabilityUrl)};`,
			'process.stdout.write("imported\\n");',
			'assertNativeCapability("localAssistance", "Word prediction");',
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, "--no-addons", probePath], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stdout).toBe("imported\n");
	expect(exitCode).not.toBe(0);
	expect(stderr).toContain("loading addons is disabled");
});
