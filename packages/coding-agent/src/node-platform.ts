// Embedded Node builds can predate ES2025 even when their Node API is version 24.
const needsRegExpEscape = typeof RegExp.escape !== "function";
const needsDisposableStack = typeof DisposableStack !== "function";
// Literal requires let the Node bundle include only these shims and their dependencies.
if (needsRegExpEscape) require("core-js/actual/regexp/escape");
if (needsDisposableStack) require("core-js/actual/disposable-stack");

export {};
