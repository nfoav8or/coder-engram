#!/usr/bin/env bash
#
# Coder Engram installer — installs the plugin into an Obsidian vault from
# GitHub release assets. Linux and macOS.
#
# Recommended: download and READ this script before running it.
#
#   curl -fsSL https://raw.githubusercontent.com/nfoav8or/coder-engram/main/scripts/install.sh -o install.sh
#   less install.sh
#   bash install.sh --vault "/path/to/YourVault"
#
# Options:
#   --vault <path>     Target vault (else auto-detected from Obsidian's vault
#                      registry; prompts when several are found).
#   --version <x.y.z>  Install a specific release (default: latest).
#   --enable           Also enable the plugin in the vault's config. Only do
#                      this while Obsidian is CLOSED; otherwise enable it in
#                      Settings -> Community plugins after a restart.
#   --skip-verify      Install WITHOUT checking the download against the
#                      release's SHA256SUMS. Only needed for releases older
#                      than 0.6.0, which predate the manifest. Anything newer
#                      publishes one, so if verification cannot be completed
#                      the safe assumption is interference, not an old release.
#
# What it does — nothing else:
#   1. Downloads main.js, manifest.json, styles.css and SHA256SUMS, and
#      verifies the files against it (see --skip-verify).
#   2. Copies them to <vault>/.obsidian/plugins/coder-engram/.
#   3. With --enable: adds "coder-engram" to community-plugins.json.
set -euo pipefail

REPO="nfoav8or/coder-engram"
PLUGIN_ID="coder-engram"
ASSETS=(main.js manifest.json styles.css)

VAULT=""
VERSION="latest"
ENABLE=0
SKIP_VERIFY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT="${2:?--vault needs a path}"; shift 2 ;;
    --version) VERSION="${2:?--version needs x.y.z}"; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The version is spliced into a URL path; only a release number or "latest"
# may reach it, so a stray value cannot steer the download elsewhere.
case "$VERSION" in
  latest) ;;
  *) [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must be x.y.z (got: $VERSION)" ;;
esac

json_tool() {
  if command -v python3 >/dev/null 2>&1; then echo python3; return; fi
  if command -v jq >/dev/null 2>&1; then echo jq; return; fi
  echo ""
}

# --- locate the vault --------------------------------------------------------
detect_vaults() {
  # Obsidian's vault registry: { "vaults": { "<id>": { "path": "...", ... } } }
  local registry=""
  case "$(uname -s)" in
    Darwin) registry="$HOME/Library/Application Support/obsidian/obsidian.json" ;;
    *) registry="${XDG_CONFIG_HOME:-$HOME/.config}/obsidian/obsidian.json" ;;
  esac
  [ -f "$registry" ] || return 0
  case "$(json_tool)" in
    python3) python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for v in (data.get("vaults") or {}).values():
    p = v.get("path")
    if p:
        print(p)
' "$registry" 2>/dev/null || true ;;
    jq) jq -r '.vaults[].path' "$registry" 2>/dev/null || true ;;
    *) ;;
  esac
}

if [ -z "$VAULT" ]; then
  mapfile -t FOUND < <(detect_vaults)
  if [ "${#FOUND[@]}" -eq 0 ]; then
    die "no vault auto-detected — pass --vault /path/to/YourVault"
  elif [ "${#FOUND[@]}" -eq 1 ]; then
    VAULT="${FOUND[0]}"
    say "Using detected vault: $VAULT"
  else
    say "Multiple vaults found:"
    i=1
    for v in "${FOUND[@]}"; do say "  $i) $v"; i=$((i + 1)); done
    if [ -t 0 ]; then
      printf 'Install into which vault? [1-%d] ' "${#FOUND[@]}"
      read -r pick
      case "$pick" in (*[!0-9]*|"") die "not a number: $pick" ;; esac
      [ "$pick" -ge 1 ] && [ "$pick" -le "${#FOUND[@]}" ] || die "out of range: $pick"
      VAULT="${FOUND[$((pick - 1))]}"
    else
      die "several vaults found and no TTY to ask — pass --vault"
    fi
  fi
