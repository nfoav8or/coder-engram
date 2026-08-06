/**
 * Shared helpers for HTTP embedding providers: endpoint normalization and
 * strict parsing/validation of returned vector matrices. Kept pure and tiny so
 * both providers share one audited validation path.
 */

/** Trim trailing slashes so `${endpoint}/api/...` never doubles the slash. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

/**
 * Validate an unknown value is a matrix of finite-number vectors with a
 * consistent, non-zero dimension and the expected row count. Throws a clear
 * error otherwise so a malformed provider response never poisons the index with
 * NaN/ragged vectors.
 */
export function parseVectorMatrix(
  value: unknown,
  expectedRows: number,
  providerLabel: string,
): number[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${providerLabel}: response did not contain an embeddings array`);
  }
  if (value.length !== expectedRows) {
    throw new Error(
      `${providerLabel}: expected ${expectedRows} embeddings, got ${value.length}`,
    );
  }
  let dim = -1;
  const out: number[][] = [];
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || row.length === 0) {
      throw new Error(`${providerLabel}: an embedding row was empty or not an array`);
    }
    // `Array.isArray` widens to `any[]`, which would let a non-number through
    // the checks below unnoticed; keep every cell `unknown` until validated.
    const cells = row as unknown[];
    const vec = new Array<number>(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const n = cells[i];
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new Error(`${providerLabel}: an embedding contained a non-finite value`);
      }
      vec[i] = n;
    }
    if (dim === -1) dim = vec.length;
    else if (vec.length !== dim) {
      throw new Error(`${providerLabel}: embeddings had inconsistent dimensions`);
    }
    out.push(vec);
  }
  return out;
}
