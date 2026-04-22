/**
 * llm-api.ts — API-based LLM backend for QMD.
 *
 * Drop-in replacement for LlamaCpp that calls external HTTP APIs.
 * Each function (embed, chat, rerank) can use a separate provider
 * with its own URL, key, and model.
 *
 * Configure in ~/.config/qmd/index.yml:
 *
 *   providers:
 *     embed:
 *       url: https://api.openai.com/v1
 *       key: sk-...
 *       model: text-embedding-3-small
 *       dims: 1536                        # optional dimension override
 *     chat:
 *       url: https://openrouter.ai/api/v1
 *       key: sk-or-...
 *       model: google/gemini-2.5-flash
 *       api: openai                       # "openai" (default) or "anthropic"
 *     rerank:
 *       url: https://api.jina.ai/v1
 *       key: jina_...
 *       model: jina-reranker-v2-base-multilingual
 *
 * For Anthropic-compatible providers (MiniMax CN, etc.):
 *
 *   providers:
 *     chat:
 *       url: https://api.minimaxi.com/anthropic
 *       key: sk-cp-...
 *       model: MiniMax-M2.7-highspeed
 *       api: anthropic
 *
 * Env vars override config file values:
 *   QMD_EMBED_URL, QMD_EMBED_KEY, QMD_EMBED_MODEL, QMD_EMBED_DIMS
 *   QMD_CHAT_URL,  QMD_CHAT_KEY,  QMD_CHAT_MODEL,  QMD_CHAT_API
 *   QMD_RERANK_URL, QMD_RERANK_KEY, QMD_RERANK_MODEL
 *
 * Env vars override config file values.
 */

import type {
  LLM,
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  Queryable,
  QueryType,
  RerankDocument,
  RerankOptions,
  RerankResult,
  RerankDocumentResult,
  LLMSessionOptions,
  ILLMSession,
} from "./llm.js";

export { formatQueryForEmbedding, formatDocForEmbedding } from "./llm.js";
import type { ProvidersConfig, ApiFormat } from "./collections.js";
export type { ProvidersConfig };

// =============================================================================
// Types
// =============================================================================

interface ResolvedEndpoint {
  url: string;
  key: string;
  model: string;
  api: ApiFormat;
}

interface ResolvedEmbedEndpoint extends ResolvedEndpoint {
  dims?: number;
}

export interface ApiLLMConfig {
  providers?: ProvidersConfig;
}

// Resolved (all fields filled with defaults)
interface ResolvedProviders {
  embed: ResolvedEmbedEndpoint;
  chat: ResolvedEndpoint;
  rerank: ResolvedEndpoint;
  timeout: number;
}

function e(key: string): string {
  return process.env[key] ?? "";
}

function resolveApi(envKey: string, cfgApi?: ApiFormat): ApiFormat {
  const v = e(envKey) || cfgApi || "";
  return v === "anthropic" ? "anthropic" : "openai";
}

function resolve(cfg: ProvidersConfig = {}): ResolvedProviders {
  return {
    embed: {
      url:   e("QMD_EMBED_URL")   || cfg.embed?.url   || "https://api.openai.com/v1",
      key:   e("QMD_EMBED_KEY")   || cfg.embed?.key   || "",
      model: e("QMD_EMBED_MODEL") || cfg.embed?.model || "text-embedding-3-small",
      dims:  e("QMD_EMBED_DIMS")  ? parseInt(e("QMD_EMBED_DIMS")) : cfg.embed?.dims,
      api:   resolveApi("QMD_EMBED_API", cfg.embed?.api),
    },
    chat: {
      url:   e("QMD_CHAT_URL")   || cfg.chat?.url   || "https://openrouter.ai/api/v1",
      key:   e("QMD_CHAT_KEY")   || cfg.chat?.key   || "",
      model: e("QMD_CHAT_MODEL") || cfg.chat?.model || "google/gemini-2.5-flash",
      api:   resolveApi("QMD_CHAT_API", cfg.chat?.api),
    },
    rerank: {
      url:   e("QMD_RERANK_URL")   || cfg.rerank?.url   || "",
      key:   e("QMD_RERANK_KEY")   || cfg.rerank?.key   || "",
      model: e("QMD_RERANK_MODEL") || cfg.rerank?.model || "",
      api:   resolveApi("QMD_RERANK_API", cfg.rerank?.api),
    },
    timeout: 30_000,
  };
}

/** Returns true if any API provider is configured (env or config). */
export function hasApiProviders(cfg?: ProvidersConfig): boolean {
  // Env vars
  if (e("QMD_EMBED_URL") || e("QMD_CHAT_URL") || e("QMD_RERANK_URL")) return true;
  // Config
  if (cfg?.embed?.url || cfg?.chat?.url || cfg?.rerank?.url) return true;
  return false;
}

