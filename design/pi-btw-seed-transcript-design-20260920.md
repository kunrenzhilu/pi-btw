# pi-btw contextual seed 文档化改造设计（seed-transcript）

- 日期：2026-09-20
- 分支：`feat/seed-transcript`（基于 `tom/local-main` @ 3d537c2）
- 状态：DRAFT — 待独立 judge 审计
- 作者：pi agent（tom 指令）

## 1. 背景与问题

### 1.1 现状

btw 的 contextual 模式 aside session 的上下文形态：

```
[system prompt]  = main 的完整 system prompt（含 AGENTS.md）+ BTW_SYSTEM_PROMPT 尾部
[seed messages]  = main session 当前分支的**全部历史消息**，以 user/assistant/toolResult
                   消息形态原样进入 aside 的消息数组（buildSessionContext 输出，
                   过滤 btw 可见消息）
[identity 对白]  = fresh-seed 身份锚（recency 位置，cc81d74 引入）
[thread 重放]    = 本 aside 线程的历史问答
[本轮 question]  = （≥7 轮时附 [aside-session reminder]）
```

### 1.2 问题的机制（实测证据）

1. **身份污染**：seed 里的 main 历史以"模型自己的消息"的形态存在（同 role 序列）。
   长会话中模型把 main 的 supervisor 第一人称叙事认领为自己的过去。实测案例
   （task75 supervisor session，09-20 10:07）：`/btw:new` 后第一问"你是aside还是main"，
   模型自称 main，并逐字引用 main 历史里对 aside 的第三人称叙述作为"证据"。
2. **上下文膨胀**：main 历史里的 thinking 块（明文+加密 reasoning 重放）占大量上下文。
   实测（同一 session）：仅思考明文 ≈ 57.7k tok（文件全量口径），另有加密 reasoning item
   随消息重放。aside 作为问答顾问，这些思考重放毫无用处。
3. **工具输出原样重放**：main 的 bash/读取结果以完整形态进入 aside 上下文，单条可达
   数万 token。

### 1.3 用户原始诉求

"既要主线上下文、又不要身份污染"——aside 保留回答主线上下文问题的能力
（"刚刚那个 taskid 是什么"、"现在是不是在 judge 阶段"），但不得再自称 main，
且上下文体积应显著缩减。

## 2. 目标 / 非目标

**目标**
- G1 aside 不再认领 main 身份（结构性消除，不依赖 prompt 锚的强弱）
- G2 保留主线上下文问答能力（信息一份不丢——thinking 除外，见非目标）
- G3 上下文体积显著缩减（丢弃 thinking + 截断工具输出）
- G4 现有 feature（身份锚、reminder、abort 落盘、handoff、ArrowUp、等宽）零回归

**非目标**
- 不改变 tangent 模式（本来无 seed）
- 不改变 aside 的工具集与"只回答不推进"纪律的执行方式（那属于行为层）
- 不做 seed 的增量更新/缓存优化（单 user message 形态本身可缓存，够用）
- 不动 handoff 的排除规则（aborted/error 轮仍不进交接）

## 3. 方案总览

### 3.1 形态对比

```
现行为：
  [system] [u1 a1 u2 a2 ... （main 原始消息流）] [identity对白] [thread] [q]

改造后：
  [system] [U_transcript：一条 user message，内含带角色标签的 main 会话文档]
           [identity对白] [thread] [q]
```

main 历史**降格为引用材料**：不再以对话消息形态存在，而是打包成一条 user message
里的文档，开头即声明：

> 以下是用户主会话的逐字记录，仅供查阅背景——你不是这些 assistant 消息的作者，
> 那段工作属于 main session 的另一个 agent。基于它回答问题，但不要把它当作
> 自己的过去继续推进。

模型读的是"文档"，身份认领的结构性根源（同 role 消息序列）被移除。

### 3.2 数据源（与现状完全同源，保证分支/压缩处理一致）

渲染输入 = `buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())`
产出的 message 列表（与现行 seed 的输入同源，同样过滤 `isVisibleBtwMessage`）。
即：分支选择、compaction 处理逻辑不变，只改**打包形态**。

### 3.3 渲染规则

文档结构：

