import type { MessagePort } from "node:worker_threads";
import type * as WorkerThreads from "node:worker_threads";
import type * as Postmortem from "@oh-my-pi/pi-utils/postmortem";
import { installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type * as JsProcessEntry from "../eval/js/process-entry";
import type { WorkerInbound as JsWorkerInbound, WorkerOutbound as JsWorkerOutbound } from "../eval/js/worker-protocol";
import { startParentWatchdog } from "../subprocess/parent-watchdog";
import { assertLocalRuntimeAvailable } from "../sdk-profile";
import { assertNativeCapability } from "../native-capabilities";
import {
	BLOB_BROKER_WORKER_ARG,
	COMPUTER_WORKER_ARG,
	DAEMON_BROKER_WORKER_ARG,
	IDA_HOST_WORKER_ARG,
	LSP_MUX_WORKER_ARG,
	MNEMOPI_EMBED_SERVER_WORKER_ARG,
	PARENT_WATCHDOG_WORKER_ARG,
	STATS_ACTIVITY_WORKER_ARG,
	TERMINAL_OUTPUT_WORKER_ARG,
	TEXT_PREDICT_WORKER_ARG,
} from "./worker-selectors";

/**
 * Worker inboxes must attach before this entry module reaches its first await.
 * The synchronous module boundary keeps worker_threads out of ordinary CLI startup.
 */
function getWorkerParentPort(): MessagePort | null {
	const workerThreads: typeof WorkerThreads = require("node:worker_threads");
	return workerThreads.parentPort;
}

const TINY_WORKER_ARG = "__omp_worker_tiny_inference";
const STATS_SYNC_WORKER_ARG = "__omp_worker_stats_sync";
const TAB_WORKER_ARG = "__omp_worker_tab";
const JS_EVAL_WORKER_ARG = "__omp_worker_js_eval";
const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";
const STT_WORKER_ARG = "__omp_worker_stt";
const TTS_WORKER_ARG = "__omp_worker_tts";
const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

/** Dispatch the shared hidden selectors without loading a CLI frontend. */
export async function runWorkerEntrypoint(arg: string | undefined): Promise<boolean> {
	if (arg === TINY_WORKER_ARG) {
		assertLocalRuntimeAvailable("Tiny local helper inference");
		await runTinyWorker();
		return true;
	}
	if (arg === STATS_SYNC_WORKER_ARG) {
		// The sync worker handles messages via `self.onmessage`, assigned while
		// its module loads. Bun flushes the worker's initial message
		// buffer when the entry module's top-level evaluation finishes — before
		// this dispatch completes — so anything the parent posted right after
		// spawning (the smoke ping, the first parse request) would be dropped.
		// Park early events and replay them once the module's handler is live.
		// Worker-thread entries using `parentPort` need the same sync-prefix
		// buffering; the computer/tab/eval cases install that inbox below.
		const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null };
		const pending: MessageEvent[] = [];
		const buffer = (event: MessageEvent): void => {
			pending.push(event);
		};
		scope.onmessage = buffer;
		// The .js subpath is the package's unconditional export for synchronous loading.
		require("@oh-my-pi/omp-stats/sync-worker.js");
		const handler = scope.onmessage;
		if (handler && handler !== buffer) {
			for (const event of pending) handler.call(scope, event);
		}
		return true;
	}
	// Bun flushes messages the parent posted before spawn once this entry's
	// top-level evaluation completes. Install a buffering inbox synchronously
	// before binding the selected worker's real handler so the parent's
	// synchronous `init` survives. The dynamically imported tab/eval modules
	// consume the same inbox after their module evaluation begins.
	if (arg === TAB_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		require("../tools/browser/tab-worker-entry");
		return true;
	}
	if (arg === COMPUTER_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		const { startComputerWorker } = require("../tools/computer/worker-entry");
		startComputerWorker();
		return true;
	}
	if (arg === JS_EVAL_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		require("../eval/js/worker-entry");
		return true;
	}
	if (arg === JS_EVAL_PROCESS_ARG) {
		// This selector is the synchronous bootstrap boundary: keep the evaluator
		// runtime and postmortem/inspector graph out of ordinary startup without
		// putting an await ahead of the subprocess message handler.
		const { startJsEvalProcess }: typeof JsProcessEntry = require("../eval/js/process-entry");
		// The .js subpath is the package's unconditional export for synchronous loading.
		const { interceptUnhandledRejections }: typeof Postmortem = require("@oh-my-pi/pi-utils/postmortem.js");
		// The JS evaluator forwards user-controlled payloads (tool-call args,
		// display outputs); a non-serializable one must fail that cell, not
		// SIGKILL the kernel and erase the eval session's state.
		await runIpcSubprocessWorker<JsWorkerInbound, JsWorkerOutbound>(
			transport => startJsEvalProcess(transport, interceptUnhandledRejections),
			{ rethrowConnectedSendErrors: true },
		);
		return true;
	}
	if (arg === STT_WORKER_ARG) {
		assertLocalRuntimeAvailable("Offline speech recognition");
		const { startSttWorker } = require("../stt/asr-worker");
		await runIpcSubprocessWorker(startSttWorker);
		return true;
	}
	if (arg === TTS_WORKER_ARG) {
		assertLocalRuntimeAvailable("Offline speech synthesis");
		const { startTtsWorker } = require("../tts/tts-worker");
		await runIpcSubprocessWorker(startTtsWorker);
		return true;
	}
	if (arg === MNEMOPI_EMBED_WORKER_ARG) {
		assertLocalRuntimeAvailable("Local memory embeddings");
		const { startMnemopiEmbedWorker } = require("../mnemopi/embed-worker");
		await runIpcSubprocessWorker(startMnemopiEmbedWorker);
		return true;
	}
	if (arg === MNEMOPI_EMBED_SERVER_WORKER_ARG) {
		assertLocalRuntimeAvailable("Local memory embeddings");
		const { startMnemopiEmbedServerFromEnvironment } = require("../mnemopi/embed-server");
		await startMnemopiEmbedServerFromEnvironment();
		return true;
	}
	if (arg === STATS_ACTIVITY_WORKER_ARG) {
		const { startStatsActivityWorker } = require("../stats/activity-worker");
		await runIpcSubprocessWorker(startStatsActivityWorker);
		return true;
	}
	if (arg === TERMINAL_OUTPUT_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		// This selector is the isolation boundary; a static import would evaluate xterm in normal CLI startup.
		require("../launch/terminal-output-worker");
		return true;
	}
	if (arg === PARENT_WATCHDOG_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		require("../subprocess/parent-watchdog-worker");
		return true;
	}
	if (arg === DAEMON_BROKER_WORKER_ARG) {
		// Worker selectors must dispatch before the normal command graph loads.
		const { startDaemonBrokerFromEnvironment } = require("../launch/broker");
		await startDaemonBrokerFromEnvironment();
		return true;
	}
	if (arg === LSP_MUX_WORKER_ARG) {
		const { startLspMuxFromEnvironment } = require("../lsp/mux/server");
		await startLspMuxFromEnvironment();
		return true;
	}
	if (arg === IDA_HOST_WORKER_ARG) {
		const { startIdaHostFromEnvironment } = require("../ida/host");
		await startIdaHostFromEnvironment();
		return true;
	}
	if (arg === BLOB_BROKER_WORKER_ARG) {
		const { startBlobBrokerFromEnvironment } = require("../blob-broker/server");
		await startBlobBrokerFromEnvironment();
		return true;
	}
	if (arg === TEXT_PREDICT_WORKER_ARG) {
		assertNativeCapability("localAssistance", "Word prediction daemon");
		const { startTextPredictDaemonFromEnvironment } = require("../predict/daemon");
		await startTextPredictDaemonFromEnvironment();
		return true;
	}
	return false;
}

