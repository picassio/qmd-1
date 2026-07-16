import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/index.js";
import { ApiLLM } from "../src/llm-api.js";
import { RemoteLLM } from "../src/remote-llm.js";
import type { LLM } from "../src/llm-types.js";

const envKeys = [
  "QMD_COMPAT_MODE",
  "QMD_EMBED_URL", "QMD_EMBED_KEY", "QMD_EMBED_MODEL", "QMD_EMBED_DIMS",
  "QMD_CHAT_URL", "QMD_CHAT_KEY", "QMD_CHAT_MODEL",
  "QMD_RERANK_URL", "QMD_RERANK_KEY", "QMD_RERANK_MODEL",
] as const;

let tempDir: string;
let counter = 0;
const realFetch = globalThis.fetch;

function dbPath(): string {
  counter += 1;
  return join(tempDir, `${counter}.sqlite`);
}

function injectedLlm(): LLM {
  return {
    embedModelName: "injected",
    embed: vi.fn(async () => ({ embedding: [1], model: "injected" })),
    embedBatch: vi.fn(async texts => texts.map(() => ({ embedding: [1], model: "injected" }))),
    generate: vi.fn(async () => null),
    modelExists: vi.fn(async name => ({ name, exists: true })),
    expandQuery: vi.fn(async query => [{ type: "vec" as const, text: query }]),
    rerank: vi.fn(async (_query, docs) => ({
      results: docs.map((doc, index) => ({ file: doc.file, score: 0, index })),
      model: "injected",
    })),
    dispose: vi.fn(async () => {}),
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "qmd-agent-board-selection-"));
  for (const key of envKeys) delete process.env[key];
});

afterEach(async () => {
  for (const key of envKeys) delete process.env[key];
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("QMD_COMPAT_MODE selection", () => {
  test("explicit StoreOptions.llm wins even when the environment mode would otherwise be rejected", async () => {
    process.env.QMD_COMPAT_MODE = "surprise-mode";
    process.env.QMD_EMBED_URL = "https://embed.example/v1";
    const injected = injectedLlm();

    const store = await createStore({ dbPath: dbPath(), llm: injected });
    expect(store.internal.llm).toBe(injected);
    await store.close();
    expect(injected.dispose).toHaveBeenCalledOnce();
  });

  test("agent-board explicitly selects RemoteLLM", async () => {
    process.env.QMD_COMPAT_MODE = "agent-board";
    const store = await createStore({ dbPath: dbPath(), config: { collections: {} } });
    expect(store.internal.llm).toBeInstanceOf(RemoteLLM);
    await store.close();
  });

  test("QMD_EMBED_URL alone preserves ordinary ApiLLM selection", async () => {
    process.env.QMD_EMBED_URL = "https://embed.example/v1";
    const store = await createStore({ dbPath: dbPath(), config: { collections: {} } });
    expect(store.internal.llm).toBeInstanceOf(ApiLLM);
    expect(store.internal.llm).not.toBeInstanceOf(RemoteLLM);
    await store.close();
  });

  test("unknown nonempty compatibility mode fails actionably before local fallback", async () => {
    process.env.QMD_COMPAT_MODE = "surprise-mode";
    await expect(createStore({ dbPath: dbPath(), config: { collections: {} } }))
      .rejects.toThrow(/Unknown QMD_COMPAT_MODE.*surprise-mode.*agent-board/i);
  });

  test.each([undefined, ""])("unset/empty compatibility preserves configured ApiLLM (%s)", async mode => {
    if (mode === undefined) delete process.env.QMD_COMPAT_MODE;
    else process.env.QMD_COMPAT_MODE = mode;
    const store = await createStore({
      dbPath: dbPath(),
      config: {
        collections: {},
        providers: { embed: { url: "https://embed.example/v1", model: "embed-model" } },
      },
    });
    expect(store.internal.llm).toBeInstanceOf(ApiLLM);
    await store.close();
  });
});

describe("ordinary ApiLLM remains general purpose", () => {
  test("configured rerank provider still performs HTTP reranking and score sorting", async () => {
    process.env.QMD_RERANK_URL = "https://rerank.example/v1";
    process.env.QMD_RERANK_KEY = "rerank-key";
    process.env.QMD_RERANK_MODEL = "rerank-model";
    const fetchMock = vi.fn(async () => Response.json({
      model: "provider-rerank-model",
      results: [
        { index: 0, relevance_score: 0.1 },
        { index: 1, relevance_score: 0.9 },
      ],
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await new ApiLLM().rerank("query", [
      { file: "a.md", text: "alpha" },
      { file: "b.md", text: "beta" },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://rerank.example/v1/rerank");
    expect(result).toEqual({
      results: [
        { file: "b.md", score: 0.9, index: 1 },
        { file: "a.md", score: 0.1, index: 0 },
      ],
      model: "provider-rerank-model",
    });
  });
});
