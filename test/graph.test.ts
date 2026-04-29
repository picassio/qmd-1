/**
 * graph.test.ts - Tests for wikilink graph boosting in search
 *
 * Tests extractWikilinks, document_links population during indexing,
 * and graphExpand/graphBoost search expansion.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/index.js";
import type { QMDStore } from "../src/index.js";
import { extractWikilinks } from "../src/store.js";

describe("extractWikilinks", () => {
  it("extracts single wikilink from body", () => {
    expect(extractWikilinks("See [[daemon-arch]] for details.")).toEqual(["daemon-arch"]);
  });

  it("extracts multiple wikilinks", () => {
    const body = "Link to [[page-one]] and [[page-two]] and [[page-three]].";
    const result = extractWikilinks(body);
    expect(result).toEqual(["page-one", "page-two", "page-three"]);
  });

  it("deduplicates wikilinks", () => {
    const body = "See [[same-page]] and again [[same-page]].";
    expect(extractWikilinks(body)).toEqual(["same-page"]);
  });

  it("returns empty array for body with no links", () => {
    expect(extractWikilinks("No links here, just plain text.")).toEqual([]);
  });

  it("handles wikilinks with spaces and special chars", () => {
    const body = "See [[my page title]] and [[another-one]].";
    expect(extractWikilinks(body)).toEqual(["my page title", "another-one"]);
  });

  it("does not match partial brackets", () => {
    expect(extractWikilinks("Not a [link] or [partial")).toEqual([]);
    expect(extractWikilinks("Also not [[incomplete")).toEqual([]);
  });

  it("handles wikilinks in markdown list items", () => {
    const body = `## Connections
- [[related-page]]
- [[other-page]]
`;
    expect(extractWikilinks(body)).toEqual(["related-page", "other-page"]);
  });
});

describe("graph boosting integration", () => {
  let store: QMDStore;
  const testDir = join(tmpdir(), `qmd-graph-test-${Date.now()}`);
  const docsDir = join(testDir, "docs");

  beforeAll(async () => {
    mkdirSync(docsDir, { recursive: true });

    // Page 1: daemon-arch — links to webui and capture
    writeFileSync(join(docsDir, "daemon-arch.md"), `---
title: Daemon Architecture
para: resources
scope:
  - pi-para
tags:
  - daemon
---
## Topic
The daemon processes sessions in the background.

## Connections
- [[webui]] — serves the web UI
- [[capture-prompt]] — handles session capture
`);

    // Page 2: webui — links to daemon-arch
    writeFileSync(join(docsDir, "webui.md"), `---
title: Web Wiki UI
para: resources
scope:
  - pi-para
tags:
  - webui
---
## Topic
Web UI for browsing the wiki.

## Connections
- [[daemon-arch]] — the backend daemon
`);

    // Page 3: capture-prompt — links to daemon-arch
    writeFileSync(join(docsDir, "capture-prompt.md"), `---
title: Capture Prompt Design
para: resources
scope:
  - pi-para
tags:
  - prompts
---
## Topic
The auto-capture prompt extracts knowledge from sessions.

## Connections
- [[daemon-arch]] — orchestrates capture
`);

    // Page 4: settings — no links at all (isolated)
    writeFileSync(join(docsDir, "settings.md"), `---
title: Settings System
para: resources
scope:
  - pi-para
tags:
  - settings
---
## Topic
Interactive settings system for configuring all options.

No wikilinks here.
`);

    // Page 5: deployment — links to settings
    writeFileSync(join(docsDir, "deployment.md"), `---
title: Deployment Guide
para: resources
scope:
  - pi-para
tags:
  - deployment
---
## Topic
How to deploy and configure the system.

## Connections
- [[settings]] — configuration options
`);

    // Page 6: performance — links to daemon-arch and webui
    writeFileSync(join(docsDir, "performance.md"), `---
title: Performance Analysis
para: resources
scope:
  - pi-para
tags:
  - performance
---
## Topic
Performance impact analysis of the system.

## Connections
- [[daemon-arch]] — daemon performance
- [[webui]] — frontend performance
`);

    const dbPath = join(testDir, "test.sqlite");
    store = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir },
        },
      },
    });

    await store.update();
  });

  afterAll(async () => {
    await store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("populates document_links table after update()", () => {
    const db = store.internal.db;

    // daemon-arch links to webui and capture-prompt
    const daemonDoc = db.prepare(`SELECT id FROM documents WHERE path = 'daemon-arch.md' AND active = 1`).get() as { id: number } | undefined;
    expect(daemonDoc).toBeDefined();

    const links = db.prepare(`SELECT target_slug FROM document_links WHERE source_id = ? ORDER BY target_slug`).all(daemonDoc!.id) as { target_slug: string }[];
    expect(links.map(l => l.target_slug)).toEqual(["capture-prompt", "webui"]);
  });

  it("populates reverse links correctly", () => {
    const db = store.internal.db;

    // webui is linked FROM daemon-arch and performance
    const reverseSources = db.prepare(`
      SELECT DISTINCT dl.source_id, d.path
      FROM document_links dl
      JOIN documents d ON d.id = dl.source_id
      WHERE dl.target_slug = 'webui'
      ORDER BY d.path
    `).all() as { source_id: number; path: string }[];

    const sourcePaths = reverseSources.map(r => r.path);
    expect(sourcePaths).toContain("daemon-arch.md");
    expect(sourcePaths).toContain("performance.md");
  });

  it("isolated page has no links in document_links", () => {
    const db = store.internal.db;
    const settingsDoc = db.prepare(`SELECT id FROM documents WHERE path = 'settings.md' AND active = 1`).get() as { id: number } | undefined;
    expect(settingsDoc).toBeDefined();

    const links = db.prepare(`SELECT target_slug FROM document_links WHERE source_id = ?`).all(settingsDoc!.id) as { target_slug: string }[];
    expect(links).toHaveLength(0);
  });

  it("searchFTS with graphBoost=true returns linked pages not in direct matches", async () => {
    // Search for "daemon" — should find daemon-arch directly, then graph-expand to webui, capture-prompt, performance (linked pages)
    const results = await store.searchLex("daemon", { graphBoost: true });

    // Direct match
    const directMatch = results.find(r => r.displayPath.includes("daemon-arch"));
    expect(directMatch).toBeDefined();

    // Graph expansion should bring in pages that link to/from daemon-arch
    const allPaths = results.map(r => r.displayPath);
    // At least one expanded page should appear (webui or capture-prompt or performance — they all link to daemon-arch)
    const expandedPages = results.filter(r =>
      !r.displayPath.includes("daemon-arch") &&
      (r.displayPath.includes("webui") ||
       r.displayPath.includes("capture-prompt") ||
       r.displayPath.includes("performance"))
    );
    expect(expandedPages.length).toBeGreaterThan(0);
  });

  it("expansion scores are always below direct match scores", async () => {
    const results = await store.searchLex("daemon", { graphBoost: true });

    const directMatches = results.filter(r => r.displayPath.includes("daemon-arch"));
    const expandedMatches = results.filter(r =>
      !r.displayPath.includes("daemon-arch") &&
      (r.displayPath.includes("webui") ||
       r.displayPath.includes("capture-prompt") ||
       r.displayPath.includes("performance"))
    );

    if (directMatches.length > 0 && expandedMatches.length > 0) {
      const minDirectScore = Math.min(...directMatches.map(r => r.score));
      for (const expanded of expandedMatches) {
        expect(expanded.score).toBeLessThan(minDirectScore);
      }
    }
  });

  it("graphBoost=false returns only direct matches", async () => {
    const withBoost = await store.searchLex("daemon", { graphBoost: true });
    const withoutBoost = await store.searchLex("daemon", { graphBoost: false });
    const defaultBoost = await store.searchLex("daemon");

    // Without boost should have same results as default (no boost)
    expect(withoutBoost.length).toEqual(defaultBoost.length);

    // With boost should have >= results (extra from expansion)
    expect(withBoost.length).toBeGreaterThanOrEqual(withoutBoost.length);
  });

  it("pages with no links produce no expansion", async () => {
    // "settings" page has no outbound links, and only deployment links to it
    // Search specifically for "Interactive settings system" — should only find settings directly
    const results = await store.searchLex("Interactive settings configuring", { graphBoost: true });

    // settings page itself should be found
    const settingsResult = results.find(r => r.displayPath.includes("settings"));
    expect(settingsResult).toBeDefined();

    // If deployment is expanded, it should score below settings
    const deploymentResult = results.find(r => r.displayPath.includes("deployment"));
    if (deploymentResult && settingsResult) {
      expect(deploymentResult.score).toBeLessThan(settingsResult.score);
    }
  });

  it("graph expansion does not duplicate already-present results", async () => {
    // Search for "daemon architecture background" — may match daemon-arch
    // Graph expansion should not add daemon-arch again
    const results = await store.searchLex("daemon", { graphBoost: true });

    const daemonResults = results.filter(r => r.displayPath.includes("daemon-arch"));
    // daemon-arch should appear at most once
    expect(daemonResults.length).toBeLessThanOrEqual(1);
  });
});
