/*
 * version-bump — keep manifest.json and versions.json in sync with package.json.
 *
 * Run automatically by the npm `version` lifecycle script (i.e. `npm version
 * <patch|minor|major|x.y.z>`), which sets `npm_package_version` to the new
 * version. It writes that version into manifest.json and records the
 * version → minAppVersion mapping in versions.json so Obsidian can pick the
 * right build for each app version. The `version` script then stages both files.
 */

import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("version-bump: npm_package_version is not set; run via `npm version <x>`.");
  process.exit(1);
}

/** Bare x.y.z compare (this project's tags are always bare, never pre-release). */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// Read and parse BOTH files before writing either, so a malformed
// versions.json fails closed instead of leaving manifest.json updated while
// versions.json is stuck on the old version.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
  console.error(`version-bump: "${targetVersion}" is not a bare x.y.z version.`);
  process.exit(1);
}
if (compareVersions(targetVersion, manifest.version) <= 0) {
  console.error(
    `version-bump: refusing to move version backward or sideways: ` +
      `"${manifest.version}" -> "${targetVersion}". Edit manifest.json/versions.json by hand if this is intentional.`,
  );
  process.exit(1);
}

const { minAppVersion } = manifest;
manifest.version = targetVersion;
versions[targetVersion] = minAppVersion;

writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`version-bump: set manifest + versions.json to ${targetVersion} (minAppVersion ${minAppVersion}).`);
