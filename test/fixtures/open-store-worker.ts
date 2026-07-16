import { createInterface } from "node:readline";
import { createStore } from "../../src/store.js";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("database path is required");

process.stdout.write("READY\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "GO") break;
}
lines.close();

try {
  const store = createStore(dbPath);
  const journal = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  const foreignKeys = store.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  const busyTimeout = store.db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  const schema = store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type IN ('table', 'trigger', 'index')
  `).get() as { count: number };
  store.close();
  process.stdout.write(`RESULT ${JSON.stringify({
    journal: journal.journal_mode,
    foreignKeys: foreignKeys.foreign_keys,
    busyTimeout: busyTimeout.timeout,
    schemaObjects: schema.count,
  })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`OPEN_ERROR ${message}\n`);
  process.exitCode = 1;
}
