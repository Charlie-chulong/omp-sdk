import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { Changes, Database, DatabaseOptions, SQLQueryBindings, Statement, Transaction } from "./sqlite-driver";

type BindingValue = Exclude<SQLQueryBindings, Record<string, unknown>>;
type Bindings = (SQLQueryBindings | SQLQueryBindings[])[];

const RESULT_CODES = [
	"SQLITE_OK",
	"SQLITE_ERROR",
	"SQLITE_INTERNAL",
	"SQLITE_PERM",
	"SQLITE_ABORT",
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
	"SQLITE_NOMEM",
	"SQLITE_READONLY",
	"SQLITE_INTERRUPT",
	"SQLITE_IOERR",
	"SQLITE_CORRUPT",
	"SQLITE_NOTFOUND",
	"SQLITE_FULL",
	"SQLITE_CANTOPEN",
	"SQLITE_PROTOCOL",
	"SQLITE_EMPTY",
	"SQLITE_SCHEMA",
	"SQLITE_TOOBIG",
	"SQLITE_CONSTRAINT",
	"SQLITE_MISMATCH",
	"SQLITE_MISUSE",
	"SQLITE_NOLFS",
	"SQLITE_AUTH",
	"SQLITE_FORMAT",
	"SQLITE_RANGE",
	"SQLITE_NOTADB",
	"SQLITE_NOTICE",
	"SQLITE_WARNING",
];
const EXTENDED_CODES: Record<number, string> = {
	257: "SQLITE_ERROR_MISSING_COLLSEQ",
	513: "SQLITE_ERROR_RETRY",
	769: "SQLITE_ERROR_SNAPSHOT",
	516: "SQLITE_ABORT_ROLLBACK",
	264: "SQLITE_READONLY_RECOVERY",
	520: "SQLITE_READONLY_CANTLOCK",
	776: "SQLITE_READONLY_ROLLBACK",
	1032: "SQLITE_READONLY_DBMOVED",
	1288: "SQLITE_READONLY_CANTINIT",
	1544: "SQLITE_READONLY_DIRECTORY",
	266: "SQLITE_IOERR_READ",
	522: "SQLITE_IOERR_SHORT_READ",
	778: "SQLITE_IOERR_WRITE",
	1034: "SQLITE_IOERR_FSYNC",
	1290: "SQLITE_IOERR_DIR_FSYNC",
	1546: "SQLITE_IOERR_TRUNCATE",
	1802: "SQLITE_IOERR_FSTAT",
	2058: "SQLITE_IOERR_UNLOCK",
	2314: "SQLITE_IOERR_RDLOCK",
	2570: "SQLITE_IOERR_DELETE",
	2826: "SQLITE_IOERR_BLOCKED",
	3082: "SQLITE_IOERR_NOMEM",
	3338: "SQLITE_IOERR_ACCESS",
	3594: "SQLITE_IOERR_CHECKRESERVEDLOCK",
	3850: "SQLITE_IOERR_LOCK",
	4106: "SQLITE_IOERR_CLOSE",
	4362: "SQLITE_IOERR_DIR_CLOSE",
	4618: "SQLITE_IOERR_SHMOPEN",
	4874: "SQLITE_IOERR_SHMSIZE",
	5130: "SQLITE_IOERR_SHMLOCK",
	5386: "SQLITE_IOERR_SHMMAP",
	5642: "SQLITE_IOERR_SEEK",
	5898: "SQLITE_IOERR_DELETE_NOENT",
	6154: "SQLITE_IOERR_MMAP",
	6410: "SQLITE_IOERR_GETTEMPPATH",
	6666: "SQLITE_IOERR_CONVPATH",
	6922: "SQLITE_IOERR_VNODE",
	7178: "SQLITE_IOERR_AUTH",
	7434: "SQLITE_IOERR_BEGIN_ATOMIC",
	7690: "SQLITE_IOERR_COMMIT_ATOMIC",
	7946: "SQLITE_IOERR_ROLLBACK_ATOMIC",
	8202: "SQLITE_IOERR_DATA",
	8458: "SQLITE_IOERR_CORRUPTFS",
	8714: "SQLITE_IOERR_IN_PAGE",
	270: "SQLITE_CANTOPEN_NOTEMPDIR",
	526: "SQLITE_CANTOPEN_ISDIR",
	782: "SQLITE_CANTOPEN_FULLPATH",
	1038: "SQLITE_CANTOPEN_CONVPATH",
	1294: "SQLITE_CANTOPEN_DIRTYWAL",
	1550: "SQLITE_CANTOPEN_SYMLINK",
	261: "SQLITE_BUSY_RECOVERY",
	517: "SQLITE_BUSY_SNAPSHOT",
	773: "SQLITE_BUSY_TIMEOUT",
	262: "SQLITE_LOCKED_SHAREDCACHE",
	518: "SQLITE_LOCKED_VTAB",
	267: "SQLITE_CORRUPT_VTAB",
	523: "SQLITE_CORRUPT_SEQUENCE",
	779: "SQLITE_CORRUPT_INDEX",
	275: "SQLITE_CONSTRAINT_CHECK",
	531: "SQLITE_CONSTRAINT_COMMITHOOK",
	787: "SQLITE_CONSTRAINT_FOREIGNKEY",
	1043: "SQLITE_CONSTRAINT_FUNCTION",
	1299: "SQLITE_CONSTRAINT_NOTNULL",
	1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
	1811: "SQLITE_CONSTRAINT_TRIGGER",
	2067: "SQLITE_CONSTRAINT_UNIQUE",
	2323: "SQLITE_CONSTRAINT_VTAB",
	2579: "SQLITE_CONSTRAINT_ROWID",
	2835: "SQLITE_CONSTRAINT_PINNED",
	3091: "SQLITE_CONSTRAINT_DATATYPE",
	279: "SQLITE_AUTH_USER",
	283: "SQLITE_NOTICE_RECOVER_WAL",
	539: "SQLITE_NOTICE_RECOVER_ROLLBACK",
	795: "SQLITE_NOTICE_RBU",
	284: "SQLITE_WARNING_AUTOINDEX",
};

