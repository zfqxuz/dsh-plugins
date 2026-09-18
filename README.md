# dsh-plugins

一组可被发现、可直接安装的 **DSH（DeepSeek Harness）插件**。

每个插件都是一个自包含的 ESM 包，只依赖 Node 内置模块；既可以通过 DSH 官方的 profile bundle 机制安装，也可以用本仓库的 `install.sh` 以 home-level 本地插件方式挂载。

> 仓库：<https://github.com/zfqxuz/dsh-plugins>
> DSH 版本：`0.1.5-rc` 及以上（插件 API：`ctx.tools.register` / `ctx.commands.register` / `ctx.on('session/event')`）

## 目录

| 插件 | 包名 | 作用 |
|---|---|---|
| [context-handoff](./context-handoff/README.md) | `dsh-context-handoff` | 可用上下文不足 30% 时，在当前工作区新开会话，并把上一会话的 `recall` 摘要与完整日志指针交给新会话继续 |
| [session-reader](./session-reader/README.md) | `dsh-session-reader` | 通过 `session_id` 读取另一个会话的完整转录（多帧 Zstandard），注册 `session_read` 工具 |
| [ecs-n8n-gh](./ecs-n8n-gh/README.md) | `dsh-ecs-n8n-gh` | ECS SSH、n8n 工作流部署、GitHub Actions 查询，注册 `ecs_*` / `n8n_*` / `gh_*` 工具 |

三个插件可以单独安装，也可以一起安装。`context-handoff` 与 `session-reader` 是天然搭档：交接时只带摘要，模型需要细节时调用 `session_read` 读取完整历史。

## 快速开始

### 方式 A：官方 profile bundle（推荐，DSH 自动发现并激活）

每个插件目录都声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会把它装进 profile 并自动加入 profile 层。需要 `pnpm`。

```bash
git clone https://github.com/zfqxuz/dsh-plugins.git
cd dsh-plugins

# 安装单个插件（本地路径）
dsh plugin --profile web add ./context-handoff
dsh plugin --profile web add ./session-reader
dsh plugin --profile web add ./ecs-n8n-gh

# 或直接从 GitHub 安装
dsh plugin --profile web add github:zfqxuz/dsh-plugins#path:/context-handoff
```

安装后重启 `dsh web`。`ecs-n8n-gh` 需要在自己的 profile `cordis.patch.yml`（用户层）里按 `id: ecs-n8n-gh` 覆盖 `config:`，因为 bundle 里是中性占位配置。

### 方式 B：home-level 本地插件（无需 pnpm）

```bash
git clone https://github.com/zfqxuz/dsh-plugins.git
cd dsh-plugins

./install.sh list                 # 查看目录
./install.sh context-handoff      # 安装一个
./install.sh all                  # 全部安装

# 指定 DSH home（默认 ~/.dsh）：
DSH_HOME=/path/to/dsh-home ./install.sh context-handoff

# ecs-n8n-gh 的必填配置：
ECS_HOST=203.0.113.10 ECS_SSH_KEY=~/.ssh/id_ed25519 GH_REPO=me/repo \
  ./install.sh ecs-n8n-gh
```

安装脚本会：

1. 把插件复制到 `$DSH_HOME/plugins/<package>/`；
2. 在 `$DSH_HOME/cordis.patch.yml` 写入带 marker 的 `insert` 块；
3. 先移除同一 `id` 的旧 block（包括没有 marker 的手工安装遗留项），因此重复执行不会产生重复挂载；
4. 修改前把旧 patch 备份为 `cordis.patch.yml.bak.<timestamp>`；
5. `ecs-n8n-gh` 会从旧 patch 中保留已有的 `ecsHost` / `sshKey` / `ghRepo` 等值，除非显式传环境变量覆盖。

`dsh web` 的 `patchReload: live` 会在下一次配置扫描时加载；否则重启 web 进程。

> `~/.dsh` 在 `workspace-write` 沙箱下默认不可写。请在普通终端运行安装脚本，或以 `danger-full-access` 权限运行。

## 插件发现（for other DSH）

仓库根目录的 [`registry.json`](./registry.json) 是机器可读目录：

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "context-handoff",
      "package": "dsh-context-handoff",
      "dir": "context-handoff",
      "entry": "context-handoff/index.js",
      "mount": { "id": "context-handoff", "name": "./plugins/dsh-context-handoff/index.js" },
      "defaultConfig": { "availableRatio": 0.3 },
      "tools": ["context_handoff"],
      "commands": ["handoff"]
    }
  ]
}
```

外部工具/脚本可以：

```bash
curl -fsSL https://raw.githubusercontent.com/zfqxuz/dsh-plugins/main/registry.json | jq .
# 列出
./install.sh list
# 生成官方安装命令
./install.sh bundle context-handoff
```

## 安全

- 所有插件只 `import 'node:*'`，不引入第三方依赖，也不随仓库分发任何密钥。
- 仓库中 **不包含** 任何 API key、SSH 私钥、会话转录或真实主机配置；`ecs-n8n-gh` 的 host / key / repo 均由安装时的 `config:` 或环境变量提供。
- `session-reader` 只读取本机 `$DSH_HOME/sessions` 下的 DSH 日志；日志中的对话内容不会离开本机，除非模型主动把工具结果发给 LLM。

## 验证

```bash
# context-handoff 逻辑单测（11 项，无需 DSH/网络）
node context-handoff/test/mock.test.mjs

# 可选的真实 headless DSH 集成测试（会调用模型，消耗额度）
context-handoff/test/run-headless-test.sh /tmp/dsh-handoff-verify
```

真实 headless 集成测试已在 `dsh 0.1.5-rc.1` / `deepseek-flash` 上跑通：

- 工具 `context_handoff(action=handoff)` 成功创建子会话；
- 子会话 `agent/inbox/spliced` 中出现 `source: { kind: "plugin", plugin: "context-handoff", form: "recall" }` 的摘要消息；
- `turn/end` 自动触发路径同样成功，子会话继承父会话 `cwd`，`parentSession` 指向父会话。

## 仓库结构

```
dsh-plugins/
├── registry.json               # 机器可读插件目录
├── install.sh                  # 目录 / 批量安装入口
├── context-handoff/            # 插件 1（含 index.js / package.json / cordis.patch.yml / test/）
├── session-reader/             # 插件 2
└── ecs-n8n-gh/                 # 插件 3
```

## License

MIT