fi

[ -d "$VAULT/.obsidian" ] || die "not an Obsidian vault (no .obsidian/): $VAULT"

# --- download ----------------------------------------------------------------
# CODER_ENGRAM_BASE_URL overrides the asset source (mirrors, testing).
# The release host is https only, and a redirect may not step down from it:
# `-L` follows a Location header across schemes by default, so without this a
# redirect to plain http:// would be followed silently. An override keeps its
# own scheme (a file:// or local-mirror source is legitimate) but still may
# not be redirected off https.
CURL_OPTS=(--proto '=https' --tlsv1.2)
if [ -n "${CODER_ENGRAM_BASE_URL:-}" ]; then
  BASE="$CODER_ENGRAM_BASE_URL"
  CURL_OPTS=(--proto-redir '=https')
  # Plain http:// silently drops TLS, which makes the whole download
  # MITM-able. Not refused — a local mirror or a file:// source is a
  # legitimate use, and the checksum step above is the real integrity control
  # — but never let it pass unremarked.
  case "$BASE" in
    http://*) say "WARNING: CODER_ENGRAM_BASE_URL uses plain http:// — the download is not protected in transit." ;;
  esac
elif [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP="$(mktemp -d)"
STAGE=""
PREV=""
DEST=""
# One exit path for every failure: drop the scratch dirs, and if the old
# install had already been moved aside when something failed, put it back.
cleanup() {
  rm -rf "$TMP"
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  if [ -n "$PREV" ] && [ -e "$PREV" ] && [ ! -e "$DEST" ]; then mv "$PREV" "$DEST"; fi
}
trap cleanup EXIT

say "Downloading Coder Engram ($VERSION) ..."
for a in "${ASSETS[@]}"; do
  curl -fsSL "${CURL_OPTS[@]}" "$BASE/$a" -o "$TMP/$a" || die "download failed: $BASE/$a"
done

# Verify against the release's checksum manifest.
#
# This FAILS CLOSED. Whoever can tamper with main.js in transit can equally
# make the SHA256SUMS request fail, and the script cannot tell that apart from
# "this is an old release that never had one" — so treating a missing manifest
# or a missing hash tool as "skip verification" handed an attacker the whole
# control for the cost of one blocked request. Every release since 0.6.0 ships
# a manifest; --skip-verify is the explicit escape hatch for anything older.
#
# sha256sum is GNU coreutils and is NOT present on a stock macOS, which this
# script supports — using it unconditionally made every macOS install die with
# "verification FAILED", blaming the release for a missing tool. Try each of
# the three tools a machine plausibly has.
sha256_tool() {
  # Probed with command -v rather than by running the tool: hashing can also
  # fail for reasons that are not "no tool installed" (permissions, disk), and
  # those must abort rather than silently downgrade to no verification.
  if command -v sha256sum >/dev/null 2>&1; then echo sha256sum; return 0; fi
  if command -v shasum >/dev/null 2>&1; then echo shasum; return 0; fi
  if command -v openssl >/dev/null 2>&1; then echo openssl; return 0; fi
  return 1
}

sha256_of() {
  case "$(sha256_tool)" in
    sha256sum) sha256sum "$1" | awk '{print $1}' ;;
    shasum) shasum -a 256 "$1" | awk '{print $1}' ;;
    openssl) openssl dgst -sha256 "$1" | awk '{print $NF}' ;;
    *) return 1 ;;
  esac
}

if [ "$SKIP_VERIFY" = "1" ]; then
  say "WARNING: --skip-verify given; installing WITHOUT checksum verification."
else
  sha256_tool >/dev/null \
    || die "no sha256 tool found (sha256sum, shasum, or openssl) — refusing to install unverified. Install one, or pass --skip-verify to accept the risk."
  curl -fsSL "${CURL_OPTS[@]}" "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" \
    || die "could not fetch SHA256SUMS from $BASE — refusing to install unverified. Releases before 0.6.0 predate it; for those, pass --skip-verify."
  for a in "${ASSETS[@]}"; do
    expected="$(awk -v f="$a" '$2 == f || $2 == "*" f {print $1}' "$TMP/SHA256SUMS" | head -1)"
    [ -n "$expected" ] || die "SHA256SUMS has no entry for $a — refusing to install"
    actual="$(sha256_of "$TMP/$a")" || die "could not hash $a — refusing to install"
    [ "$actual" = "$expected" ] \
      || die "checksum verification FAILED for $a — refusing to install"
  done
  say "Checksums verified."
