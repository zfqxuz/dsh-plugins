# 会话迁移契约（session-transfer）

状态：基线 v1（2026-10-09）。实现排期：阶段 1。
目的：让「上下文交接」与「会话归属」解耦 —— handoff 只决定何时换会话、换过去带什么；
       谁持有新会话由**当前绑定方**决定，插件不假设存在浏览器客户端。

## 不变量
1. 一个 session id 任一时刻只有一个 write handle（DSH 保证，不可绕过）。
2. 一个 chatKey 任一时刻只绑定一个 session，且只有一处写入函数。
3. 每次迁移是一个事务：requested -> claimed -> committed（或 aborted），严格排他。
4. 抢不到会话时**不得新建会话来掩盖**（禁止静默 fork）。
5. 只读观察不获取 write handle，不改变归属。
6. 接续会话由**接手方**创建（谁持有谁创建），避免"建完再移交写权"的竞态。

## 事件
- context-handoff/requested
  { fromSessionId, cwd, reason, digest, availableRatio, used, contextWindow, deadlineMs }
  插件发出，等待认领窗口（默认 2s）。
- context-handoff/claimed
  { fromSessionId, by }   by 例：qq-bridge:u:2493922172。排他：先到先得。
- context-handoff/committed
  { fromSessionId, toSessionId, by, mode }   mode: consumer-created | plugin-created
- context-handoff/aborted
  { fromSessionId, by, error }   认领后创建失败，控制权交回插件（插件随后自建）。

媒介：优先进程内事件总线；若 ctx.emit 不可用，退化为监听 session/created 中
header.parentSession === 绑定会话（语义等价，零内核改动）。

## 认领时序
1. 插件判定触发（turn/end + 压力 + idle + once + cooldown）后广播 requested。
2. 消费者（QQ 桥接）判断 fromSessionId 是否为自己的绑定会话；是则回 claimed。
3. 消费者用自己的创建路径建新会话：**按 chatKey 的角色**重建 preset / 权限 preset / cwd、
   挂自己的系统提示与会话工具、注入 recall 摘要、flush 落盘。
4. 消费者更新绑定（单一事实源）并向用户发一条"已换到新会话继续"的通知，然后广播 committed。
5. 插件收到 committed 后冻结父会话（freezeParent / freezeTools 按配置生效），并把
   once/children 状态落盘（避免宿主重启后重复交接）。
6. 创建失败 -> 消费者广播 aborted -> 插件按"无人认领"分支自行创建（严格二选一）。

## 无人认领分支（纯浏览器场景）
插件保持现行为：自建子会话 + autoContinue + 冻结父会话；浏览器 client 半负责切 UI。
因此 client 半保留，不删除。

## 消费者义务（QQ 桥接）
- 绑定会话被判定为交接源时才认领；非绑定会话只做只读观察。
- 认领必须按角色重建会话组合（角色在会话创建/续接时固化，见 SPEC-identity.md §3.2）。
- 迁移期间该 chatKey 的新消息投给新绑定或排队，绝不落回旧会话。
- 启动时对账：沿 header.parentSession 找到同一工作区里最新的后代会话并重绑。
  （注意：只有 handoff 子会话带 parentSession；桥接旧版静默 fork 出来的会话没有该字段，无法自动连回。）

## guest / 群聊
不迁移。这类会话只做原地 compaction（避免"交接给一个用户打不开的会话"）。

## 验收
- 无消费者时不回归（浏览器路径行为不变）。
- 从 QQ 触发的交接，下一条 QQ 消息在新会话继续，父会话不再回话。
- 认领/创建失败时不产生第二个会话。
