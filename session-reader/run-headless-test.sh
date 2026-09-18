#!/bin/bash
# Source-mount headless test for dsh-session-reader.
#
# Usage:
#   SESSION_ID=session-xxxx ./run-headless-test.sh
#
# Requires `dsh` on PATH and a valid model credential.
set -u
: "${SESSION_ID:?set SESSION_ID to the session id you want to read}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY="${TMPDIR:-/tmp}/dsh-session-reader-overlay.yml"
cat > "$OVERLAY" <<YAML
- insert:
    - id: session-reader
      name: $REPO_DIR/index.js
YAML

PROMPT="请调用 session_read 工具读取 ${SESSION_ID}（参数 max_chars=14000，include_tool_calls=false，include_tool_results=false）。拿到工具返回结果后，请把该工具返回的文本原样作为最终回答输出，不要总结，不要使用 bash 或其它工具。"
exec dsh --profile headless --patch "$OVERLAY" "$PROMPT"
