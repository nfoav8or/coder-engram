/**
 * Dependency-free payload validation helpers.
 *
 * Used to validate server tool-call arguments and to sanitize user input
 * before it reaches the filesystem or index. Kept intentionally small — no
 * schema library — because the validated surface is narrow and explicit.
 */

import { ValidationError } from "./errors";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, name = "payload"): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ValidationError(`Expected ${name} to be an object`);
  }
  return value;
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
  opts: { maxLength?: number; minLength?: number } = {},
): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new ValidationError(`Field "${key}" must be a string`);
  }
  const min = opts.minLength ?? 1;
  if (value.trim().length < min) {
    throw new ValidationError(`Field "${key}" must be at least ${min} character(s)`);
  }
  const max = opts.maxLength ?? 100_000;
  if (value.length > max) {
    throw new ValidationError(`Field "${key}" exceeds maximum length of ${max}`);
  }
  return value;
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
  fallback = "",
  maxLength = 100_000,
): string {
  const value = obj[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") {
    throw new ValidationError(`Field "${key}" must be a string when provided`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`Field "${key}" exceeds maximum length of ${maxLength}`);
  }
  return value;
}

export function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const value = obj[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new ValidationError(`Field "${key}" must be a boolean when provided`);
  }
  return value;
}

/**
 * `maxItemLength` bounds each item, not just how many there are: a cap on the
 * count alone leaves the field's real size bounded only by the request body, so
 * a deliberate cap elsewhere on the same payload (add_memory's content limit)
 * can be walked around through a list field.
 */
export function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  maxItems = 256,
  maxItemLength = 1024,
): string[] {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`Field "${key}" must be an array of strings`);
  }
  if (value.length > maxItems) {
    throw new ValidationError(`Field "${key}" has too many items (max ${maxItems})`);
  }
  return value.map((v, i) => {
    if (typeof v !== "string") {
      throw new ValidationError(`Field "${key}[${i}]" must be a string`);
    }
    if (v.length > maxItemLength) {
      throw new ValidationError(
        `Field "${key}[${i}]" exceeds maximum length of ${maxItemLength}`,
      );
    }
    return v;
  });
}

export function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const value = obj[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`Field "${key}" must be a finite number`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ValidationError(`Field "${key}" must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new ValidationError(`Field "${key}" must be <= ${opts.max}`);
  }
  return value;
}

/** Clamp a number defensively into a range. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Validate a TCP port number. */
export function assertValidPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError(`Invalid port: ${port} (must be 1–65535)`);
  }
  return port;
}
