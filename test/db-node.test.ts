/**
 * db-node.test.ts - the node:sqlite driver (QMD_SQLITE_DRIVER=node): better-sqlite3's
 * transaction semantics, extension loading only when asked, and driver selection.
 */
import { describe, expect, test } from "vitest";
import { resolveSqliteDriver } from "../src/db.js";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

describe.skipIf(isBun)("node:sqlite driver", async () => {
  const { NodeSqliteDatabase, nodeSqliteHasFts5 } = await import("../src/db-node.js");

  const open = () => {
    const db = new NodeSqliteDatabase(":memory:");
    db.exec("CREATE TABLE t (n INTEGER)");
    return db;
  };
  const count = (db: InstanceType<typeof NodeSqliteDatabase>) =>
    (db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c;

  test("statements bind positional and named parameters as better-sqlite3 does", () => {
    const db = open();
    const result = db.prepare("INSERT INTO t (n) VALUES (?)").run(7);
    expect(result.changes).toBe(1);
    db.prepare("INSERT INTO t (n) VALUES ($n)").run({ n: 8 });
    expect(db.prepare("SELECT n FROM t ORDER BY n").all().map((row: any) => row.n)).toEqual([7, 8]);
    expect(db.prepare("SELECT n FROM t WHERE n = ?").get(99)).toBeUndefined();
    db.close();
  });

  test("a transaction commits, and a throw rolls it back whole", () => {
    const db = open();
    const insert = db.transaction((values: number[]) => {
      for (const value of values) db.prepare("INSERT INTO t (n) VALUES (?)").run(value);
      return values.length;
    });
    expect(insert([1, 2])).toBe(2);
    expect(() => db.transaction(() => {
      db.prepare("INSERT INTO t (n) VALUES (3)").run();
      throw new Error("stop");
    })()).toThrow("stop");
    expect(count(db)).toBe(2);
    db.close();
  });

  test("nested transactions are savepoints: an inner failure rolls back only its own part", () => {
    const db = open();
    const inner = db.transaction(() => {
      db.prepare("INSERT INTO t (n) VALUES (2)").run();
      throw new Error("inner");
    });
    db.transaction(() => {
      db.prepare("INSERT INTO t (n) VALUES (1)").run();
      expect(() => inner()).toThrow("inner");
      db.prepare("INSERT INTO t (n) VALUES (3)").run();
    })();
    expect(db.prepare("SELECT n FROM t ORDER BY n").all().map((row: any) => row.n)).toEqual([1, 3]);
    db.close();
  });

  test("SQL cannot load an extension of its own", () => {
    const db = open();
    expect(() => db.prepare("SELECT load_extension('nothing')").get()).toThrow();
    db.close();
  });

  // Node 23's SQLite has none: db.ts then refuses the driver, saying so.
  test.skipIf(!nodeSqliteHasFts5())("FTS5 with BM25 is there, as QMD's keyword search needs", () => {
    const db = open();
    db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='porter unicode61')");
    db.prepare("INSERT INTO f (body) VALUES (?)").run("projects areas resources archives");
    const row = db.prepare("SELECT bm25(f) AS score FROM f WHERE f MATCH ?").get("resource*") as { score: number };
    expect(typeof row.score).toBe("number");
    db.close();
  });
});

describe("driver selection", () => {
  test("the runtime's default, or the one named", () => {
    expect(resolveSqliteDriver("")).toBe(isBun ? "bun" : "better-sqlite3");
    if (!isBun) expect(resolveSqliteDriver("node")).toBe("node");
  });

  test("an unknown driver, or one for the other runtime, is an error", () => {
    expect(() => resolveSqliteDriver("sqlite3")).toThrow(/must be better-sqlite3, node, or bun/);
    expect(() => resolveSqliteDriver(isBun ? "node" : "bun")).toThrow(/cannot run under/);
  });
});
