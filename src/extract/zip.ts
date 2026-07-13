/**
 * zip — a minimal, dependency-free ZIP reader for office documents.
 *
 * Both Microsoft OOXML (docx/pptx/xlsx) and OpenDocument (odt/odp/ods) are ZIP
 * archives of XML. Rather than bundling a ZIP library, this reads the central
 * directory and inflates entries with the platform's `DecompressionStream`
 * (available in Electron's Chromium and Node 18+ — both runtimes we target).
 *
 * Deliberately partial: no zip64 (office documents are nowhere near 4 GB), no
 * encryption (an encrypted document extracts as null upstream), and sizes are
 * taken from the central directory (authoritative even for streamed archives
 * that use data descriptors). Malformed input throws; callers treat any throw
 * as "no text".
 */

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate — the only methods office writers use. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Inflated-size ceiling per entry. Deflate reaches ~1000:1, so without a cap a
 * 1 MB crafted entry inflates to ~1 GB in renderer memory (a decompression
 * bomb). The declared size is checked first and the stream is counted while
 * inflating, because the declared size can lie.
 */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * Aggregate inflated-size ceiling across every entry read from one archive.
 * The per-entry cap alone still lets a crafted archive spread its payload
 * over hundreds of near-cap entries (the directory count field allows 65535),
 * decompressing tens of GB in total. Callers that loop over entries share one
 * budget so the whole archive is bounded, not just each part.
 */
export const MAX_TOTAL_INFLATED_BYTES = 256 * 1024 * 1024;

export interface InflateBudget {
  remaining: number;
}

export function newInflateBudget(): InflateBudget {
  return { remaining: MAX_TOTAL_INFLATED_BYTES };
}

/** Parse the central directory. Throws on anything that isn't a ZIP. */
export function readZipDirectory(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-central-directory record sits in the last 22..(22+65535) bytes
  // (variable-length comment); scan backwards for its signature.
  let eocd = -1;
  const scanFrom = Math.max(0, data.length - 22 - 65535);
  for (let i = data.length - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  const nameDecoder = new TextDecoder("utf-8");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== CDFH_SIG) {
      throw new Error("corrupt zip: bad central-directory entry");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = nameDecoder.decode(data.subarray(offset + 46, offset + 46 + nameLen));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read + decompress one entry's bytes, drawing on `budget` when supplied. */
export async function readZipEntry(
  data: Uint8Array,
  entry: ZipEntry,
  budget?: InflateBudget,
): Promise<Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > data.length || view.getUint32(at, true) !== LFH_SIG) {
    throw new Error(`corrupt zip: bad local header for ${entry.name}`);
  }
  // The LOCAL name/extra lengths can differ from the central directory's.
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const start = at + 30 + nameLen + extraLen;
  const raw = data.subarray(start, start + entry.compressedSize);
  const cap = budget ? Math.min(MAX_INFLATED_BYTES, budget.remaining) : MAX_INFLATED_BYTES;
  if (entry.uncompressedSize > cap) {
    throw new Error(`zip entry too large when inflated: ${entry.name}`);
  }
  if (entry.method === 0) {
    if (budget) budget.remaining -= raw.byteLength;
    return raw;
  }
  if (entry.method === 8) {
    const stream = new Blob([raw as BlobPart]).stream().pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
    // Count while inflating — the declared uncompressedSize can lie.
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw new Error(`zip entry inflates past the cap: ${entry.name}`);
      }
      chunks.push(value);
    }
    if (budget) budget.remaining -= total;
    const out = new Uint8Array(total);
    let atOut = 0;
    for (const c of chunks) {
      out.set(c, atOut);
      atOut += c.byteLength;
    }
    return out;
  }
  throw new Error(`unsupported zip compression method ${entry.method} in ${entry.name}`);
}

/** Convenience: read a UTF-8 text entry by exact name, or null if absent. */
export async function readZipText(
  data: Uint8Array,
  name: string,
  budget?: InflateBudget,
): Promise<string | null> {
  const entry = readZipDirectory(data).find((e) => e.name === name);
  if (!entry) return null;
  return new TextDecoder("utf-8").decode(await readZipEntry(data, entry, budget));
}
