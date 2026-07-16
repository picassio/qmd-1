import { afterEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";

const workerPath = fileURLToPath(new URL("./fixtures/open-store-worker.ts", import.meta.url));
const tempDirs: string[] = [];

async function tempDb(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `qmd-${name}-`));
  tempDirs.push(dir);
  return join(dir, "index.sqlite");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type OpenResult = {
  journal: string;
  foreignKeys: number;
  busyTimeout: number;
  schemaObjects: number;
};

type Worker = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  done: Promise<OpenResult>;
};

function startWorker(dbPath: string): Worker {
  const isBun = typeof globalThis.Bun !== "undefined";
  const args = isBun ? [workerPath, dbPath] : ["--import", "tsx", workerPath, dbPath];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, QMD_SQLITE_BUSY_TIMEOUT: "10000" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker readiness timed out: ${errors}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("READY\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!output.includes("READY\n")) {
        clearTimeout(timer);
        reject(new Error(`worker exited before ready (${code}): ${errors}`));
      }
    });
  });
  const done = new Promise<OpenResult>((resolve, reject) => {
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited ${code}: ${errors}\n${output}`));
        return;
      }
      const resultLine = output.split("\n").find((line) => line.startsWith("RESULT "));
      if (!resultLine) {
        reject(new Error(`worker returned no result: ${errors}\n${output}`));
        return;
      }
      resolve(JSON.parse(resultLine.slice("RESULT ".length)));
    });
  });
  return { child, ready, done };
}

async function runSynchronizedOpenWave(dbPath: string, count = 6) {
  const workers = Array.from({ length: count }, () => startWorker(dbPath));
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.end("GO\n");
  return Promise.all(workers.map((worker) => worker.done));
}

describe("concurrent store initialization", () => {
  test("barrier-started cold opens serialize schema creation", async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      const dbPath = await tempDb(`cold-${iteration}`);
      const results = await runSynchronizedOpenWave(dbPath);
      expect(results).toHaveLength(6);
      expect(results.every((result) => result.journal === "wal")).toBe(true);
      expect(results.every((result) => result.foreignKeys === 1)).toBe(true);
      expect(results.every((result) => result.busyTimeout === 10_000)).toBe(true);
      expect(new Set(results.map((result) => result.schemaObjects)).size).toBe(1);
    }
  }, 60_000);

  test("barrier-started warm opens preserve a stable schema", async () => {
    const dbPath = await tempDb("warm");
    const initial = createStore(dbPath);
    const initialSchemaObjects = (initial.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table', 'trigger', 'index')
    `).get() as { count: number }).count;
    initial.close();

    for (let iteration = 0; iteration < 3; iteration++) {
      const results = await runSynchronizedOpenWave(dbPath);
      expect(results.every((result) => result.schemaObjects === initialSchemaObjects)).toBe(true);
      expect(results.every((result) => result.journal === "wal")).toBe(true);
      expect(results.every((result) => result.foreignKeys === 1)).toBe(true);
    }
  }, 60_000);
});
