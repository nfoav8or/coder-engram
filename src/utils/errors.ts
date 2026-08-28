/**
 * Typed error hierarchy for Coder Engram.
 *
 * Using discrete error classes lets callers distinguish user-actionable
 * problems (bad settings, unsafe paths) from internal failures, and lets the
 * UI/server layers produce clear, non-leaky messages.
 */

export class EngramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A path that would resolve outside the vault or memory root, or is malformed. */
export class PathSecurityError extends EngramError {}

/** Invalid settings or configuration supplied by the user. */
export class ConfigError extends EngramError {}

/** A request payload (e.g. server tool call) failed validation. */
export class ValidationError extends EngramError {}

/** Wrap an unknown thrown value into a readable message. Local use only — see
 * `toClientMessage` for anything that crosses the server boundary. */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

/**
 * Normalize a caught value into an `Error` for rethrowing.
 *
 * A bare `throw err` in a `catch` rethrows a value the type system knows only
 * as `unknown`, and nothing guarantees a host API, a companion plugin, or a
 * fetch rejection handed us an `Error` at all — every caller here treats a
 * failure as one, so a rejected string propagated as a string and lost its
 * message on the way out. An existing `Error` is returned UNCHANGED, so
 * subclass identity (`PathSecurityError`, `ConfigError`, …) and the original
 * stack survive an `instanceof` check downstream; only a genuine non-`Error`
 * is wrapped.
 *
 * This is also what makes `@typescript-eslint/no-throw-literal` provable at the
 * rethrow sites, with `allowThrowingUnknown` off — the same class of finding
 * Obsidian's review scan reports.
 */
export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(toMessage(err));
}

/**
 * An absolute filesystem path, in the two shapes host errors produce.
 *
 * Node quotes the path in its `errno` messages (`open '/home/u/vault/x.md'`),
 * which matters because a vault folder may contain spaces — a whitespace-
 * delimited match would stop at the first one and leak the rest. The bare form
 * covers messages that don't quote. Neither matches a URL: a `//` there is
 * preceded by `:`, which is not an accepted leading character.
 */
const QUOTED_ABSOLUTE_PATH = /(['"`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^'"`\n]*)\1/g;
const BARE_ABSOLUTE_PATH = /(^|[\s([<])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`)\]>\n]+)/g;

/**
 * Strip absolute filesystem paths out of a message.
 *
 * Vault-relative paths survive untouched — `resolveInVault` guarantees they
 * never start with a separator or a drive letter — so the caller still learns
 * which note failed, in the only namespace it is entitled to know about.
 */
export function redactAbsolutePaths(message: string): string {
  return message
    .replace(QUOTED_ABSOLUTE_PATH, "$1<path>$1")
    .replace(BARE_ABSOLUTE_PATH, "$1<path>");
}

/**
 * The message form safe to hand to an MCP client.
 *
 * Errors raised by this plugin are authored text and cross unchanged. Errors
 * raised beneath it — Node's `fs`, Obsidian's adapter — carry the vault's
 * absolute location, and with it the account name and the vault's real folder
 * name, none of which any tool otherwise discloses. The unredacted message
 * still reaches the local logger, so nothing is lost to whoever is debugging.
 */
export function toClientMessage(err: unknown): string {
  return redactAbsolutePaths(toMessage(err));
}
