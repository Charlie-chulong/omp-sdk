import { strict as assert } from "node:assert";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "../src/sqlite-driver";

// These contracts use node:test so the same source can exercise either native
// driver. Bundle for Node before running there; the utility sources use the
// repository's extensionless TypeScript module imports.

test("nested constraint errors roll back only their savepoint", () => {
	using db = new Database(":memory:");
	db.run("CREATE TABLE entries (value TEXT UNIQUE)");
	const insert = db.query("INSERT INTO entries VALUES (?)");
	const inner = db.transaction(() => {
		insert.run("inner");
		insert.run("outer");
	});
	const outer = db.transaction(() => {
		insert.run("outer");
		assert.throws(() => inner.immediate(), { code: "SQLITE_CONSTRAINT_UNIQUE" });
		assert.equal(db.inTransaction, true);
		insert.run("tail");
	});
	outer.exclusive();
	assert.equal(db.inTransaction, false);
	assert.deepEqual(db.query("SELECT value FROM entries ORDER BY rowid").values(), [["outer"], ["tail"]]);
});

test("a caller-owned transaction survives nested rollback and retains error identity", () => {
	using db = new Database(":memory:");
	db.run("CREATE TABLE entries (value TEXT); BEGIN IMMEDIATE; INSERT INTO entries VALUES ('caller')");
	const failure = new Error("callback failed");
	const nested = db.transaction(() => {
		db.run("INSERT INTO entries VALUES (?)", ["discarded"]);
		throw failure;
	});
	assert.throws(
		() => nested.deferred(),
		error => error === failure,
	);
	assert.equal(db.inTransaction, true);
	assert.deepEqual(db.query("SELECT value FROM entries").values(), [["caller"]]);
	db.run("ROLLBACK");
	assert.deepEqual(db.query("SELECT value FROM entries").all(), []);
});

