import { describe, it, expect } from "vitest";
import { formatLineRange, formatModifiedDate } from "../src/ui/format";

describe("formatLineRange", () => {
  it("renders a single 0-based line as a 1-based 'Line N'", () => {
    expect(formatLineRange(0, 0)).toBe("Line 1");
    expect(formatLineRange(11, 11)).toBe("Line 12");
  });

  it("renders a span as 1-based 'Lines A–B'", () => {
    expect(formatLineRange(4, 7)).toBe("Lines 5–8");
    expect(formatLineRange(0, 2)).toBe("Lines 1–3");
  });

  it("never renders an end before the start", () => {
    // Defensive: a malformed endLine < startLine collapses to a single line.
    expect(formatLineRange(5, 3)).toBe("Line 6");
  });
});

describe("formatModifiedDate", () => {
  it("renders an epoch-ms mtime as a UTC YYYY-MM-DD day", () => {
    expect(formatModifiedDate(Date.UTC(2026, 6, 5, 23, 59))).toBe("2026-07-05");
  });

  it("returns empty for a non-finite mtime", () => {
    expect(formatModifiedDate(NaN)).toBe("");
    expect(formatModifiedDate(Infinity)).toBe("");
  });
});
