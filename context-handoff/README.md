# dsh-context-handoff

一个 DSH（DeepSeek Harness）插件：**当当前会话「可用上下文」不足阈值（默认 30%）时，自动在当前工作区新开一个会话，并把上一个会话的摘要（recall）与完整日志指针交给新会话继续。**

它解决的是「一个会话上下文快满，但任务还没做完」的问题：与其等 80% 阈值触发压缩、丢失细节，这个插件在 70% 已用（30% 可用）时提前把工作交接给一个干净的新会话。

## 行为

1. 监听会话的 `turn/end`（可配 `step-end`）。
2. 读取与 Web 上下文环相同的占用数据（`contextPressure` 投影，回退到 `tokenMeter.measure()` + `session.requestContext()`）。
3. 当 `可用 tokens / contextWindow < availableRatio`（默认 0.3）且会话处于 idle：
   - 在当前工作区（`session.header.cwd`）创建一个**普通新会话**；
   - 新会话参加与父会话相同的 agent preset（`agentPresets.composeFrom`）；
   - 把上一会话的**摘要**（最近对话、TODO、最近工具活动、标题、goal）作为 `recall` 消息注入；
   - 默认自动开始新会话的接续回合（`autoContinue: true`）；
   - 给父会话注入一条 `notice`，提醒模型后续到新会话继续；
   - 若新会话首条消息落盘失败，会记录 warning。
4. 同一个源会话默认只自动交接一次（`once: true`）。

> 默认是 **fresh** 模式：新会话只带摘要，不带旧历史，因此上下文是干净的。摘要里会写明上一会话 id、`cwd`、日志文件路径，并提示模型可用 `session_read` 工具读取完整历史。若你更想要无损前缀，可以设置 `continueMode: seed`（从最后一个 `turn/end` 截断，等价于 DSH fork）。

## 安装方式 A：官方 profile 插件（推荐，DSH 自动发现）

每个插件目录本身就是一个带 `dsh.bundle` 的包。先克隆本仓库，然后：

```bash
# 本地路径（需要 pnpm）
dsh plugin --profile web add /path/to/dsh-plugins/context-handoff

# 或者直接从 GitHub 安装
dsh plugin --profile web add github:zfqxuz/dsh-plugins#path:/context-handoff
```

`dsh plugin` 会把包装进 profile 的 `node_modules`，并因为 `dsh.bundle.patch` 自动把它加入 profile 层。重启 `dsh web` 后生效。

## 安装方式 B：home-level 本地插件（无需 pnpm）

```bash
cd /path/to/dsh-plugins
./install.sh context-handoff          # 默认写 ~/.dsh
# 或指定 DSH_HOME：
DSH_HOME=/path/to/dsh-home ./install.sh context-handoff
```

安装脚本会把 `index.js` / `package.json` 复制到 `$DSH_HOME/plugins/dsh-context-handoff/`，并向 `$DSH_HOME/cordis.patch.yml` 写入（幂等、带 marker）：

```yaml
# >>> dsh-plugins: context-handoff >>>
- insert:
    - id: context-handoff
      name: ./plugins/dsh-context-handoff/index.js
      config:
        availableRatio: 0.3
# <<< dsh-plugins: context-handoff <<<
```

`dsh web` 的 `patchReload: live` 会在下一次配置扫描时加载它；否则重启 web 进程。

> 注意：`~/.dsh` 在 `workspace-write` 沙箱下不可写。请从普通终端运行安装脚本，或以 `danger-full-access` 模式运行。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `availableRatio` | `0.3` | 可用上下文比例低于此值触发（0.3 = 30% 可用 / 70% 已用） |
| `contextWindow` | `0` | 会话没记录 contextWindow 时的回退值；0 表示不提供 |
| `minUsedTokens` | `0` | 已用 token 低于此值不触发 |
| `checkOn` | `turn-end` | 检查边界：`turn-end` 或 `step-end` |
| `autoContinue` | `true` | 是否自动在新会话开始接续回合（false 则只注入 recall，等用户发话） |
| `continueMode` | `fresh` | `fresh`（摘要）或 `seed`（fork 已完成回合前缀） |
| `digestMaxChars` | `12000` | recall 摘要字符上限 |
| `digestMaxMessages` | `30` | 摘要保留的 user/assistant 消息数上限 |
| `digestMaxToolEvents` | `16` | 摘要保留的 tool call/result 对数上限 |
| `digestIncludeToolCalls` | `true` | 摘要是否包含工具活动 |
| `notifyParent` | `true` | 是否向父会话注入 notice |
| `once` | `true` | 每个源会话只自动交接一次 |
| `includeSubagents` | `false` | 是否也处理子代理会话 |
| `cooldownMs` | `30000` | 两次自动交接之间的进程级最小间隔 |
| `dryRun` | `false` | 只记录/报告，不真正创建会话 |
| `toolName` | `context_handoff` | 模型工具名 |
| `commandName` | `handoff` | 人类 slash 命令名（不带 `/`） |

## 模型工具 `context_handoff`

| `action` | 作用 |
|---|---|
| `status`（默认） | 输出当前占用、阈值、是否会触发、是否已交接 |
| `check` | 仅当低于阈值时触发一次交接 |
| `handoff` | **强制**立即交接（绕过阈值与 once） |
| `list` | 列出本次进程内最近的交接/跳过记录 |

## 人类命令

- `/handoff` — 按阈值检查并交接；
- `/handoff status` — 查看占用；
- `/handoff force` — 强制交接。

## 已验证

1. **逻辑单测**：`node test/mock.test.mjs`（11 项，覆盖触发阈值、once、强制交接、dryRun、seed 截断、摘要、配置校验、tokenMeter 回退）。
2. **真实 headless DSH 集成测试**（`DSH_HOME` 指向可写目录，`--patch` 挂载本地插件）：
   - 工具 `handoff` 强制交接成功，创建子会话并在 `agent/inbox/spliced` 中写入 `form: recall` 的摘要；
   - `turn/end` 自动触发成功，子会话 `cwd` 继承父会话、`parentSession` 指向父会话；
   - 实测 `availableAtTrigger ≈ 99.3%`（测试把阈值设为 0.999 以便立即触发；真实默认 30%）。

安装与启动后，可让模型执行：

```text
调用 context_handoff 工具，参数 action="status"
```

## 设计说明

- **为什么默认不 seed 全套历史**：父会话已经 70% 满，seed 会把同样的压力复制给子会话。默认只带有界摘要；需要完整历史时由模型调用 `session_read`。
- **为什么用 `recall` 消息**：DSH 的 `ContextForm` 专门为「从另一个会话日志提炼的材料」定义了 `recall`，语义正确且 UI 可识别。
- **只用 Node 内置模块**：插件通过绝对路径挂载，不保证能解析 `@deepseek-ai/*`，因此只 `import 'node:*'`；所有 DSH 服务都通过 `ctx.get()` 可选获取，缺失时优雅降级。
- **和自动压缩的关系**：DSH `compaction-basic` 默认在 80% 已用时压缩；本插件默认在 70% 已用时交接，先一步保住完整协作上下文。
