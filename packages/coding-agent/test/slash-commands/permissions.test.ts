import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { cfgToolsApprovalMode, cfgToolsRestrictedFolders } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let current: AgentSession;
let authStorage: AuthStorage;
let previousSettings: SettingsTestState;

beforeAll(async () => {
	await initTheme(false);
});
beforeEach(async () => {
	previousSettings = beginSettingsTest();
	const settings = await Settings.init({ inMemory: true });
	authStorage = createInMemoryAuthStorage();
	current = new AgentSession({
		agent: new Agent({ initialState: { model: getBundledModel("openai", "gpt-4o-mini"), tools: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		autoApprove: true,
	});
});
afterEach(async () => {
	try {
		await current.dispose();
	} finally {
		authStorage.close();
		restoreSettingsTestState(previousSettings);
	}
});

describe("/permissions", () => {
	it("opens a picker above a pending approval without replacing its composer", async () => {
		let overlay: Component | undefined;
		const pending = "approval for a pending workspace write";
		const editorContainer = new Container();
		editorContainer.addChild(new Text(pending));
		const ctx = createInteractiveModeContext({
			session: current,
			approvalOwnsComposer: true,
			editorContainer,
			ui: {
				showOverlay: component => {
					overlay = component;
					return {
						hide: () => {
							overlay = undefined;
						},
						setHidden: () => {},
						isHidden: () => false,
					};
				},
			},
		});
		await executeBuiltinSlashCommand("/permissions", { ctx });
		expect(editorContainer.render(80).join("\n")).toContain(pending);
		for (let index = 0; index < 3; index++) overlay?.handleInput?.("\x1b[A");
		overlay?.handleInput?.("\r");
		expect(current.approvalMode).toBe("always-ask");
		expect(editorContainer.render(80).join("\n")).toContain(pending);
		expect(overlay).toBeUndefined();
		expect(await executeBuiltinSlashCommand("/permissions yolo", { ctx })).toBe(true);
		expect(current.approvalMode).toBe("yolo");
	});

	it("reports the effective mode and leaves bare and invalid text invocations unchanged", async () => {
		current.setApprovalMode("always-ask-cached");
		const output: string[] = [];
		const runtime = {
			session: current,
			sessionManager: current.sessionManager,
			settings: current.settings,
			cwd: current.sessionManager.getCwd(),
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		await executeAcpBuiltinSlashCommand("/permissions", runtime);
		expect(output.at(-1)).toContain(current.approvalMode);
		await executeAcpBuiltinSlashCommand("/permissions yolo extra", runtime);
		expect(current.approvalMode).toBe("always-ask-cached");
	});

	it("does not allow collaboration guests to grant host permissions", async () => {
		current.setApprovalMode("always-ask");
		const ctx = createInteractiveModeContext({ session: current, collabGuest: { readOnly: false } });
		await executeBuiltinSlashCommand("/permissions yolo", { ctx });
		expect(current.approvalMode).toBe("always-ask");
	});
});

describe("Tool Approval settings precedence", () => {
	it("shows the session mode and persists live choices without changing unrelated runtime overrides", () => {
		const settings = current.settings;
		cfgToolsRestrictedFolders.override(settings, ["/private"]);
		const host = createSettingsHost(current);
		host.set(cfgToolsApprovalMode.id, "always-ask");
		expect(current.approvalMode).toBe("always-ask");
		expect(host.get(cfgToolsApprovalMode.id)).toBe("always-ask");
		expect(settings.getGlobalSettings()).toMatchObject({ tools: { approvalMode: "always-ask" } });
		host.set(cfgToolsApprovalMode.id, "yolo");
		expect(current.approvalMode).toBe("yolo");
		expect(settings.getGlobalSettings()).toMatchObject({ tools: { approvalMode: "yolo" } });
		expect(cfgToolsRestrictedFolders.get(settings)).toEqual(["/private"]);
	});
});
