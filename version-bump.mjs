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

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`version-bump: set manifest + versions.json to ${targetVersion} (minAppVersion ${minAppVersion}).`);
