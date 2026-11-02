import { describe, expect, it } from "bun:test";
import * as net from "node:net";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import { ProxyPolicyController, withProxyPolicy } from "@oh-my-pi/pi-ai/utils/proxy";

/** A rejected real CONNECT proves the Cowork fallback uses the configured wire route. */
describe("coworkFetch policy routing", () => {
	it("routes HTTPS requests and Request inputs through the current Anthropic proxy", async () => {
		const targets: string[] = [];
		const sockets = new Set<net.Socket>();
		const server = net.createServer(socket => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.once("data", chunk => {
				targets.push(chunk.toString().split("\r\n")[0]);
				socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP listener");
		const controller = new ProxyPolicyController({ enabled: true, providers: {
			anthropic: { mode: "proxy", url: `http://127.0.0.1:${address.port}` },
		} });
		try {
			await withProxyPolicy(controller, async () => {
				await coworkFetch("https://provider.invalid/v1/messages", {
					method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1_500),
				}).catch(() => undefined);
				await coworkFetch(new Request("https://provider.invalid/v1/messages", { signal: AbortSignal.timeout(1_500) })).catch(() => undefined);
				controller.setPolicy({ ...controller.getPolicy(), enabled: false });
				await expect(coworkFetch("https://provider.invalid/v1/messages", {
					headers: { accept: "*/*" }, signal: AbortSignal.timeout(1_500),
				})).rejects.toThrow();
			});
			expect(targets).toEqual(["CONNECT provider.invalid:443 HTTP/1.1", "CONNECT provider.invalid:443 HTTP/1.1"]);
		} finally {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => error ? closed.reject(error) : closed.resolve());
			await closed.promise;
		}
	});
});
