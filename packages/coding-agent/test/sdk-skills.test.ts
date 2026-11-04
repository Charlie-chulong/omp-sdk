import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeManagedSkill } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { Skill } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

import { cfgAutolearnEnabled } from "@oh-my-pi/pi-coding-agent/autolearn/settings";
import { cfgSkillsCustomDirectories } from "@oh-my-pi/pi-coding-agent/extensibility/settings";

function createIsolatedSkillsSettings(extensions: string[] = []): Settings {
	return Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
		extensions,
	});
}

function createExtensionSkill(packageDir: string, skillName: string): void {
	fs.mkdirSync(path.join(packageDir, "skills", skillName), { recursive: true });
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: path.basename(packageDir), omp: { extensions: ["./extension.ts"] } }),
	);
	fs.writeFileSync(path.join(packageDir, "extension.ts"), "export default function extension() {}\n");
	fs.writeFileSync(
		path.join(packageDir, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: SDK extension package skill\n---\nbody\n`,
	);
}

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests: skill
	// discovery never touches models, and building them per test would make createAgentSession call
	// modelRegistry.refreshInBackground(), whose online model discovery saturates the event loop and
	// serializes the otherwise-parallel capability scans (~340ms/call). Supplying a prebuilt registry
	// skips that refresh entirely (~24ms/call).
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-skills-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// Create skill in .omp/skills/ for native project-level discovery
		skillsDir = path.join(tempDir, ".omp", "skills", "test-skill");
		fs.mkdirSync(skillsDir, { recursive: true });
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-home-"));
		process.env.HOME = tempHomeDir;
		const nativeUserSkillsDir = path.join(tempHomeDir, ".omp", "agent", "skills");
		fs.mkdirSync(nativeUserSkillsDir, { recursive: true });

		// Create a test skill in the pi skills directory
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);

		const externalSkillDir = path.join(tempDir, "external-symlinked-skill");
		fs.mkdirSync(externalSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(externalSkillDir, "SKILL.md"),
			`---
name: symlinked-skill
description: Skill loaded through a symlink.
---

# Symlinked Skill

Loaded via symbolic link.
`,
		);
		fs.symlinkSync(
			externalSkillDir,
			path.join(path.dirname(skillsDir), "symlinked-skill-link"),
			process.platform === "win32" ? "junction" : "dir",
		);
	});

	// Every session binds process state (discovery toggles, effects, the shared-LSP mode) until disposed.
	const sessions: AgentSession[] = [];
	const createSession = async (options: Parameters<typeof createAgentSession>[0]) => {
		const created = await createAgentSession(options);
		sessions.push(created.session);
		return created;
	};
	const removeTempHome = cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }));

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			if (!session.isDisposed) await session.dispose();
		}
		removeTempHome();
	});

	const createRefreshSession = async (): Promise<AgentSession> => {
		const settings = createIsolatedSkillsSettings();
		cfgAutolearnEnabled.override(settings, true);
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: path.join(tempHomeDir, ".omp", "agent"),
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			contextFiles: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		return session;
	};

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.skills.length).toBeGreaterThan(0);
		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("SDK invocation root scope isolates disabled discovery and merges normal discovery", async () => {
		const explicitPackage = path.join(tempDir, "sdk-explicit-extension");
		const settingsPackage = path.join(tempDir, "sdk-settings-extension");
		const installedPackage = path.join(tempHomeDir, ".omp", "plugins", "node_modules", "sdk-installed-extension");
		createExtensionSkill(explicitPackage, "sdk-explicit-skill");
		createExtensionSkill(settingsPackage, "sdk-settings-skill");
		createExtensionSkill(installedPackage, "sdk-installed-skill");
		fs.mkdirSync(path.join(tempHomeDir, ".omp", "plugins"), { recursive: true });
		fs.writeFileSync(
			path.join(tempHomeDir, ".omp", "plugins", "package.json"),
			JSON.stringify({ name: "omp-plugins", dependencies: { "sdk-installed-extension": "1.0.0" } }),
		);

		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		const baseSessionOptions = {
			cwd: tempDir,
			agentDir: path.join(tempHomeDir, ".omp", "agent"),
			modelRegistry: sharedModelRegistry,
			additionalExtensionPaths: [explicitPackage],
			enableMCP: false,
			enableLsp: false,
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
		};
		let session: AgentSession | undefined;
		try {
			({ session } = await createSession({
				...baseSessionOptions,
				sessionManager: SessionManager.inMemory(),
				settings: createIsolatedSkillsSettings([settingsPackage]),
				disableExtensionDiscovery: true,
			}));

			const isolatedSkillNames = session.skills.map(skill => skill.name);
			expect(isolatedSkillNames).toContain("sdk-explicit-skill");
			expect(isolatedSkillNames).not.toEqual(expect.arrayContaining(["sdk-settings-skill", "sdk-installed-skill"]));

			await session.dispose();
			session = undefined;
			({ session } = await createSession({
				...baseSessionOptions,
				sessionManager: SessionManager.inMemory(),
				settings: createIsolatedSkillsSettings([settingsPackage]),
			}));

			const mergedSkillNames = session.skills.map(skill => skill.name);
			expect(mergedSkillNames).toEqual(expect.arrayContaining(["sdk-explicit-skill", "sdk-settings-skill"]));
		} finally {
			await session?.dispose();
			setAgentDir(previousAgentDir);
		}
	});

	it("should discover skills when skill directory is a symlink", async () => {
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "symlinked-skill")).toBe(true);
	});

	it("should still discover project skills when user skills directory is missing", async () => {
		const userAgentDir = path.join(tempHomeDir, ".omp", "agent");
		removeSyncWithRetries(path.join(userAgentDir, "skills"));
		fs.writeFileSync(path.join(userAgentDir, "placeholder.txt"), "placeholder");

		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("refreshSkills reloads project skills on an existing session", async () => {
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(false);

		const runtimeSkillDir = path.join(tempDir, ".omp", "skills", "runtime-added-skill");
		fs.mkdirSync(runtimeSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(runtimeSkillDir, "SKILL.md"),
			`---
name: runtime-added-skill
description: Added after the session is created.
---

# Runtime Added Skill

This skill is added after session creation.
`,
		);

		await session.refreshSkills();

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(true);

		removeSyncWithRetries(runtimeSkillDir);

		await session.refreshSkills();

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(false);
	});

	it("a live skills.customDirectories edit exposes the directory's skills without restart", async () => {
		const settings = createIsolatedSkillsSettings();
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
		});
		const customDir = path.join(tempDir, "live-custom-skills");
		fs.mkdirSync(path.join(customDir, "live-custom-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(customDir, "live-custom-skill", "SKILL.md"),
			"---\nname: live-custom-skill\ndescription: Added through a live settings edit.\n---\nbody\n",
		);
		expect(session.skills.some((s: Skill) => s.name === "live-custom-skill")).toBe(false);

		// Command pickers (TUI autocomplete, RPC/ACP) rebuild on this notification.
		const skillAnnounced = Promise.withResolvers<void>();
		const unsubscribe = session.subscribeCommandMetadataChanged(() => {
			if (session.skills.some((s: Skill) => s.name === "live-custom-skill")) skillAnnounced.resolve();
		});
		cfgSkillsCustomDirectories.set(settings, [customDir]);
		await skillAnnounced.promise;
		unsubscribe();

		expect(session.systemPrompt.join("\n")).toContain("live-custom-skill");
	});

	it("manage_skill hot-registers managed skills in the active session", async () => {
		const originalAgentDir = getAgentDir();
		const managedAgentDir = path.join(tempHomeDir, ".omp", "agent");
		setAgentDir(managedAgentDir);
		const settings = createIsolatedSkillsSettings();
		cfgAutolearnEnabled.set(settings, true);
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: managedAgentDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
		});
		let commandMetadataChanges = 0;
		const unsubscribeCommandMetadata = session.subscribeCommandMetadataChanged(() => {
			commandMetadataChanges++;
		});

		try {
			const manageSkill = session.getToolByName("manage_skill");
			expect(manageSkill).toBeDefined();
			await manageSkill!.execute("manage-skill-create", {
				action: "create",
				name: "runtime-managed-skill",
				description: "Created by manage_skill during the session.",
				body: "# Runtime Managed Skill\n\nUse this immediately.",
			});

			expect(session.skills.some(skill => skill.name === "runtime-managed-skill")).toBe(true);
			expect(commandMetadataChanges).toBe(1);
			expect(getActiveSkills().some(skill => skill.name === "runtime-managed-skill")).toBe(true);
			expect(session.agent.state.systemPrompt.join("\n")).toContain("runtime-managed-skill");
			const readSkill = session.getToolByName("read");
			expect(readSkill).toBeDefined();
			const readResult = await readSkill!.execute("read-managed-skill", { path: "skill://runtime-managed-skill" });
			expect(
				readResult.content.some(part => part.type === "text" && part.text.includes("# Runtime Managed Skill")),
			).toBe(true);

			const updated = await manageSkill!.execute("manage-skill-update", {
				action: "update",
				name: "runtime-managed-skill",
				description: "Updated and immediately available.",
				body: "# Updated Managed Skill\n\nUse the replacement instructions.",
			});
			expect(updated.details).toMatchObject({ persisted: true, refresh: "completed" });
			expect(session.skills.find(skill => skill.name === "runtime-managed-skill")?.description).toBe(
				"Updated and immediately available.",
			);
			expect(session.agent.state.systemPrompt.join("\n")).toContain("Updated and immediately available.");
			expect(commandMetadataChanges).toBe(2);

			await manageSkill!.execute("manage-skill-delete", {
				action: "delete",
				name: "runtime-managed-skill",
			});
			expect(session.skills.some(skill => skill.name === "runtime-managed-skill")).toBe(false);
			expect(getActiveSkills().some(skill => skill.name === "runtime-managed-skill")).toBe(false);
			expect(session.agent.state.systemPrompt.join("\n")).not.toContain("runtime-managed-skill");
			expect(commandMetadataChanges).toBe(3);
			await expect(
				readSkill!.execute("read-deleted-managed-skill", { path: "skill://runtime-managed-skill" }),
			).rejects.toThrow(/Unknown skill/);
		} finally {
			await session.dispose();
			unsubscribeCommandMetadata();
			setAgentDir(originalAgentDir);
		}
	});

	it("refreshes skill prompts without depending on a nested registry ALS scope", async () => {
		const session = await createRefreshSession();
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			"---\nname: test-skill\ndescription: Refreshed without ALS queue reentry.\n---\nbody\n",
		);
		const missingScope = vi.spyOn(AsyncLocalStorage.prototype, "getStore").mockReturnValue(undefined);
		try {
			await session.refreshSkills();
			expect(session.skills.find(skill => skill.name === "test-skill")?.description).toBe(
				"Refreshed without ALS queue reentry.",
			);
			expect(session.agent.state.systemPrompt.join("\n")).toContain("Refreshed without ALS queue reentry.");
		} finally {
			missingScope.mockRestore();
		}
	});

	it("settles cancellation queued after a persisted update without applying its stale refresh", async () => {
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let blocked: Promise<void> | undefined;
		let restoreRefresh: (() => void) | undefined;
		try {
			await writeManagedSkill({
				action: "create",
				name: "queued-update",
				description: "Original catalog.",
				body: "old",
			});
			const session = await createRefreshSession();
			const oldPrompt = session.agent.state.systemPrompt;
			blocked = session.runToolRegistryMutation(async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			const controller = new AbortController();
			const queued = Promise.withResolvers<void>();
			const refresh = session.refreshSkills.bind(session);
			const refreshSpy = vi.spyOn(session, "refreshSkills").mockImplementation(signal => {
				expect(signal).toBe(controller.signal);
				queued.resolve();
				return refresh(signal);
			});
			restoreRefresh = () => refreshSpy.mockRestore();
			const tool = session.getToolByName("manage_skill")!;
			const execution = tool.execute(
				"queued-update",
				{ action: "update", name: "queued-update", description: "Persisted catalog.", body: "saved" },
				controller.signal,
			);
			await queued.promise;
			controller.abort(new Error("cancel queued refresh"));
			const result = await execution;
			expect(result.details).toMatchObject({ persisted: true, refresh: "cancelled" });
			expect(
				await Bun.file(path.join(getAgentDir(), "managed-skills", "queued-update", "SKILL.md")).text(),
			).toContain("saved");
			expect(session.skills.find(skill => skill.name === "queued-update")?.description).toBe("Original catalog.");
			expect(session.agent.state.systemPrompt).toBe(oldPrompt);
			release.resolve();
			await blocked;
			await session.runToolRegistryMutation(async () => {});
			expect(session.skills.find(skill => skill.name === "queued-update")?.description).toBe("Original catalog.");
		} finally {
			release.resolve();
			await blocked;
			restoreRefresh?.();
			setAgentDir(previousAgentDir);
		}
	});

	it("never lets a cancelled prompt candidate overwrite a newer skills and prompt commit", async () => {
		const session = await createRefreshSession();
		const originalSkills = session.skills;
		const originalWarnings = session.skillWarnings;
		const originalPrompt = session.agent.state.systemPrompt;
		const backend = await resolveMemoryBackend(session.settings);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string | undefined>();
		const instructions = vi.spyOn(backend, "buildDeveloperInstructions").mockImplementationOnce(() => {
			entered.resolve();
			return release.promise;
		});
		const controller = new AbortController();
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			"---\nname: test-skill\ndescription: Abandoned candidate.\n---\nold candidate\n",
		);
		const refresh = session.refreshSkills(controller.signal);
		const outcome = refresh.then(
			() => undefined,
			error => error,
		);
		try {
			await entered.promise;
			expect(session.skills).toBe(originalSkills);
			expect(session.skillWarnings).toBe(originalWarnings);
			expect(session.agent.state.systemPrompt).toBe(originalPrompt);
			controller.abort(new Error("candidate cancelled"));
			expect(await outcome).toBeInstanceOf(Error);
			fs.writeFileSync(
				path.join(skillsDir, "SKILL.md"),
				"---\nname: test-skill\ndescription: Newest committed candidate.\n---\nnew body\n",
			);
			await session.refreshSkills();
			const winningPrompt = session.agent.state.systemPrompt;
			expect(winningPrompt.join("\n")).toContain("Newest committed candidate.");
			release.resolve("stale developer instructions");
			await release.promise;
			await session.runToolRegistryMutation(async () => {});
			expect(session.skills.find(skill => skill.name === "test-skill")?.description).toBe(
				"Newest committed candidate.",
			);
			expect(getActiveSkills().find(skill => skill.name === "test-skill")?.description).toBe(
				"Newest committed candidate.",
			);
			expect(session.agent.state.systemPrompt).toBe(winningPrompt);
			expect(winningPrompt.join("\n")).not.toContain("stale developer instructions");
		} finally {
			controller.abort();
			release.resolve(undefined);
			await outcome;
			instructions.mockRestore();
		}
	});

	it("learn hot-registers minted managed skills in the active session", async () => {
		const originalAgentDir = getAgentDir();
		const managedAgentDir = path.join(tempHomeDir, ".omp", "agent");
		setAgentDir(managedAgentDir);
		const settings = Settings.isolated({
			"skills.enabled": true,
			"skills.enableCodexUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
			"skills.enablePiUser": false,
			"skills.enablePiProject": true,
			"autolearn.enabled": true,
			"memory.backend": "local",
		});
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: managedAgentDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
		});

		try {
			const learn = session.getToolByName("learn");
			expect(learn).toBeDefined();
			await learn!.execute("learn-skill-create", {
				memory: "Use learned-managed-skill immediately in the same session.",
				skill: {
					action: "create",
					name: "learned-managed-skill",
					description: "Minted by learn during the active session.",
					body: "# Learned Managed Skill\n\nAvailable immediately via skill://.",
				},
			});

			expect(session.skills.some(skill => skill.name === "learned-managed-skill")).toBe(true);
			expect(getActiveSkills().some(skill => skill.name === "learned-managed-skill")).toBe(true);
			expect(session.agent.state.systemPrompt.join("\n")).toContain("learned-managed-skill");
			const readSkill = session.getToolByName("read");
			expect(readSkill).toBeDefined();
			const readResult = await readSkill!.execute("read-learned-skill", { path: "skill://learned-managed-skill" });
			expect(
				readResult.content.some(part => part.type === "text" && part.text.includes("# Learned Managed Skill")),
			).toBe(true);
		} finally {
			await session.dispose();
			setAgentDir(originalAgentDir);
		}
	});

	it("should have empty skills when options.skills is empty array (--no-skills)", async () => {
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [], // Explicitly empty - like --no-skills
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should be empty
		expect(session.skills).toEqual([]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});

	it("should use provided skills when options.skills is explicitly set", async () => {
		const customSkill: Skill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			source: "custom" as const,
		};

		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [customSkill],
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should contain only the provided skill
		expect(session.skills).toEqual([customSkill]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});
});
