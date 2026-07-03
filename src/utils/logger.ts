/**
 * Debug-gated logger with secret redaction.
 *
 * Logging is OFF by default and only emits when the user enables debug logging
 * in settings. Security-relevant events (server start, auth failures) are
 * logged at `info` when debug is on, but secrets are always redacted so tokens
 * and API keys never reach the console.
 */

const SECRET_KEY_PATTERN = /(token|secret|apikey|api_key|authorization|password|bearer)/i;
const REDACTED = "«redacted»";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Recursively redact values whose keys look secret. Never mutates the input. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "«…»";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const PREFIX = "[engram]";

class ConsoleLogger implements Logger {
  constructor(
    private readonly enabled: () => boolean,
    private readonly scope: string,
  ) {}

  private tag(): string {
    return this.scope ? `${PREFIX}[${this.scope}]` : PREFIX;
  }

  private emit(
    fn: (...args: unknown[]) => void,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (!this.enabled()) return;
    if (context) fn(this.tag(), message, redact(context));
    else fn(this.tag(), message);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.emit(console.debug.bind(console), message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.emit(console.info.bind(console), message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    // Warnings/errors always emit (they are actionable), still redacted.
    if (context) console.warn(this.tag(), message, redact(context));
    else console.warn(this.tag(), message);
  }
  error(message: string, context?: Record<string, unknown>): void {
    if (context) console.error(this.tag(), message, redact(context));
    else console.error(this.tag(), message);
  }
  child(scope: string): Logger {
    const combined = this.scope ? `${this.scope}:${scope}` : scope;
    return new ConsoleLogger(this.enabled, combined);
  }
}

/**
 * Create a logger whose debug/info output is gated by `enabled()`.
 * warn/error always emit because they signal actionable problems.
 */
export function createLogger(enabled: () => boolean, scope = ""): Logger {
  return new ConsoleLogger(enabled, scope);
}

/** A logger that emits nothing — useful for tests and disabled states. */
export const NULL_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NULL_LOGGER;
  },
};
