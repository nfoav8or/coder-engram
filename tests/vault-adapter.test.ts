import { describe, it, expect } from "vitest";
import { InMemoryVaultAdapter, assertRelative } from "../src/core/vault-adapter";
import { PathSecurityError } from "../src/utils/errors";

/**
 * `assertRelative` is the adapter-level half of the path defence: every read,
 * write, append and stat calls it, and both the in-memory and the Obsidian
 * adapter share it. `resolveInVault` guards paths the plugin BUILDS; this
 * guards the ones it is HANDED. A mutation sweep found it could be removed
 * outright with the suite still green, which is exactly the shape of guard that
 * a later refactor deletes as unreachable.
 */

describe("assertRelative", () => {
  it("rejects absolute, drive-rooted and UNC paths", () => {
    for (const p of ["/etc/passwd", "\\\\server\\share\\x.md", "C:\\Windows\\x.md", "c:/x.md"]) {
      expect(() => assertRelative(p)).toThrow(PathSecurityError);
    }
  });

  it("accepts an ordinary vault-relative path", () => {
    expect(() => assertRelative("Claude Code/Memory/Global/profile.md")).not.toThrow();
  });
});

describe("InMemoryVaultAdapter path safety", () => {
  it("refuses to read or write outside the vault", async () => {
    const adapter = new InMemoryVaultAdapter("v", { "Notes/a.md": "alpha" });
    await expect(adapter.read("/etc/passwd")).rejects.toBeInstanceOf(PathSecurityError);
    await expect(adapter.write("/tmp/evil.md", "x")).rejects.toBeInstanceOf(PathSecurityError);
    await expect(adapter.append("C:\\evil.md", "x")).rejects.toBeInstanceOf(PathSecurityError);
    // The vault's own content is untouched by the refusals.
    expect(await adapter.read("Notes/a.md")).toBe("alpha");
  });
});
