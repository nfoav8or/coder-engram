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
 * Absolute filesystem paths, and the URLs that must be told apart from them.
 *
 * One pass with three ordered alternatives, because the alternatives have to
 * see each other. The previous version scanned for a bare path only after one
 * of a fixed set of leading characters (start, whitespace, `(`, `[`, `<`),
 * which is what kept it off the `//` in `https://` — but that allowlist also
 * excluded every other separator a host error actually uses, so `error:/home/u`,
 * `path=/home/u`, `a,/home/u` and a mismatched-quote `'/home/u"` all survived
 * with the vault's real location in them. Matching URLs EXPLICITLY, ahead of
 * the bare form, lets the bare form accept any position at all.
 *
 *   1. A quoted path — Node quotes in `errno` messages (`open '/home/u/x.md'`),
 *      and a vault folder may contain spaces, so a whitespace-delimited match
 *      would stop at the first one and leak the rest.
 *   2. A `scheme://` URL, which the replacer keeps — with the exception of
 *      `file://`, which names a local path as surely as a bare one does.
 *   3. A bare path, reached only where 1 and 2 did not match — so a URL's `//`
 *      is already consumed and can no longer be mistaken for one. It still
 *      refuses to start immediately after a path character, which is what keeps
 *      the `/` of a VAULT-RELATIVE `Notes/private.md` from being read as the
 *      start of an absolute one. That single rule is all the old leading
 *      allowlist was really buying; stating it as what it excludes rather than
 *      what it permits is what lets every real separator through.
 */
const REDACTABLE = new RegExp(
  [
    /(['"`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^'"`\n]*)\1/, // 1: quoted
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"`)\]>\n]*)/, // 2: URL
    /(?<![A-Za-z0-9._\-/\\])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`)\]>\n]+)/, // 3: bare
  ]
    .map((r) => r.source)
    .join("|"),
  "g",
);

/**
 * Strip absolute filesystem paths out of a message.
 *
 * Vault-relative paths survive untouched — `resolveInVault` guarantees they
 * never start with a separator or a drive letter — so the caller still learns
 * which note failed, in the only namespace it is entitled to know about.
 */
export function redactAbsolutePaths(message: string): string {
  return message.replace(
    REDACTABLE,
    (match, quote: string | undefined, _quoted: string | undefined, url: string | undefined) => {
      if (quote !== undefined) return `${quote}<path>${quote}`;
      // A URL is not a filesystem path and is assumed safe to report — except
      // `file://`, whose whole point is to name one.
      if (url !== undefined) return url.startsWith("file://") ? "<path>" : match;
      return "<path>";
    },
  );
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
