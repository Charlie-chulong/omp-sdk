import { resolveExtraCa } from "@oh-my-pi/pi-utils/tls-fetch";
import { rootCertificates } from "node:tls";
import Ws from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { ConnectionOptions } from "node:tls";
import { getProxyForUrl } from "./proxy";

export interface ModelWebSocket extends EventTarget {
	readonly readyState: number;
	readonly bufferedAmount: number;
	readonly url: string;
	binaryType: Ws["binaryType"] | "blob";
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	responseHeaders?: Headers;
	send(data: string | ArrayBuffer | ArrayBufferView): void | number;
	close(code?: number, reason?: string): void;
	ping(data?: string | Uint8Array): void | number;
}
export interface ModelWebSocketOptions {
	headers?: Record<string, string>;
	proxy?: string;
	tls?: ConnectionOptions;
}

const host = globalThis as unknown as { Bun?: unknown };
export function createModelWebSocket(url: string, options: ModelWebSocketOptions = {}): ModelWebSocket {
	if (host.Bun) {
		// Native Bun and ws share this transport surface, despite different declarations.
		const NativeSocket = WebSocket as unknown as new (url: string, options: ModelWebSocketOptions) => ModelWebSocket;
		return new NativeSocket(url, options);
	}
	const proxy = options.proxy ?? getProxyForUrl("", new URL(url));
	const extraCa = resolveExtraCa();
	const tlsOptions = { ...options.tls, ...(extraCa ? { ca: [...rootCertificates, extraCa] } : {}) };
	const socket = new Ws(url, {
		...tlsOptions,
		headers: options.headers,
		...(proxy ? { agent: new HttpsProxyAgent(proxy, tlsOptions) } : {}),
	});
	// ws provides the DOM event facade and native ping control frames.
	const adapted = socket as unknown as ModelWebSocket;
	socket.on("upgrade", response => {
		const headers = new Headers();
		for (const [key, value] of Object.entries(response.headers)) {
			if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
			else if (value !== undefined) headers.set(key, value);
		}
		adapted.responseHeaders = headers;
	});
	return adapted;
}
