import { describe, it, expect } from "vitest";
import { extractMetadata } from "../src/core/metadata-extractor";

describe("probe realistic merge-conflict with BOTH fences present", () => {
  it("terminated fm containing conflict markers still parses tags", () => {
    const md = [
      "---",
      "title: My note",
      "<<<<<<< HEAD",
      "tags: private, work",
      "=======",
      "tags: public",
      ">>>>>>> other",
      "---",
      "body text",
    ].join("\n");
    console.log("terminated-conflict tags:", extractMetadata(md).tags);
  });

  it("unterminated: EOF right after tags with truncated write cutting mid next key (realistic truncation)", () => {
    const md = [
      "---",
      "title: My note",
      "tags: private",
    ].join("\n");
    console.log("truncated-after-tags:", extractMetadata(md).tags);
  });

  it("unterminated: truncated mid-write cuts BEFORE tags line (tags never written)", () => {
    const md = [
      "---",
      "title: My note",
    ].join("\n");
    console.log("truncated-before-tags:", extractMetadata(md).tags);
  });

  it("unterminated: YAML block comment above tags at top (##)", () => {
    const md = [
      "---",
      "## not a key, doubled hash comment",
      "tags: secret",
    ].join("\n");
    console.log("double-hash-comment tags:", extractMetadata(md).tags);
  });

  it("unterminated: tab-indented continuation line before sawKey", () => {
    const md = [
      "---",
      "\tsome: nested",
      "tags: secret",
    ].join("\n");
    console.log("tab-indented-first tags:", extractMetadata(md).tags);
  });
});
