import "./node-platform";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { parsePluginArgs, runPluginCommand } from "./cli/plugin-cli";
import { initializeNodeSdk } from "./node-bootstrap";

initializeNodeSdk(import.meta.url);

/** Run a full `plugin` argv in a dedicated Node process, preserving CLI output and exit semantics. */
export async function runNodePluginCommand(args: readonly string[]): Promise<void> {
	const command = parsePluginArgs([...args]);
	if (!command) throw new Error("Node SDK plugin commands must start with 'plugin'");
	await initTheme();
	await runPluginCommand(command);
}
