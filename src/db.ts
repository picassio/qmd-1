/**
 * db.ts - Cross-runtime SQLite compatibility layer
 *
 * Provides a unified Database export that works under Bun (bun:sqlite), Node.js
 * with better-sqlite3 (the default), and Node.js's own node:sqlite. The APIs are
 * nearly identical — the main difference is the import path.
 *
 * QMD_SQLITE_DRIVER=node selects node:sqlite (Node 22.13 or later): no native
 * addon, for platforms better-sqlite3 has no build for, such as Android. It is
 * read once, when this module loads. QMD_SQLITE_VEC_PATH names a sqlite-vec
 * loadable extension to use instead of the sqlite-vec package's own, for a
 * platform that package has no build for.
 *
 * On macOS, Apple's system SQLite is compiled with SQLITE_OMIT_LOAD_EXTENSION,
 * which prevents loading native extensions like sqlite-vec. When running under
 * Bun we call Database.setCustomSQLite() to swap in Homebrew's full-featured
 * SQLite build before creating any database instances.
 */

export const isBun = typeof globalThis.Bun !== "undefined";

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 120_000;

/** Resolve the per-connection SQLite busy timeout from the environment. */
export function resolveSqliteBusyTimeout(value = process.env.QMD_SQLITE_BUSY_TIMEOUT): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  return Math.floor(parsed);
}

/** Which SQLite driver this process uses: `QMD_SQLITE_DRIVER`, or the runtime's default. */
export type SqliteDriver = "bun" | "better-sqlite3" | "node";

export function resolveSqliteDriver(value = process.env.QMD_SQLITE_DRIVER): SqliteDriver {
  if (value === undefined || value.trim() === "") return isBun ? "bun" : "better-sqlite3";
  const driver = value.trim();
  if (driver !== "better-sqlite3" && driver !== "node" && driver !== "bun") {
    throw new Error(`QMD_SQLITE_DRIVER must be better-sqlite3, node, or bun; got ${JSON.stringify(value)}`);
  }
  if (isBun !== (driver === "bun")) {
    throw new Error(`QMD_SQLITE_DRIVER=${driver} cannot run under ${isBun ? "Bun" : "Node.js"}`);
  }
  return driver;
}

export const sqliteDriver: SqliteDriver = resolveSqliteDriver();
/** A sqlite-vec loadable extension of the caller's choosing, for a platform the sqlite-vec package lacks. */
const sqliteVecPath = process.env.QMD_SQLITE_VEC_PATH?.trim() || undefined;

let _Database: any;
let _sqliteVecLoad: ((db: any) => void) | null;

if (sqliteDriver === "node") {
  const { NodeSqliteDatabase } = await import("./db-node.js");
  _Database = NodeSqliteDatabase;
  if (sqliteVecPath !== undefined) {
    _sqliteVecLoad = (db: any) => db.loadExtension(sqliteVecPath);
  } else {
    try {
      const { getLoadablePath } = await import("sqlite-vec");
      const vecPath = getLoadablePath();
      _sqliteVecLoad = (db: any) => db.loadExtension(vecPath);
    } catch {
      // No build of sqlite-vec for this platform: vector search won't work, BM25 and the rest are unaffected.
      _sqliteVecLoad = null;
    }
  }
} else if (isBun) {
  // Dynamic string prevents tsc from resolving bun:sqlite on Node.js builds
  const bunSqlite = "bun:" + "sqlite";
  const BunDatabase = (await import(/* @vite-ignore */ bunSqlite)).Database;

  // See: https://bun.com/docs/runtime/sqlite#setcustomsqlite
  if (process.platform === "darwin") {
    const homebrewPaths = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",  // Apple Silicon
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",     // Intel
    ];
    for (const p of homebrewPaths) {
      try {
        BunDatabase.setCustomSQLite(p);
        break;
      } catch {}
    }
  }

  _Database = BunDatabase;

  // setCustomSQLite may have silently failed — test that extensions actually work.
  try {
    const { getLoadablePath } = await import("sqlite-vec");
    const vecPath = getLoadablePath();
    const testDb = new BunDatabase(":memory:");
    testDb.loadExtension(vecPath);
    testDb.close();
    _sqliteVecLoad = (db: any) => db.loadExtension(vecPath);
  } catch {
    // Vector search won't work, but BM25 and other operations are unaffected.
    _sqliteVecLoad = null;
  }
} else {
  _Database = (await import("better-sqlite3")).default;
  if (sqliteVecPath !== undefined) {
    _sqliteVecLoad = (db: any) => db.loadExtension(sqliteVecPath);
  } else {
    const sqliteVec = await import("sqlite-vec");
    _sqliteVecLoad = (db: any) => sqliteVec.load(db);
  }
}

/**
 * Open a SQLite database. Works with bun:sqlite, better-sqlite3, and node:sqlite.
 */
export function openDatabase(path: string): Database {
  const db = new _Database(path) as Database;
  try {
    // Apply this before callers can perform schema setup or any other writes.
    db.exec(`PRAGMA busy_timeout = ${resolveSqliteBusyTimeout()}`);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

/**
 * Common subset of the Database interface used throughout QMD.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  loadExtension(path: string): void;
  close(): void;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
}

export interface Statement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/**
 * Load the sqlite-vec extension into a database.
 *
 * Throws with platform-specific fix instructions when the extension is
 * unavailable.
 */
export function loadSqliteVec(db: Database): void {
  if (!_sqliteVecLoad) {
    const hint = isBun && process.platform === "darwin"
      ? "On macOS with Bun, install Homebrew SQLite: brew install sqlite\n" +
        "Or install qmd with npm instead: npm install -g @tobilu/qmd"
      : sqliteDriver === "node"
        ? "The sqlite-vec package has no build for this platform: set QMD_SQLITE_VEC_PATH to a sqlite-vec loadable extension built for it."
        : "Ensure the sqlite-vec native module is installed correctly.";
    throw new Error(`sqlite-vec extension is unavailable. ${hint}`);
  }
  _sqliteVecLoad(db);
}
