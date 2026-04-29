import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/index.js";
import type { QMDStore } from "../src/index.js";

describe("frontmatter metadata search", () => {
  let store: QMDStore;
  const testDir = join(tmpdir(), `qmd-fm-test-${Date.now()}`);
  const docsDir = join(testDir, "docs");

  beforeAll(async () => {
    mkdirSync(docsDir, { recursive: true });

    // Create test wiki pages with frontmatter
    writeFileSync(join(docsDir, "daemon.md"), `---
title: Daemon Architecture
para: resources
scope:
  - pi-para
tags:
  - daemon
  - architecture
---
## Topic
The daemon processes sessions in the background.

## Key Facts
- Runs as systemd service
- Uses LLM for capture
`);

    writeFileSync(join(docsDir, "webui.md"), `---
title: Web Wiki UI
para: resources
scope:
  - pi-para
tags:
  - webui
  - frontend
---
## Topic
Web UI for browsing the wiki.

## Key Facts
- React SPA
- D3 graph view
`);

    writeFileSync(join(docsDir, "gepa.md"), `---
title: GEPA Metrics
para: resources
scope:
  - agent-board
tags:
  - metrics
  - optimization
---
## Topic
GEPA scoring metrics for agent evaluation.

## Key Facts
- 6 weighted sub-scores
- Fast local evaluator
`);

    writeFileSync(join(docsDir, "vm-setup.md"), `---
title: VM Setup
para: areas
scope:
  - global
tags:
  - infrastructure
  - deployment
---
## Topic
Development VM configuration.
`);

    // Page without frontmatter
    writeFileSync(join(docsDir, "plain.md"), `# Plain Page
No frontmatter here. Just a regular markdown file about daemon operations.
`);

    store = await createStore({
      dbPath: join(testDir, "test.sqlite"),
      config: {
        collections: { wiki: { path: docsDir } },
      },
    });

    await store.update();
  });

  afterAll(async () => {
    if (store) await store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("indexes frontmatter title correctly", async () => {
    const results = await store.searchLex("daemon architecture", { limit: 5, collection: "wiki" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Daemon Architecture");
  });

  it("searches without metadata filter (baseline)", async () => {
    const results = await store.searchLex("daemon", { limit: 10, collection: "wiki" });
    // Should find both daemon.md and plain.md (mentions daemon)
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by scope", async () => {
    const results = await store.searchLex("topic", { limit: 10, collection: "wiki", metadata: { scope: "pi-para" } });
    // Should only find pi-para scoped pages
    expect(results.length).toBe(2); // daemon + webui
    const scopes = results.map(r => r.displayPath);
    expect(scopes).not.toContain(expect.stringContaining("gepa"));
    expect(scopes).not.toContain(expect.stringContaining("vm-setup"));
  });

  it("filters by tag", async () => {
    const results = await store.searchLex("topic", { limit: 10, collection: "wiki", metadata: { tag: "architecture" } });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Daemon Architecture");
  });

  it("filters by category", async () => {
    const results = await store.searchLex("topic", { limit: 10, collection: "wiki", metadata: { category: "areas" } });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("VM Setup");
  });

  it("combines scope + tag filter", async () => {
    const results = await store.searchLex("topic", { limit: 10, collection: "wiki", metadata: { scope: "pi-para", tag: "webui" } });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Web Wiki UI");
  });

  it("returns empty for non-matching filter", async () => {
    const results = await store.searchLex("topic", { limit: 10, collection: "wiki", metadata: { scope: "nonexistent" } });
    expect(results.length).toBe(0);
  });

  it("plain files without frontmatter are still searchable", async () => {
    const results = await store.searchLex("plain page", { limit: 5, collection: "wiki" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Plain Page");
  });

  it("plain files are excluded by metadata filter", async () => {
    // plain.md has no frontmatter → no metadata → excluded by scope filter
    const results = await store.searchLex("daemon operations", { limit: 5, collection: "wiki", metadata: { scope: "pi-para" } });
    const paths = results.map(r => r.displayPath);
    expect(paths).not.toContain(expect.stringContaining("plain"));
  });
});
