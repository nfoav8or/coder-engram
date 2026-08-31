/**
 * tokens — a cheap, dependency-free estimate of what a piece of output costs
 * the caller.
 *
 * The tools already accept `maxChars`, but characters are not the unit anyone
 * budgets in: an agent has a context window measured in tokens, and converting
 * between the two in its head is exactly the arithmetic it should not have to
 * do. `tokenBudget` lets it ask in its own unit.
 *
 * This is an ESTIMATE and is named like one. Real tokenization depends on the
 * model, and bundling a tokenizer for a plugin whose whole point is to stay
 * small and offline would be a poor trade. What matters is the direction of the
 * error, and both functions below are deliberately conservative in the same
 * direction: a budget converts to FEWER characters than it might really buy,
 * and an estimate reports MORE tokens than the text probably costs. Overshoot
 * is the dangerous side — an agent that asked for 2,000 tokens and received
 * 3,000 has had the decision taken away from it.
 */

/**
 * Characters per token, chosen low rather than average.
 *
 * English prose runs about 4 and code rather less; 3.5 sits under both, so the
 * conversion under-promises. A ratio at or above the true average would let a
 * budget be quietly exceeded on code-heavy content, which is most of what this
 * plugin's memory holds.
 */
const CHARS_PER_TOKEN = 3.5;

/** Characters a token budget buys, rounded down. */
export function charsForTokens(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

/** Approximate token cost of `text`, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
