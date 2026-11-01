import type * as BunSqlite from "bun:sqlite";
import type {
	Changes as BunChanges,
	DatabaseOptions as BunDatabaseOptions,
	SQLQueryBindings as BunSQLQueryBindings,
} from "bun:sqlite";
import { createRequire } from "node:module";
import { NodeDatabase, NodeStatement } from "./sqlite-node";

export type SQLQueryBindings = BunSQLQueryBindings;
export type DatabaseOptions = BunDatabaseOptions;
export type Changes = BunChanges;

/** Structural subset of the native statement API implemented by both drivers. */
export type Statement<Result = unknown, Params extends SQLQueryBindings[] = any[]> = Pick<
	BunSqlite.Statement<Result, Params>,
	| "all"
	| "get"
	| "run"
	| "iterate"
	| "columnNames"
	| "paramsCount"
	| "finalize"
	| "toString"
	| typeof Symbol.iterator
	| typeof Symbol.dispose
> & {
	all(): Result[];
	get(): Result | null;
	run(): Changes;
	values(
		...params: Parameters<BunSqlite.Statement<Result, Params>["values"]> | []
	): Array<Array<string | bigint | number | boolean | Uint8Array | null>>;
	iterate(): IterableIterator<Result>;
};

export interface Transaction<Args extends any[], Result> {
	(...args: Args): Result;
	deferred: (...args: Args) => Result;
	immediate: (...args: Args) => Result;
	exclusive: (...args: Args) => Result;
}

export interface Database extends Disposable {
	readonly filename: string;
	readonly inTransaction: boolean;
	query<ReturnType = unknown, ParamsType extends SQLQueryBindings | SQLQueryBindings[] = SQLQueryBindings[]>(
		sql: string,
	): Statement<ReturnType, ParamsType extends any[] ? ParamsType : [ParamsType]>;
	prepare<ReturnType = unknown, ParamsType extends SQLQueryBindings | SQLQueryBindings[] = SQLQueryBindings[]>(
		sql: string,
		params?: ParamsType,
	): Statement<ReturnType, ParamsType extends any[] ? ParamsType : [ParamsType]>;
	run(sql: string, ...bindings: (SQLQueryBindings | SQLQueryBindings[])[]): Changes;
	exec(sql: string, ...bindings: (SQLQueryBindings | SQLQueryBindings[])[]): Changes;
	loadExtension(extension: string, entryPoint?: string): void;
	serialize(name?: string): Buffer;
	close(throwOnError?: boolean): void;
	transaction<Args extends any[], Result>(callback: (...args: Args) => Result): Transaction<Args, Result>;
}

export interface DatabaseConstructor {
	new (filename?: string, options?: number | DatabaseOptions): Database;
	open(filename: string, options?: number | DatabaseOptions): Database;
	MAX_QUERY_CACHE_SIZE: number;
	readonly prototype: Database;
}

// Only the selected runtime's native module is loaded. In particular, Bun must
// never resolve node:sqlite, and Node/Electron must never resolve bun:sqlite.
const bunDriver = process.versions.bun ? (createRequire(import.meta.url)("bun:sqlite") as typeof BunSqlite) : undefined;
// Bun's native methods also execute prebound parameters with no arguments;
// its generic declarations omit that overload (verified against the native driver).
const bunDatabase = bunDriver?.Database as DatabaseConstructor | undefined;
export const Database: DatabaseConstructor = bunDatabase ?? NodeDatabase;
export const Statement = bunDriver?.Statement ?? NodeStatement;
