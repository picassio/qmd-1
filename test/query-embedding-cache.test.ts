/**
 * query-embedding-cache.test.ts - ApiLLM keeps search queries' embeddings: the same query again sends no request;
 * documents, other models, and failed answers are never kept.
 */
import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { ApiLLM, QUERY_EMBEDDING_CACHE } from "../src/llm-api.js";

let server: Server | undefined;

afterEach(() => server?.close());

async function provider(fail = () => false) {
  const asked: unknown[] = [];
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      asked.push(JSON.parse(body).input);
      if (fail()) {
        response.statusCode = 500;
        response.end("{}");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }], model: "m" }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  return { asked, llm: new ApiLLM({ providers: { embed: { url, model: "m" } } as never }) };
}

describe("query embedding cache", () => {
  test("a query asked again is answered without a request", async () => {
    const { asked, llm } = await provider();
    const first = await llm.embed("what about proxmox", { isQuery: true });
    const again = await llm.embed("what about proxmox", { isQuery: true });
    expect(again).toEqual(first);
    expect(asked.length).toBe(1);
  });

  test("documents, other models, and other texts are asked each time", async () => {
    const { asked, llm } = await provider();
    await llm.embed("a page body");
    await llm.embed("a page body");
    await llm.embed("q", { isQuery: true });
    await llm.embed("q", { isQuery: true, model: "other" });
    await llm.embed("q2", { isQuery: true });
    expect(asked.length).toBe(5);
  });

  test("a failed answer is not kept", async () => {
    let failing = true;
    const { asked, llm } = await provider(() => failing);
    expect(await llm.embed("q", { isQuery: true })).toBeNull();
    failing = false;
    expect(await llm.embed("q", { isQuery: true })).not.toBeNull();
    expect(await llm.embed("q", { isQuery: true })).not.toBeNull();
    expect(asked.length).toBe(2);
  });

  test("it keeps the most recent queries only", async () => {
    const { asked, llm } = await provider();
    for (let index = 0; index <= QUERY_EMBEDDING_CACHE; index++) await llm.embed(`q${index}`, { isQuery: true });
    await llm.embed("q0", { isQuery: true });
    expect(asked.length).toBe(QUERY_EMBEDDING_CACHE + 2);
  });
});
