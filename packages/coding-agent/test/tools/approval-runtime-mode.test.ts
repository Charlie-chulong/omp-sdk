import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionFactory,
	ExtensionUIDialogOptions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const toolCall = (command: string, cwd: string): MockResponse => ({
	content: [{ type: "toolCall", name: "bash", arguments: { command, cwd } }],
	stopReason: "toolUse",
});

describe("live session approval mode", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let root: TempDir;

	beforeEach(() => {
		root = TempDir.createSync("@omp-live-approval-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage?.close();
			authStorage = undefined;
			root[Symbol.dispose]();
		}
	});

	async function start(
		root: TempDir,
		ui: ExtensionUIContext,
		overrides: Record<string, unknown> = {},
		extensions: ExtensionFactory[] = [],
	): Promise<AgentSession> {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("openai", "test-key");
		const created = await createAgentSession({
			cwd: root.path(),
			agentDir: root.join("agent"),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				...overrides,
			}),
			autoApprove: true,
			hasUI: true,
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: root.path(), rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["bash"],
		});
		session = created.session;
		created.setToolUIContext(ui, true);
		await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, uiContext: ui });
		return session;
	}

	it("a live downgrade takes precedence over the startup auto-approve flag", async () => {
		const prompts: string[] = [];
		const ui = {
			select: async (title: string) => {
				prompts.push(title);
				return "Deny";
			},
			notify: () => {},
		} as unknown as ExtensionUIContext;
		const target = await start(root, ui);
		cfgToolsApprovalMode.override(target.settings, "always-ask");
		target.agent.streamFn = createMockModel({
			responses: [toolCall("printf denied > permission-probe.txt", root.path()), { content: ["done"] }],
		}).stream;

		await target.prompt("write the probe");

		expect(await Bun.file(root.join("permission-probe.txt")).exists()).toBe(false);
		expect(prompts, JSON.stringify(target.messages)).toHaveLength(1);
		expect(target.messages.some(message => message.role === "toolResult" && message.isError)).toBe(true);
	});

	it("upgrading a pending approval runs the same tool without an answer or a restarted turn", async () => {
		const shown = Promise.withResolvers<void>();
		let cancelled = false;
		const ui = {
			select: (_title: string, _choices: string[], options?: ExtensionUIDialogOptions) => {
				const answer = Promise.withResolvers<string | undefined>();
				const onAbort = () => {
					cancelled = true;
					answer.resolve(undefined);
				};
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				shown.resolve();
				return answer.promise.finally(() => options?.signal?.removeEventListener("abort", onAbort));
			},
			notify: () => {},
		} as unknown as ExtensionUIContext;
		const target = await start(root, ui);
		target.setApprovalMode("always-ask");
		target.agent.streamFn = createMockModel({
			responses: [toolCall("printf upgraded > permission-probe.txt", root.path()), { content: ["done"] }],
		}).stream;

		const running = target.prompt("write the probe");
		await shown.promise;
		expect(target.isStreaming).toBe(true);
		target.setApprovalMode("yolo");
		await running;

		expect(cancelled).toBe(true);
		expect(await Bun.file(root.join("permission-probe.txt")).text()).toBe("upgraded");
		expect(target.messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(target.messages.find(message => message.role === "toolResult")?.isError).toBe(false);
	});

	it("a downgrade while an asynchronous extension hook waits gates the tool before execution", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const ui = {
			select: async (title: string) => {
				prompts.push(title);
				return "Deny";
			},
			notify: () => {},
		} as unknown as ExtensionUIContext;
		const target = await start(root, ui, {}, [
			api => {
				api.on("tool_call", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		]);
		target.agent.streamFn = createMockModel({
			responses: [toolCall("printf stale > permission-probe.txt", root.path()), { content: ["done"] }],
		}).stream;

		const running = target.prompt("write the probe");
		await entered.promise;
		target.setApprovalMode("always-ask");
		release.resolve();
		await running;

		expect(prompts).toHaveLength(1);
		expect(await Bun.file(root.join("permission-probe.txt")).exists()).toBe(false);
	});

	for (const policy of ["explicit-prompt", "restricted-folder"] as const) {
		it(`an upgrade does not authorize a pending ${policy} call`, async () => {
			let prompts = 0;
			const ui = {
				approve: async (_prompt: unknown) => {
					prompts++;
					if (prompts === 1) {
						target.setApprovalMode("yolo");
						await Promise.resolve();
					}
					return "deny";
				},
				select: async () => "Deny",
				notify: () => {},
			} as unknown as ExtensionUIContext;
			const target: AgentSession = await start(
				root,
				ui,
				policy === "explicit-prompt"
					? { "tools.approval": { bash: "prompt" } }
					: { "tools.restrictedFolders": [root.path()] },
			);
			target.setApprovalMode("always-ask");
			target.agent.streamFn = createMockModel({
				responses: [toolCall("printf unsafe > permission-probe.txt", root.path()), { content: ["done"] }],
			}).stream;

			await target.prompt("write the probe");

			expect(prompts).toBe(2);
			expect(target.approvalMode).toBe("yolo");
			expect(await Bun.file(root.join("permission-probe.txt")).exists()).toBe(false);
			expect(target.messages.find(message => message.role === "toolResult")?.isError).toBe(true);
		});
	}
});
