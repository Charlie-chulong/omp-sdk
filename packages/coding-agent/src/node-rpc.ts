import "./node-platform";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parseArgs } from "./cli/args";
import { all } from "./config/registry";
import { Settings } from "./config/settings";
import { initializeNodeSdk } from "./node-bootstrap";
import { runRpcMode } from "./modes/rpc/rpc-mode";
import { claimRpcInput } from "./modes/rpc/rpc-input";
import { createAgentSession } from "./sdk";
import { SessionManager } from "./session/session-manager";
import { resolveResumableSession } from "./session/session-listing";
import { closeDaemonClients, daemonClientForProject } from "./launch/client";
import { BUILTIN_TOOL_NAMES } from "./tools/builtin-names";
import { cfgToolsApprovalMode } from "./tools/settings";

export * from "./modes/rpc/rpc-mode";

initializeNodeSdk(import.meta.url);

export interface NodeRpcHostOptions {
	cwd: string;
	agentDir?: string;
	protocolMode?: "rpc" | "rpc-ui";
	model?: string;
	thinkingOptionId?: string;
	session?: string;
	noSession?: boolean;
	systemPrompt?: string;
	extraArgs?: string[];
	extensions?: string[];
	disallowedTools?: string[];
	configFiles?: string[];
}

const supportedParsedOptions: Readonly<Record<string, true>> = {
	model: true,
	provider: true,
	thinking: true,
	config: true,
	extensions: true,
	noExtensions: true,
	tools: true,
	noTools: true,
	noLsp: true,
	noContextFiles: true,
	noSkills: true,
	noRules: true,
	systemPrompt: true,
	appendSystemPrompt: true,
	approvalMode: true,
	autoApprove: true,
	smol: true,
	slow: true,
	plan: true,
	noUi: true,
	noSession: true,
	sessionDir: true,
	messages: true,
	fileArgs: true,
	unknownFlags: true,
	unrecognizedFlags: true,
	invalidFlagValues: true,
};

/** Run the existing full RPC protocol around an SDK session, without entering the Bun CLI. */
export async function startNodeRpcHost(options: NodeRpcHostOptions): Promise<never> {
	const input = claimRpcInput();
	if (!path.isAbsolute(options.cwd)) throw new Error("Node SDK cwd must be absolute");
	const parsed = parseArgs([
		...(options.model ? ["--model", options.model] : []),
		...(options.thinkingOptionId ? ["--thinking", options.thinkingOptionId] : []),
		...(options.extraArgs ?? []),
	]);
	if (parsed.unrecognizedFlags.length || parsed.invalidFlagValues.length) {
		throw new Error(
			`Invalid Node SDK session options: ${[...parsed.unrecognizedFlags, ...parsed.invalidFlagValues].join(", ")}`,
		);
	}
	if (parsed.messages.length || parsed.fileArgs.length || parsed.unknownFlags.size) {
		throw new Error("Node SDK startup accepts session options, not an initial CLI prompt");
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== undefined && value !== false && !supportedParsedOptions[key]) {
			throw new Error(`Node SDK backend does not support the CLI option '${key}'`);
		}
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const settings = await Settings.init({
		cwd: options.cwd,
		agentDir,
		configFiles: [...(options.configFiles ?? []), ...(parsed.config ?? [])],
	});
	for (const setting of all()) {
		if (setting.definition.protocolDefault?.includes("rpc")) setting.pinDefault(settings);
	}
	if (parsed.approvalMode) cfgToolsApprovalMode.override(settings, parsed.approvalMode);
	else if (parsed.autoApprove) cfgToolsApprovalMode.override(settings, "yolo");
	if (parsed.smol || parsed.slow || parsed.plan) {
		settings.overrideModelRoles({ smol: parsed.smol, slow: parsed.slow, plan: parsed.plan });
	}
	const sessionDir = parsed.sessionDir ?? SessionManager.getDefaultSessionDir(options.cwd, agentDir);
	let sessionManager: SessionManager | undefined;
	if (options.noSession || parsed.noSession) {
		if (options.session) throw new Error("Cannot combine a saved session with noSession");
		sessionManager = SessionManager.inMemory(options.cwd);
	} else if (options.session) {
		const candidate = path.resolve(options.cwd, options.session);
		let sessionFile: string | undefined;
		try {
			if ((await fs.stat(candidate)).isFile()) sessionFile = candidate;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (!sessionFile) {
			const match = await resolveResumableSession(options.session, options.cwd, sessionDir, {
				allowGlobalFallback: true,
			});
			sessionFile = match?.session.path;
		}
		if (!sessionFile) throw new Error(`Saved session not found: ${options.session}`);
		sessionManager = await SessionManager.open(sessionFile, sessionDir, undefined, { throwIfMissing: true });
	}
	const denied = new Set(options.disallowedTools ?? []);
	let toolNames = parsed.noTools ? [] : parsed.tools;
	if (denied.size) {
		// Image generation is settings-gated, not part of the built-in manifest.
		// A denylist must not turn unrelated denials into an image whitelist denial.
		toolNames = (toolNames ?? [...BUILTIN_TOOL_NAMES, "generate_image"]).filter(name => !denied.has(name));
	}
	const result = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		settings,
		sessionManager,
		modelPattern: parsed.provider && parsed.model ? `${parsed.provider}/${parsed.model}` : parsed.model,
		thinkingLevel: parsed.thinking,
		systemPrompt: options.systemPrompt ?? parsed.systemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompt,
		additionalExtensionPaths: [...(options.extensions ?? []), ...(parsed.extensions ?? [])],
		disableExtensionDiscovery: parsed.noExtensions,
		toolNames,
		enableLsp: parsed.noLsp ? false : undefined,
		noContextFiles: parsed.noContextFiles,
		skills: parsed.noSkills ? [] : undefined,
		rules: parsed.noRules ? [] : undefined,
		interactivePrompts: options.protocolMode === "rpc-ui",
		allowSessionModelFallback: false,
	});
	if (result.extensionsResult.errors.length) {
		await result.session.dispose();
		throw new Error(
			`Node SDK extensions failed: ${result.extensionsResult.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`,
		);
	}
	return runRpcMode(result.session, {
		input,
		setToolUIContext: options.protocolMode === "rpc-ui" ? result.setToolUIContext : undefined,
		headless: parsed.noUi,
		mcpManager: result.mcpManager,
		subagentEventBus: result.subagentEventBus,
	});
}

/** Stop a persisted project daemon through its existing broker protocol. */
export async function stopNodeRpcDaemon(input: { cwd: string; name: string }): Promise<void> {
	try {
		const client = await daemonClientForProject(input.cwd);
		const response = await client.request({ op: "stop", name: input.name, timeoutMs: 2000 });
		if (response.op !== "stop") throw new Error(`Unexpected daemon broker response: ${response.op}`);
	} finally {
		await closeDaemonClients();
	}
}
