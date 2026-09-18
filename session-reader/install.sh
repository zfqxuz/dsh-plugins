#!/bin/bash
# Install dsh-session-reader into a DSH home (default ~/.dsh) as a home-level
# local plugin, without pnpm. Idempotent: re-running replaces the managed block.
set -euo pipefail

PLUGIN_ID="session-reader"
DIR_NAME="dsh-session-reader"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-${HOME:-/home/zfq}/.dsh}"
DEST="$DSH_HOME/plugins/$DIR_NAME"
PATCH="$DSH_HOME/cordis.patch.yml"
MARK_BEGIN="# >>> dsh-plugins: $PLUGIN_ID >>>"
MARK_END="# <<< dsh-plugins: $PLUGIN_ID <<<"

for f in index.js package.json; do
  if [ ! -f "$SRC_DIR/$f" ]; then
    echo "install: missing $SRC_DIR/$f" >&2
    exit 2
  fi
done

mkdir -p "$DEST" "$DSH_HOME"
install -m 0644 "$SRC_DIR/index.js" "$DEST/index.js"
install -m 0644 "$SRC_DIR/package.json" "$DEST/package.json"
[ -f "$SRC_DIR/cordis.patch.yml" ] && install -m 0644 "$SRC_DIR/cordis.patch.yml" "$DEST/cordis.patch.yml"
[ -f "$SRC_DIR/README.md" ] && install -m 0644 "$SRC_DIR/README.md" "$DEST/README.md"

if [ -f "$PATCH" ]; then
  cp -f "$PATCH" "$PATCH.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
fi

PATCH_TOOL="$SRC_DIR/../tools/patch-blocks.mjs"
if [ -f "$PATCH_TOOL" ] && command -v node >/dev/null 2>&1; then
  # Removes the managed marker block AND any legacy unmarked insert for this id.
  node "$PATCH_TOOL" remove "$PATCH" "$PLUGIN_ID" || true
elif [ -f "$PATCH" ]; then
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip { print }
  ' "$PATCH" > "$PATCH.tmp"
  mv "$PATCH.tmp" "$PATCH"
fi
if [ ! -f "$PATCH" ]; then
  printf '# DSH home-level user patch layer.\n' > "$PATCH"
fi

cat >> "$PATCH" <<YAML

$MARK_BEGIN
# Read another conversation transcript by session id.
- insert:
    - id: $PLUGIN_ID
      name: ./plugins/$DIR_NAME/index.js
$MARK_END
YAML

echo "installed $DIR_NAME -> $DEST"
echo "mounted by $PATCH (block: $MARK_BEGIN)"
