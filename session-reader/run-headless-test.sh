#!/bin/bash
set -u
cd /home/zfq
export HOME=/home/zfq
export PATH=/home/zfq/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export NODE_OPTIONS=--max-old-space-size=6144
export DSH_TELEMETRY_DISABLED=1
PROMPT='请调用 session_read 工具读取 session-52f79a2a-ce83-4c7c-a85b-329769bb6d7a（参数 max_chars=14000，include_tool_calls=false，include_tool_results=false）。拿到工具返回结果后，请把该工具返回的文本原样作为最终回答输出，不要总结，不要使用 bash 或其它工具。'
exec /home/zfq/node24/bin/node /home/zfq/node24/bin/dsh --profile headless --patch /home/zfq/runGroup/dsh-plugins/session-reader/test-overlay.patch.yml "$PROMPT"
