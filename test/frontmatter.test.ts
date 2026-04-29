import { describe, it, expect } from "vitest";
import { parseFrontmatterFromContent } from "../src/store.js";

describe("parseFrontmatterFromContent", () => {
  it("parses standard wiki frontmatter", () => {
    const content = `---
title: My Page Title
para: resources
scope:
  - pi-para
  - qmd
tags:
  - architecture
  - daemon
links:
  - other-page
  - another-page
created: "2026-04-28"
updated: "2026-04-28"
---
## Topic
This is the body content.

## Key Facts
- Fact 1
- Fact 2`;

    const { frontmatter, body } = parseFrontmatterFromContent(content);

    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.title).toBe("My Page Title");
    expect(frontmatter!.category).toBe("resources");
    expect(frontmatter!.scope).toEqual(["pi-para", "qmd"]);
    expect(frontmatter!.tags).toEqual(["architecture", "daemon"]);
    expect(frontmatter!.links).toEqual(["other-page", "another-page"]);

    // Body should not contain frontmatter
    expect(body).not.toContain("---");
    expect(body).toContain("## Topic");
    expect(body).toContain("This is the body content.");
  });

  it("returns null frontmatter for content without frontmatter", () => {
    const content = `# Just a heading
Some body text.`;

    const { frontmatter, body } = parseFrontmatterFromContent(content);

    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  it("handles quoted values", () => {
    const content = `---
title: "Quoted Title"
para: 'areas'
---
Body`;

    const { frontmatter } = parseFrontmatterFromContent(content);

    expect(frontmatter!.title).toBe("Quoted Title");
    expect(frontmatter!.category).toBe("areas");
  });

  it("handles empty arrays", () => {
    const content = `---
title: Test
scope:
tags:
---
Body`;

    const { frontmatter } = parseFrontmatterFromContent(content);

    expect(frontmatter!.title).toBe("Test");
    // Empty arrays (key: followed by no items) should result in empty arrays
    expect(frontmatter!.scope).toEqual([]);
    expect(frontmatter!.tags).toEqual([]);
  });

  it("handles frontmatter with only title", () => {
    const content = `---
title: Simple Page
---
Content here.`;

    const { frontmatter, body } = parseFrontmatterFromContent(content);

    expect(frontmatter!.title).toBe("Simple Page");
    expect(frontmatter!.scope).toBeUndefined();
    expect(frontmatter!.tags).toBeUndefined();
    expect(body).toBe("Content here.");
  });

  it("strips leading newlines from body", () => {
    const content = `---
title: Test
---


Body starts here.`;

    const { body } = parseFrontmatterFromContent(content);

    expect(body).toBe("Body starts here.");
  });

  it("maps 'para' field to category", () => {
    const content = `---
para: archives
---
Old content.`;

    const { frontmatter } = parseFrontmatterFromContent(content);
    expect(frontmatter!.category).toBe("archives");
  });

  it("ignores unknown fields", () => {
    const content = `---
title: Known
unknown_field: some value
custom: data
scope:
  - pi-para
---
Body`;

    const { frontmatter } = parseFrontmatterFromContent(content);

    expect(frontmatter!.title).toBe("Known");
    expect(frontmatter!.scope).toEqual(["pi-para"]);
    // Unknown fields should not appear
    expect((frontmatter as any).unknown_field).toBeUndefined();
    expect((frontmatter as any).custom).toBeUndefined();
  });
});
