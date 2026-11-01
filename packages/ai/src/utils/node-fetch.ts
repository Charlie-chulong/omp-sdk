import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils/tls-fetch";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { ConnectionOptions } from "node:tls";
import type { FetchImpl } from "../types";
import { getProxyForUrl } from "./proxy";

const dispatchers = new Map<string, Dispatcher>();
const host = globalThis as unknown as { Bun?: unknown };
const nativeFetch = globalThis.fetch;
type ExtendedInit = RequestInit & {
	proxy?: string;
	tls?: ConnectionOptions & { serverName?: string };
	timeout?: number | false;
	unix?: string;
	dispatcher?: Dispatcher;
};

/** Translate Bun's wire-affecting fetch extensions into real undici dispatchers. */
export function portableFetch(base: FetchImpl = nativeFetch): FetchImpl {
	if (host.Bun || (base !== nativeFetch && base !== globalThis.fetch)) return base;
	return async (input, init) => {
		const extraCa = resolveExtraCa();
		const options = (extraCa ? withExtraCaInit(init, extraCa) : init) as ExtendedInit | undefined;
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const proxy = options?.proxy ?? getProxyForUrl("", url);
		const tls = options?.tls;
		const key = JSON.stringify([proxy, tls, options?.unix, options?.timeout]);
		let dispatcher = options?.dispatcher ?? dispatchers.get(key);
		if (!dispatcher) {
			const connect = {
				...tls,
				...(tls?.serverName ? { servername: tls.serverName } : {}),
				...(options?.unix ? { socketPath: options.unix } : {}),
			};
			const timeout = options?.timeout === false ? 0 : options?.timeout;
			const common = { connect, headersTimeout: timeout ?? 0, bodyTimeout: timeout ?? 0 };
			dispatcher = proxy
				? new ProxyAgent({
						uri: proxy,
						requestTls: connect,
						proxyTls: tls,
						headersTimeout: timeout ?? 0,
						bodyTimeout: timeout ?? 0,
					})
				: new Agent(common);
			dispatchers.set(key, dispatcher);
		}
		const { proxy: _proxy, tls: _tls, timeout: _timeout, unix: _unix, ...standard } = options ?? {};
		const response = await undiciFetch(input instanceof Request ? input.url : input.toString(), {
			...(input instanceof Request
				? { method: input.method, headers: input.headers, body: input.body, signal: input.signal }
				: {}),
			...standard,
			dispatcher,
			duplex: "half",
		} as Parameters<typeof undiciFetch>[1]);
		// undici's web types are structurally identical to the host DOM response.
		return response as unknown as Response;
	};
}
