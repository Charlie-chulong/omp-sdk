import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { TempDir } from "@oh-my-pi/pi-utils";

const packageDir = path.resolve(import.meta.dir, "..");

for (const artifact of ["node", "node-desktop"]) {
	const entry = path.join(packageDir, "dist", artifact, "sdk.mjs");
	describe.skipIf(!fs.existsSync(entry))(`${artifact} auth storage contention`, () => {
		test("opens committed credentials without waiting for another connection's pending write", async () => {
			using root = TempDir.createSync("@node-auth-storage-");
			const source = `
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteAuthCredentialStore } from ${JSON.stringify(pathToFileURL(entry).href)};
const dbPath = ${JSON.stringify(root.join("agent.db"))};
const seed = await SqliteAuthCredentialStore.open(dbPath);
await seed.saveApiKey("openai", "test-existing-key");
seed.close();
const writer = new DatabaseSync(dbPath);
let reopened;
try {
	writer.exec("BEGIN IMMEDIATE; UPDATE auth_credentials SET disabled_cause = 'pending' WHERE provider = 'openai'");
	reopened = await SqliteAuthCredentialStore.open(dbPath);
	assert.deepEqual(reopened.listAuthCredentials("openai").map(row => row.credential), [
		{ type: "api_key", key: "test-existing-key" },
	]);
	writer.exec("COMMIT");
	assert.deepEqual(reopened.listAuthCredentials("openai"), []);
} finally {
	if (writer.isTransaction) writer.exec("ROLLBACK");
	reopened?.close();
	writer.close();
}
`;
			const result = await $`node --input-type=module -e ${source}`.cwd(root.path()).quiet().nothrow();
			expect(result.exitCode, result.stderr.toString()).toBe(0);
		}, 15_000);
	});
}
