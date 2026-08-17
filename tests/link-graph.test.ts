import { describe, it, expect } from "vitest";
import { linkKey, relatedNotes } from "../src/indexing/link-graph";
import { IndexedChunk } from "../src/indexing/index-manager";

function chunk(notePath: string, links: string[], id = notePath): IndexedChunk {
  return {
    id,
    notePath,
    heading: "",
    headingPath: [],
    text: "",
    startLine: 0,
    endLine: 0,
    tags: [],
    aliases: [],
    links,
    mtime: 1000,
  };
}

describe("linkKey", () => {
  it("reduces a target to its lowercased basename without .md", () => {
    expect(linkKey("Notes/Foo.md")).toBe("foo");
    expect(linkKey("Bar")).toBe("bar");
    expect(linkKey("path/to/Baz.md")).toBe("baz");
  });

  it("strips anchors and aliases", () => {
    expect(linkKey("Note#Heading")).toBe("note");
    expect(linkKey("note.md#Section")).toBe("note");
    expect(linkKey("Name|alias")).toBe("name");
  });
});

describe("relatedNotes", () => {
  const corpus: IndexedChunk[] = [
    chunk("Notes/a.md", ["B"]), // a -> b (wikilink basename)
    chunk("Notes/b.md", ["a"]), // b -> a
    chunk("Notes/c.md", ["Notes/a.md"]), // c -> a (markdown path)
    chunk("Notes/d.md", []), // isolated
  ];

  it("resolves forward links (linksTo) by basename to indexed notes", () => {
    expect(relatedNotes("Notes/a.md", corpus).linksTo).toEqual(["Notes/b.md"]);
  });

  it("serves fresh results for a new chunks array (graph cache keys on array identity)", () => {
    const first = [chunk("Notes/a.md", ["B"]), chunk("Notes/b.md", [])];
    expect(relatedNotes("Notes/a.md", first).linksTo).toEqual(["Notes/b.md"]);
    // Same array again → served from the cached graph, same answer.
    expect(relatedNotes("Notes/a.md", first).linksTo).toEqual(["Notes/b.md"]);
    // A refresh that changes anything swaps in a NEW array; results must
    // reflect it rather than the cached graph of the old array.
    const second = [chunk("Notes/a.md", ["C"]), chunk("Notes/b.md", []), chunk("Notes/c.md", [])];
    expect(relatedNotes("Notes/a.md", second).linksTo).toEqual(["Notes/c.md"]);
  });

  it("resolves backlinks (linkedFrom) from every note that links to it", () => {
    expect(relatedNotes("Notes/a.md", corpus).linkedFrom).toEqual(["Notes/b.md", "Notes/c.md"]);
  });

  it("never includes the note itself", () => {
    const withSelf = [chunk("Notes/a.md", ["a", "B"]), chunk("Notes/b.md", [])];
    const r = relatedNotes("Notes/a.md", withSelf);
    expect(r.linksTo).toEqual(["Notes/b.md"]);
    expect(r.linkedFrom).toEqual([]);
  });

  it("drops links that resolve to no indexed note", () => {
    const r = relatedNotes("Notes/a.md", [chunk("Notes/a.md", ["Ghost", "Missing"])]);
    expect(r.linksTo).toEqual([]);
  });

  it("resolves a basename collision to every matching note (honest over-approximation)", () => {
    const collide = [
      chunk("X/foo.md", []),
      chunk("Y/foo.md", []),
      chunk("Notes/src.md", ["foo"]),
    ];
    expect(relatedNotes("Notes/src.md", collide).linksTo).toEqual(["X/foo.md", "Y/foo.md"]);
  });
});
