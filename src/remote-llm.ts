/**
 * Agent Board compatibility LLM over OpenAI-style HTTP endpoints.
 *
 * This module is deliberately native-free. It imports only erased types from
 * llm-types.ts and never falls back to a local model.
 */
import type {
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  LLM,
  ModelInfo,
  Queryable,
  QueryType,
  RerankDocument,
  RerankResult,
} from "./llm-types.js";

type EndpointConfig = {
  url: string;
  key?: string;
  model: string;
  dims?: number;
};

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function embedConfig(): EndpointConfig | null {
  const url = process.env.QMD_EMBED_URL;
  if (!url) return null;
  const rawDims = process.env.QMD_EMBED_DIMS;
  const parsedDims = rawDims === undefined || rawDims === "" ? undefined : Number(rawDims);
  return {
    url: trimTrailingSlashes(url),
    key: process.env.QMD_EMBED_KEY,
    model: process.env.QMD_EMBED_MODEL || "text-embedding-3-small",
    dims: parsedDims !== undefined && Number.isFinite(parsedDims) && parsedDims !== 0
      ? parsedDims
      : undefined,
  };
}

function chatConfig(): EndpointConfig | null {
  const url = process.env.QMD_CHAT_URL;
  if (!url) return null;
  return {
    url: trimTrailingSlashes(url),
    key: process.env.QMD_CHAT_KEY,
    model: process.env.QMD_CHAT_MODEL || "",
  };
}

function headers(key?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable response>";
  }
}

function expansionPrompt(query: string, context?: string): string {
  const contextLine = context ? `\nContext: ${context}` : "";
  return (
    `/no_think Expand this search query: ${query}${contextLine}\n\n` +
    "Reply with one expansion per line, each prefixed by its type and a colon. " +
    "Use these types only:\n" +
    "  lex:  a keyword/lexical variant\n" +
    "  vec:  a semantic paraphrase for vector search\n" +
    "  hyde: a hypothetical answer/document snippet\n" +
    "Output only those lines, nothing else."
  );
}

export class RemoteLLM implements LLM {
  get embedModelName(): string {
    return process.env.QMD_EMBED_MODEL || "text-embedding-3-small";
  }

  async embed(text: string, _options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
    const config = embedConfig();
    if (!config) {
      console.error("RemoteLLM.embed: QMD_EMBED_URL is not set");
      return null;
    }
    const result = await this.embedRequest(config, [text]);
    return result[0] ?? null;
  }

  async embedBatch(texts: string[], _options: EmbedOptions = {}): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    const config = embedConfig();
    if (!config) {
      console.error("RemoteLLM.embedBatch: QMD_EMBED_URL is not set");
      return texts.map(() => null);
    }
    return this.embedRequest(config, texts);
  }

  private async embedRequest(config: EndpointConfig, inputs: string[]): Promise<(EmbeddingResult | null)[]> {
    try {
      const body: Record<string, unknown> = {
        model: config.model,
        input: inputs,
      };
      if (config.dims !== undefined) body.dimensions = config.dims;

      const response = await fetch(`${config.url}/embeddings`, {
        method: "POST",
        headers: headers(config.key),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        console.error(`RemoteLLM embed HTTP ${response.status}: ${await safeText(response)}`);
        return inputs.map(() => null);
      }

      const json = await response.json() as {
        data?: Array<{ index?: number; embedding?: unknown }>;
      };
      if (!Array.isArray(json?.data)) {
        console.error("RemoteLLM embed: malformed response (no data array)");
        return inputs.map(() => null);
      }

      const output: (EmbeddingResult | null)[] = inputs.map(() => null);
      json.data.forEach((item, position) => {
        const index = typeof item?.index === "number" ? item.index : position;
        const embedding = item?.embedding;
        if (
          Number.isInteger(index) && index >= 0 && index < output.length &&
          Array.isArray(embedding) && embedding.length > 0 &&
          embedding.every(value => typeof value === "number" && Number.isFinite(value))
        ) {
          output[index] = { embedding: embedding as number[], model: config.model };
        }
      });
      return output;
    } catch (error) {
      console.error("RemoteLLM embed error:", error);
      return inputs.map(() => null);
    }
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult | null> {
    const config = chatConfig();
    if (!config) {
      console.error("RemoteLLM.generate: QMD_CHAT_URL is not set");
      return null;
    }
    const text = await this.chatCompletion(config, prompt, {
      maxTokens: options.maxTokens ?? 150,
      temperature: options.temperature ?? 0.7,
    });
    return text === null ? null : { text, model: config.model, done: true };
  }

  async expandQuery(
    query: string,
    options: { context?: string; intent?: string; includeLexical?: boolean } = {},
  ): Promise<Queryable[]> {
    const includeLexical = options.includeLexical ?? true;
    const fallback = (): Queryable[] => [
      ...(includeLexical ? [{ type: "lex" as const, text: query }] : []),
      { type: "vec", text: query },
    ];
    const config = chatConfig();
    if (!config) return fallback();

    try {
      const text = await this.chatCompletion(config, expansionPrompt(query, options.context), {
        maxTokens: 600,
        temperature: 0.7,
      });
      if (text === null) return fallback();

      const queryTerms = query.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      const hasQueryTerm = (candidate: string): boolean => {
        if (queryTerms.length === 0) return true;
        const lower = candidate.toLowerCase();
        return queryTerms.some(term => lower.includes(term));
      };

      const parsed = text.trim().split("\n")
        .map((line): Queryable | null => {
          const colon = line.indexOf(":");
          if (colon < 0) return null;
          const type = line.slice(0, colon).trim();
          if (type !== "lex" && type !== "vec" && type !== "hyde") return null;
          const value = line.slice(colon + 1).trim();
          if (!value || !hasQueryTerm(value)) return null;
          return { type: type as QueryType, text: value };
        })
        .filter((item): item is Queryable => item !== null)
        .filter(item => includeLexical || item.type !== "lex");

      if (parsed.length > 0) return parsed;
      const richFallback: Queryable[] = [
        { type: "hyde", text: `Information about ${query}` },
        { type: "lex", text: query },
        { type: "vec", text: query },
      ];
      return includeLexical ? richFallback : richFallback.filter(item => item.type !== "lex");
    } catch (error) {
      console.error("RemoteLLM query expansion failed:", error);
      return fallback();
    }
  }

  async rerank(_query: string, documents: RerankDocument[]): Promise<RerankResult> {
    return {
      results: documents.map((document, index) => ({ file: document.file, score: 0, index })),
      model: "identity",
    };
  }

  async tokenize(text: string): Promise<readonly number[]> {
    return Array.from(text, character => character.codePointAt(0)!);
  }

  async detokenize(tokens: readonly unknown[]): Promise<string> {
    return tokens.map(token => String.fromCodePoint(token as number)).join("");
  }

  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }

  async dispose(): Promise<void> {
    // Remote compatibility owns no native resources.
  }

  private async chatCompletion(
    config: EndpointConfig,
    prompt: string,
    options: { maxTokens: number; temperature: number },
  ): Promise<string | null> {
    try {
      const response = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: headers(config.key),
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: options.maxTokens,
          temperature: options.temperature,
        }),
      });
      if (!response.ok) {
        console.error(`RemoteLLM chat HTTP ${response.status}: ${await safeText(response)}`);
        return null;
      }
      const json = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = json?.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : null;
    } catch (error) {
      console.error("RemoteLLM chat error:", error);
      return null;
    }
  }
}
