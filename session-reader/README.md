# dsh-session-reader

一个 DSH（DeepSeek Harness）插件：通过 `session_id` 读取另一个对话的
`session.vN.jsonl.zstd` 日志，并向模型注册一个 `session_read` 工具。

## 安装位置

- 插件代码：`~/.dsh/plugins/dsh-session-reader/`
- 挂载配置：`~/.dsh/cordis.patch.yml`
  - `id: session-reader`
  - `name: ./plugins/dsh-session-reader/index.js`
- 本仓库源码：`/home/zfq/runGroup/dsh-plugins/session-reader/`

`~/.dsh/cordis.patch.yml` 是 DSH 的 home-level user patch layer，
会叠加到所有 profile；当前 `dsh web` 进程在 `patchReload: live` 下会自动重载。

## 工具 `session_read`

参数：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `session_id` | string | 必填 | 例如 `session-52f79a2a-ce83-4c7c-a85b-329769bb6d7a`，也可以传 session 目录或 `.jsonl.zstd` 路径 |
| `max_chars` | integer | `200000` | 返回的最大字符数；`<= 0` 表示不截断 |
| `include_reasoning` | boolean | `false` | 是否包含模型 reasoning |
| `include_tool_calls` | boolean | `false` | 是否包含工具调用名称和参数 |
| `include_tool_results` | boolean | `false` | 是否包含工具结果正文（可能非常大） |

默认只输出 user/assistant 的文本正文，因此通常得到适合 LLM 阅读的对话记录。

## 已验证

已通过 headless DSH agent 调用已安装插件读取真实会话日志，验证了多帧 Zstandard
解压、工具注册与转录渲染。

本地验证导出（`verification/session-52-transcript.txt`）包含真实对话内容，
因此 **不随本仓库分发**（见 `.gitignore`）。需要复现时请对自己的会话运行：

```text
调用 session_read 工具读取 <你的 session_id>
```

## 多帧 Zstd 说明

DSH 的 `.jsonl.zstd` 是“追加式 concatenated multi-frame Zstandard”容器，
不是单个 zstd 帧。`node:zlib.zstdDecompressSync()` 只解第一帧，
所以插件内实现了结构化 frame 扫描，再逐帧解压，避免漏掉整个会话。
