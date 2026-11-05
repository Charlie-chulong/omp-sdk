import assert from "node:assert/strict";
import { once } from "node:events";
import * as net from "node:net";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket, { WebSocketServer } from "ws";

// Real Node sockets are required: Bun's TLS end/error ordering differs.
const watchdog = setTimeout(() => {
	process.stderr.write("Local proxy fixture did not finish\n");
	process.exit(2);
}, 10000);
watchdog.unref();
const results = [];

for (const protocol of ["https", "http"]) {
	const sockets = new Set();
	const socketClosures = [];
	const proxy = net.createServer(socket => {
		sockets.add(socket);
		const closed = Promise.withResolvers();
		socketClosures.push(closed.promise);
		socket.once("close", () => {
			sockets.delete(socket);
			closed.resolve();
		});
		socket.once("data", () => socket.end());
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	const agent = new HttpsProxyAgent(`${protocol}://127.0.0.1:${proxy.address().port}`);
	const socket = new WebSocket("wss://model.invalid/", { agent });
	const errors = [];
	socket.on("error", error => errors.push(error.message));
	const closed = Promise.withResolvers();
	socket.once("close", closed.resolve);
	await closed.promise;
	assert.equal(socket.readyState, WebSocket.CLOSED);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /proxy|TLS|socket/i);
	agent.destroy();
	const proxyClosed = once(proxy, "close");
	proxy.close();
	await proxyClosed;
	await Promise.all(socketClosures);
	assert.equal(sockets.size, 0);
	results.push({ scenario: `${protocol}-eof`, outcome: "request-error", socketsClosed: true });
}

const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(upstream, "listening");
upstream.on("connection", socket => socket.send("proxy transport still works"));
const proxy = net.createServer(socket => {
	socket.once("data", () => {
		const target = net.connect(upstream.address().port, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			socket.pipe(target).pipe(socket);
		});
		socket.on("error", () => target.destroy());
		target.on("error", () => socket.destroy());
		socket.once("close", () => target.destroy());
		target.once("close", () => socket.destroy());
	});
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const agent = new HttpsProxyAgent(`http://127.0.0.1:${proxy.address().port}`);
const socket = new WebSocket(`ws://127.0.0.1:${upstream.address().port}`, { agent });
const [message] = await once(socket, "message");
assert.equal(message.toString(), "proxy transport still works");
const socketClosed = once(socket, "close");
socket.close();
await socketClosed;
agent.destroy();
const proxyClosed = once(proxy, "close");
proxy.close();
await proxyClosed;
const upstreamClosed = once(upstream, "close");
upstream.close();
await upstreamClosed;
results.push({ scenario: "http-connect", outcome: "message-received", socketsClosed: true });
clearTimeout(watchdog);
process.stdout.write(`${JSON.stringify(results)}\n`);
