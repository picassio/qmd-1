/**
 * Remote embedding requests report their usage (tokens, and cost when the provider says it) to listeners, so a host can
 * count what search by meaning costs.
 */
import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { ApiLLM, onApiUsage, type ApiUsage } from "../src/llm-api.js";

let server: Server | undefined;
let stop: (() => void) | undefined;

afterEach(() => {
  server?.close();
  stop?.();
});

async function provider(usage: Record<string, number> | undefined) {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const input = JSON.parse(body).input;
      const texts = Array.isArray(input) ? input : [input];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        data: texts.map((_text: string, index: number) => ({ index, embedding: [1, 2, 3] })),
        model: "openai/text-embedding-3-small",
        ...(usage === undefined ? {} : { usage }),
      }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  return { url, llm: new ApiLLM({ providers: { embed: { url, model: "m" } } as never }) };
}

describe("API usage", () => {
  test("an embedding and a batch report their tokens and cost", async () => {
    const heard: ApiUsage[] = [];
    stop = onApiUsage((usage) => heard.push(usage));
    const { url, llm } = await provider({ prompt_tokens: 12, total_tokens: 12, cost: 0.00000024 });

    await llm.embed("what about proxmox", { isQuery: true });
    await llm.embedBatch(["a", "b", "c"]);
    expect(heard).toEqual([
      { kind: "embed", url, model: "openai/text-embedding-3-small", inputs: 1, promptTokens: 12, cost: 0.00000024 },
      { kind: "embed", url, model: "openai/text-embedding-3-small", inputs: 3, promptTokens: 12, cost: 0.00000024 },
    ]);
  });

  test("a query answered from the cache reports nothing; a provider without usage reports nothing", async () => {
    const heard: ApiUsage[] = [];
    stop = onApiUsage((usage) => heard.push(usage));
    const { llm } = await provider(undefined);

    await llm.embed("q", { isQuery: true });
    await llm.embed("q", { isQuery: true });
    expect(heard).toEqual([]);
  });

  test("a listener that throws does not break the embedding", async () => {
    stop = onApiUsage(() => {
      throw new Error("boom");
    });
    const { llm } = await provider({ prompt_tokens: 3 });

    expect((await llm.embed("x"))?.embedding).toEqual([1, 2, 3]);
  });
});
