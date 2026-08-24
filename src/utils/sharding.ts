/**
 * Size-adaptive sharded persistence — the rules shared by the chunk index and
 * the embedding store. One home for the constants so the two caches can never
 * drift apart on layout decisions.
 *
 * Above a per-store threshold a cache persists as 256 shard files
 * (`<name>-00.json` … `<name>-ff.json`, routed by FNV-1a of a stable key) so an
 * edit rewrites ~1/256 of the corpus instead of one monolithic file — the write
 * cost that dominates large vaults and hammers sync clients. Below
 * SHARD_DOWN_FACTOR × threshold it switches back; the gap is hysteresis so a
 * vault sitting at the boundary doesn't rewrite its whole cache on alternate
 * saves. Small vaults never leave the single-file layout and see byte-identical
 * behavior to previous releases.
 */
import { fnv1a32 } from "./hash";

export type Layout = "single" | "sharded";

export const SHARD_COUNT = 256;
export const SHARD_DOWN_FACTOR = 0.8;

/** Shard index for a routing key (note path for chunks, chunk id for vectors). */
export function shardOf(key: string): number {
  return fnv1a32(key) % SHARD_COUNT;
}

/**
 * Path of shard `i` beside `baseFile`. Derived from the already-validated
 * `Index/*.json` path (never from external input), so shards can only ever
 * live beside the file they split.
 */
export function shardPath(baseFile: string, i: number): string {
  const hex = i.toString(16).padStart(2, "0");
  return baseFile.replace(/\.json$/, `-${hex}.json`);
}

/** Layout for the NEXT persist, sticky around the threshold (hysteresis). */
export function chooseLayout(current: Layout, count: number, singleFileMax: number): Layout {
  if (current === "sharded") {
    return count < singleFileMax * SHARD_DOWN_FACTOR ? "single" : "sharded";
  }
  return count > singleFileMax ? "sharded" : "single";
}
