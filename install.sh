#!/bin/bash
# dsh-plugins — installer / catalog for this repository.
#
#   ./install.sh list                 list catalog entries
#   ./install.sh all                  install every plugin into $DSH_HOME
#   ./install.sh <id> [...]           install one plugin
#   ./install.sh bundle <id>          print the official `dsh plugin add` command
#
# Environment:
#   DSH_HOME   target DSH home (default: ~/.dsh)
#
# The per-plugin installers are idempotent and write a managed marker block
# into $DSH_HOME/cordis.patch.yml, so re-running never duplicates mounts.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-${HOME:-/home/zfq}/.dsh}"
export DSH_HOME

ids() {
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const p of r.plugins) console.log([p.id, p.package, p.version, p.description].join("\t"));
  ' "$REPO_DIR/registry.json"
}

usage() {
  cat <<'USAGE'
Usage: ./install.sh <command> [id]

Commands:
  list              List plugins in registry.json
  all               Install every plugin into $DSH_HOME/plugins + cordis.patch.yml
  <id>              Install one plugin (context-handoff | session-reader | ecs-n8n-gh)
  bundle <id>       Print the official `dsh plugin --profile web add` command

Environment: DSH_HOME (default ~/.dsh)
USAGE
}

resolve_plugin_dir() {
  local id="$1"
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const p = r.plugins.find((x) => x.id === process.argv[2]);
    if (!p) process.exit(3);
    process.stdout.write(p.dir);
  ' "$REPO_DIR/registry.json" "$id" 2>/dev/null
}

cmd="${1:-}"
if [ -z "$cmd" ]; then usage; exit 1; fi
shift || true

case "$cmd" in
  list|ls)
    printf '%-18s %-22s %-8s %s\n' "ID" "PACKAGE" "VERSION" "DESCRIPTION"
    while IFS=$'\t' read -r id pkg ver desc; do
      printf '%-18s %-22s %-8s %s\n' "$id" "$pkg" "$ver" "$desc"
    done < <(ids)
    ;;
  bundle)
    id="${1:-}"
    [ -n "$id" ] || { echo "install: bundle needs a plugin id" >&2; exit 1; }
    dir="$(resolve_plugin_dir "$id")" || { echo "install: unknown plugin '$id'" >&2; exit 1; }
    echo "dsh plugin --profile web add $REPO_DIR/$dir"
    echo "# or from GitHub:"
    echo "dsh plugin --profile web add github:zfqxuz/dsh-plugins#path:/$dir"
    ;;
  all)
    install_failed=0
    while IFS=$'\t' read -r id _pkg _ver _desc; do
      if [ -x "$REPO_DIR/$id/install.sh" ] || [ -f "$REPO_DIR/$id/install.sh" ]; then
        echo "== installing $id =="
        DSH_HOME="$DSH_HOME" bash "$REPO_DIR/$id/install.sh" || install_failed=1
      else
        echo "warn: $id has no install.sh; use './install.sh bundle $id'" >&2
      fi
    done < <(ids)
    exit "$install_failed"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    id="$cmd"
    dir="$(resolve_plugin_dir "$id")" || { echo "install: unknown plugin '$id' (try './install.sh list')" >&2; exit 1; }
    if [ ! -f "$REPO_DIR/$dir/install.sh" ]; then
      echo "install: $id has no home-level installer; use './install.sh bundle $id'" >&2
      exit 2
    fi
    exec env DSH_HOME="$DSH_HOME" bash "$REPO_DIR/$dir/install.sh"
    ;;
esac
