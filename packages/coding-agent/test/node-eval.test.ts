import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const packageDir = path.resolve(import.meta.dir, "..");

// Like the other Node artifact contracts, run only after the SDK bundles exist.
// Dynamic imports in fixture cells exercise the evaluator's module loading boundary.
for (const artifact of ["node", "node-desktop"]) {
	const host = path.join(packageDir, "dist", artifact, "host.mjs");
	describe.skipIf(!fs.existsSync(host))(`${artifact} JavaScript eval`, () => {
		test("retains JS modules and rejects typed execution without module side effects", async () => {
			using root = TempDir.createSync("@node-eval-contract-");
			const result = await ptree.exec(
				[
					"node",
					"--input-type=module",
					"-e",
					`import assert from "node:assert/strict";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
const cwd = ${JSON.stringify(root.path())};
const snapshot = { cwd, sessionId: "node-eval-contract", localRoots: {} };
const worker = fork(${JSON.stringify(host)}, ["__omp_worker_js_eval_process"], {
  execArgv: ["--experimental-vm-modules"],
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
let pending;
let sequence = 0;
worker.on("message", message => pending?.(message));
function request(message, expectedType) {
  const { promise, resolve, reject } = Promise.withResolvers();
  let output = "";
  const fail = error => { cleanup(); reject(error); };
  const exit = code => fail(new Error("eval worker exited: " + code));
  function cleanup() {
    pending = undefined;
    worker.off("error", fail);
    worker.off("exit", exit);
  }
  pending = reply => {
    if (reply.type === "init-failed") return fail(new Error(reply.error.message));
    if (reply.type === "text") output += reply.chunk;
    if (reply.type !== expectedType) return;
    cleanup();
    resolve({ ...reply, output });
  };
  worker.once("error", fail);
  worker.once("exit", exit);
  worker.send(message, error => { if (error) fail(error); });
  return promise;
}
async function run(code, filename = "cell.js") {
  return await request({ type: "run", runId: String(++sequence), code, filename, snapshot }, "result");
}
async function value(code) {
  const result = await run(code);
  assert.equal(result.ok, true, result.error?.message);
  // Native diagnostics can share the text stream; select the cell's JSON value.
  const line = result.output.trim().split("\\n").findLast(line => {
    try { JSON.parse(line); return true; } catch { return false; }
  });
  if (line === undefined) throw new Error("Cell returned no JSON value: " + result.output);
  return JSON.parse(line);
}
async function rejected(code, pattern) {
  const result = await run(code);
  assert.equal(result.ok, false, result.output);
  assert.match(result.error.message, pattern);
}
try {
  await request({ type: "init", snapshot }, "ready");
  assert.equal(await value("var retained = 40; retained + 2"), 42);
  assert.equal(await value("retained + 3"), 43);
  const text = "interface Demo { value: string }; import type { Demo } from './types'; as const";
  assert.equal(await value("/* type Alias = number */ JSON.stringify(" + JSON.stringify(text) + ")"), text);
  for (const typed of ["const value: number = 42;", "interface Demo { value: number }", "import type { Demo } from './types.js';"]) {
    await rejected("globalThis.typedCellSideEffect = true;\\n" + typed, /Unexpected|Missing|reserved|token/i);
    assert.equal(await value("Boolean(globalThis.typedCellSideEffect)"), false);
  }
  for (const extension of ["ts", "tsx", "mts", "cts", "jsx"]) {
    const filename = path.join(cwd, "unsupported." + extension);
    fs.writeFileSync(filename, "globalThis.typedModuleSideEffect = true; export const value = 42;");
    const loaded = await run("globalThis.typedLoadSideEffect = true;", filename);
    assert.equal(loaded.ok, false);
    assert.match(loaded.error.message, /Precompile/);
    assert.equal(await value("Boolean(globalThis.typedLoadSideEffect)"), false);
    for (const specifier of ["./unsupported." + extension, pathToFileURL(filename).href + "?version=1"]) {
      await rejected("await import(" + JSON.stringify(specifier) + ")", /Precompile to \\.js, \\.mjs, or \\.cjs/);
    }
    await rejected("require(" + JSON.stringify("./unsupported." + extension) + ")", /Precompile/);
    await rejected("createRequire(" + JSON.stringify(path.join(cwd, "cell.js")) + ")(" + JSON.stringify("./unsupported." + extension) + ")", /Precompile/);
    assert.equal(await value("Boolean(globalThis.typedModuleSideEffect)"), false);
    assert.equal(await value("(await read(" + JSON.stringify(filename) + ")).includes('typedModuleSideEffect')"), true);
  }
  fs.writeFileSync(path.join(cwd, "blocked.js"), "import './unsupported.ts'; globalThis.blockedModuleSideEffect = true;");
  await rejected("await import('./blocked.js')", /Precompile/);
  assert.equal(await value("Boolean(globalThis.blockedModuleSideEffect)"), false);
  fs.writeFileSync(path.join(cwd, "typed-syntax.js"), "globalThis.typedSyntaxSideEffect = true; export const value: number = 42;");
  await rejected("await import('./typed-syntax.js')", /Unexpected|Missing|token/i);
  assert.equal(await value("Boolean(globalThis.typedSyntaxSideEffect)"), false);
  fs.writeFileSync(path.join(cwd, "require-typed.js"), "require('./unsupported.cts'); globalThis.requireTypedSideEffect = true;");
  await rejected("await import('./require-typed.js')", /Precompile/);
  assert.equal(await value("Boolean(globalThis.requireTypedSideEffect)"), false);
  const packageDir = path.join(cwd, "node_modules", "typed-package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "typed-package", main: "index.ts" }));
  fs.writeFileSync(path.join(packageDir, "index.ts"), "globalThis.typedPackageSideEffect = true; export const value = 42;");
  await rejected("await import('typed-package')", /Precompile/);
  await rejected("require('typed-package')", /Precompile/);
  assert.equal(await value("Boolean(globalThis.typedPackageSideEffect)"), false);
  fs.writeFileSync(path.join(cwd, "cached.js"), "globalThis.moduleLoads = (globalThis.moduleLoads ?? 0) + 1; export const value = 42;");
  assert.equal(await value("(await import('./cached.js')).value"), 42);
  assert.equal(await value("(await import('./cached')).value"), 42);
  assert.equal(await value("globalThis.moduleLoads"), 1);
  fs.writeFileSync(path.join(cwd, "cached.js"), "globalThis.moduleLoads++; export const value = 43;");
  const modified = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(cwd, "cached.js"), modified, modified);
  assert.equal(await value("(await import('./cached.js')).value"), 43);
  assert.equal(await value("globalThis.moduleLoads"), 2);
  fs.writeFileSync(path.join(cwd, "a.js"), "import { b } from './b.js'; export function a() { return b() + 1; }");
  fs.writeFileSync(path.join(cwd, "b.js"), "import { a } from './a.js'; export function b() { return 41; } export function answer() { return a(); }");
  assert.equal(await value("(await import('./b.js')).answer()"), 42);
  fs.writeFileSync(path.join(cwd, "common.cjs"), "module.exports = { value: 42 };");
  assert.equal(await value("require('./common.cjs').value"), 42);
  assert.equal(await value("(await import('./common.cjs')).default.value"), 42);
  await request({ type: "close" }, "closed");
  console.log("Node eval contract passed");
} finally {
  worker.kill();
}`,
				],
				{
					cwd: packageDir,
					timeout: 30_000,
					allowNonZero: true,
				},
			);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain("Node eval contract passed");
		}, 35_000);
	});
}
