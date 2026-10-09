#!/bin/bash
# 开发机部署：把 registry.json 里的插件 symlink 到 $DSH_HOME/plugins/dsh-<id>
#
#   DSH_HOME=~/.dsh ./tools/link.sh              # 全部插件
#   DSH_HOME=~/.dsh ./tools/link.sh <id> [id...] # 指定插件
#
# 与 install.sh（copy 模式，分发用）配套：
#   - link 模式：改仓库源码即生效，不产生第二份可编辑副本（开发机用这个）
#   - copy 模式：install.sh <id>（分发用），遇到 symlink 会拒绝覆盖（FORCE=1 可强制）
# 挂载块（cordis.patch.yml）由各插件自己的 install.sh 维护；首次安装跑一次即可。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-${HOME:-/home/zfq}/.dsh}"
META_DIR="$DSH_HOME/plugins/.deployed-from"
mkdir -p "$META_DIR"

registry() {
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (process.argv[2] === "*") {
      for (const p of r.plugins) console.log(p.id);
    } else {
      const p = r.plugins.find((x) => x.id === process.argv[2]);
      if (p) process.stdout.write(p.dir);
    }
  ' "$REPO_DIR/registry.json" "$1"
}

ids=("$@")
if [ "${#ids[@]}" -eq 0 ]; then
  mapfile -t ids < <(registry '*')
fi

for id in "${ids[@]}"; do
  dir="$(registry "$id")"
  [ -n "$dir" ] || { echo "link: unknown plugin '$id' (see registry.json)" >&2; exit 3; }
  src="$REPO_DIR/$dir"
  dest="$DSH_HOME/plugins/dsh-$id"
  [ -d "$src" ] || { echo "link: missing source $src" >&2; exit 2; }

  if [ -L "$dest" ]; then
    rm -f "$dest"
  elif [ -e "$dest" ]; then
    mv "$dest" "$dest.bak.$(date +%Y%m%d%H%M%S)"
    echo "backed up old $dest"
  fi
  ln -sfn "$src" "$dest"

  ref="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'repo=%s\ndir=%s\nref=%s\nmode=link\ndeployed_at=%s\n' \
    "$REPO_DIR" "$dir" "$ref" "$(date -Is)" > "$META_DIR/dsh-$id.txt"
  echo "linked $dest -> $src ($ref)"
done
