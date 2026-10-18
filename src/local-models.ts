/**
 * local-models.ts - QMD_NO_LOCAL_MODELS=1 turns local models off: no node-llama-cpp, no GGUF download, nothing loaded
 * or run on this machine. For hosts where a local model is never wanted (phones, battery-powered or small machines):
 * there, embedding, reranking, and query expansion come from remote API providers or not at all.
 *
 * Every way into the local runtime (`llm.js`) asks this first, and a refused one is an error that says so; QMD then
 * never selects, imports, downloads, or falls back to a local model.
 */

/** Whether local models may be used: unless QMD_NO_LOCAL_MODELS is 1. Any other value than 1, 0, or unset is an error. */
export function localModelsAllowed(value = process.env.QMD_NO_LOCAL_MODELS): boolean {
  if (value === undefined || value === "" || value === "0") return true;
  if (value === "1") return false;
  throw new Error(`QMD_NO_LOCAL_MODELS must be 1 or 0; got ${JSON.stringify(value)}`);
}

/** Throw when local models are off: what needed one, and how to get it remotely instead. */
export function requireLocalModels(what: string): void {
  if (!localModelsAllowed()) {
    throw new Error(
      `Local models are turned off (QMD_NO_LOCAL_MODELS=1), and ${what} would need one. ` +
      "Configure a remote API provider for it instead.",
    );
  }
}
