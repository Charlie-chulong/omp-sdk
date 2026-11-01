import { it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const nodeExecutable = process.env.OMP_NODE_EXECUTABLE ?? Bun.which("node");
it.skipIf(!nodeExecutable)(
	"preserves process, shell and server contracts in actual Node",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-node-process-"));
		try {
			const bundle = path.join(directory, "runtime-process-node-probe.mjs");
			const build = await Bun.build({
				entrypoints: [path.join(import.meta.dir, "fixtures/runtime-process-node-probe.ts")],
				target: "node",
				format: "esm",
				packages: "bundle",
			});
			if (!build.success) throw new AggregateError(build.logs, "Node runtime process probe failed to bundle");
			await Bun.write(bundle, build.outputs[0]!);
			const child = Bun.spawn([nodeExecutable!, "--test", bundle], {
				env: { ...process.env, NODE_PATH: path.join(import.meta.dir, "../../../node_modules") },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (exitCode !== 0) throw new Error(`Node runtime process probes exited ${exitCode}\n${stdout}\n${stderr}`);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	60_000,
);
