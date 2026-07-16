/**
 * db.ts - Cross-runtime SQLite compatibility layer
 *
 * Provides a unified Database export that works under both Bun (bun:sqlite)
 * and Node.js (better-sqlite3). The APIs are nearly identical — the main
 * difference is the import path.
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

let _Database: any;
let _sqliteVecLoad: ((db: any) => void) | null;

if (isBun) {
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
  const sqliteVec = await import("sqlite-vec");
  _sqliteVecLoad = (db: any) => sqliteVec.load(db);
}

/**
 * Open a SQLite database. Works with both bun:sqlite and better-sqlite3.
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
      : "Ensure the sqlite-vec native module is installed correctly.";
    throw new Error(`sqlite-vec extension is unavailable. ${hint}`);
  }
  _sqliteVecLoad(db);
}
