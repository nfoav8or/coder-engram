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
#
# What it does — nothing else:
#   1. Downloads main.js, manifest.json, styles.css (and SHA256SUMS when the
#      release provides one, verifying the files against it).
#   2. Copies them to <vault>/.obsidian/plugins/coder-engram/.
#   3. With --enable: adds "coder-engram" to community-plugins.json.
set -euo pipefail

REPO="nfoav8or/coder-engram"
PLUGIN_ID="coder-engram"
ASSETS=(main.js manifest.json styles.css)

VAULT=""
VERSION="latest"
ENABLE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT="${2:?--vault needs a path}"; shift 2 ;;
    --version) VERSION="${2:?--version needs x.y.z}"; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

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
if [ -n "${CODER_ENGRAM_BASE_URL:-}" ]; then
  BASE="$CODER_ENGRAM_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading Coder Engram ($VERSION) ..."
for a in "${ASSETS[@]}"; do
  curl -fsSL "$BASE/$a" -o "$TMP/$a" || die "download failed: $BASE/$a"
done

# Verify against the release's checksum manifest when it exists (releases
# older than 0.6.0 don't ship one — the installer says so rather than skipping
# silently).
if curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null; then
  ( cd "$TMP" && sha256sum -c SHA256SUMS --ignore-missing --quiet ) \
    || die "checksum verification FAILED — refusing to install"
  say "Checksums verified."
else
  say "note: this release publishes no SHA256SUMS; skipping checksum verification."
fi

# --- install -----------------------------------------------------------------
DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$DEST"
for a in "${ASSETS[@]}"; do
  cp "$TMP/$a" "$DEST/$a"
done
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
    *) say "note: --enable needs python3; enable it in Settings -> Community plugins instead." ;;
  esac
else
  say "Next: open Obsidian -> Settings -> Community plugins -> enable \"Coder Engram\"."
  say "(A brand-new vault must first leave Restricted Mode on that screen.)"
fi
