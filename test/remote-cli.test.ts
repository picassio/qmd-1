import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStore,
  hashContent,
  insertContent,
  insertDocument,
  insertEmbedding,
} from "../src/store.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const builtCli = join(projectRoot, "dist", "cli", "qmd.js");
const denyNativeLoader = join(projectRoot, "test", "fixtures", "deny-native-loader.mjs");
const nodeBinary = process.versions.bun
  ? execFileSync("/usr/bin/env", ["bash", "-lc", "command -v node"], { encoding: "utf8" }).trim()
  : process.execPath;

let testDir: string;
let configDir: string;
let docsDir: string;
let copyDocsDir: string;
let dbPath: string;
let localConfigDir: string;
let localDocsDir: string;
let localCopyDocsDir: string;
let localDbPath: string;
let server: Server;
let baseUrl: string;
let embedCalls = 0;
let chatCalls = 0;
const remoteDocument = "# Remote Search\n\nProfile preferences and remote semantic material.\n";

function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function startServer(): Promise<void> {
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/embeddings") {
      embedCalls += 1;
      const rawInput = body.input;
      const inputs = Array.isArray(rawInput) ? rawInput : [rawInput];
      res.end(JSON.stringify({
        data: inputs.map((_input, index) => ({ index, embedding: [1, 0] })),
        model: "provider-model-must-be-ignored",
      }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      chatCalls += 1;
      const prompt = String((body.messages as Array<{ content?: string }> | undefined)?.[0]?.content ?? "");
      const queryMatch = prompt.match(/Expand this search query:\s*([^\n]+)/i);
      const query = queryMatch?.[1]?.trim() || "remote semantic question";
      res.end(JSON.stringify({
        choices: [{ message: { content: `lex: ${query}\nvec: ${query} semantic\nhyde: ${query} guide` } }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing server address"));
      baseUrl = `http://127.0.0.1:${address.port}/v1`;
      resolveStart();
    });
  });
}

async function runBuilt(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const result = await execFileAsync(nodeBinary, [
      "--no-warnings",
      "--experimental-loader", denyNativeLoader,
      builtCli,
      ...args,
    ], {
      cwd: docsDir,
      env: {
        ...process.env,
        INDEX_PATH: dbPath,
        QMD_CONFIG_DIR: configDir,
        PWD: docsDir,
        QMD_COMPAT_MODE: "agent-board",
        QMD_EMBED_URL: baseUrl,
        QMD_EMBED_KEY: "test-embed-key",
        QMD_EMBED_MODEL: "remote-embed-model",
        QMD_EMBED_DIMS: "2",
        QMD_CHAT_URL: baseUrl,
        QMD_CHAT_KEY: "test-chat-key",
        QMD_CHAT_MODEL: "remote-chat-model",
        NO_COLOR: "1",
        ...extraEnv,
      },
      maxBuffer: 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message, exitCode: failed.code ?? 1 };
  }
}

async function runBuiltConfiguredLocal(args: string[]) {
  return runBuilt(args, {
    INDEX_PATH: localDbPath,
    QMD_CONFIG_DIR: localConfigDir,
    PWD: localDocsDir,
    QMD_COMPAT_MODE: "",
    QMD_EMBED_MODEL: "",
  });
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-remote-cli-"));
  configDir = join(testDir, "config");
  docsDir = join(testDir, "docs");
  copyDocsDir = join(testDir, "docs-copy");
  dbPath = join(testDir, "index.sqlite");
  localConfigDir = join(testDir, "local-config");
  localDocsDir = join(testDir, "local-docs");
  localCopyDocsDir = join(testDir, "local-docs-copy");
  localDbPath = join(testDir, "local-index.sqlite");
  await mkdir(configDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  await mkdir(copyDocsDir, { recursive: true });
  await mkdir(localConfigDir, { recursive: true });
  await mkdir(localDocsDir, { recursive: true });
  await mkdir(localCopyDocsDir, { recursive: true });
  await writeFile(join(docsDir, "remote.md"), remoteDocument);
  await writeFile(join(copyDocsDir, "remote.md"), remoteDocument);
  await writeFile(join(localDocsDir, "remote.md"), remoteDocument);
  await writeFile(join(localCopyDocsDir, "remote.md"), remoteDocument);
  await writeFile(join(configDir, "index.yml"), [
    "collections:",
    "  docs:",
    `    path: ${JSON.stringify(docsDir)}`,
    "    pattern: '**/*.md'",
    "",
  ].join("\n"));
  await writeFile(join(localConfigDir, "index.yml"), [
    "models:",
    "  embed: custom-local-model.gguf",
    "collections:",
    "  docs:",
    `    path: ${JSON.stringify(localDocsDir)}`,
    "    pattern: '**/*.md'",
    "",
  ].join("\n"));

  const store = createStore(dbPath);
  const hash = await hashContent(remoteDocument);
  const now = new Date(0).toISOString();
  insertContent(store.db, hash, remoteDocument, now);
  insertDocument(store.db, "docs", "remote.md", "Remote Search", hash, now, now);
  store.ensureVecTable(2);
  insertEmbedding(store.db, hash, 0, 0, new Float32Array([1, 0]), "remote-embed-model", now);
  store.db.prepare(`
    INSERT INTO embedding_documents (hash, model, total_chunks, embedded_at, completed_at)
    VALUES (?, 'remote-embed-model', 1, ?, ?)
  `).run(hash, now, now);
  store.close();

  const localStore = createStore(localDbPath);
  insertContent(localStore.db, hash, remoteDocument, now);
  insertDocument(localStore.db, "docs", "remote.md", "Remote Search", hash, now, now);
  localStore.ensureVecTable(2);
  insertEmbedding(localStore.db, hash, 0, 0, new Float32Array([1, 0]), "custom-local-model.gguf", now);
  localStore.db.prepare(`
    INSERT INTO embedding_documents (hash, model, total_chunks, embedded_at, completed_at)
    VALUES (?, 'custom-local-model.gguf', 1, ?, ?)
  `).run(hash, now, now);
  localStore.close();

  await startServer();
  await execFileAsync("npm", ["run", "build"], { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 });
}, 60_000);

afterAll(async () => {
  await new Promise<void>(resolveClose => server?.close(() => resolveClose()));
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  embedCalls = 0;
  chatCalls = 0;
});

describe("built native-free CLI", () => {
  test("help starts while native package resolution is denied", async () => {
    const result = await runBuilt(["--help"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).not.toContain("native package resolution denied");
  });

  test("status, search health, and embed preflight use the active remote model", async () => {
    const status = await runBuilt(["status"]);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).not.toContain("Pending:");

    const search = await runBuilt(["vsearch", "profile preferences", "-c", "docs", "--no-expand", "--json"]);
    expect(search.exitCode, search.stderr).toBe(0);
    expect(search.stderr).not.toContain("need embeddings");

    const callsBeforeEmbed = embedCalls;
    const embed = await runBuilt(["embed"]);
    expect(embed.exitCode, embed.stderr).toBe(0);
    expect(embed.stdout).toContain("All content hashes already have embeddings");
    expect(embedCalls).toBe(callsBeforeEmbed);
  });

  test.each(["--no-expand", "--noExpand"])("vsearch %s makes exactly one embed call and zero chat calls", async flag => {
    const result = await runBuilt(["vsearch", "profile preferences", "-c", "docs", "-n", "3", flag, "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
    expect(chatCalls).toBe(0);
    expect(embedCalls).toBe(1);
  });

  test("default vsearch retains chat expansion and multiple raw-query embedding operations", async () => {
    const result = await runBuilt(["vsearch", "profile preferences", "-c", "docs", "-n", "3", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(chatCalls).toBeGreaterThanOrEqual(1);
    expect(embedCalls).toBeGreaterThan(1);
  });

  test("remote query uses compatibility chat/embed paths while native resolution is denied", async () => {
    const result = await runBuilt(["query", "remote semantic question", "-c", "docs", "--no-rerank", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
    expect(chatCalls).toBeGreaterThanOrEqual(1);
    expect(embedCalls).toBe(1);
    expect(result.stderr).not.toContain("native package resolution denied");
  });

  test("configured local model scopes native-free status and indexing notices", async () => {
    const status = await runBuiltConfiguredLocal(["status"]);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).not.toContain("Pending:");
    expect(status.stderr).not.toContain("native package resolution denied");

    const update = await runBuiltConfiguredLocal(["update"]);
    expect(update.exitCode, update.stderr).toBe(0);
    expect(update.stdout).not.toContain("need vectors");
    expect(update.stderr).not.toContain("native package resolution denied");

    const add = await runBuiltConfiguredLocal(["collection", "add", localCopyDocsDir, "--name", "docs-copy"]);
    expect(add.exitCode, add.stderr).toBe(0);
    expect(add.stdout).not.toContain("need vectors");
    expect(add.stderr).not.toContain("native package resolution denied");
  });

  test("update and collection indexing notices use the active remote model", async () => {
    const update = await runBuilt(["update"]);
    expect(update.exitCode, update.stderr).toBe(0);
    expect(update.stdout).not.toContain("need vectors");

    const add = await runBuilt(["collection", "add", copyDocsDir, "--name", "docs-copy"]);
    expect(add.exitCode, add.stderr).toBe(0);
    expect(add.stdout).not.toContain("need vectors");
  });
});

describe("native-free static dependency boundary", () => {
  test("API/CLI roots do not statically reach the local-only llm module", () => {
    const roots = [
      "src/index.ts", "src/cli/qmd.ts", "src/store.ts", "src/llm-types.ts",
      "src/llm-api.ts", "src/remote-llm.ts", "src/mcp/server.ts",
    ];
    const visited = new Set<string>();
    const queue = roots.map(path => resolve(projectRoot, path));
    const staticImport = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(staticImport)) {
        const specifier = match[1]!;
        expect(specifier).not.toMatch(/^node-llama-cpp(?:\/|$)/);
        if (!specifier.startsWith(".")) continue;
        const candidate = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
        expect(candidate).not.toBe(resolve(projectRoot, "src/llm.ts"));
        queue.push(candidate);
      }
    }
  });
});
