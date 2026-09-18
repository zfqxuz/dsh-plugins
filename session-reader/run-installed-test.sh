#!/bin/bash
# Home-installed headless test for dsh-session-reader.
#
# Usage:
#   SESSION_ID=session-xxxx ./run-installed-test.sh
#
# Requires the plugin to be mounted in $DSH_HOME/cordis.patch.yml first.
set -u
: "${SESSION_ID:?set SESSION_ID to the session id you want to read}"

PROMPT="请调用已安装的 session_read 工具读取 ${SESSION_ID}（参数 max_chars=1600，include_tool_calls=false，include_tool_results=false）。拿到工具结果后，把工具返回的文本原样作为最终回答输出，不要使用 bash 或其它工具，也不要总结。"
exec dsh --profile headless "$PROMPT"
