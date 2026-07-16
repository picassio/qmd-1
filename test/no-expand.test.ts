import { afterEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import {
  createStore,
  vectorSearchQuery,
  type Store,
} from "../src/store.js";
import {
  formatQueryForEmbedding,
  setDefaultLlm,
  type LLM,
} from "../src/llm-types.js";

const paths: string[] = [];

function countingLlm(expansions: { type: "lex" | "vec" | "hyde"; text: string }[] = []): LLM & {
  embed: ReturnType<typeof vi.fn>;
  expandQuery: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async () => ({ embedding: [1, 0], model: "counting-model" }));
  const expandQuery = vi.fn(async () => expansions);
  return {
    embedModelName: "counting-model",
    embed,
    embedBatch: vi.fn(async texts => texts.map(() => ({ embedding: [1, 0], model: "counting-model" }))),
    generate: vi.fn(async () => null),
    modelExists: vi.fn(async name => ({ name, exists: true })),
    expandQuery,
    rerank: vi.fn(async (_query, docs) => ({
      results: docs.map((doc, index) => ({ file: doc.file, score: 0, index })),
      model: "counting-model",
    })),
    dispose: vi.fn(async () => {}),
  } as LLM & { embed: ReturnType<typeof vi.fn>; expandQuery: ReturnType<typeof vi.fn> };
}

function vectorStore(llm: LLM): Store {
  const path = join(tmpdir(), `qmd-no-expand-${process.pid}-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(path);
  const store = createStore(path);
  store.llm = llm;
  setDefaultLlm(llm);
  store.ensureVecTable(2);
  return store;
}

afterEach(() => {
  setDefaultLlm(null);
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(path + suffix); } catch {}
    }
  }
  vi.restoreAllMocks();
});

describe("vectorSearchQuery no-expand path", () => {
  test("performs zero expansion, one formatted embed, and one vector lookup", async () => {
    const llm = countingLlm([{ type: "vec", text: "must not run" }]);
    const store = vectorStore(llm);
    const searchVec = vi.spyOn(store, "searchVec");

    try {
      await vectorSearchQuery(store, "profile preferences", { noExpand: true });
    } finally {
      store.close();
    }

    expect(llm.expandQuery).not.toHaveBeenCalled();
    expect(llm.embed).toHaveBeenCalledExactlyOnceWith(
      formatQueryForEmbedding("profile preferences", "embeddinggemma"),
      { model: "embeddinggemma", isQuery: true },
    );
    expect(searchVec).toHaveBeenCalledOnce();
    expect(searchVec).toHaveBeenCalledWith(
      "profile preferences", "embeddinggemma", 10, undefined,
    );
  });

  test("default vector search retains expansion and embeds every vector variant", async () => {
    const llm = countingLlm([
      { type: "lex", text: "profile keywords" },
      { type: "vec", text: "profile semantic" },
      { type: "hyde", text: "profile hypothetical document" },
    ]);
    const store = vectorStore(llm);
    const searchVec = vi.spyOn(store, "searchVec");

    try {
      await vectorSearchQuery(store, "profile preferences");
    } finally {
      store.close();
    }

    expect(llm.expandQuery).toHaveBeenCalledOnce();
    expect(llm.embed).toHaveBeenCalledTimes(3);
    expect(searchVec).toHaveBeenCalledTimes(3);
  });
});
