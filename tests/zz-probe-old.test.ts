import { describe, it } from "vitest";
import { extractMetadata } from "../src/core/metadata-extractor.OLD";

describe("OLD behavior baseline", () => {
  it("merge-conflict markers between title and tags (OLD)", () => {
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
    console.log("OLD merge-conflict tags:", extractMetadata(md).tags);
  });
  it("prose before tags line (OLD)", () => {
    const md = [
      "---",
      "Random opening prose that is not YAML at all",
      "tags: secret",
      "body",
    ].join("\n");
    console.log("OLD prose-before-tags tags:", extractMetadata(md).tags);
  });
});
