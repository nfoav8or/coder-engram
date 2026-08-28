import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Coverage for `scripts/install.sh`, the first thing a user runs and until now
 * the only shipped code with no test at all. Two bugs had already reached
 * users through it — verification that could not work on macOS, and an asset
 * absent from SHA256SUMS being skipped while the run reported success — both
 * in the step whose entire job is to refuse a bad download.
 *
 * The script already takes `CODER_ENGRAM_BASE_URL` to point at a different
 * asset source, so a `file://` directory stands in for a GitHub release and
 * nothing here touches the network.
 */

const HAVE_TOOLS =
  spawnSync("bash", ["-c", "command -v curl"], { stdio: "ignore" }).status === 0 &&
  spawnSync("bash", ["-c", "command -v sha256sum || command -v shasum"], { stdio: "ignore" }).status === 0;

const ASSETS = ["main.js", "manifest.json", "styles.css"];

/** A throwaway release directory plus a vault to install it into. */
function scaffold(): { root: string; release: string; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "engram-install-"));
  const release = join(root, "release");
  const vault = join(root, "vault");
  mkdirSync(release);
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(release, "main.js"), "// pretend bundle\n");
  writeFileSync(join(release, "manifest.json"), JSON.stringify({ id: "coder-engram", version: "9.9.9" }));
  writeFileSync(join(release, "styles.css"), ".engram {}\n");
  const sums = execFileSync("bash", ["-c", `cd ${JSON.stringify(release)} && sha256sum ${ASSETS.join(" ")}`], {
    encoding: "utf8",
  });
  writeFileSync(join(release, "SHA256SUMS"), sums);
  return { root, release, vault };
}

function runInstaller(release: string, vault: string, extraArgs: string[] = []) {
  return spawnSync("bash", ["scripts/install.sh", "--vault", vault, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, CODER_ENGRAM_BASE_URL: `file://${release}` },
  });
}

const installedFiles = (vault: string) =>
  ASSETS.filter((a) => existsSync(join(vault, ".obsidian", "plugins", "coder-engram", a)));

describe.skipIf(!HAVE_TOOLS)("scripts/install.sh", () => {
  it("installs the release assets into the vault after verifying them", () => {
    const { root, release, vault } = scaffold();
    try {
      const run = runInstaller(release, vault);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("Checksums verified.");
      const dest = join(vault, ".obsidian", "plugins", "coder-engram");
      for (const a of ASSETS) expect(existsSync(join(dest, a))).toBe(true);
      expect(readFileSync(join(dest, "main.js"), "utf8")).toBe("// pretend bundle\n");
      // --enable is opt-in: without it the plugin is installed, not switched on.
      expect(existsSync(join(vault, ".obsidian", "community-plugins.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to install when SHA256SUMS cannot be fetched", () => {
    // The whole verification step used to degrade to a "note:" and install
    // anyway. Whoever can tamper with main.js in transit can equally make this
    // one request fail, so a missing manifest is indistinguishable from
    // interference and must fail closed.
    const { root, release, vault } = scaffold();
    try {
      rmSync(join(release, "SHA256SUMS"));
      const run = runInstaller(release, vault);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/refusing to install unverified/);
      expect(installedFiles(vault), "nothing may be installed unverified").toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to install when no sha256 tool is available", () => {
    // Same failure class: "no tool" used to skip verification entirely.
    const { root, release, vault } = scaffold();
    try {
      const run = spawnSync("bash", ["scripts/install.sh", "--vault", vault], {
        encoding: "utf8",
        // An empty PATH plus bash builtins: curl is gone too, but the tool
        // check runs first, so this pins the branch under test.
        env: { ...process.env, PATH: "/nonexistent", CODER_ENGRAM_BASE_URL: `file://${release}` },
      });
      expect(run.status).not.toBe(0);
      expect(installedFiles(vault)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs without a manifest only when --skip-verify is explicit", () => {
    const { root, release, vault } = scaffold();
    try {
      rmSync(join(release, "SHA256SUMS"));
      const run = runInstaller(release, vault, ["--skip-verify"]);
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/WITHOUT checksum verification/);
      expect(installedFiles(vault)).toEqual(ASSETS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to install an asset that does not match its checksum", () => {
    const { root, release, vault } = scaffold();
    try {
      writeFileSync(join(release, "main.js"), "// swapped after the manifest was written\n");
      const run = runInstaller(release, vault);
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toMatch(/verification FAILED/);
      // Nothing was copied — a refusal must not leave a half-installed plugin.
      expect(existsSync(join(vault, ".obsidian", "plugins", "coder-engram", "main.js"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an asset the checksum manifest does not cover", () => {
    // The failure mode that shipped: verification that iterates the manifest
    // never notices a downloaded file missing from it, and reports success.
    const { root, release, vault } = scaffold();
    try {
      const sums = readFileSync(join(release, "SHA256SUMS"), "utf8")
        .split("\n")
        .filter((l) => !l.endsWith(" main.js"))
        .join("\n");
      writeFileSync(join(release, "SHA256SUMS"), sums);
      const run = runInstaller(release, vault);
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toMatch(/no entry for main\.js/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a target that is not an Obsidian vault", () => {
    const { root, release } = scaffold();
    try {
      const notAVault = join(root, "just-a-folder");
      mkdirSync(notAVault);
      const run = runInstaller(release, notAVault);
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toMatch(/not an Obsidian vault/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
