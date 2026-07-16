/** Native-free LLM selection and session routing. */
import { ApiLLM, hasApiProviders } from "./llm-api.js";
import { RemoteLLM } from "./remote-llm.js";
import {
  withLLMSessionGeneric,
  type ILLMSession,
  type LLM,
  type LLMSessionOptions,
} from "./llm-types.js";
import type { ProvidersConfig } from "./collections.js";

export type LlmMode = "agent-board" | "api" | "local";

export type SelectedLlm = {
  llm: LLM;
  mode: LlmMode;
};

export type LocalModelConfig = {
  embed?: string;
  generate?: string;
  rerank?: string;
};

export type LocalRuntimeOptions = {
  inactivityTimeoutMs?: number;
  disposeModelsOnInactivity?: boolean;
};

export function compatibilityMode(): "agent-board" | null {
  const mode = process.env.QMD_COMPAT_MODE ?? "";
  if (mode === "") return null;
  if (mode === "agent-board") return mode;
  throw new Error(
    `Unknown QMD_COMPAT_MODE "${mode}". Supported compatibility mode: agent-board. ` +
    "Unset QMD_COMPAT_MODE to use ordinary qmd-engine behavior.",
  );
}

/** Select compatibility/API modes without loading the local runtime. */
export function selectNonLocalLlm(providers?: ProvidersConfig): SelectedLlm | null {
  if (compatibilityMode() === "agent-board") {
    return { llm: new RemoteLLM(), mode: "agent-board" };
  }
  if (hasApiProviders(providers)) {
    return { llm: new ApiLLM({ providers }), mode: "api" };
  }
  return null;
}

/** Full selection. The local-only module is reached solely through dynamic import. */
export async function selectConfiguredLlm(
  providers?: ProvidersConfig,
  models?: LocalModelConfig,
  localOptions: LocalRuntimeOptions = {},
): Promise<SelectedLlm> {
  const nonLocal = selectNonLocalLlm(providers);
  if (nonLocal) return nonLocal;

  try {
    const { LlamaCpp } = await import("./llm.js");
    return {
      mode: "local",
      llm: new LlamaCpp({
        embedModel: models?.embed,
        generateModel: models?.generate,
        rerankModel: models?.rerank,
        ...localOptions,
      }),
    };
  } catch (error) {
    throw new Error(
      "Local GGUF mode requires the optional peer dependency node-llama-cpp, which is not installed. " +
      "Either configure remote API providers, set QMD_COMPAT_MODE=agent-board, inject StoreOptions.llm, " +
      "or install node-llama-cpp to use local models. " +
      `(${(error as Error).message})`,
    );
  }
}

export async function withSelectedLlmSession<T>(
  selected: SelectedLlm,
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions,
): Promise<T> {
  if (selected.mode === "local") {
    const { withLLMSessionForLlm } = await import("./llm.js");
    return withLLMSessionForLlm(selected.llm, fn, options);
  }
  return withLLMSessionGeneric(selected.llm, fn, options);
}
