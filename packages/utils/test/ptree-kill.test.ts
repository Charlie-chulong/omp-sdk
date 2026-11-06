import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { exec } from "@oh-my-pi/pi-utils/ptree";

describe("ptree kill without a usable native process handle", () => {
	it.skipIf(process.platform === "win32").each([
		["the handle lookup throws", "lookup-throws"],
		["native termination rejects", "termination-rejects"],
	])("still ends a SIGTERM-ignoring child when %s", async (_name, mode) => {
		const probe = path.join(import.meta.dir, "fixtures/ptree-kill-probe.ts");
		const result = await exec([process.execPath, probe, mode], { allowNonZero: true });
		expect(result.exitCode, result.stderr).toBe(0);
	});
});
