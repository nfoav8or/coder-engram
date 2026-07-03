import { describe, it, expect } from "vitest";
import { normalizeEndpoint, parseVectorMatrix } from "../src/embeddings/embedding-http";

describe("normalizeEndpoint", () => {
  it("trims whitespace", () => {
    expect(normalizeEndpoint("  http://x:11434  ")).toBe("http://x:11434");
  });
  it("strips a single trailing slash", () => {
    expect(normalizeEndpoint("http://x:11434/")).toBe("http://x:11434");
  });
  it("strips multiple trailing slashes", () => {
    expect(normalizeEndpoint("http://x:11434///")).toBe("http://x:11434");
  });
  it("leaves an already-clean endpoint unchanged", () => {
    expect(normalizeEndpoint("http://x:11434/v1")).toBe("http://x:11434/v1");
  });
});

describe("parseVectorMatrix happy path", () => {
  it("returns the matrix for well-formed input", () => {
    const m = parseVectorMatrix([[1, 2], [3, 4]], 2, "P");
    expect(m).toEqual([[1, 2], [3, 4]]);
  });
  it("accepts negative and fractional finite numbers", () => {
    const m = parseVectorMatrix([[-1.5, 0], [0.25, -3]], 2, "P");
    expect(m).toEqual([[-1.5, 0], [0.25, -3]]);
  });
});

describe("parseVectorMatrix throw paths", () => {
  it("throws when value is not an array", () => {
    expect(() => parseVectorMatrix({} as unknown, 1, "P")).toThrow(/embeddings array/i);
  });
  it("throws when row count != expectedRows", () => {
    expect(() => parseVectorMatrix([[1]], 2, "P")).toThrow(/expected 2/i);
  });
  it("throws when a row is empty", () => {
    expect(() => parseVectorMatrix([[]], 1, "P")).toThrow(/empty or not an array/i);
  });
  it("throws when a row is not an array", () => {
    expect(() => parseVectorMatrix([42], 1, "P")).toThrow(/empty or not an array/i);
  });
  it("throws on NaN", () => {
    expect(() => parseVectorMatrix([[NaN]], 1, "P")).toThrow(/non-finite/i);
  });
  it("throws on Infinity", () => {
    expect(() => parseVectorMatrix([[Infinity]], 1, "P")).toThrow(/non-finite/i);
  });
  it("throws on a string value", () => {
    expect(() => parseVectorMatrix([["x"]] as unknown, 1, "P")).toThrow(/non-finite/i);
  });
  it("throws on inconsistent dimensions", () => {
    expect(() => parseVectorMatrix([[1, 2], [3]], 2, "P")).toThrow(/inconsistent dimensions/i);
  });
  it("includes the provider label in the message", () => {
    expect(() => parseVectorMatrix(null, 1, "MyProvider")).toThrow(/MyProvider/);
  });
});
