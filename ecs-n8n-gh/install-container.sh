#!/bin/sh
# In-container installer for dsh-ecs-n8n-gh: copies /src into /dsh/plugins and
# merges a mount block into /dsh/cordis.patch.yml. Idempotent.
#
# Configure through the environment (all optional at install time, required at
# tool call time):
#   ECS_HOST, ECS_USER, ECS_PORT, ECS_SSH_KEY, DEPLOY_DIR, DSH_PROJECT_ROOT,
#   GH_REPO, N8N_CONTAINER, DSH_UID
set -eu

DEST=/dsh/plugins/dsh-ecs-n8n-gh
PATCH=/dsh/cordis.patch.yml
MARK_BEGIN="# >>> dsh-plugins: ecs-n8n-gh >>>"
MARK_END="# <<< dsh-plugins: ecs-n8n-gh <<<"
DSH_UID="${DSH_UID:-1000}"

ECS_HOST="${ECS_HOST:-}"
ECS_USER="${ECS_USER:-root}"
ECS_PORT="${ECS_PORT:-22}"
ECS_SSH_KEY="${ECS_SSH_KEY:-}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/touhou-trpg}"
DSH_PROJECT_ROOT="${DSH_PROJECT_ROOT:-}"
GH_REPO="${GH_REPO:-}"
N8N_CONTAINER="${N8N_CONTAINER:-touhou-trpg-n8n}"

mkdir -p "$DEST"
cp /src/index.js "$DEST/index.js"
cp /src/package.json "$DEST/package.json"
[ -f /src/README.md ] && cp /src/README.md "$DEST/README.md"
chown -R "$DSH_UID:$DSH_UID" "$DEST"

touch "$PATCH"
if grep -q "$MARK_BEGIN" "$PATCH" 2>/dev/null; then
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip { print }
  ' "$PATCH" > "$PATCH.tmp"
  mv "$PATCH.tmp" "$PATCH"
fi

cat >> "$PATCH" <<YAML

$MARK_BEGIN
# Common ECS / n8n / GitHub Actions operations.
- insert:
    - id: ecs-n8n-gh
      name: ./plugins/dsh-ecs-n8n-gh/index.js
      config:
        ecsHost: '$ECS_HOST'
        ecsUser: '$ECS_USER'
        ecsPort: $ECS_PORT
        sshKey: '$ECS_SSH_KEY'
        deployDir: '$DEPLOY_DIR'
        n8nContainer: '$N8N_CONTAINER'
        workspace: '$DSH_PROJECT_ROOT'
        ghRepo: '$GH_REPO'
$MARK_END
YAML

chown "$DSH_UID:$DSH_UID" "$PATCH"
echo "installed dsh-ecs-n8n-gh"