test("a deferred foreign-key failure at commit rolls back the transaction", () => {
	using db = new Database(":memory:");
	db.run(`PRAGMA foreign_keys = ON;
CREATE TABLE parents (id INTEGER PRIMARY KEY);
CREATE TABLE children (parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);`);
	const insert = db.transaction(() => {
		db.run("INSERT INTO children VALUES (?)", [99]);
		assert.equal(db.inTransaction, true);
	});
	assert.throws(() => insert.immediate(), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
	assert.equal(db.inTransaction, false);
	assert.deepEqual(db.query("SELECT parent_id FROM children").all(), []);
});

test("an immediate transaction's BUSY error never runs its callback or rolls back its peer", () => {
	const directory = mkdtempSync(join(tmpdir(), "omp-sqlite-driver-"));
	try {
		using first = new Database(join(directory, "store.db"));
		using second = new Database(join(directory, "store.db"));
		first.run("CREATE TABLE entries (value TEXT); BEGIN IMMEDIATE");
		second.run("PRAGMA busy_timeout = 1");
		let called = false;
		const transaction = second.transaction(() => {
			called = true;
		});
		assert.throws(
			() => transaction.immediate(),
			error => {
				assert.equal(typeof error, "object");
				return (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					typeof error.code === "string" &&
					error.code.startsWith("SQLITE_BUSY")
				);
			},
		);
		assert.equal(called, false);
		assert.equal(first.inTransaction, true);
		assert.equal(second.inTransaction, false);
		first.run("ROLLBACK");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("strict named and numbered bindings reject missing parameters without treating SQL literals as bindings", () => {
	using db = new Database(":memory:", { strict: true });
	using query = db.prepare<{ first: string; second: string; literal: string }, Record<string, string>>(
		"SELECT :credential AS first, ?1 AS second, ':not_a_parameter ?9' AS literal -- ?7\n",
		{ credential: "secret'); DROP TABLE entries; --" },
	);
	assert.equal(query.paramsCount, 1);
	const initial = query.get();
	assert.equal(initial?.first, "secret'); DROP TABLE entries; --");
	assert.equal(initial?.second, initial?.first);
	assert.equal(initial?.literal, ":not_a_parameter ?9");
	assert.throws(() => query.get({}), /bind|param/i);
	assert.deepEqual(query.get({ credential: initial!.first }), initial);
});

test("Node snapshot rejection leaves a caller-owned transaction active", { skip: !!process.versions.bun }, () => {
	using db = new Database(":memory:");
	db.run("CREATE TABLE entries (value TEXT); BEGIN; INSERT INTO entries VALUES ('pending')");
	assert.throws(() => db.serialize(), { code: "SQLITE_ERROR" });
	assert.equal(db.inTransaction, true);
	assert.deepEqual(db.query("SELECT value FROM entries").values(), [["pending"]]);
	db.run("ROLLBACK");
});

test("numbered and repeated bindings keep SQLite indices across named and anonymous slots", () => {
	using db = new Database(":memory:", { strict: true });
	using query = db.prepare("SELECT ?3 AS third, :name AS named, ?1 AS first, ?3 AS repeated");
	assert.equal(query.paramsCount, 4);
	assert.deepEqual(query.values("first", "unused", "third", "named"), [["third", "named", "first", "third"]]);
	assert.deepEqual(query.values(), [["third", "named", "first", "third"]]);
	assert.deepEqual(query.values({ "?1": "first", 1: "unused", "?3": "third", name: "named" }), [
		["third", "named", "first", "third"],
	]);
});

test("numbered UPSERT bindings accumulate persisted model performance samples", () => {
	using db = new Database(":memory:", { strict: true });
	db.run("CREATE TABLE perf (model_key TEXT PRIMARY KEY, output_tokens INTEGER, gen_ms REAL)");
	using upsert = db.query(
		"INSERT INTO perf VALUES (?1, ?2, ?3) ON CONFLICT(model_key) DO UPDATE SET output_tokens = perf.output_tokens + excluded.output_tokens, gen_ms = perf.gen_ms + excluded.gen_ms",
	);
	upsert.run("provider/model", 7, 1.5);
	upsert.run("provider/model", 3, 0.5);
	assert.deepEqual(db.query("SELECT model_key, output_tokens, gen_ms FROM perf").all(), [
		{ model_key: "provider/model", output_tokens: 10, gen_ms: 2 },
	]);
});

test("binding tokens ignore identifier dollars and CR inside line comments", () => {
	using db = new Database(":memory:", { strict: true });
	db.run("CREATE TABLE entries (column$value TEXT)");
	db.run("INSERT INTO entries VALUES (?)", ["persisted"]);
	using query = db.prepare(
		"SELECT column$value, :🔑 AS credential, @name::suffix(key) AS suffix FROM entries --\r ?9 :ignored\n",
		{ "🔑": "secret", "name::suffix(key)": "suffix" },
	);
	assert.equal(query.paramsCount, 2);
	assert.deepEqual(query.values(), [["persisted", "secret", "suffix"]]);
});

test("explicit positional lists require the full count, while an empty list clears retained bindings", () => {
	using db = new Database(":memory:", { strict: true });
	using query = db.prepare<unknown, any[]>("SELECT ? AS first, ? AS second", ["first", "second"]);
	assert.deepEqual(query.values(), [["first", "second"]]);
	assert.throws(() => query.values("missing second"), /expected|values|bind|param/i);
	assert.deepEqual(query.values([]), [[null, null]]);
	assert.deepEqual(query.values({ 0: "first", 1: "second" }), [["first", "second"]]);
	assert.throws(() => query.values({ 0: "missing second" }), /bind|param/i);
});

test("retained blob bindings own their bytes across every statement read method", () => {
	using db = new Database(":memory:");
	const bytes = new Uint8Array([1, 2, 3]);
	using query = db.prepare<{ value: Uint8Array }, [Uint8Array]>("SELECT ? AS value", [bytes]);
	bytes.fill(9);
	assert.deepEqual(Array.from(query.get()!.value), [1, 2, 3]);
	assert.deepEqual(Array.from(query.all()[0].value), [1, 2, 3]);
	assert.deepEqual(Array.from(query.values()[0][0] as Uint8Array), [1, 2, 3]);
	assert.deepEqual(Array.from([...query.iterate()][0].value), [1, 2, 3]);
	const replacement = new Uint8Array([4, 5]);
	query.get(replacement);
	replacement.fill(8);
	assert.deepEqual(Array.from(query.get()!.value), [4, 5]);
});

test("integer, boolean and unsigned bigint bindings preserve Bun SQLite storage types", () => {
	using db = new Database(":memory:");
	assert.deepEqual(db.query("SELECT typeof(?), typeof(?), typeof(?), ?").values(42, true, 1.5, (1n << 64n) - 1n), [
		["integer", "integer", "real", -1],
	]);
	using safe = new Database(":memory:", { safeIntegers: true });
	assert.deepEqual(safe.query("SELECT ?, ?").values(42, true), [[42n, 1n]]);
	assert.throws(() => safe.query("SELECT ?").get(1n << 64n), /bigint|range|large/i);
});

test("run binds only the first statement, sums direct changes and clears stale read/DDL counts", () => {
	using db = new Database(":memory:");
	db.run("CREATE TABLE entries (value INTEGER)");
	assert.deepEqual(db.run("INSERT INTO entries VALUES (?); INSERT INTO entries VALUES (9);", 7), {
		changes: 2,
		lastInsertRowid: 2,
	});
	assert.deepEqual(db.run("INSERT INTO entries VALUES (?); INSERT INTO entries VALUES (?); --\r ignored\n;", 8), {
		changes: 2,
		lastInsertRowid: 4,
	});
	assert.deepEqual(db.query("SELECT value FROM entries").values(), [[7], [9], [8], [null]]);
	assert.deepEqual(db.query("SELECT value FROM entries").run(), { changes: 0, lastInsertRowid: 4 });
	assert.deepEqual(db.run("SELECT value FROM entries"), { changes: 0, lastInsertRowid: 4 });
	assert.deepEqual(db.run("CREATE TABLE other (value INTEGER)"), { changes: 0, lastInsertRowid: 4 });
	db.run(
		"CREATE TABLE audit (value INTEGER); CREATE TRIGGER inserted AFTER INSERT ON entries BEGIN INSERT INTO audit VALUES (new.value); END",
	);
	assert.equal(db.query("INSERT INTO entries VALUES (?)").run(10).changes, 1);
	assert.equal(db.run("INSERT INTO entries VALUES (11); INSERT INTO entries VALUES (12)").changes, 2);
});

test(
	"Node WAL snapshots are standalone and safely quote attached schema names",
	{ skip: !!process.versions.bun },
	() => {
		const directory = mkdtempSync(join(tmpdir(), "omp-sqlite-driver-"));
		try {
			const databasePath = join(directory, "store.db");
			using writer = new Database(databasePath);
			writer.run(
				"PRAGMA journal_mode = WAL; CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT); PRAGMA user_version = 7",
			);
			writer.run("INSERT INTO entries VALUES (?, ?)", [1, "committed"]);
			using reader = new Database(databasePath, { readonly: true });
			assert.throws(
				() => reader.run("INSERT INTO entries VALUES (2, 'forbidden')"),
				error =>
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					String(error.code).startsWith("SQLITE_READONLY"),
			);
			const snapshotPath = join(directory, "snapshot.db");
			writeFileSync(snapshotPath, reader.serialize(""));
			using restored = new Database(snapshotPath, { readonly: true });
			assert.deepEqual(restored.query("SELECT * FROM entries").values(), [[1, "committed"]]);
			assert.deepEqual(restored.query("PRAGMA user_version").values(), [[7]]);
			const schema = 'archive"; DROP TABLE entries; --';
			const quoted = `"${schema.replaceAll('"', '""')}"`;
			writer.run(`ATTACH DATABASE ? AS ${quoted}`, [join(directory, "attached.db")]);
			writer.run(`CREATE TABLE ${quoted}.entries (value TEXT); INSERT INTO ${quoted}.entries VALUES ('attached')`);
			const attachedPath = join(directory, "attached-snapshot.db");
			writeFileSync(attachedPath, writer.serialize(schema));
			using attached = new Database(attachedPath, { readonly: true });
			assert.deepEqual(attached.query("SELECT value FROM entries").values(), [["attached"]]);
			assert.deepEqual(writer.query("SELECT value FROM main.entries").values(), [["committed"]]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test(
	"moving an open database preserves a classifiable extended readonly or I/O error",
	{ skip: process.platform === "win32" },
	() => {
		const directory = mkdtempSync(join(tmpdir(), "omp-sqlite-driver-"));
		try {
			const filename = join(directory, "store.db");
			using db = new Database(filename);
			db.run("CREATE TABLE entries (value TEXT)");
			renameSync(filename, join(directory, "moved.db"));
			assert.throws(
				() => db.run("INSERT INTO entries VALUES ('value')"),
				error => {
					if (!error || typeof error !== "object" || !("code" in error) || !("errno" in error)) return false;
					return (
						typeof error.code === "string" &&
						/^SQLITE_(?:READONLY|IOERR)_/.test(error.code) &&
						typeof error.errno === "number" &&
						error.errno > 255
					);
				},
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test(
	"Node finalization ends active cursors and cached finalized statements can be prepared again",
	{ skip: !!process.versions.bun },
	() => {
		using db = new Database(":memory:");
		const query = db.query("SELECT 1 AS value UNION ALL SELECT 2");
		const iterator = query.iterate();
		const first = iterator.next();
		assert.equal(first.done, false);
		assert.deepEqual(first.value, { value: 1 });
		query.finalize();
		query.finalize();
		assert.equal(iterator.next().done, true);
		assert.throws(() => query.get(), /finalized/i);
		const replacement = db.query("SELECT 1 AS value UNION ALL SELECT 2");
		assert.notEqual(replacement, query);
		assert.deepEqual(replacement.all(), [{ value: 1 }, { value: 2 }]);
		db.close(true);
		db.close(true);
		assert.throws(() => replacement.get(), /closed|finalized/i);
	},
);

test("a failed Node extension load does not enable SQL extension loading", { skip: !!process.versions.bun }, () => {
	using db = new Database(":memory:");
	assert.throws(() => db.loadExtension("/nonexistent/omp-sqlite-extension"));
	assert.throws(() => db.loadExtension("/nonexistent/omp\0extension"), /null bytes/i);
	assert.throws(() => db.loadExtension("/nonexistent/omp", "entry\0point"), /null bytes/i);
	assert.throws(
		() => db.query("SELECT load_extension(?)").get("/nonexistent/omp-sqlite-extension"),
		/not authorized/i,
	);
	assert.deepEqual(db.query("SELECT 1 AS alive").get(), { alive: 1 });
});

test(
	"Node rejects unsupported native open flags rather than silently ignoring them",
	{ skip: !!process.versions.bun },
	() => {
		// SQLITE_OPEN_NOFOLLOW must not be accepted without native enforcement.
		assert.throws(() => new Database(":memory:", 0x01000000 | 6), /only supports.*open flags/i);
		assert.throws(() => new Database("store\0.db"), /null bytes/i);
	},
);
