# dsh-context-handoff

一个 DSH（DeepSeek Harness）插件：**当当前会话「可用上下文」不足阈值（默认 50%，即已用达到 50%）时，自动在当前工作区新开一个会话，把上一会话的摘要（recall）与完整日志指针交给新会话继续，并让 Web 界面无感自动切换过去。**

它解决的是「一个会话上下文快满，但任务还没做完」的问题：与其等 80% 阈值触发压缩、丢失细节，这个插件在 50% 已用（50% 可用）时提前把工作交接给一个干净的新会话。

## 行为

1. 监听会话的 `turn/end`（可配 `step-end`）。
2. 读取与 Web 上下文环相同的占用数据（`contextPressure` 投影，回退到 `tokenMeter.measure()` + `session.requestContext()`）。
3. 当 `可用 tokens / contextWindow < availableRatio`（默认 `0.5`）且会话处于 idle：
   - 在当前工作区（`session.header.cwd`）创建一个**普通新会话**，`parentSession` 指向父会话；
   - 新会话参加与父会话相同的 agent preset（`agentPresets.composeFrom`）；
   - 把上一会话的**摘要**（最近对话、TODO、最近工具活动、标题、goal）作为 `recall` 消息注入；
   - 默认自动开始新会话的接续回合（`autoContinue: true`）；
   - **冻结源会话**：注册一条作用域内的硬性 prompt context（禁止继续工作、禁止调用工具、禁止反问），并可同时隐藏/拒绝源会话的工具；
   - 给父会话注入一条 `notice`；若新会话首条消息落盘失败，会记录 warning。
4. 同一个源会话保留一条 active 交接记录：自动触发只交接一次；`context_handoff(action="handoff")` 默认**复用**已有接续会话，不会重复建会话（`new_session: true` 才强制新建）。
5. **浏览器伴随模块（client half）**：监听会话列表，发现「新出现且 `parentId` 等于当前选中会话」的非 subagent 会话时自动 `uiWorkspace.openSession(childId)`，把界面直接切过去。这样用户不需要手动点击新会话。

> 默认是 **fresh** 模式：新会话只带摘要，不带旧历史，因此上下文是干净的。摘要里会写明上一会话 id、`cwd`、日志文件路径，并提示模型可用 `session_read` 工具读取完整历史。若你更想要无损前缀，可以设置 `continueMode: seed`（从最后一个 `turn/end` 截断，等价于 DSH fork）。

## 无感自动切换是怎么实现的

DSH 的 host 插件没有切换浏览器当前会话的接口：`uiWorkspace.openSession()` 是客户端函数。因此本插件是**双面包**：

- host 半：`index.js`，负责检测阈值、创建接续会话、注入 recall、冻结旧会话；
- client 半：`client.js`，通过 `dsh.client` 声明为浏览器模块，监听 `ctx.sessions.list`，在合适时机调用 `uiWorkspace.openSession`。

`client.js` 的安全约束：

- 只处理 **激活之后新出现** 的会话，刷新页面不会把你拽进旧会话；
- 只处理 `parentId === 当前会话`、`origin !== 'subagent'`、非 blank 的行；
- 每个 child 只自动打开一次；
- 等第一个 `phase === 'ready'` 的快照后才开始判断；
- 暴露只读诊断对象 `window.__dshContextHandoff = { applied, opened, lastError }`。

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

安装脚本会把 `index.js` / `client.js` / `package.json` 复制到 `$DSH_HOME/plugins/dsh-context-handoff/`，并向 `$DSH_HOME/cordis.patch.yml` 写入（幂等、带 marker、自动清理旧的无 marker 安装）：

```yaml
# >>> dsh-plugins: context-handoff >>>
- insert:
    - id: context-handoff
      name: ./plugins/dsh-context-handoff/index.js
      config:
        availableRatio: 0.5
        autoContinue: true
        continueMode: fresh
        digestMaxChars: 12000
        freezeParent: true
        freezeTools: true
# <<< dsh-plugins: context-handoff <<<
```

> **必须重启 `dsh web`。** host 半可能被 hot-reload，但 client 半的包元数据（是否声明 `dsh.client`）会被 `dsh-client-modules` 缓存到进程结束；新增 `client.js` 后不重启不会出现在浏览器模块图里。

