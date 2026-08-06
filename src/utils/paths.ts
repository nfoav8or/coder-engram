/**
 * Path safety — the single choke-point for every vault path the plugin touches.
 *
 * Obsidian addresses files as forward-slash paths relative to the vault root.
 * There is no legitimate reason for a plugin-managed path to be absolute or to
 * contain a `..` that escapes its root. This module normalizes paths and
 * rejects anything that could resolve outside the vault or outside the
 * configured memory root.
 *
 * SECURITY: All reads/writes performed by the plugin MUST route their paths
 * through `normalizeVaultRelativePath` / `resolveInVault`. Do not construct
 * vault paths by ad-hoc string concatenation elsewhere.
 */

import { PathSecurityError } from "./errors";

/** Characters that must never appear in a vault path. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this pattern exists to reject in a vault path
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Returns true if the input looks like an absolute or drive/UNC-rooted path.
 * Such paths are never valid vault-relative paths.
 */
export function isAbsoluteLike(input: string): boolean {
  if (input.length === 0) return false;
  if (input.startsWith("/") || input.startsWith("\\")) return true; // posix root / UNC / backslash root
  if (/^[a-zA-Z]:[\\/]?/.test(input)) return true; // C: or C:\ or c:/
  return false;
}

/**
 * Normalize a vault-relative path into a clean, forward-slash form, resolving
 * `.` and `..` segments. Throws {@link PathSecurityError} if the path is
 * absolute, malformed, or escapes the vault root via `..`.
 */
export function normalizeVaultRelativePath(input: string): string {
  if (typeof input !== "string") {
    throw new PathSecurityError("Path must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new PathSecurityError("Path must not be empty");
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new PathSecurityError("Path contains invalid control characters");
  }
  if (isAbsoluteLike(trimmed)) {
    throw new PathSecurityError(`Absolute paths are not allowed: "${input}"`);
  }

  const parts = trimmed.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) {
        throw new PathSecurityError(
          `Path escapes its root via "..": "${input}"`,
        );
      }
      out.pop();
      continue;
    }
    out.push(part);
  }

  if (out.length === 0) {
    // e.g. "." or "./" — resolves to the root itself, which is not a valid
    // standalone relative file path.
    throw new PathSecurityError(`Path resolves to nothing: "${input}"`);
  }

  return out.join("/");
}

/**
 * Join and normalize path segments into a single safe vault-relative path.
 * Throws if the combined result would escape the root.
 */
export function joinVaultPath(...segments: string[]): string {
  const joined = segments.filter((s) => s !== undefined && s !== null && s !== "").join("/");
  return normalizeVaultRelativePath(joined);
}

/**
 * True if `candidate` (a normalized vault-relative path) is the root itself or
 * lives underneath `root`. Uses segment-boundary comparison so that
 * "Claude Codex" is NOT considered inside "Claude Code".
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeVaultRelativePath(root);
  const normalizedCandidate = normalizeVaultRelativePath(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(normalizedRoot + "/");
}

/**
 * Resolve a subpath under a memory root, guaranteeing the result stays inside
 * that root (and therefore inside the vault). This is the function every
 * memory read/write should use.
 *
 * @param root     Vault-relative memory root, e.g. "Claude Code".
 * @param subpath  Vault-relative subpath under the root, e.g. "Memory/Inbox".
 *                 An empty subpath resolves to the root itself.
 * @returns        The normalized, safe vault-relative path.
 */
export function resolveInVault(root: string, subpath: string): string {
  const normalizedRoot = normalizeVaultRelativePath(root);
  if (subpath === undefined || subpath === null || subpath.trim() === "") {
    return normalizedRoot;
  }
  // Reject an absolute subpath early with a clear message.
  if (isAbsoluteLike(subpath)) {
    throw new PathSecurityError(`Absolute subpaths are not allowed: "${subpath}"`);
  }
  const combined = normalizeVaultRelativePath(`${normalizedRoot}/${subpath}`);
  if (!isInsideRoot(normalizedRoot, combined)) {
    throw new PathSecurityError(
      `Path "${subpath}" escapes the memory root "${normalizedRoot}"`,
    );
  }
  return combined;
}
