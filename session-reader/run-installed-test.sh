#!/bin/bash
set -u
cd /home/zfq
export HOME=/home/zfq
export PATH=/home/zfq/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export NODE_OPTIONS=--max-old-space-size=6144
export DSH_TELEMETRY_DISABLED=1
PROMPT='请调用已安装的 session_read 工具读取 session-52f79a2a-ce83-4c7c-a85b-329769bb6d7a（参数 max_chars=1600，include_tool_calls=false，include_tool_results=false）。拿到工具结果后，把工具返回的文本原样作为最终回答输出，不要使用 bash 或其它工具，也不要总结。'
exec /home/zfq/node24/bin/node /home/zfq/node24/bin/dsh --profile headless "$PROMPT"