/**
 * Boot a subprocess-isolated transformers.js worker over the parent's IPC
 * channel and block until the parent disconnects. The tiny-model, STT, and TTS
 * workers each run `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) in a child address space because its NAPI
 * finalizer segfaults Bun on shutdown (issue #1606); the parent `SIGKILL`s the
 * child so that finalizer never runs in either process. This wires `process`
 * IPC to the worker's typed transport, keeps the event loop alive while the
 * worker is idle, and hard-kills the process on parent `disconnect` or — via
 * the off-main-thread {@link startParentWatchdog} — parent exit.
 */
async function runIpcSubprocessWorker<In, Out>(
	start: (transport: {
		send(message: Out): void;
		sendAndFlush(message: Out): Promise<void>;
		onMessage(handler: (message: In) => void): () => void;
	}) => void,
	options?: {
		/**
		 * Rethrow send failures while the IPC channel is still connected instead
		 * of shutting down. A connected-channel failure means this particular
		 * message could not be serialized (e.g. a JS eval cell passed a function
		 * into tool args, a DataCloneError under advanced serialization) — the
		 * caller must see that error, exactly as Worker `postMessage` would
		 * deliver it, rather than losing the whole worker and its state.
		 * Channel-gone failures still shut down.
		 */
		rethrowConnectedSendErrors?: boolean;
	},
): Promise<void> {
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
	// `process.send` only exists when spawned with an IPC channel; the parent
	// always spawns us that way. If it's missing, the parent vanished and
	// there's no one to talk to.
	const ipcSend = (): IpcSend | undefined => (process as NodeJS.Process & { send?: IpcSend }).send;
	if (!ipcSend()) {
		// Intentional fall-through: shutdown() only resolves the promise;
		// the await + SIGKILL tail below is what actually exits.
		shutdown();
	}
	const send = (message: Out): void => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return;
		}
		try {
			sender.call(process, message);
		} catch (error) {
			if (options?.rethrowConnectedSendErrors && process.connected) throw error;
			shutdown();
		}
	};
	const sendAndFlush = (message: Out): Promise<void> => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		try {
			sender.call(process, message, () => resolve());
		} catch {
			shutdown();
			resolve();
		}
		return promise;
	};
	start({
		send,
		sendAndFlush,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as In);
			process.on("message", wrap);
			return () => {
				process.off("message", wrap);
			};
		},
	});
	const initialParentPid = process.ppid;
	if (process.platform === "win32" && initialParentPid <= 0) {
		shutdown();
	} else if (initialParentPid > 0) {
		startParentWatchdog(initialParentPid);
	}
	const keepalive = setInterval(() => {}, 2 ** 30);
	// Parent went away (crashed, SIGKILL, etc.) — commit suicide so we don't
	// linger as an orphan. SIGKILL via `process.kill` keeps us symmetrical with
	// the parent's hard-kill on shutdown: skip every JS/native finalizer.
	process.on("disconnect", () => shutdown());
	try {
		await shuttingDown;
	} finally {
		clearInterval(keepalive);
	}
	process.kill(process.pid, "SIGKILL");
}

/**
 * Hidden subcommand that boots the ONNX tiny-model worker for one model: a
 * detached process owning that model's socket (`OMP_TINY_WORKER_SOCKET`),
 * shared by every omp process on the machine and exiting on its own when
 * idle. It exists so `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) never runs in an omp address space — its NAPI
 * finalizer segfaults Bun on Windows (issue #1606).
 */
async function runTinyWorker(): Promise<void> {
	const { startTinyWorkerFromEnvironment } = require("../tiny/worker");
	await startTinyWorkerFromEnvironment();
}