/** Keep native error identity, stack, errcode and message; expose Bun's result-code fields to existing recovery paths. */
function normalizeError(error: unknown): unknown {
	if (error instanceof Error && "errcode" in error && typeof error.errcode === "number") {
		Object.assign(error, {
			name: "SQLiteError",
			errno: error.errcode,
			code: EXTENDED_CODES[error.errcode] ?? RESULT_CODES[error.errcode & 0xff] ?? "SQLITE_ERROR",
		});
	}
	return error;
}

interface ParameterLayout {
	names: (string | undefined)[];
}

/** Lex SQL tokens, not SQL values: numbered/repeated bindings must keep SQLite's original parameter indices. */
function parameterLayout(sql: string): ParameterLayout {
	const names: (string | undefined)[] = [];
	const named = new Map<string, number>();
	// Consume bare identifiers too: the $ in column$name is not a binding.
	// SQLite permits every non-ASCII byte in names and Tcl suffixes on all
	// named parameter prefixes, and only LF terminates a line comment.
	const tokens =
		/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|(\?\d*|[:@$#](?:[A-Za-z0-9_$\u0080-\uFFFF]|::)+(?:\([^)\s]*\))?)|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/g;
	for (const match of sql.matchAll(tokens)) {
		const parameter = match[1];
		if (parameter === undefined) continue;
		if (parameter === "?") {
			names.push(undefined);
		} else if (parameter[0] === "?") {
			const index = Number(parameter.slice(1)) - 1;
			if (!Number.isInteger(index) || index < 0 || index >= 32766) {
				throw Object.assign(new Error("variable number must be between ?1 and ?32766"), {
					code: "SQLITE_ERROR",
					errno: 1,
				});
			}
			if (index >= names.length) names.length = index + 1;
			names[index] ??= parameter;
		} else {
			const existing = named.get(parameter);
			if (existing === undefined) {
				named.set(parameter, names.length);
				names.push(parameter);
			}
		}
	}
	return { names };
}

function isBindingRecord(value: unknown): value is Record<string, BindingValue> {
	return value !== null && typeof value === "object" && !ArrayBuffer.isView(value) && !Array.isArray(value);
}

function inputValue(value: BindingValue | undefined, safeIntegers: boolean): SQLInputValue {
	if (typeof value === "boolean") return value ? 1n : 0n;
	// Node binds every JS number as REAL; Bun binds safe integers as INTEGER.
	if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return BigInt(value);
	if (typeof value === "bigint") return safeIntegers ? value : BigInt.asIntN(64, value);
	// Retained bindings must own their bytes, as SQLite's SQLITE_TRANSIENT does.
	if (ArrayBuffer.isView(value)) return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	return value ?? null;
}

interface NativeBindings {
	named: Record<string, SQLInputValue>;
	anonymous: SQLInputValue[];
}

export class NodeStatement<ReturnType = unknown, ParamsType extends SQLQueryBindings[] = any[]> implements Statement<
	ReturnType,
	ParamsType
> {
	#native: StatementSync | undefined;
	readonly #layout: ParameterLayout;
	readonly #strict: boolean;
	readonly #safeIntegers: boolean;
	#bindings: NativeBindings;
	readonly #iterators = new Set<IterableIterator<ReturnType>>();
	readonly #database: DatabaseSync | undefined;
	readonly #changes: StatementSync | undefined;
	readonly sourceSQL: string;

	constructor(
		native: StatementSync,
		layout = parameterLayout(native.sourceSQL),
		options: DatabaseOptions = {},
		database?: DatabaseSync,
		changes?: StatementSync,
	) {
		this.#native = native;
		this.#layout = layout;
		this.sourceSQL = native.sourceSQL;
		this.#database = database;
		this.#changes = changes;
		this.#strict = options.strict ?? false;
		this.#safeIntegers = options.safeIntegers ?? false;
		this.#bindings = { named: Object.create(null), anonymous: [] };
		for (const name of layout.names) {
			if (name !== undefined && name[0] !== "?") this.#bindings.named[name] = null;
			else this.#bindings.anonymous.push(null);
		}
		// Node throws on out-of-range integer reads unless BigInt reads are enabled.
		// Bun's default instead converts all integers to numbers, even outside the safe range.
		native.setReadBigInts(true);
		native.setAllowBareNamedParameters(false);
	}

	get isFinalized(): boolean {
		return this.#native === undefined || this.#database?.isOpen === false;
	}

	get paramsCount(): number {
		return this.#layout.names.length;
	}

	get columnNames(): string[] {
		try {
			return this.#statement()
				.columns()
				.map(column => column.name);
		} catch (error) {
			throw normalizeError(error);
		}
	}

	#statement(): StatementSync {
		if (!this.#native) throw new Error("Statement has been finalized");
		if (this.#database?.isOpen === false) throw new Error("Database has closed");
		return this.#native;
	}

	#bind(params: Bindings): NativeBindings {
		if (params.length === 0 || this.paramsCount === 0) return this.#bindings;
		const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
		const record = values.length === 1 && isBindingRecord(values[0]) ? values[0] : undefined;
		const { names } = this.#layout;
		if (!record && values.length !== 0 && values.length !== names.length) {
			throw new RangeError(`SQLite query expected ${names.length} values, received ${values.length}`);
		}
		const bound: NativeBindings = { named: Object.create(null), anonymous: [] };
		for (let index = 0; index < names.length; index++) {
			const name = names[index];
			let value: BindingValue | undefined;
			let present: boolean;
			if (record) {
				const prefixed = name ?? String(index);
				const bare = name !== undefined && name[0] !== "?" ? name.slice(1) : String(index);
				const preferred = this.#strict ? bare : prefixed;
				const key = Object.hasOwn(record, preferred) ? preferred : prefixed;
				present = Object.hasOwn(record, key);
				value = present ? record[key] : undefined;
			} else {
				present = index < values.length;
				value = values[index] as BindingValue | undefined;
			}
			if (!present && this.#strict && (record || values.length !== 0)) throw new Error("Missing SQLite bindings");
			if (isBindingRecord(value)) throw new TypeError("Invalid SQLite binding value");
			const input = inputValue(value, this.#safeIntegers);
			if (name !== undefined && name[0] !== "?") bound.named[name] = input;
			else bound.anonymous.push(input);
		}
		this.#bindings = bound;
		return this.#bindings;
	}

	setBindings(params: SQLQueryBindings | SQLQueryBindings[]): void {
		this.#bind([params]);
	}

	#row<Row>(row: Row): Row {
		if (row !== null && typeof row === "object") {
			if (!Array.isArray(row)) Object.setPrototypeOf(row, Object.prototype);
			if (!this.#safeIntegers) {
				for (const key of Object.keys(row)) {
					const values = row as Record<string, unknown>;
					if (typeof values[key] === "bigint") values[key] = Number(values[key]);
				}
			}
		}
		return row;
	}

	all(...params: ParamsType | []): ReturnType[] {
		try {
			const bindings = this.#bind(params);
			const rows = this.#statement().all(bindings.named, ...bindings.anonymous) as ReturnType[];
			for (const row of rows) this.#row(row);
			return rows;
		} catch (error) {
			throw normalizeError(error);
		}
	}

	get(...params: ParamsType | []): ReturnType | null {
		try {
			const bindings = this.#bind(params);
			const row = this.#statement().get(bindings.named, ...bindings.anonymous);
			return row === undefined ? null : (this.#row(row) as ReturnType);
		} catch (error) {
			throw normalizeError(error);
		}
	}

	run(...params: ParamsType | []): Changes {
		try {
			const bindings = this.#bind(params);
			const native = this.#statement();
			const before = this.#changes?.get()?.totalChanges;
			const result = native.run(bindings.named, ...bindings.anonymous);
			// sqlite3_changes() is stale after SELECT and DDL. Bun reports zero,
			// while retaining only direct changes (not trigger side-effects).
			const changes = this.#changes && this.#changes.get()!.totalChanges === before ? 0 : Number(result.changes);
			return {
				changes,
				lastInsertRowid: this.#safeIntegers ? result.lastInsertRowid : Number(result.lastInsertRowid),
			};
		} catch (error) {
			throw normalizeError(error);
		}
	}

	values(...params: ParamsType | []): Array<Array<string | bigint | number | boolean | Uint8Array | null>> {
		const native = this.#statement();
		try {
			native.setReturnArrays(true);
			const bindings = this.#bind(params);
			const rows = native.all(bindings.named, ...bindings.anonymous) as unknown as Array<
				Array<string | bigint | number | Uint8Array | null>
			>;
			for (const row of rows) this.#row(row);
			return rows;
		} catch (error) {
			throw normalizeError(error);
		} finally {
			native.setReturnArrays(false);
		}
	}

	iterate(...params: ParamsType | []): IterableIterator<ReturnType> {
		const statement = this;
		let nativeIterator: ReturnTypeIterator | undefined;
		try {
			const bindings = this.#bind(params);
			nativeIterator = this.#statement().iterate(bindings.named, ...bindings.anonymous) as ReturnTypeIterator;
		} catch (error) {
			throw normalizeError(error);
		}
		// return() must also release a native cursor that has not been advanced yet.
		const iterator: IterableIterator<ReturnType> = {
			next() {
				try {
					if (!nativeIterator) return { done: true, value: undefined };
					statement.#statement();
					const next = nativeIterator.next();
					if (next.done) {
						statement.#iterators.delete(iterator);
						nativeIterator = undefined;
					} else next.value = statement.#row(next.value);
					return next as IteratorResult<ReturnType>;
				} catch (error) {
					iterator.return!();
					throw normalizeError(error);
				}
			},
			return() {
				try {
					if (statement.#database?.isOpen !== false) nativeIterator?.return?.();
					return { done: true, value: undefined };
				} finally {
					statement.#iterators.delete(iterator);
					nativeIterator = undefined;
				}
			},
			[Symbol.iterator]() {
				return this;
			},
		};
		this.#iterators.add(iterator);
		return iterator;
	}

	[Symbol.iterator](): IterableIterator<ReturnType> {
		return this.iterate(...([] as unknown as ParamsType));
	}

	finalize(): void {
		if (!this.#native) return;
		for (const iterator of this.#iterators) iterator.return?.();
		this.#bindings = { named: Object.create(null), anonymous: [] };
		// Node 24 exposes no native statement-finalize method. Dropping the last
		// handle permits native GC finalization; DatabaseSync.close finalizes all
		// outstanding handles synchronously, regardless of garbage collection.
		this.#native = undefined;
	}

	[Symbol.dispose](): void {
		this.finalize();
	}

	toString(): string {
		return this.isFinalized ? "" : this.#native!.expandedSQL;
	}
}

type ReturnTypeIterator = IterableIterator<Record<string, unknown>>;

export class NodeDatabase implements Database {
	static MAX_QUERY_CACHE_SIZE = 20;
	readonly filename: string;
	readonly #native: DatabaseSync;
	readonly #options: DatabaseOptions;
	readonly #cache = new Map<string, NodeStatement<any, any[]>>();
	#savepointId = 0;
	readonly #changes: StatementSync;

	constructor(filename = ":memory:", options: number | DatabaseOptions = {}) {
		this.filename = filename.trim();
		if (this.filename.includes("\0")) throw new TypeError("SQLite filenames must not contain null bytes");
		if (typeof options === "number" && (!Number.isInteger(options) || options < 0 || options > 7)) {
			throw new TypeError("Node SQLite only supports the READONLY, READWRITE and CREATE open flags");
		}
		this.#options =
			typeof options === "number"
				? { readonly: (options & 1) !== 0, readwrite: (options & 2) !== 0, create: (options & 4) !== 0 }
				: { ...options };
		const readonly = this.#options.readonly || this.#options.readwrite === false;
		if (readonly && (this.#options.create || this.#options.readwrite)) {
			throw new TypeError("A read-only database cannot have create: true or readwrite: true");
		}
		const dbPath = this.filename || ":memory:";
		if (readonly && dbPath === ":memory:") throw new Error("Cannot open an anonymous database in read-only mode");
		const create = this.#options.create ?? !this.#options.readwrite;
		if (!readonly && !create && dbPath !== ":memory:" && !existsSync(dbPath)) {
			throw Object.assign(new Error("unable to open database file"), {
				name: "SQLiteError",
				code: "SQLITE_CANTOPEN",
				errno: 14,
			});
		}
		try {
			const { DatabaseSync: NativeDatabase } = process.getBuiltinModule("node:sqlite") as {
				DatabaseSync: typeof DatabaseSync;
			};
			this.#native = new NativeDatabase(dbPath, {
				readOnly: !!readonly,
				enableForeignKeyConstraints: false,
				enableDoubleQuotedStringLiterals: true,
				allowExtension: true,
			});
			this.#native.enableLoadExtension(false);
			this.#changes = this.#native.prepare("SELECT total_changes() AS totalChanges");
			this.#changes.setReadBigInts(true);
		} catch (error) {
			throw normalizeError(error);
		}
	}

	static open(filename?: string, options?: number | DatabaseOptions): NodeDatabase {
		return new NodeDatabase(filename, options);
	}

	get inTransaction(): boolean {
		return this.#native.isOpen && this.#native.isTransaction;
	}

	prepare<ReturnType = unknown, ParamsType extends SQLQueryBindings | SQLQueryBindings[] = any[]>(
		sql: string,
		params?: ParamsType,
	): NodeStatement<ReturnType, ParamsType extends any[] ? ParamsType : [ParamsType]> {
		try {
			const native = this.#native.prepare(sql);
			const statement = new NodeStatement<ReturnType, ParamsType extends any[] ? ParamsType : [ParamsType]>(
				native,
				parameterLayout(native.sourceSQL),
				this.#options,
				this.#native,
				this.#changes,
			);
			if (params !== undefined && params !== null) statement.setBindings(params);
			return statement;
		} catch (error) {
			throw normalizeError(error);
		}
	}

	query<ReturnType = unknown, ParamsType extends SQLQueryBindings | SQLQueryBindings[] = any[]>(
		sql: string,
	): NodeStatement<ReturnType, ParamsType extends any[] ? ParamsType : [ParamsType]> {
		let statement = this.#cache.get(sql);
		if (statement && !statement.isFinalized) {
			this.#cache.delete(sql);
			this.#cache.set(sql, statement);
		} else {
			statement = this.prepare(sql);
			const max = NodeDatabase.MAX_QUERY_CACHE_SIZE;
			if (max > 0 && sql.length <= 64 * 1024) {
				this.#cache.delete(sql);
				if (this.#cache.size >= max) this.#cache.delete(this.#cache.keys().next().value!);
				this.#cache.set(sql, statement);
			}
		}
		return statement;
	}

	run(sql: string, ...bindings: Bindings): Changes {
		let remaining = sql;
		let result: Changes | undefined;
		while (!/^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*$/.test(remaining)) {
			using statement = this.prepare(remaining);
			const next = result ? statement.run() : statement.run(...(bindings as SQLQueryBindings[]));
			if (result) {
				result.changes += next.changes;
				result.lastInsertRowid = next.lastInsertRowid;
			} else {
				result = next;
			}
			remaining = remaining.slice(statement.sourceSQL.length);
		}
		if (!result) throw new Error("Query contained no valid SQL statement; likely empty query.");
		return result;
	}

	exec(sql: string, ...bindings: Bindings): Changes {
		return this.run(sql, ...bindings);
	}

	loadExtension(extension: string, entryPoint?: string): void {
		if (extension.includes("\0") || entryPoint?.includes("\0")) {
			throw new TypeError("SQLite extension paths and entry points must not contain null bytes");
		}
		try {
			this.#native.enableLoadExtension(true);
			try {
				this.#native.loadExtension(extension, entryPoint || undefined);
			} finally {
				this.#native.enableLoadExtension(false);
			}
		} catch (error) {
			throw normalizeError(error);
		}
	}

	serialize(name = "main"): Buffer {
		name ||= "main";
		if (name.includes("\0")) throw new TypeError("SQLite database names must not contain null bytes");
		// Node 24 has no synchronous sqlite3_serialize/backup binding. Current
		// migration/recovery callers snapshot dedicated read-only connections;
		// VACUUM INTO captures their committed state, including WAL frames.
		if (this.inTransaction) {
			throw Object.assign(new Error("Cannot serialize a Node SQLite database inside a transaction"), {
				name: "SQLiteError",
				code: "SQLITE_ERROR",
				errno: 1,
			});
		}
		const directory = mkdtempSync(join(tmpdir(), "omp-sqlite-snapshot-"));
		try {
			chmodSync(directory, 0o700);
			const snapshot = join(directory, "snapshot.db");
			closeSync(openSync(snapshot, "wx", 0o600));
			using vacuum = this.prepare(`VACUUM "${name.replaceAll('"', '""')}" INTO ?`);
			vacuum.run(snapshot);
			return readFileSync(snapshot);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	close(_throwOnError?: boolean): void {
		if (!this.#native.isOpen) return;
		try {
			for (const statement of this.#cache.values()) statement.finalize();
			this.#native.close();
		} catch (error) {
			throw normalizeError(error);
		} finally {
			this.#cache.clear();
		}
	}

	[Symbol.dispose](): void {
		this.close(true);
	}

	transaction<Args extends any[], Result>(callback: (...args: Args) => Result): Transaction<Args, Result> {
		if (typeof callback !== "function") throw new TypeError("Expected first argument to be a function");
		const db = this;
		function wrap(mode: string): (...args: Args) => Result {
			return function (this: unknown, ...args: Args): Result {
				const nested = db.inTransaction;
				const savepoint = nested ? `omp_tx_${++db.#savepointId}` : undefined;
				db.run(nested ? `SAVEPOINT ${savepoint}` : `BEGIN${mode}`);
				try {
					const result = callback.apply(this, args);
					db.run(nested ? `RELEASE ${savepoint}` : "COMMIT");
					return result;
				} catch (error) {
					if (db.inTransaction) {
						db.run(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
						if (nested) db.run(`RELEASE ${savepoint}`);
					}
					throw error;
				}
			};
		}
		return Object.assign(wrap(""), {
			deferred: wrap(" DEFERRED"),
			immediate: wrap(" IMMEDIATE"),
			exclusive: wrap(" EXCLUSIVE"),
		});
	}
}
