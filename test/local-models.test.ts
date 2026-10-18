/**
 * local-models.test.ts - QMD_NO_LOCAL_MODELS=1: no local model is ever selected, imported, or used; remote providers
 * still are.
 */
import { afterEach, describe, expect, test } from "vitest";
import { localModelsAllowed, requireLocalModels } from "../src/local-models.js";
import { selectConfiguredLlm } from "../src/llm-selection.js";
import { createStore } from "../src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const saved = process.env.QMD_NO_LOCAL_MODELS;

afterEach(() => {
  if (saved === undefined) delete process.env.QMD_NO_LOCAL_MODELS;
  else process.env.QMD_NO_LOCAL_MODELS = saved;
});

describe("QMD_NO_LOCAL_MODELS", () => {
  test("1 turns local models off; 0 or unset leaves them; anything else is an error", () => {
    expect(localModelsAllowed(undefined)).toBe(true);
    expect(localModelsAllowed("")).toBe(true);
    expect(localModelsAllowed("0")).toBe(true);
    expect(localModelsAllowed("1")).toBe(false);
    expect(() => localModelsAllowed("yes")).toThrow(/must be 1 or 0/);
  });

  test("with no remote provider, selection refuses before anything local is imported", async () => {
    process.env.QMD_NO_LOCAL_MODELS = "1";
    await expect(selectConfiguredLlm(undefined)).rejects.toThrow(/Local models are turned off/);
    expect(() => requireLocalModels("this")).toThrow(/QMD_NO_LOCAL_MODELS=1/);
  });

  test("a remote provider is still selected", async () => {
    process.env.QMD_NO_LOCAL_MODELS = "1";
    const selected = await selectConfiguredLlm({ embed: { url: "http://127.0.0.1:9", model: "remote" } } as never);
    expect(selected.mode).toBe("api");
  });

  test("a store with no provider does not open on local models", async () => {
    process.env.QMD_NO_LOCAL_MODELS = "1";
    const dir = await mkdtemp(join(tmpdir(), "qmd-no-local-"));
    try {
      await expect(createStore({ dbPath: join(dir, "index.sqlite"), config: { collections: {} } })).rejects.toThrow(
        /Local models are turned off/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
