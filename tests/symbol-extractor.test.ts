import { describe, it, expect } from "vitest";
import { MAX_SYMBOLS_PER_CHUNK, extractSymbols } from "../src/core/symbol-extractor";

function fenced(code: string, lang = "ts"): string {
  return `Some prose.\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\nMore prose.`;
}

describe("extractSymbols", () => {
  it("finds the declaration forms that mean the same thing across languages", () => {
    expect(extractSymbols(fenced("export function resolveInVault(root: string) {}"))).toContain(
      "resolveInVault",
    );
    expect(extractSymbols(fenced("class MemoryWriter {}"))).toContain("MemoryWriter");
    expect(extractSymbols(fenced("interface VaultAdapter {}"))).toContain("VaultAdapter");
    expect(extractSymbols(fenced("type SupersessionOutcome = string;"))).toContain(
      "SupersessionOutcome",
    );
    expect(extractSymbols(fenced("def chunk_markdown(text):", "python"))).toContain(
      "chunk_markdown",
    );
    expect(extractSymbols(fenced("fn parse_ref(raw: &str) -> Ref {}", "rust"))).toContain(
      "parse_ref",
    );
    expect(extractSymbols(fenced("func (r *Repo) Save(x int) {}", "go"))).toContain("Save");
    expect(extractSymbols(fenced("const applyFilters = (a) => a;"))).toContain("applyFilters");
  });

  it("ignores prose that merely contains a declaration keyword", () => {
    // Treating prose as declarations would put a symbol on nearly every chunk,
    // which is the same as putting one on none.
    expect(extractSymbols("We decided the class of errors to handle is narrow.")).toEqual([]);
    expect(extractSymbols("The function of the inbox is review, not storage.")).toEqual([]);
  });

  it("does not make a symbol of every assignment", () => {
    // A const bound to a value is a local, not an API. Indexing those would
    // drown the real declarations.
    expect(extractSymbols(fenced("const maxChars = 12000;"))).toEqual([]);
    expect(extractSymbols(fenced("let count = items.length;"))).toEqual([]);
    // Bound to something callable, it is a declaration again.
    expect(extractSymbols(fenced("const build = function () {};"))).toContain("build");
  });

  it("skips the fence delimiter's language tag", () => {
    expect(extractSymbols(fenced("x", "typescript"))).toEqual([]);
  });

  it("deduplicates and caps what one chunk can contribute", () => {
    const many = Array.from({ length: 100 }, (_, i) => `function f${i}() {}`).join("\n");
    expect(extractSymbols(fenced(many)).length).toBe(MAX_SYMBOLS_PER_CHUNK);

    const repeated = "function same() {}\nfunction same() {}";
    expect(extractSymbols(fenced(repeated))).toEqual(["same"]);
  });

  it("costs nothing for a chunk with no code at all", () => {
    expect(extractSymbols("Just prose, no fences anywhere in this chunk.")).toEqual([]);
  });

  it("is not confused by a mismatched inner fence marker", () => {
    // ``` inside a ~~~ block is content, so what follows is still fenced.
    const doc = "~~~\n```\nfunction stillInside() {}\n~~~";
    expect(extractSymbols(doc)).toContain("stillInside");
  });
});
