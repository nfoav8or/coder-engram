/**
 * hash — small deterministic, dependency-free hashes shared across layers.
 * Non-cryptographic: used for cache keys and shard routing, never security.
 */

/** FNV-1a 32-bit hash of a string. */
export function fnv1a32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
