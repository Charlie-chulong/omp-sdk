import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "@oh-my-pi/omptype/zod";
import { isEnoent, normalizePathForComparison, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { runtime } from "@oh-my-pi/pi-utils/runtime";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { BUILTIN_TOOL_NAMES } from "../../tools/builtin-names";
import { loadCustomTools } from "../custom-tools/loader";
import { loadExtensions } from "../extensions/loader";
import { getEnabledPlugins, resolvePluginManifestEntries, type ScopedInstalledPlugin } from "./loader";
import {
	getInstalledPluginsRegistryPath,
	readInstalledPluginsRegistry,
	writeInstalledPluginsRegistry,
} from "./marketplace/registry";
import { normalizePluginRuntimeConfig, writePluginRuntimeConfig } from "./runtime-config";

const runtimeConfigSchema = z.object({
	plugins: z
		.record(
			z.string(),
			z
				.object({
					version: z.string(),
					enabledFeatures: z.array(z.string()).nullable(),
					enabled: z.boolean(),
				})
				.passthrough(),
		)
		.optional(),
	settings: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export interface PluginStartupCheck {
	name: string;
	scope: "user" | "project";
	path: string;
	errors: string[];
	disabled: boolean;
}

async function disablePlugin(plugin: ScopedInstalledPlugin, cwd: string): Promise<void> {
	const registryPath =
		plugin.scope === "user" ? getInstalledPluginsRegistryPath() : await resolveActiveProjectRegistryPath(cwd);
	if (!registryPath) throw new Error(`Cannot resolve project plugin registry for ${plugin.name}`);
	const lockPath = path.join(path.dirname(registryPath), "omp-plugins.lock.json");
	const config = await runtime
		.file(lockPath)
		.json()
		.catch(error => {
			if (isEnoent(error)) return {};
			throw error;
		});
	const state = normalizePluginRuntimeConfig(runtimeConfigSchema.parse(config));
	state.plugins[plugin.name] = {
		...(state.plugins[plugin.name] ?? { version: plugin.version, enabledFeatures: plugin.enabledFeatures }),
		enabled: false,
	};
	// The runtime lock prevents the failed module from loading even if registry synchronization fails.
	await writePluginRuntimeConfig(lockPath, state);

	const registry = await readInstalledPluginsRegistry(registryPath);
	const pluginPath = normalizePathForComparison(await fs.realpath(plugin.path));
	let changed = false;
	for (const entries of Object.values(registry.plugins)) {
		for (const entry of entries) {
			if (entry.scope !== plugin.scope || entry.enabled === false) continue;
			const installedPath = await fs.realpath(entry.installPath).catch(error => {
				if (isEnoent(error)) return null;
				throw error;
			});
			if (installedPath && normalizePathForComparison(installedPath) === pluginPath) {
				entry.enabled = false;
				changed = true;
			}
		}
	}
	if (changed) await writeInstalledPluginsRegistry(registryPath, registry);
}

/** Load enabled plugin entry points with the selected runtime, without opening a session or executing tools. */
export async function checkPluginStartup(
	cwd: string,
	options: { disableFailed?: boolean } = {},
): Promise<PluginStartupCheck[]> {
	const plugins = await getEnabledPlugins(cwd);
	const checks: PluginStartupCheck[] = [];
	try {
		for (const plugin of plugins) {
			const check: PluginStartupCheck = {
				name: plugin.name,
				scope: plugin.scope,
				path: plugin.path,
				errors: [],
				disabled: false,
			};
			try {
				const modules: string[] = [];
				const tools: string[] = [];
				for (const key of ["extensions", "hooks", "tools", "commands"] as const) {
					for (const { entry, resolvedPath } of resolvePluginManifestEntries(plugin, key)) {
						if (!resolvedPath) {
							check.errors.push(`${key}: ${entry}: declared entry not found on disk`);
						} else if (key === "tools") {
							tools.push(resolvedPath);
						} else if (key === "commands") {
							parseFrontmatter(await runtime.file(resolvedPath).text(), { source: resolvedPath, level: "warn" });
						} else {
							modules.push(resolvedPath);
						}
					}
				}
				if (modules.length) {
					const result = await loadExtensions(modules, cwd);
					check.errors.push(...result.errors.map(error => `${error.path}: ${error.error}`));
				}
				if (tools.length) {
					const result = await loadCustomTools(
						tools.map(toolPath => ({ path: toolPath })),
						cwd,
						[...BUILTIN_TOOL_NAMES],
					);
					check.errors.push(...result.errors.map(error => `${error.path}: ${error.error}`));
				}
			} catch (error) {
				check.errors.push(error instanceof Error ? error.message : String(error));
			}
			if (check.errors.length && options.disableFailed) {
				await disablePlugin(plugin, cwd);
				check.disabled = true;
			}
			checks.push(check);
		}
	} finally {
		if (options.disableFailed) clearPluginRootsAndCaches();
	}
	return checks;
}
