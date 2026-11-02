# Examples

Example code for omp-coding-agent SDK, extensions, hooks, and custom tools.

TypeScript examples run directly with Bun. Node SDK/Desktop executable plugins, tools, commands, and eval scripts must be precompiled to `.js`, `.mjs`, or `.cjs`, including their dependencies; manifests must reference the emitted files.

## Directories

### [sdk/](sdk/)

Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, hooks, and session management.

### [extensions/](extensions/)

Example extensions using `ExtensionAPI`: custom tools, commands, UI, and system prompt changes.

### [hooks/](hooks/)

Example hooks (`HookAPI` factories) for intercepting tool calls, adding safety gates, and integrating with external systems. They load through the extension runner.

### [custom-tools/](custom-tools/)

Example custom tools that extend the agent's capabilities.

## Documentation

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../../../docs/extensions.md)
- [Hooks Documentation](../../../docs/hooks.md)
- [Custom Tools Documentation](../../../docs/custom-tools.md)
- [Skills Documentation](../../../docs/skills.md)
