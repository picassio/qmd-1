import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RemoteLLM } from "../src/remote-llm.js";
import type { RerankDocument } from "../src/llm-types.js";

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const qmdKeys = [
  "QMD_EMBED_URL", "QMD_EMBED_KEY", "QMD_EMBED_MODEL", "QMD_EMBED_DIMS", "QMD_EMBED_API",
  "QMD_CHAT_URL", "QMD_CHAT_KEY", "QMD_CHAT_MODEL", "QMD_CHAT_API",
  "QMD_RERANK_URL", "QMD_RERANK_KEY", "QMD_RERANK_MODEL", "QMD_RERANK_API",
] as const;

const requests: CapturedRequest[] = [];

function clearQmdEnv(): void {
  for (const key of qmdKeys) delete process.env[key];
}

function stubFetch(handler: (request: CapturedRequest) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    requests.push(request);
    return handler(request);
  }));
}

beforeEach(() => {
  clearQmdEnv();
  requests.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  clearQmdEnv();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RemoteLLM Agent Board wire contract", () => {
  test("single embed uses an array input, trims URL, sends finite nonzero dimensions, and preserves configured model identity", async () => {
    Object.assign(process.env, {
      QMD_EMBED_URL: "https://embed.example/v1///",
      QMD_EMBED_KEY: "embed-key",
      QMD_EMBED_MODEL: "configured-embed-model",
      QMD_EMBED_DIMS: "1536",
      QMD_EMBED_API: "anthropic",
    });
    stubFetch(() => Response.json({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      model: "provider-reported-model",
    }));

    await expect(new RemoteLLM().embed("hello")).resolves.toEqual({
      embedding: [0.1, 0.2],
      model: "configured-embed-model",
    });
    expect(requests).toEqual([expect.objectContaining({
      url: "https://embed.example/v1/embeddings",
      body: {
        model: "configured-embed-model",
        input: ["hello"],
        dimensions: 1536,
      },
    })]);
    expect(requests[0]!.headers.authorization).toBe("Bearer embed-key");
  });

  test.each([undefined, "", "0", "NaN", "Infinity"])("omits invalid/zero dimensions %s", async (dims) => {
    Object.assign(process.env, {
      QMD_EMBED_URL: "https://embed.example/v1",
      QMD_EMBED_MODEL: "embed-model",
    });
    if (dims === undefined) delete process.env.QMD_EMBED_DIMS;
    else process.env.QMD_EMBED_DIMS = dims;
    stubFetch(() => Response.json({ data: [{ index: 0, embedding: [1] }] }));

    await new RemoteLLM().embed("x");
    expect(requests[0]!.body).not.toHaveProperty("dimensions");
    expect(requests[0]!.headers).not.toHaveProperty("authorization");
  });

  test("batch embed makes one request and restores response order by index", async () => {
    Object.assign(process.env, {
      QMD_EMBED_URL: "https://embed.example/v1",
      QMD_EMBED_MODEL: "embed-model",
    });
    stubFetch(() => Response.json({ data: [
      { index: 2, embedding: [3] },
      { index: 0, embedding: [1] },
      { index: 1, embedding: [2] },
    ] }));

    const result = await new RemoteLLM().embedBatch(["a", "b", "c"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.input).toEqual(["a", "b", "c"]);
    expect(result.map(item => item?.embedding)).toEqual([[1], [2], [3]]);
  });

  test("embed failures return nulls without batch-to-individual retry", async () => {
    Object.assign(process.env, { QMD_EMBED_URL: "https://embed.example/v1" });
    stubFetch(() => new Response("nope", { status: 503 }));
    const llm = new RemoteLLM();

    await expect(llm.embed("one")).resolves.toBeNull();
    await expect(llm.embedBatch(["a", "b"])).resolves.toEqual([null, null]);
    expect(requests).toHaveLength(2);
  });

  test("missing URL, network failure, and malformed embed responses use null failure values", async () => {
    stubFetch(() => { throw new Error("network down"); });
    const llm = new RemoteLLM();
    await expect(llm.embed("missing-url")).resolves.toBeNull();
    await expect(llm.embedBatch(["a", "b"])).resolves.toEqual([null, null]);
    expect(requests).toHaveLength(0);

    process.env.QMD_EMBED_URL = "https://embed.example/v1";
    await expect(llm.embed("network-failure")).resolves.toBeNull();
    expect(requests).toHaveLength(1);

    stubFetch(() => Response.json({ unexpected: true }));
    await expect(llm.embedBatch(["a", "b"])).resolves.toEqual([null, null]);
  });

  test("chat always uses OpenAI wire, returns raw text, and ignores API style hints", async () => {
    Object.assign(process.env, {
      QMD_CHAT_URL: "https://chat.example/v1/",
      QMD_CHAT_KEY: "chat-key",
      QMD_CHAT_MODEL: "chat-model",
      QMD_CHAT_API: "anthropic",
    });
    stubFetch(() => Response.json({
      choices: [{ message: { content: "plain provider text" } }],
      model: "ignored-provider-model",
    }));

    const result = await new RemoteLLM().generate("prompt", { maxTokens: 77, temperature: 0.25 });
    expect(result).toEqual({ text: "plain provider text", model: "chat-model", done: true });
    expect(result?.text).not.toContain("<memory-context>");
    expect(requests[0]).toEqual(expect.objectContaining({
      url: "https://chat.example/v1/chat/completions",
      body: {
        model: "chat-model",
        messages: [{ role: "user", content: "prompt" }],
        max_tokens: 77,
        temperature: 0.25,
      },
    }));
    expect(requests[0]!.headers.authorization).toBe("Bearer chat-key");
  });

  test("missing, failed, and malformed chat responses return null", async () => {
    const llm = new RemoteLLM();
    stubFetch(() => Response.json({}));
    await expect(llm.generate("missing-url")).resolves.toBeNull();
    expect(requests).toHaveLength(0);

    process.env.QMD_CHAT_URL = "https://chat.example/v1";
    stubFetch(() => new Response("bad gateway", { status: 502 }));
    await expect(llm.generate("http-failure")).resolves.toBeNull();

    stubFetch(() => Response.json({ choices: [] }));
    await expect(llm.generate("malformed")).resolves.toBeNull();
  });
});

describe("RemoteLLM Agent Board behavior", () => {
  test("expansion parses typed provider text without fencing", async () => {
    Object.assign(process.env, {
      QMD_CHAT_URL: "https://chat.example/v1",
      QMD_CHAT_MODEL: "chat-model",
    });
    stubFetch(() => Response.json({ choices: [{ message: { content:
      "lex: deploy rollback\nvec: how to rollback a deploy\nhyde: deploy rollback instructions\nvec: unrelated text",
    } }] }));

    await expect(new RemoteLLM().expandQuery("deploy rollback")).resolves.toEqual([
      { type: "lex", text: "deploy rollback" },
      { type: "vec", text: "how to rollback a deploy" },
      { type: "hyde", text: "deploy rollback instructions" },
    ]);
    expect(JSON.stringify(requests[0]!.body)).not.toContain("<memory-context>");
  });

  test("missing or failed chat expansion degrades to original vec plus optional lex", async () => {
    const llm = new RemoteLLM();
    stubFetch(() => Response.json({}));
    await expect(llm.expandQuery("original")).resolves.toEqual([
      { type: "lex", text: "original" },
      { type: "vec", text: "original" },
    ]);
    await expect(llm.expandQuery("original", { includeLexical: false })).resolves.toEqual([
      { type: "vec", text: "original" },
    ]);
    expect(requests).toHaveLength(0);

    process.env.QMD_CHAT_URL = "https://chat.example/v1";
    stubFetch(() => new Response("failed", { status: 500 }));
    await expect(llm.expandQuery("original")).resolves.toEqual([
      { type: "lex", text: "original" },
      { type: "vec", text: "original" },
    ]);
  });

  test("rerank is stable identity and ignores every rerank provider variable", async () => {
    Object.assign(process.env, {
      QMD_RERANK_URL: "https://must-not-be-called.example/v1",
      QMD_RERANK_KEY: "rerank-key",
      QMD_RERANK_MODEL: "rerank-model",
      QMD_RERANK_API: "custom",
    });
    stubFetch(() => { throw new Error("rerank HTTP must not happen"); });
    const docs: RerankDocument[] = [
      { file: "b.md", text: "beta" },
      { file: "a.md", text: "alpha" },
    ];

    await expect(new RemoteLLM().rerank("query", docs)).resolves.toEqual({
      results: [
        { file: "b.md", score: 0, index: 0 },
        { file: "a.md", score: 0, index: 1 },
      ],
      model: "identity",
    });
    expect(requests).toHaveLength(0);
  });

  test("tokenization is one lossless token per Unicode code point", async () => {
    const llm = new RemoteLLM();
    const text = "héllo 世界 🚀 𝄞";
    const tokens = await llm.tokenize(text);
    expect(tokens).toHaveLength(Array.from(text).length);
    await expect(llm.detokenize(tokens)).resolves.toBe(text);
  });

  test("modelExists and dispose are native-free no-op capabilities", async () => {
    const llm = new RemoteLLM();
    await expect(llm.modelExists("remote-model")).resolves.toEqual({ name: "remote-model", exists: true });
    await expect(llm.dispose()).resolves.toBeUndefined();
  });
});
