/**
 * db-node.ts - better-sqlite3's surface that QMD uses, over Node.js's own node:sqlite.
 *
 * Selected with QMD_SQLITE_DRIVER=node (db.ts). node:sqlite statements already have
 * run/get/all with the same parameter binding (positional, and named without their
 * prefix) and the same results; what it lacks is transaction(), which this adds the
 * way better-sqlite3 does: the outermost call is a transaction, nested calls are
 * savepoints, and a throw rolls back to where its call began.
 */
import { DatabaseSync } from "node:sqlite";
import type { Database, Statement } from "./db.js";

let savepoints = 0;

/** Whether this Node.js's own SQLite has FTS5, which QMD's keyword search needs (Node 23's has not). */
export function nodeSqliteHasFts5(): boolean {
  const db = new DatabaseSync(":memory:");
  try {
    return db.prepare("PRAGMA compile_options").all().some((row: any) => row.compile_options === "ENABLE_FTS5");
  } finally {
    db.close();
  }
}

export class NodeSqliteDatabase implements Database {
  readonly #db: DatabaseSync;
  #depth = 0;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.#db = new DatabaseSync(path, { readOnly: options.readonly === true, allowExtension: true });
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): Statement {
    return this.#db.prepare(sql) as unknown as Statement;
  }

  loadExtension(path: string): void {
    this.#db.enableLoadExtension(true);
    try {
      this.#db.loadExtension(path);
    } finally {
      // Only QMD's own extension: SQL cannot load another.
      this.#db.enableLoadExtension(false);
    }
  }

  close(): void {
    this.#db.close();
  }

  get open(): boolean {
    return this.#db.isOpen;
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const run = (...args: Parameters<T>): ReturnType<T> => {
      const outer = this.#depth === 0;
      const name = `qmd_sp_${++savepoints}`;

      this.#db.exec(outer ? "BEGIN" : `SAVEPOINT ${name}`);
      this.#depth++;
      try {
        const result = fn(...args);
        this.#depth--;
        this.#db.exec(outer ? "COMMIT" : `RELEASE ${name}`);
        return result;
      } catch (error) {
        this.#depth--;
        this.#db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    };

    return run as T;
  }
}
