#!/bin/bash
# Install dsh-ecs-n8n-gh into a DSH home (default ~/.dsh) as a home-level local
# plugin, without pnpm. Idempotent: re-running replaces the managed block.
#
# Overridable defaults: ECS_HOST, ECS_USER, ECS_PORT, ECS_SSH_KEY, DEPLOY_DIR,
# DSH_PROJECT_ROOT (local workspace), GH_REPO, N8N_CONTAINER.
set -euo pipefail

PLUGIN_ID="ecs-n8n-gh"
DIR_NAME="dsh-ecs-n8n-gh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-${HOME:-/home/zfq}/.dsh}"
DEST="$DSH_HOME/plugins/$DIR_NAME"
PATCH="$DSH_HOME/cordis.patch.yml"
MARK_BEGIN="# >>> dsh-plugins: $PLUGIN_ID >>>"
MARK_END="# <<< dsh-plugins: $PLUGIN_ID <<<"

ECS_HOST="${ECS_HOST:-}"
ECS_USER="${ECS_USER:-root}"
ECS_PORT="${ECS_PORT:-22}"
ECS_SSH_KEY="${ECS_SSH_KEY:-${SSH_KEY:-}}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/touhou-trpg}"
DSH_PROJECT_ROOT="${DSH_PROJECT_ROOT:-}"
GH_REPO="${GH_REPO:-}"
N8N_CONTAINER="${N8N_CONTAINER:-touhou-trpg-n8n}"

# Preserve values from a previous (possibly unmarked) install when the caller
# did not provide an override. This keeps a re-run from wiping a real ECS host
# or key path out of cordis.patch.yml.
preserve() {
  local key="$1" current="$2" found
  if [ -n "$current" ]; then printf '%s' "$current"; return; fi
  if [ -f "$PATCH" ]; then
    found="$(grep -m1 -E "^[[:space:]]*$key:[[:space:]]*" "$PATCH" 2>/dev/null \
      | sed -E "s/^[^:]+:[[:space:]]*//; s/[[:space:]]*$//; s/^['\"]//; s/['\"]$//" || true)"
    if [ -n "$found" ]; then printf '%s' "$found"; return; fi
  fi
  printf '%s' "$current"
}
ECS_HOST="$(preserve ecsHost "$ECS_HOST")"
ECS_USER="$(preserve ecsUser "$ECS_USER")"
ECS_PORT="$(preserve ecsPort "$ECS_PORT")"
ECS_SSH_KEY="$(preserve sshKey "$ECS_SSH_KEY")"
DEPLOY_DIR="$(preserve deployDir "$DEPLOY_DIR")"
DSH_PROJECT_ROOT="$(preserve workspace "$DSH_PROJECT_ROOT")"
GH_REPO="$(preserve ghRepo "$GH_REPO")"
N8N_CONTAINER="$(preserve n8nContainer "$N8N_CONTAINER")"

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
# Common ECS / n8n / GitHub Actions operations.
- insert:
    - id: $PLUGIN_ID
      name: ./plugins/$DIR_NAME/index.js
      config:
        ecsHost: '$ECS_HOST'
        ecsUser: '$ECS_USER'
        ecsPort: $ECS_PORT
        sshKey: '$ECS_SSH_KEY'
        deployDir: '$DEPLOY_DIR'
        composeFile: docker-compose.prod.yml
        n8nContainer: '$N8N_CONTAINER'
        workspace: '$DSH_PROJECT_ROOT'
        ghRepo: '$GH_REPO'
        maxOutput: 30000
$MARK_END
YAML

echo "installed $DIR_NAME -> $DEST"
echo "mounted by $PATCH (block: $MARK_BEGIN)"
if [ -z "$ECS_HOST" ] || [ -z "$ECS_SSH_KEY" ]; then
  echo "warn: ecsHost / sshKey are empty; edit the managed block in $PATCH or re-run with ECS_HOST / ECS_SSH_KEY." >&2
fi