> 注意：`~/.dsh` 在 `workspace-write` 沙箱下不可写。请从普通终端运行安装脚本，或以 `danger-full-access` 模式运行。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `availableRatio` | `0.5` | 可用上下文比例低于此值触发（0.5 = 50% 可用 / 50% 已用） |
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
| `freezeParent` | `true` | 交接后冻结源会话：注册作用域内硬性 prompt context |
| `freezeTools` | `true` | 冻结时隐藏源会话全局工具，并用 guard 拒绝其全部工具调用 |
| `once` | `true` | 每个源会话只自动交接一次 |
| `includeSubagents` | `false` | 是否也处理子代理会话 |
| `cooldownMs` | `30000` | 两次自动交接之间的进程级最小间隔 |
| `dryRun` | `false` | 只记录/报告，不真正创建会话 |
| `toolName` | `context_handoff` | 模型工具名 |
| `commandName` | `handoff` | 人类 slash 命令名（不带 `/`） |

## 模型工具 `context_handoff`

| `action` | 作用 |
|---|---|
| `status`（默认） | 输出当前占用、阈值、是否会触发、已有接续会话 id |
| `check` | 仅当低于阈值时确保一条接续会话（已有则复用） |
| `handoff` | **强制**立即交接（绕过阈值；已有接续会话则复用） |
| `list` | 列出本次进程内最近的交接/跳过记录 |

可选参数 `new_session: true` 仅在 `action="handoff"` 时生效，用于强制新建一条接续会话。

## 人类命令

- `/handoff` — 按阈值检查并交接；
- `/handoff status` — 查看占用与已有接续会话；
- `/handoff force` — 强制交接（复用已有接续会话）。

## 已验证

1. **host 逻辑单测**：`node test/mock.test.mjs`（15 项：触发阈值、once、强制去重、`new_session`、dryRun、seed 截断、摘要、配置校验、freeze 开关、tokenMeter 回退）。
2. **client 逻辑单测**：`node test/client.test.mjs`（5 项：新 child 只开一次、pending→ready 基线、忽略 subagent/非 child、切换 current 后开新 child、effect 释放）。
3. **真实 headless DSH 集成测试**（`DSH_HOME` 指向可写目录，`--patch` 挂载本地插件）：
   - 工具 `handoff` 强制交接成功，创建子会话并在 `agent/inbox/spliced` 中写入 `form: recall` 的摘要；
   - `turn/end` 自动触发成功，子会话 `cwd` 继承父会话、`parentSession` 指向父会话；
   - 子会话确实自动接着跑 turn（实测 4 次工具调用后完成）。
4. **真实 Web 集成测试**（`dsh web` + Playwright Chromium）：
   - `dsh-client-modules` 从 home-level 文件挂载中发现 `dsh.client`，把 `dsh-context-handoff/client.js` 编入 `window.__DSH_BOOT__`（54 个 entry 之一）；
   - 浏览器加载无 console / page error，`window.__dshContextHandoff.applied === true`。

安装与启动后，可让模型执行：

```text
调用 context_handoff 工具，参数 action="status"
```

## 设计说明

- **为什么默认不 seed 全套历史**：父会话已经 50% 满，seed 会把同样的压力复制给子会话。默认只带有界摘要；需要完整历史时由模型调用 `session_read`。
- **为什么用 `recall` 消息**：DSH 的 `ContextForm` 专门为「从另一个会话日志提炼的材料」定义了 `recall`，语义正确且 UI 可识别。
- **为什么还要冻结旧会话**：client 切换是「尽力而为」的 UI 行为；如果用户在切换前继续在旧会话输入，冻结能保证旧会话不再重复干活。
- **只用 Node 内置模块**：host 半通过绝对路径挂载，不保证能解析 `@deepseek-ai/*`，因此只 `import 'node:*'`；client 半手写为 `window.__ModuleLoader__.load(...)` 格式，不 `require` 任何外部模块。
- **和自动压缩的关系**：DSH `compaction-basic` 默认在 80% 已用时压缩；本插件默认在 50% 已用时交接，先一步保住完整协作上下文。
