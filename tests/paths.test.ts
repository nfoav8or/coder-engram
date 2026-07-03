import { describe, it, expect } from "vitest";
import {
  normalizeVaultRelativePath,
  isAbsoluteLike,
  resolveInVault,
  joinVaultPath,
  isInsideRoot,
} from "../src/utils/paths";
import { PathSecurityError } from "../src/utils/errors";

describe("isAbsoluteLike", () => {
  it("detects posix absolute paths", () => {
    expect(isAbsoluteLike("/etc/passwd")).toBe(true);
  });
  it("detects windows drive-letter paths", () => {
    expect(isAbsoluteLike("C:\\Windows")).toBe(true);
    expect(isAbsoluteLike("c:/Windows")).toBe(true);
  });
  it("detects backslash-rooted paths", () => {
    expect(isAbsoluteLike("\\Windows")).toBe(true);
  });
  it("detects UNC paths", () => {
    expect(isAbsoluteLike("\\\\server\\share")).toBe(true);
  });
  it("treats normal relative paths as not absolute", () => {
    expect(isAbsoluteLike("Claude Code/Memory")).toBe(false);
  });
});

describe("normalizeVaultRelativePath", () => {
  it("collapses redundant separators and dot segments", () => {
    expect(normalizeVaultRelativePath("Claude Code/./Memory//Inbox")).toBe(
      "Claude Code/Memory/Inbox",
    );
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeVaultRelativePath("Claude Code\\Memory")).toBe(
      "Claude Code/Memory",
    );
  });

  it("strips a leading ./", () => {
    expect(normalizeVaultRelativePath("./Notes/a.md")).toBe("Notes/a.md");
  });

  it("resolves interior .. that stays inside", () => {
    expect(normalizeVaultRelativePath("a/b/../c")).toBe("a/c");
  });

  // --- Traversal / escape rejection (the security-critical cases) ---

  it("rejects a leading ..", () => {
    expect(() => normalizeVaultRelativePath("../secret")).toThrow(PathSecurityError);
  });

  it("rejects .. that escapes after normalization", () => {
    expect(() => normalizeVaultRelativePath("a/../../secret")).toThrow(
      PathSecurityError,
    );
  });

  it("rejects a bare ..", () => {
    expect(() => normalizeVaultRelativePath("..")).toThrow(PathSecurityError);
  });

  it("rejects posix absolute paths", () => {
    expect(() => normalizeVaultRelativePath("/etc/passwd")).toThrow(
      PathSecurityError,
    );
  });

  it("rejects windows drive-letter absolute paths", () => {
    expect(() => normalizeVaultRelativePath("C:/Windows/system32")).toThrow(
      PathSecurityError,
    );
  });

  it("rejects UNC paths", () => {
    expect(() => normalizeVaultRelativePath("\\\\host\\share")).toThrow(
      PathSecurityError,
    );
  });

  it("rejects NUL bytes", () => {
    expect(() => normalizeVaultRelativePath("a" + String.fromCharCode(0) + "b")).toThrow(PathSecurityError);
  });

  it("rejects empty / whitespace-only paths", () => {
    expect(() => normalizeVaultRelativePath("")).toThrow(PathSecurityError);
    expect(() => normalizeVaultRelativePath("   ")).toThrow(PathSecurityError);
  });
});

describe("joinVaultPath", () => {
  it("joins and normalizes segments", () => {
    expect(joinVaultPath("Claude Code", "Memory", "Inbox")).toBe(
      "Claude Code/Memory/Inbox",
    );
  });
  it("rejects a segment that tries to escape", () => {
    expect(() => joinVaultPath("Claude Code", "../..")).toThrow(PathSecurityError);
  });
});

describe("isInsideRoot", () => {
  it("accepts a child path", () => {
    expect(isInsideRoot("Claude Code", "Claude Code/Memory/x.md")).toBe(true);
  });
  it("accepts the root itself", () => {
    expect(isInsideRoot("Claude Code", "Claude Code")).toBe(true);
  });
  it("rejects a sibling with a shared prefix", () => {
    expect(isInsideRoot("Claude Code", "Claude Codex/x.md")).toBe(false);
  });
  it("rejects a path outside the root", () => {
    expect(isInsideRoot("Claude Code", "Other/x.md")).toBe(false);
  });
});

describe("resolveInVault", () => {
  const root = "Claude Code";

  it("resolves a normal subpath under the memory root", () => {
    expect(resolveInVault(root, "Memory/Inbox/pending-memory.md")).toBe(
      "Claude Code/Memory/Inbox/pending-memory.md",
    );
  });

  it("returns the root when given an empty subpath", () => {
    expect(resolveInVault(root, "")).toBe("Claude Code");
  });

  it("rejects a subpath that escapes the memory root", () => {
    expect(() => resolveInVault(root, "../outside.md")).toThrow(PathSecurityError);
  });

  it("rejects a subpath that escapes even with interior segments", () => {
    expect(() => resolveInVault(root, "Memory/../../outside.md")).toThrow(
      PathSecurityError,
    );
  });

  it("rejects an absolute subpath", () => {
    expect(() => resolveInVault(root, "/etc/passwd")).toThrow(PathSecurityError);
  });

  it("rejects when the root itself is absolute", () => {
    expect(() => resolveInVault("/abs/root", "Memory")).toThrow(PathSecurityError);
  });
});
