import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("Cursor proxy resolution", () => {
	it("tunnels the run through the Cursor provider policy", async () => {
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-proxy-policy.ts")], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ connectTargets: ["198.51.100.7:8443"] });
	}, 60_000);
});