```
[MAIN SESSION TRANSCRIPT — reference only]
<framing 声明（3.1 引文）>

--- [main] user ---
<user 文本>

--- [main] assistant ---
<assistant 可见文本>

--- [main] assistant → tool call: bash ---
<arguments JSON（截断）>

--- [main] tool result: bash ---
<结果文本（截断）>

--- [main] session compacted ---
<compaction summary 文本>

[... 更早的条目已省略 ...]        ← 触发全局上限时
```

规则表：

| 项 | 规则 |
|---|---|
| thinking 块 | **丢弃**（G3 主项；aside 问答不需要 main 的思考过程） |
| 加密 reasoning 重放 | 随消息形态一起消失（不再有消息形态） |
| tool call | 保留 name + arguments JSON，单条截断 2000 chars，超出加 `…[truncated]` |
| tool result 文本 | 单条截断 4000 chars，超出加 `…[truncated N chars]` |
| assistant/user 可见文本 | 不截断（异常巨大者受全局上限保护） |
| 图片块 | 占位 `[image omitted]` |
| compaction 条目 | 渲染为 `--- [main] session compacted ---` + summary 文本（这是重要上下文，不丢） |
| 空主历史 | 不生成 transcript 文档，仅保留 identity 对白（tangent 化退化，合法） |
| 全局上限 | 文档总字符 **200,000**（≈50k tok）：超限时**保最新弃最旧**，插入省略标记 |

### 3.4 与现有 feature 的组合

| feature | 影响 |
|---|---|
| identity 对白（fresh-seed 锚） | 保留，位于 transcript 文档之后（recency 端），文案不变 |
| ≥7 轮 reminder | 不变（附在 question 上，与 seed 形态无关） |
| abort 落盘 | 不变（thread entry 机制独立于 seed） |
| handoff（inject/summarize） | `sideThreadStartIndex` 语义不变：transcript 文档是 seed[0]，其后的 identity 对白与 thread 重放照旧被 `isBtwSeedMarkerPair` 剥离/提取。**无逻辑改动** |
| thread 重放 | 不变（问答对仍以消息形态重放——这是 aside **自己的**对话，必须保持消息形态） |

### 3.5 实施切分

- `renderMainTranscript(messages: Message[]): string` 纯函数 + 单元测试
- `buildBtwSeedState`：contextual 分支改为 `messages.push(transcriptUserMessage)`（替换原消息流展开）
- 现有 seed/identity 测试更新 + 新增渲染规则测试

## 4. 留给 judge 裁决的参数

1. **tool result 单条截断 4000 chars** 是否合适？（备选：2000 / 8000 / 不截断只靠全局上限）
2. **全局上限 200,000 chars** 是否合适？（备选：100k / 300k；保最新弃最旧的策略是否正确）
3. **是否需要回退开关**（如 `PI_BTW_SEED_RAW=1` 退回旧的消息形态）？我方倾向**不做**（少一个无人维护的分支路径；git revert 即回滚），judge 可否决
4. **compaction summary 是否该进 transcript**？我方倾向保留（它是 main 上下文的高密度摘要）
5. transcript 文档用**一条 user message** 承载（而非 system 附注）——judge 是否认为有更优承载位

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 截断导致 aside 答不准细节问题 | 全局上限保最新；单条截断有标记，模型可声明"记录已截断" |
| 单条大 user message 的模型注意力 | GLM/GPT/Claude 对长文档均正常；真出问题可回退 |
| 回归现有 feature | 测试套件（现 94 用例）必须全绿 + 新增渲染测试 |
| 回滚 | `git revert` 单 commit；无数据迁移、无持久化格式变化 |

## 6. 验收标准

1. `npx tsc --noEmit` 通过；`npx vitest --run` 全绿（现有用例仅 seed 形态断言需更新）
2. 新增单测覆盖渲染规则表全行：thinking 丢弃、tool call/result 截断、图片占位、
   compaction 渲染、全局上限保最新、空历史退化
3. handoff 测试（inject/summarize 不含 transcript 文档、不含 marker）保持全绿
4. 真机验证：长 main session（>100k tok）上 `/btw:new` 后第一问"你是谁"→ 自称 aside；
   "刚才的 taskid 是什么" → 能从 transcript 答