// =============================================================================
// HTTP
// =============================================================================

async function post<T>(
  url: string,
  body: Record<string, unknown>,
  key: string,
  timeout: number,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${url}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// =============================================================================
// ApiLLM
// =============================================================================

export class ApiLLM implements LLM {
  private p: ResolvedProviders;
  private disposed = false;

  constructor(config: ApiLLMConfig = {}) {
    this.p = resolve(config.providers);
  }

  get embedModelName(): string { return this.p.embed.model; }

  // ── Embed ───────────────────────────────────────────────

  async embed(text: string, options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
    if (this.disposed) return null;
    const { url, key, model, dims } = this.p.embed;
    try {
      const body: Record<string, unknown> = { model: options.model || model, input: text };
      if (dims) body.dimensions = dims;

      const data = await post<{
        data: Array<{ embedding: number[] }>;
        model: string;
      }>(`${url}/embeddings`, body, key, this.p.timeout);

      const vec = data.data?.[0]?.embedding;
      return vec ? { embedding: vec, model: data.model || model } : null;
    } catch (err) {
      console.error("embed error:", (err as Error).message);
      return null;
    }
  }

  async embedBatch(texts: string[], options: EmbedOptions = {}): Promise<(EmbeddingResult | null)[]> {
    if (this.disposed || !texts.length) return texts.map(() => null);
    const { url, key, model, dims } = this.p.embed;
    try {
      const body: Record<string, unknown> = { model: options.model || model, input: texts };
      if (dims) body.dimensions = dims;

      const data = await post<{
        data: Array<{ embedding: number[]; index: number }>;
        model: string;
      }>(`${url}/embeddings`, body, key, this.p.timeout);

      const sorted = (data.data || []).sort((a, b) => a.index - b.index);
      return texts.map((_, i) => {
        const item = sorted[i];
        return item?.embedding ? { embedding: item.embedding, model: data.model || model } : null;
      });
    } catch (err) {
      console.error("embedBatch error:", (err as Error).message);
      return Promise.all(texts.map(t => this.embed(t, options)));
    }
  }

  // ── Generate ────────────────────────────────────────────

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult | null> {
    if (this.disposed) return null;
    const { url, key, model, api } = this.p.chat;
    const useModel = options.model || model;

    try {
      if (api === "anthropic") {
        return await this.generateAnthropic(url, key, useModel, prompt, options);
      }
      return await this.generateOpenAI(url, key, useModel, prompt, options);
    } catch (err) {
      console.error("generate error:", (err as Error).message);
      return null;
    }
  }

  private async generateOpenAI(
    url: string, key: string, model: string, prompt: string, options: GenerateOptions,
  ): Promise<GenerateResult> {
    const data = await post<{
      choices: Array<{ message: { content: string } }>;
      model: string;
    }>(`${url}/chat/completions`, {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options.maxTokens || 150,
      temperature: options.temperature ?? 0.7,
    }, key, this.p.timeout);

    return {
      text: data.choices?.[0]?.message?.content || "",
      model: data.model || model,
      done: true,
    };
  }

  private async generateAnthropic(
    url: string, key: string, model: string, prompt: string, options: GenerateOptions,
  ): Promise<GenerateResult> {
    // Anthropic Messages API format
    // If URL already ends with /messages, use as-is
    // If URL ends with /anthropic (e.g. MiniMax CN), append /v1/messages
    // Otherwise append /messages
    const endpoint = url.endsWith("/messages") ? url
      : url.endsWith("/v1") ? `${url}/messages`
      : `${url}/v1/messages`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: options.maxTokens || 150,
        temperature: options.temperature ?? 0.7,
      }),
      signal: AbortSignal.timeout(this.p.timeout),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json() as {
      content: Array<{ type: string; text?: string }>;
      model: string;
    };

    const text = data.content
      ?.filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("") || "";

    return { text, model: data.model || model, done: true };
  }

  // ── Query Expansion ─────────────────────────────────────

  async expandQuery(
    query: string,
    options: { context?: string; intent?: string; includeLexical?: boolean } = {},
  ): Promise<Queryable[]> {
    if (this.disposed) return [{ type: "vec", text: query }];
    const { context, intent, includeLexical = true } = options;

    const system = [
      "You are a search query expansion engine.",
      "Given a query, generate 3-5 diverse sub-queries for different search backends.",
      "Output each on its own line: type: text",
      "Types: lex (keyword), vec (semantic), hyde (hypothetical document).",
      context ? `Context: ${context}` : "",
    ].filter(Boolean).join("\n");

    const user = intent
      ? `Expand this search query: ${query}\nQuery intent: ${intent}`
      : `Expand this search query: ${query}`;

    try {
      const result = await this.generate(`${system}\n\n${user}`, {
        maxTokens: 400,
        temperature: 0.7,
      });
      if (!result?.text) throw new Error("empty");

      const queryables: Queryable[] = [];
      for (const line of result.text.trim().split("\n")) {
        const i = line.indexOf(":");
        if (i === -1) continue;
        const type = line.slice(0, i).trim().toLowerCase();
        if (type !== "lex" && type !== "vec" && type !== "hyde") continue;
        const text = line.slice(i + 1).trim();
        if (text) queryables.push({ type: type as QueryType, text });
      }

      const filtered = includeLexical ? queryables : queryables.filter(q => q.type !== "lex");
      if (filtered.length > 0) return filtered;
    } catch { /* fallback */ }

    const fb: Queryable[] = [
      { type: "hyde", text: `Information about ${query}` },
      { type: "lex", text: query },
      { type: "vec", text: query },
    ];
    return includeLexical ? fb : fb.filter(q => q.type !== "lex");
  }

  // ── Rerank ──────────────────────────────────────────────

  async rerank(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions = {},
  ): Promise<RerankResult> {
    if (this.disposed || !documents.length) return { results: [], model: "" };
    const { url, key, model } = this.p.rerank;

    // No rerank provider configured → chat-based scoring
    if (!model || !url) return this.chatRerank(query, documents);

    try {
      const endpoint = url.endsWith("/rerank") ? url : `${url}/rerank`;
      const data = await post<{
        results: Array<{ index: number; relevance_score: number }>;
        model?: string;
      }>(endpoint, {
        model, query,
        documents: documents.map(d => d.text),
        top_n: documents.length,
      }, key, this.p.timeout);

      return {
        results: (data.results || [])
          .sort((a, b) => b.relevance_score - a.relevance_score)
          .map(r => ({ file: documents[r.index]?.file || "", score: r.relevance_score, index: r.index })),
        model: data.model || model,
      };
    } catch (err) {
      console.error("rerank error, falling back to chat:", (err as Error).message);
      return this.chatRerank(query, documents);
    }
  }

  /** Fallback: use chat model to score relevance */
  private async chatRerank(query: string, documents: RerankDocument[]): Promise<RerankResult> {
    const docList = documents
      .map((d, i) => `[${i}] ${d.title || d.file}: ${d.text.slice(0, 300)}`)
      .join("\n\n");

    try {
      const result = await this.generate(
        `Score each document's relevance to the query 0-10.\nOutput ONLY a JSON array, e.g. [8, 3, 9]\n\nQuery: ${query}\n\nDocuments:\n${docList}\n\nScores:`,
        { maxTokens: 100, temperature: 0 },
      );
      const match = result?.text?.match(/\[[\d\s,.]+\]/);
      if (!match) throw new Error("no array");

      const scores: number[] = JSON.parse(match[0]);
      return {
        results: documents
          .map((d, i) => ({ file: d.file, score: (scores[i] ?? 0) / 10, index: i }))
          .sort((a, b) => b.score - a.score),
        model: this.p.chat.model,
      };
    } catch {
      return {
        results: documents.map((d, i) => ({ file: d.file, score: 1 - i * 0.01, index: i })),
        model: "fallback",
      };
    }
  }

  // ── Utility ─────────────────────────────────────────────

  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }

  async dispose(): Promise<void> { this.disposed = true; }
}

