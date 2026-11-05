import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Node proxy EOF rejects the request without killing the host or breaking later connections", async () => {
	const fixture = fileURLToPath(new URL("./fixtures/node-proxy-disconnect.mjs", import.meta.url));
	const child = Bun.spawn(["node", fixture], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(stdout)).toEqual([
			{ scenario: "https-eof", outcome: "request-error", socketsClosed: true },
			{ scenario: "http-eof", outcome: "request-error", socketsClosed: true },
			{ scenario: "http-connect", outcome: "message-received", socketsClosed: true },
		]);
	} finally {
		child.kill();
		await child.exited;
	}
}, 15000);
