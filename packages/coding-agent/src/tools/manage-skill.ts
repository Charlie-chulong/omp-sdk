import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	sanitizeSkillName,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import manageSkillDescription from "../prompts/tools/manage-skill.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgAutolearnEnabled } from "../autolearn/settings";

const manageSkillSchema = type({
	action: "'create' | 'update' | 'delete'",
	name: type("string").describe("kebab-case skill name"),
	"description?": type("string").describe(
		"one-line description of when to use the skill (required for create/update)",
	),
	"body?": type("string").describe("the SKILL.md body in markdown, no frontmatter (required for create/update)"),
}).narrow(
	(p, ctx) =>
		p.action === "delete" ||
		(p.description !== undefined && p.body !== undefined) ||
		// Enforce the action/field contract at validation time rather than only in
		// execute. Kept as a cross-field narrow (not a discriminated union) so the
		// wire schema stays a single root object — strict structured-output mode and
		// the Anthropic tool-schema builder both require that.
		ctx.mustBe('used with both "description" and "body" for "create" and "update"'),
);

export type ManageSkillParams = typeof manageSkillSchema.infer;

/**
 * Direct create/update/delete of isolated managed skills. Gated behind
 * `autolearn.enabled`; backend-independent (the skill side is standalone).
 */
export class ManageSkillTool implements AgentTool<typeof manageSkillSchema> {
	readonly name = "manage_skill";
	readonly approval = "write" as const;
	readonly label = "Manage Skill";
	readonly description = manageSkillDescription;
	readonly parameters = manageSkillSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Create, update, or delete an isolated managed skill";

	constructor(private readonly refreshSkills?: (signal?: AbortSignal) => Promise<void>) {}

	static createIf(session: ToolSession): ManageSkillTool | null {
		if (!cfgAutolearnEnabled.get(session.settings)) return null;
		return new ManageSkillTool(session.refreshSkills);
	}

	async execute(_id: string, params: ManageSkillParams, signal?: AbortSignal): Promise<AgentToolResult> {
		signal?.throwIfAborted();
		if (params.action === "delete") {
			await deleteManagedSkill(params.name, signal);
			return this.#persistedResult(params, `Deleted managed skill "${params.name}".`, signal);
		}

		// Defensive narrowing: the schema refine already rejects create/update
		// without both fields, so this is unreachable for valid input — it only
		// proves the strings are present to `writeManagedSkill`'s typed contract.
		if (!params.description || !params.body) {
			throw new Error(`"${params.action}" requires both "description" and "body".`);
		}
		// A managed skill resolves below any authored skill of the same name
		// (authored always wins in discovery), so creating one under a name an
		// authored skill already claims writes a file that never surfaces. Refuse
		// up front rather than report a false "Created". `sanitizeSkillName`
		// normalizes to the on-disk name the discovery scan compares against.
		if (params.action === "create" && isNameClaimedByAuthoredSkill(sanitizeSkillName(params.name))) {
			return {
				content: [
					{
						type: "text",
						text: `Cannot create managed skill "${params.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
					},
				],
				isError: true,
				details: { action: "create", name: params.name, shadowed: true },
			};
		}
		const { path: skillPath } = await writeManagedSkill(
			{
				action: params.action,
				name: params.name,
				description: params.description,
				body: params.body,
			},
			signal,
		);
		const relativePath = path.relative(getManagedSkillsDir(), skillPath);
		const verb = params.action === "create" ? "Created" : "Updated";
		return this.#persistedResult(
			params,
			`${verb} managed skill "${params.name}" (managed-skills/${relativePath}).`,
			signal,
		);
	}

	async #persistedResult(
		params: ManageSkillParams,
		persistedText: string,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		try {
			signal?.throwIfAborted();
			await untilAborted(signal, () => this.refreshSkills?.(signal) ?? Promise.resolve());
			return {
				content: [{ type: "text", text: persistedText }],
				details: {
					action: params.action,
					name: params.name,
					persisted: true,
					refresh: this.refreshSkills ? "completed" : "not_configured",
				},
			};
		} catch (error) {
			const refresh = signal?.aborted ? "cancelled" : "failed";
			const reason = error instanceof Error ? error.message : String(error);
			return {
				content: [
					{
						type: "text",
						text: `${persistedText} The file change is persisted. Session skill refresh ${refresh}: ${reason}. Do not repeat the file operation; refresh skills separately when ready.`,
					},
				],
				isError: true,
				details: { action: params.action, name: params.name, persisted: true, refresh, refreshError: reason },
			};
		}
	}
}
