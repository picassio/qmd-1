import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import {
  cleanupOrphanedVectors,
  createStore,
  generateEmbeddings,
  getHashesNeedingEmbedding,
  insertEmbedding,
  type Store,
} from "../src/store.js";
import type { LLM } from "../src/llm-types.js";

const originalBusyTimeout = process.env.QMD_SQLITE_BUSY_TIMEOUT;
const tempDirs: string[] = [];

async function tempDb(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `qmd-${name}-`));
  tempDirs.push(dir);
  return join(dir, "index.sqlite");
}

afterEach(async () => {
  if (originalBusyTimeout === undefined) delete process.env.QMD_SQLITE_BUSY_TIMEOUT;
  else process.env.QMD_SQLITE_BUSY_TIMEOUT = originalBusyTimeout;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function pragmaBusyTimeout(value?: string): number {
  if (value === undefined) delete process.env.QMD_SQLITE_BUSY_TIMEOUT;
  else process.env.QMD_SQLITE_BUSY_TIMEOUT = value;
  const db = openDatabase(":memory:");
  try {
    return (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
  } finally {
    db.close();
  }
}

describe("SQLite busy timeout", () => {
  test("defaults every connection to 120 seconds", () => {
    expect(pragmaBusyTimeout()).toBe(120_000);
  });

  test("accepts finite nonnegative overrides and floors fractions", () => {
    expect(pragmaBusyTimeout("0")).toBe(0);
    expect(pragmaBusyTimeout("125.9")).toBe(125);
  });

  test.each(["", "-1", "nope", "Infinity", "-Infinity", "NaN"])(
    "falls back for invalid override %j",
    (value) => expect(pragmaBusyTimeout(value)).toBe(120_000),
  );

  test("honors the configured timeout during sustained write contention", async () => {
    const dbPath = await tempDb("lock-wait");
    process.env.QMD_SQLITE_BUSY_TIMEOUT = "140";
    const holder = openDatabase(dbPath);
    holder.exec("CREATE TABLE lock_test (id INTEGER PRIMARY KEY)");
    holder.exec("BEGIN IMMEDIATE");
    const contender = openDatabase(dbPath);
    const started = Date.now();
    try {
      expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(/busy|locked/i);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(110);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      holder.exec("ROLLBACK");
      contender.close();
      holder.close();
    }
  }, 7_000);

  test("zero is an explicit fail-fast timeout", async () => {
    const dbPath = await tempDb("lock-zero");
    process.env.QMD_SQLITE_BUSY_TIMEOUT = "0";
    const holder = openDatabase(dbPath);
    holder.exec("CREATE TABLE lock_test (id INTEGER PRIMARY KEY)");
    holder.exec("BEGIN IMMEDIATE");
    const contender = openDatabase(dbPath);
    const started = Date.now();
    try {
      expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(/busy|locked/i);
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      holder.exec("ROLLBACK");
      contender.close();
      holder.close();
    }
  });
});

function fakeLlm(model: string, partial = false): LLM {
  return {
    embedModelName: model,
    async tokenize(text) { return Array.from(text); },
    async detokenize(tokens) { return tokens.join(""); },
    async embed() { return { embedding: [1, 0, 0], model }; },
    async embedBatch(texts) {
      return texts.map((_text, index) => partial && index > 0
        ? null
        : { embedding: [1, index + 1, 0], model });
    },
    async generate() { return null; },
    async modelExists() { return { name: model, exists: true }; },
    async expandQuery() { return []; },
    async rerank(_query, documents) {
      return { model: "identity", results: documents.map((doc, index) => ({ file: doc.file, score: 0, index })) };
    },
    async dispose() {},
  };
}

function insertActiveDocument(store: Store, hash: string, body: string): void {
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, body, now);
  store.db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES ('docs', ?, 'Recovery', ?, ?, ?, 1)
  `).run(`${hash}.md`, hash, now, now);
}

function counts(store: Store, hash: string) {
  const content = (store.db.prepare(`SELECT COUNT(*) AS count FROM content_vectors WHERE hash = ?`).get(hash) as { count: number }).count;
  const vectors = (store.db.prepare(`SELECT COUNT(*) AS count FROM vectors_vec WHERE hash_seq LIKE ?`).get(`${hash}_%`) as { count: number }).count;
  return { content, vectors };
}

describe("partial embedding recovery", () => {
  test("legacy seq0 rows without expected-chunk metadata remain pending", async () => {
    const dbPath = await tempDb("legacy-pending");
    const store = createStore(dbPath);
    store.llm = fakeLlm("active-model");
    try {
      insertActiveDocument(store, "legacyhash", "legacy body");
      store.ensureVecTable(3);
      insertEmbedding(store.db, "legacyhash", 0, 0, new Float32Array([1, 0, 0]), "active-model", new Date().toISOString());

      expect(store.getHashesNeedingEmbedding()).toBe(1);
      expect(getHashesNeedingEmbedding(store.db, "active-model")).toBe(1);

      const now = new Date().toISOString();
      store.db.prepare(`
        INSERT INTO embedding_documents (hash, model, total_chunks, embedded_at, completed_at)
        VALUES ('legacyhash', 'active-model', 2, ?, ?)
      `).run(now, now);
      // Even a falsely marked completion cannot make seq0 alone complete.
      expect(store.getHashesNeedingEmbedding()).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a failed multi-chunk document is cleaned, stays pending, and retries completely", async () => {
    const dbPath = await tempDb("partial-retry");
    const hash = "partialhash";
    let store = createStore(dbPath);
    insertActiveDocument(store, hash, `# Recovery\n\n${"x".repeat(4_000)}`);
    store.llm = fakeLlm("active-model", true);

    const failed = await generateEmbeddings(store);
    expect(failed.errors).toBeGreaterThan(0);
    expect(counts(store, hash)).toEqual({ content: 0, vectors: 0 });
    const expected = store.db.prepare(`
      SELECT total_chunks, completed_at FROM embedding_documents WHERE hash = ? AND model = ?
    `).get(hash, "active-model") as { total_chunks: number; completed_at: string | null };
    expect(expected.total_chunks).toBeGreaterThan(1);
    expect(expected.completed_at).toBeNull();
    expect(store.getHashesNeedingEmbedding()).toBe(1);
    store.close();

    store = createStore(dbPath);
    store.llm = fakeLlm("active-model");
    try {
      const retried = await generateEmbeddings(store);
      expect(retried.errors).toBe(0);
      expect(retried.chunksEmbedded).toBe(expected.total_chunks);
      expect(counts(store, hash)).toEqual({ content: expected.total_chunks, vectors: expected.total_chunks });
      expect(store.db.prepare(`
        SELECT GROUP_CONCAT(seq, ',') AS sequences
        FROM (SELECT seq FROM content_vectors WHERE hash = ? ORDER BY seq)
      `).get(hash)).toEqual({ sequences: Array.from({ length: expected.total_chunks }, (_, seq) => seq).join(",") });
      expect((store.db.prepare(`
        SELECT completed_at FROM embedding_documents WHERE hash = ? AND model = ?
      `).get(hash, "active-model") as { completed_at: string | null }).completed_at).not.toBeNull();
      expect(store.getHashesNeedingEmbedding()).toBe(0);
    } finally {
      store.close();
    }
  });

  test("blank documents stay excluded from pending work across retries and reopen", async () => {
    const dbPath = await tempDb("blank-document");
    const hash = "blankhash";
    let store = createStore(dbPath);
    store.llm = fakeLlm("active-model");
    insertActiveDocument(store, hash, " \n\t\u00a0\u2003\ufeff");

    expect(store.getHashesNeedingEmbedding()).toBe(0);
    store.ensureVecTable(3);
    expect(store.getHashesNeedingEmbedding()).toBe(0);
    await expect(generateEmbeddings(store)).resolves.toMatchObject({
      docsProcessed: 0,
      chunksEmbedded: 0,
      errors: 0,
    });
    store.close();

    store = createStore(dbPath);
    store.llm = fakeLlm("active-model");
    try {
      expect(store.getHashesNeedingEmbedding()).toBe(0);
      await expect(generateEmbeddings(store)).resolves.toMatchObject({
        docsProcessed: 0,
        chunksEmbedded: 0,
        errors: 0,
      });
      expect(store.getIndexHealth().needsEmbedding).toBe(0);
      expect(store.getStatus().needsEmbedding).toBe(0);
    } finally {
      store.close();
    }
  });

  test("an interrupted prefix is detected on reopen and stale sequences are replaced", async () => {
    const dbPath = await tempDb("interrupted-prefix");
    const hash = "interruptedhash";
    let store = createStore(dbPath);
    store.llm = fakeLlm("active-model");
    insertActiveDocument(store, hash, `# Interrupted\n\n${"y".repeat(2_500)}`);
    store.ensureVecTable(3);
    const now = new Date().toISOString();
    store.db.prepare(`
      INSERT INTO embedding_documents (hash, model, total_chunks, embedded_at, completed_at)
      VALUES (?, 'active-model', 4, ?, NULL)
    `).run(hash, now);
    insertEmbedding(store.db, hash, 0, 0, new Float32Array([1, 0, 0]), "active-model", now);
    insertEmbedding(store.db, hash, 99, 99, new Float32Array([0, 1, 0]), "active-model", now);
    store.close();

    store = createStore(dbPath);
    store.llm = fakeLlm("active-model");
    try {
      expect(store.getHashesNeedingEmbedding()).toBe(1);
      const result = await generateEmbeddings(store);
      expect(result.errors).toBe(0);
      expect(store.getHashesNeedingEmbedding()).toBe(0);
      expect(store.db.prepare(`SELECT 1 FROM content_vectors WHERE hash = ? AND seq = 99`).get(hash)).toBeFalsy();
      expect(store.db.prepare(`SELECT 1 FROM vectors_vec WHERE hash_seq = ?`).get(`${hash}_99`)).toBeFalsy();
    } finally {
      store.close();
    }
  });

  test("missing vector counterparts and wrong models remain pending", async () => {
    const dbPath = await tempDb("consistency");
    const hash = "consistencyhash";
    const store = createStore(dbPath);
    insertActiveDocument(store, hash, `# Consistency\n\n${"z".repeat(2_000)}`);
    store.llm = fakeLlm("model-a");
    try {
      await generateEmbeddings(store);
      expect(store.getHashesNeedingEmbedding()).toBe(0);

      const row = store.db.prepare(`SELECT seq FROM content_vectors WHERE hash = ? ORDER BY seq DESC LIMIT 1`).get(hash) as { seq: number };
      store.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`${hash}_${row.seq}`);
      expect(store.getHashesNeedingEmbedding()).toBe(1);

      store.llm = fakeLlm("model-b");
      expect(store.getHashesNeedingEmbedding()).toBe(1);
      expect(store.getIndexHealth().needsEmbedding).toBe(1);
      expect(store.getStatus().needsEmbedding).toBe(1);
    } finally {
      store.close();
    }
  });

  test("orphan cleanup removes vector, content-vector, and completion rows consistently", async () => {
    const dbPath = await tempDb("orphan-cleanup");
    const store = createStore(dbPath);
    const hash = "orphanhash";
    try {
      const now = new Date().toISOString();
      store.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, 'orphan', ?)`).run(hash, now);
      store.ensureVecTable(3);
      insertEmbedding(store.db, hash, 0, 0, new Float32Array([1, 0, 0]), "active-model", now);
      store.db.prepare(`
        INSERT INTO embedding_documents (hash, model, total_chunks, embedded_at, completed_at)
        VALUES (?, 'active-model', 1, ?, ?)
      `).run(hash, now, now);

      expect(cleanupOrphanedVectors(store.db)).toBe(1);
      expect(store.db.prepare(`SELECT COUNT(*) AS count FROM content_vectors WHERE hash = ?`).get(hash)).toEqual({ count: 0 });
      expect(store.db.prepare(`SELECT COUNT(*) AS count FROM vectors_vec WHERE hash_seq = ?`).get(`${hash}_0`)).toEqual({ count: 0 });
      expect(store.db.prepare(`SELECT COUNT(*) AS count FROM embedding_documents WHERE hash = ?`).get(hash)).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  test("rolls back content metadata when sqlite-vec insertion fails", async () => {
    const dbPath = await tempDb("chunk-transaction");
    const store = createStore(dbPath);
    try {
      store.ensureVecTable(3);
      store.db.exec("DROP TABLE vectors_vec");
      expect(() => insertEmbedding(
        store.db,
        "transactionhash",
        0,
        0,
        new Float32Array([1, 0, 0]),
        "active-model",
        new Date().toISOString(),
      )).toThrow();
      expect(store.db.prepare(`SELECT COUNT(*) AS count FROM content_vectors WHERE hash = 'transactionhash'`).get())
        .toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });
});
