import { describe, it, expect } from "vitest";
import { charsForTokens, estimateTokens } from "../src/utils/tokens";

describe("the token estimate", () => {
  it("errs on the safe side in both directions", () => {
    // Overshoot is the dangerous side: an agent that asked for 2,000 tokens and
    // received 3,000 has had the decision taken away from it. So a budget buys
    // fewer characters than it might, and an estimate reports more tokens than
    // the text probably costs.
    const text = "x".repeat(4000);
    // Real English runs near 4 chars/token, so 1000 is the optimistic answer.
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(1000);
    // And a 1000-token budget must not hand back the full 4000 characters.
    expect(charsForTokens(1000)).toBeLessThanOrEqual(4000);
  });

  it("round-trips without growing", () => {
    // Converting a budget to characters and back must never claim more budget
    // than you started with, or a chain of conversions inflates.
    for (const tokens of [256, 1000, 4096, 16_000]) {
      expect(estimateTokens("y".repeat(charsForTokens(tokens)))).toBeLessThanOrEqual(tokens);
    }
  });

  it("handles the degenerate inputs", () => {
    expect(estimateTokens("")).toBe(0);
    expect(charsForTokens(0)).toBe(0);
    expect(charsForTokens(-100)).toBe(0);
  });
});