// =============================================================================
// Session wrapper (matches LlamaCpp session interface)
// =============================================================================

export class ApiLLMSession implements ILLMSession {
  private llm: ApiLLM;
  private released = false;
  private ac: AbortController;

  constructor(llm: ApiLLM, options: LLMSessionOptions = {}) {
    this.llm = llm;
    this.ac = new AbortController();
    if (options.signal) {
      options.signal.addEventListener("abort", () => this.ac.abort(), { once: true });
    }
    if (options.maxDuration) {
      const t = setTimeout(() => this.ac.abort(), options.maxDuration);
      t.unref?.();
    }
  }

  get isValid(): boolean { return !this.released && !this.ac.signal.aborted; }
  get signal(): AbortSignal { return this.ac.signal; }

  async embed(text: string, options?: EmbedOptions) {
    return this.isValid ? this.llm.embed(text, options) : null;
  }
  async embedBatch(texts: string[], options?: EmbedOptions) {
    return this.isValid ? this.llm.embedBatch(texts, options) : texts.map(() => null);
  }
  async expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }) {
    return this.isValid ? this.llm.expandQuery(query, options) : [{ type: "vec" as const, text: query }];
  }
  async rerank(query: string, docs: RerankDocument[], options?: RerankOptions) {
    return this.isValid ? this.llm.rerank(query, docs, options) : { results: [], model: "" };
  }

  release(): void {
    this.released = true;
    this.ac.abort();
  }
}
