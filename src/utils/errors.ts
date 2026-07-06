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

/** Wrap an unknown thrown value into a readable message without leaking internals. */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}
