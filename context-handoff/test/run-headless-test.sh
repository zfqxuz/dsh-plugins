#!/bin/bash
# Optional integration test: boots a real DSH headless profile against an
# isolated writable DSH_HOME, mounts this plugin with a very high trigger
# ratio, and asks the model to force one handoff.
#
# Requirements:
#   - `dsh` on PATH (v0.1.5-rc or newer)
#   - a DeepSeek credential in $HOME/.dsh/.credentials.yaml (copied, never printed)
#   - network access for the model call
#
# Usage: test/run-headless-test.sh /tmp/dsh-handoff-verify
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="${1:-/tmp/dsh-handoff-verify}"
OVERLAY="$TEST_HOME/handoff-overlay.yml"

command -v dsh >/dev/null 2>&1 || { echo "dsh not found on PATH" >&2; exit 2; }

rm -rf "$TEST_HOME"
mkdir -p "$TEST_HOME/home"
if [ -f "${HOME}/.dsh/.credentials.yaml" ]; then
  cp "${HOME}/.dsh/.credentials.yaml" "$TEST_HOME/home/.credentials.yaml"
  chmod 600 "$TEST_HOME/home/.credentials.yaml"
else
  echo "warn: no ${HOME}/.dsh/.credentials.yaml; set DEEPSEEK_API_KEY instead" >&2
fi

cat > "$OVERLAY" <<YAML
- insert:
    - id: context-handoff
      name: $PLUGIN_DIR/index.js
      config:
        availableRatio: 0.999
        cooldownMs: 0
        autoContinue: false
        digestMaxChars: 3000
        digestMaxMessages: 10
YAML

before="$(find "$TEST_HOME/home/sessions" -name 'session.v*.jsonl.zstd' 2>/dev/null | wc -l)"
echo "sessions before: $before"

cd "$TEST_HOME"
DSH_HOME="$TEST_HOME/home" DSH_TELEMETRY_DISABLED=1 \
  dsh --profile headless --patch "$OVERLAY" \
  'Call the context_handoff tool with action="handoff". Then output the tool result text verbatim. Do not use any other tool.'

after="$(find "$TEST_HOME/home/sessions" -name 'session.v*.jsonl.zstd' 2>/dev/null | wc -l)"
echo "sessions after: $after"
if [ "$after" -le "$before" ]; then
  echo "FAIL: no continuation session was persisted" >&2
  exit 1
fi
echo "PASS: continuation session persisted; inspect $TEST_HOME/home/sessions"
