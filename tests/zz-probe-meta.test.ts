import { describe, it, expect } from "vitest";
import { extractMetadata } from "../src/core/metadata-extractor";

function tagsOf(md: string) {
  return extractMetadata(md).tags;
}

describe("probe fail-open shapes", () => {
  it("unterminated fm: git merge-conflict markers between title and tags", () => {
    const md = [
      "---",
      "title: My note",
      "<<<<<<< HEAD",
      "tags: private, work",
      "=======",
      "tags: public",
      ">>>>>>> other",
      "body text",
    ].join("\n");
    console.log("merge-conflict tags:", tagsOf(md));
  });

  it("unterminated fm: prose before tags line", () => {
    const md = [
      "---",
      "Random opening prose that is not YAML at all",
      "tags: secret",
      "body",
    ].join("\n");
    console.log("prose-before-tags tags:", tagsOf(md));
  });

  it("unterminated fm: indented nested key before tags (no sawKey yet)", () => {
    const md = [
      "---",
      "  nested: value",
      "tags: secret",
      "body",
    ].join("\n");
    console.log("indented-first tags:", tagsOf(md));
  });

  it("unterminated fm: blank line then tags", () => {
    const md = [
      "---",
      "",
      "tags: secret",
      "body",
    ].join("\n");
    console.log("blank-first tags:", tagsOf(md));
  });

  it("unterminated fm: comment then tags", () => {
    const md = [
      "---",
      "# a comment",
      "tags: secret",
      "body",
    ].join("\n");
    console.log("comment-first tags:", tagsOf(md));
  });

  it("unterminated fm: tags then stray unindented line then more tags-like line", () => {
    const md = [
      "---",
      "tags: private",
      "aliases",
      "  - foo",
      "body",
    ].join("\n");
    console.log("tags-then-stray tags:", tagsOf(md), extractMetadata(md).aliases);
  });

  it("terminated fm: comment line inside normal frontmatter doesn't break parsing (baseline)", () => {
    const md = [
      "---",
      "title: t",
      "# a comment inside fm",
      "tags: secret",
      "---",
      "body",
    ].join("\n");
    console.log("terminated-with-comment tags:", tagsOf(md));
  });

  it("BOM before fence", () => {
    const md = "﻿" + ["---", "tags: secret", "---", "body"].join("\n");
    console.log("BOM tags:", tagsOf(md));
  });

  it("CRLF unterminated with conflict markers", () => {
    const md = [
      "---",
      "title: My note",
      "<<<<<<< HEAD",
      "tags: private, work",
      "body",
    ].join("\r\n");
    console.log("CRLF merge tags:", tagsOf(md));
  });
});
