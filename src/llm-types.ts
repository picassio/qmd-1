/**
 * llm-types.ts — Types, interfaces, and pure functions for the LLM abstraction layer.
 *
 * This module has NO dependency on node-llama-cpp. It provides:
 * - All LLM-related type definitions (LLM interface, ILLMSession, etc.)
 * - Embedding formatting functions (formatQueryForEmbedding, formatDocForEmbedding)
 * - Generic LLM session wrapper (withLLMSessionForLlm)
 * - Default LLM singleton management
 *
 * The node-llama-cpp-dependent implementation (LlamaCpp class) stays in llm.ts
 * and is lazy-loaded only when local GGUF models are needed.
 */

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_EMBED_MODEL_NAME = "embeddinggemma";
export const DEFAULT_EMBED_MODEL_URI = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
export const DEFAULT_RERANK_MODEL_URI = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
export const DEFAULT_GENERATE_MODEL_URI = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

// =============================================================================
// Embedding Formatting Functions
// =============================================================================

/**
 * Detect if a model URI uses the Qwen3-Embedding format.
 */
export function isQwen3EmbeddingModel(modelUri: string): boolean {
  return /qwen.*embed/i.test(modelUri) || /embed.*qwen/i.test(modelUri);
}

/**
 * Format a query for embedding.
 */
export function formatQueryForEmbedding(query: string, modelUri?: string): string {
  const uri = modelUri ?? process.env.QMD_EMBED_MODEL ?? DEFAULT_EMBED_MODEL_NAME;
  if (isQwen3EmbeddingModel(uri)) {
    return `Instruct: Retrieve relevant documents for the given query\nQuery: ${query}`;
  }
  return `task: search result | query: ${query}`;
}

/**
 * Format a document for embedding.
 */
export function formatDocForEmbedding(text: string, title?: string, modelUri?: string): string {
  const uri = modelUri ?? process.env.QMD_EMBED_MODEL ?? DEFAULT_EMBED_MODEL_NAME;
  if (isQwen3EmbeddingModel(uri)) {
    return title ? `${title}\n${text}` : text;
  }
  return `title: ${title || "none"} | text: ${text}`;
}

// =============================================================================
// Types
// =============================================================================

export type TokenLogProb = {
  token: string;
  logprob: number;
};

export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

export type GenerateResult = {
  text: string;
  model: string;
  logprobs?: TokenLogProb[];
  done: boolean;
};

export type RerankDocumentResult = {
  file: string;
  score: number;
  index: number;
};

export type RerankResult = {
  results: RerankDocumentResult[];
  model: string;
};

export type ModelInfo = {
  name: string;
  exists: boolean;
  path?: string;
};

export type EmbedOptions = {
  model?: string;
  isQuery?: boolean;
  title?: string;
};

export type GenerateOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type RerankOptions = {
  model?: string;
};

export type LLMSessionOptions = {
  maxDuration?: number;
  signal?: AbortSignal;
  name?: string;
};

export interface ILLMSession {
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]>;
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
  readonly isValid: boolean;
  readonly signal: AbortSignal;
}

export type QueryType = 'lex' | 'vec' | 'hyde';

export type Queryable = {
  type: QueryType;
  text: string;
};

export type RerankDocument = {
  file: string;
  text: string;
  title?: string;
};

// =============================================================================
// LLM Interface
// =============================================================================

export interface LLM {
  readonly embedModelName: string;
  /** Optional lossless tokenizer capability used by remote/local chunking. */
  tokenize?(text: string): Promise<readonly any[]>;
  detokenize?(tokens: readonly any[]): Promise<string>;
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;
  modelExists(model: string): Promise<ModelInfo>;
  expandQuery(query: string, options?: { context?: string; intent?: string; includeLexical?: boolean }): Promise<Queryable[]>;
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
  dispose(): Promise<void>;
}

// =============================================================================
// Generic LLM Session Wrapper (no node-llama-cpp dependency)
// =============================================================================

/**
 * Execute a function with a scoped LLM session.
 * For LLM implementations that don't need complex session management (e.g. ApiLLM),
 * this creates a simple wrapper with abort support.
 *
 * For LlamaCpp, callers should use the LlamaCpp-specific session management
 * from llm.ts which handles context pooling and model lifecycle.
 */
export async function withLLMSessionGeneric<T>(
  llm: LLM,
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options?.maxDuration) {
    timer = setTimeout(() => ac.abort(), options.maxDuration);
    timer.unref?.();
  }
  if (options?.signal) {
    options.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const session: ILLMSession = {
    get isValid() { return !ac.signal.aborted; },
    get signal() { return ac.signal; },
    embed: (text, opts) => llm.embed(text, opts),
    embedBatch: (texts, opts) => llm.embedBatch(texts, opts),
    expandQuery: (query, opts) => llm.expandQuery(query, opts),
    rerank: (query, docs, opts) => llm.rerank(query, docs, opts),
  };
  try {
    return await fn(session);
  } finally {
    if (timer) clearTimeout(timer);
    ac.abort();
  }
}

// =============================================================================
// Default LLM Singleton (no node-llama-cpp dependency)
// =============================================================================

/** Lazy loader for LlamaCpp — set by llm.ts when it's imported */
let llamaCppLoader: (() => LLM | Promise<LLM>) | null = null;

/** Generic LLM singleton (can be ApiLLM or LlamaCpp) */
let defaultLlm: LLM | null = null;

/**
 * Register a lazy loader for the LlamaCpp singleton.
 * Called by llm.ts at import time.
 */
export function registerLlamaCppLoader(loader: () => LLM | Promise<LLM>): void {
  llamaCppLoader = loader;
}

/**
 * Set a generic LLM instance (ApiLLM or LlamaCpp).
 */
export function setDefaultLlm(llm: LLM | null): void {
  defaultLlm = llm;
}

/**
 * Get the default LLM. Returns the generic LLM if set.
 * If no LLM is set and no LlamaCpp loader registered, throws.
 */
export function getDefaultLlm(): LLM {
  if (defaultLlm) return defaultLlm;
  if (llamaCppLoader) {
    const loaded = llamaCppLoader();
    if (!(loaded instanceof Promise)) {
      defaultLlm = loaded;
      return defaultLlm;
    }
  }
  throw new Error(
    "No LLM configured. Set API providers in ~/.config/qmd/index.yml " +
    "or ensure node-llama-cpp is available for local models."
  );
}

/**
 * Get the default LLM, loading LlamaCpp lazily if needed.
 */
export async function getOrCreateDefaultLlm(): Promise<LLM> {
  if (defaultLlm) return defaultLlm;
  if (llamaCppLoader) {
    defaultLlm = await llamaCppLoader();
    return defaultLlm;
  }
  throw new Error(
    "No LLM configured. Set API providers in ~/.config/qmd/index.yml " +
    "or ensure node-llama-cpp is available for local models."
  );
}

/**
 * Dispose the default LLM instance.
 */
export async function disposeDefaultLlm(): Promise<void> {
  if (defaultLlm) {
    await defaultLlm.dispose();
    defaultLlm = null;
  }
}