fi

# --- install -----------------------------------------------------------------
# Staged, then swapped: the three assets are copied one at a time, and a
# failure between two of them left a plugin that was half one version and
# half another. The new directory is built beside the old one — carrying
# everything already there, since data.json holds the settings and the server
# token — and takes its place with two renames; cleanup restores the old
# directory if the second never happens.
PLUGINS_DIR="$VAULT/.obsidian/plugins"
DEST="$PLUGINS_DIR/$PLUGIN_ID"
[ -L "$DEST" ] && die "refusing to install through a symlink: $DEST"
mkdir -p "$PLUGINS_DIR"
# A run killed between the two renames below leaves the old install parked
# under its .previous name and nothing at $DEST; installing fresh over that
# would drop the settings and server token it holds. Put it back first. One
# left beside a live $DEST was superseded by a later install and is removed.
for parked in "$PLUGINS_DIR"/."$PLUGIN_ID".previous.*; do
  [ -d "$parked" ] || continue
  if [ ! -e "$DEST" ]; then
    mv "$parked" "$DEST"
    say "Restored the previous install an interrupted run left parked."
  else
    rm -rf "$parked"
  fi
done
STAGE="$(mktemp -d "$PLUGINS_DIR/.$PLUGIN_ID.staging.XXXXXX")"
# mktemp creates it 0700; the plugin directory should look like one mkdir made.
chmod 755 "$STAGE"
if [ -d "$DEST" ]; then cp -a "$DEST/." "$STAGE/"; fi
for a in "${ASSETS[@]}"; do
  cp "$TMP/$a" "$STAGE/$a"
done
if [ -d "$DEST" ]; then
  PREV="$PLUGINS_DIR/.$PLUGIN_ID.previous.$$"
  mv "$DEST" "$PREV"
fi
mv "$STAGE" "$DEST"
STAGE=""
if [ -n "$PREV" ]; then rm -rf "$PREV"; PREV=""; fi
say "Installed to $DEST"

# --- enable (opt-in) ---------------------------------------------------------
if [ "$ENABLE" -eq 1 ]; then
  CP_JSON="$VAULT/.obsidian/community-plugins.json"
  case "$(json_tool)" in
    python3) python3 - "$CP_JSON" "$PLUGIN_ID" <<'PYEOF'
import json, os, sys
path, plugin = sys.argv[1], sys.argv[2]
plugins = []
if os.path.exists(path):
    with open(path) as f:
        plugins = json.load(f)
if plugin not in plugins:
    plugins.append(plugin)
    with open(path, "w") as f:
        json.dump(plugins, f, indent=2)
PYEOF
      say "Enabled in community-plugins.json — restart Obsidian to load it." ;;
    jq)
      tmp_json="$CP_JSON.tmp.$$"
      if [ -f "$CP_JSON" ]; then
        jq --arg p "$PLUGIN_ID" 'if index($p) then . else . + [$p] end' "$CP_JSON" > "$tmp_json" \
          || { rm -f "$tmp_json"; die "could not update $CP_JSON (is it valid JSON?)"; }
      else
        jq -n --arg p "$PLUGIN_ID" '[$p]' > "$tmp_json" || { rm -f "$tmp_json"; die "jq failed"; }
      fi
      mv "$tmp_json" "$CP_JSON"
      say "Enabled in community-plugins.json — restart Obsidian to load it." ;;
    *) say "note: --enable needs python3 or jq; enable it in Settings -> Community plugins instead." ;;
  esac
else
  say "Next: open Obsidian -> Settings -> Community plugins -> enable \"Coder Engram\"."
  say "(A brand-new vault must first leave Restricted Mode on that screen.)"
fi
