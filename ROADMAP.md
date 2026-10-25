# Roadmap

Each phase maps to a capability the Agent Harness job postings actually test. The right-hand column is the interview question it prepares you to answer.

## Phase 0 — 骨架 ✅

- [x] pi RPC client: JSONL framing, id correlation, event stream, dispose
- [x] SQLite state: tasks + events, WAL
- [x] serial worker, stale-task reaping (crash recovery)
- [x] CLI: doctor / login / ask / worker / list / show
- [x] isolated pi config dir, `--no-session`, `--no-approve`

> "为什么执行器不连数据库？崩溃时你怎么恢复？"

## Phase 1 — 让任务真的能跑（阻塞在凭证）

- [ ] `login` 成功绑定一个 provider（DeepSeek / Claude / OpenAI 兼容 / 本地）
- [ ] 成功执行第一个真实任务，跑通流式输出 + 工具事件
- [ ] 验证 `agent_settled` 与重试、compaction 的交互
- [ ] 把 `data/pi` 的会话文件接入 task replay

> "一次 run 的结束条件是什么？`agent_end` 和 `agent_settled` 差在哪？"

## Phase 2 — 三层记忆（v3）✅

**层一：证据事件绑定**
- [x] `conversation_events` 追加日志，每条消息有全局编号 `#1024 | user_1`
- [x] 提炼输入是编号事件流，不是纯文本
- [x] `evidence_event_id` + `evidence_quote` **对该事件单独校验**（跨条拼接会被拒）
- [x] 历史任务自动回填为事件（v2 → v3 迁移）

**层二：多主体与消歧**
- [x] `target` 四种结构：current_speaker / named_member(name) / current_group / self
- [x] 禁止代词，转述必须归属被提及的人（"张三说李四不吃辣" → 李四）
- [x] 派生 `subject`（user / member:xxx / group / agent）用于 key、注入与过滤

**层三：状态冲突裁决**
- [x] 四态动作：create / correct / invalidate / contest，correct 必填 `target_fact_id`
- [x] 提炼时把「已有记忆（带 ID 与 state）」作为上下文喂入
- [x] DB 裁定：create 撞 key → correct；无目标 correct → create；无目标 invalidate/contest → 拒绝
- [x] `contest` 双行标争议，**争议项不注入**，`resolve <key> <id>` 人工裁决
- [x] 单槽唯一、历史状态化保留（superseded / invalidated / contested）

**通用**
- [x] 批处理触发：累积 N 轮（默认 10）或闲置 M 分钟（默认 15）
- [x] 可重试：输出非 JSON 时不标记已提炼
- [x] 注入：importance + 新近度，1800 字符预算，运行时注入
- [x] `MEMORY.md` 渲染（活跃 / 争议 / 历史三段）
- [ ] 群聊多发言者：目前只有 user_1 与 agent，需要 IM 接入后才有真实 speaker 集合
- [ ] 争议自动收敛：同一冲突被多次提及时，是否升级为必须人工裁决

> "上下文窗口满了怎么办？压缩会丢什么？你怎么验证没丢关键信息？"

## Phase 2.5 — 会话上下文（A 阶段）✅

- [x] `src/context.ts`：最近 N 条消息 + 字符预算，纯函数、可单测
- [x] 预算从最新往回收（最新的消息永不被挤掉；单条超长也保留）
- [x] 拼装顺序：长期记忆 → 最近对话 → 当前消息
- [x] 每任务记录 `context_injected {ids, messages, chars}`，事后可查"它当时看到了什么"
- [x] 8 项单测（顺序/标签/取最新/预算截断/空历史/角色过滤）
- [x] A/B 验证：上一轮才出现的事实，带窗口能答对，空线程直接反问"请告诉我型号"
- [x] B 阶段：`thread_state` 滚动摘要 + 游标 + 触发压缩
  - [x] 结构化摘要（已确认事实 / 用户指令 / 未决问题 / 关键实体），≤1200 字符
  - [x] 压缩失败不推进游标（可重试），且不影响当轮回答
  - [x] 摘要是派生视图：源事件全量保留，可重算
  - [x] `pi-rt thread <thread>` 查看游标与摘要
  - [x] 验证：窗口缩到 1 条时，仍能仅凭摘要答出「Orion-7 / 王工」
- [x] 摘要评测：`pi-rt eval-context`（10 短例 + 5 压力例，基线=固定窗口无摘要 vs 系统=窗口+摘要）
  - 短会话：基线 10/10，系统 10/10（摘要无增量）
  - 长会话（20–25 轮）：基线 **0/5**，系统 **5/5**（事实被挤出窗口，摘要全部捞回）
  - 平均摘要 145–234 字符，远小于原文
- [ ] 边界：几百轮以上时摘要的衰减曲线（当前只测到 25 轮）
- [ ] 检索：优先用 bigram 相似度；FTS5 的 trigram 对 2 字中文失效（已实测）

> "压缩会丢什么？你怎么验证没丢关键信息？"

## Phase 2.6 — 可靠性与预算 ✅

- [x] 重试：按错误分类（429/5xx/网络/子进程退出 可重试；缺 key/模型不存在/401/超预算 不可重试）
- [x] 指数退避 + full jitter + 上限；`sleep` 可注入以便测试
- [x] 以「任务」为重试单位，每次尝试新起 pi 进程；用户消息只记一次（重试不制造第二条事件/记忆）
- [x] 并发门 `Gate`：`maxConcurrent` + `minIntervalMs`（并发数表达不了"每分钟最多几次"）
- [x] 预算用 **provider 真实用量**（`totalTokens` + `cost.total` 对象），每日上限 + 单任务上限
- [x] 失败也记账（失败的尝试同样烧 token）
- [x] 实测：超预算 449ms 内拒绝、零 token；不可重试错误 2.3s 内失败、无退避
- [ ] 检索（可选）：bigram 优先；FTS5 trigram 对 2 字中文失效（已实测）

> "一次 429 会发生什么？预算怎么不失控？"

## Phase 2.7 — 短状态与上下文编排（P1）✅

**短状态**
- [x] `short_state` 表（partial unique index + 惰性过期 + 软删除为 stale）
- [x] 同步写：`state set` 返回即落库（与异步蒸馏的长期记忆刻意不同）
- [x] 作用域：`global` 对所有线程可见，线程 key 只在本线程
- [x] 注入：排在长期记忆之前，每行带剩余时间
- [x] 晋升：`state promote` → 长期记忆，原名保留可追溯；`use_count≥3` 时列表提示
- [x] 守卫：凭据形态的 key 或 value 一律拒写（短状态同样进 prompt）
- [x] agent 自写：控制标记 `<!--state: k=v; ttl=7d-->`，服务端解析并剥离，不暴露给用户
- [x] 实测：agent 自主写入 `debug_port=8899`（168h）、回复无标记、晋升链路通
- [ ] 异步 `serve` 模式的闲置提炼（短状态已有，长期记忆还没有）

**上下文编排 P1**
- [x] `src/compose.ts` 纯函数：按段渲染 + 输出 manifest
- [x] **零行为变化**：重构前后 prompt 逐字 diff，485 字符完全一致
- [x] `context_plan` 事件：每段的字符数、meta、skipped、token 估算
- [x] **P2 段预算 / 淘汰顺序 / 跨段去重**
  - floor/cap 表：window 保底 1200，memory 顶 900，retrieved 最先淘汰，当前消息与指令永不截断
  - 淘汰顺序：retrieved → short_state → memory → summary → window
  - 跨段去重：window > short_state > memory > summary，比较前剥掉 `- [事实·4]` / `[Rick]` 前缀
  - manifest 增加 floor/cap/truncated/droppedChars/evictions/dedup/overBudget
  - 实盘：记忆里与短状态重复的一行被丢（similarity 0.73），311→258 字符
- [x] **P3-a token 校准**：`tokens ≈ slope × chars + intercept`（带截距的最小二乘）
  - 为什么必须带截距：provider 的 `input` 包含 pi 自己的系统提示与工具 schema
  - 少于 8 个样本不启用；报告 `r2`，差的时候显式警告
  - `pi-rt calibrate [--backfill] [--reset]`，从 `usage.input ⨝ context_plan.usedChars` 回填
  - 实测：8 样本 → slope 0.3259、intercept 115、r2 0.692 → 3.07 chars/token（默认 3.5 低估约 12%）
- [x] **P3-b 冲突裁决**：读路径只提示、不写库
  - 两个信号：「同话题 + 数字不同」（词面相似度仅 0.23 也必须能抓到）、「无数字的措辞漂移」
  - 相似度用**包含度**而非 Jaccard（长度惩罚会让改写句只有 0.21）
  - 冲突提示渲染在当前消息之前，记 `context_conflict` 事件，记忆行**不变**
  - 实测：记忆 3000 / 窗口 8080 → 提示生效，回答采用 8080 并说明 3000 作废
- [ ] P4 检索段（仅在扫描实验证明有必要时启用）

> "它为什么答错了？" —— 看 `context_plan`。

## Phase 2.8 — 事件表瘦身 ✅

- [x] 写入侧过滤：流式增量与 turn 包装不入库（`src/event-log.ts`）
- [x] 保留类型压缩为有效字段（tool 名称/结果/错误、agent 停止原因）
- [x] 超长 payload 截断为 `{truncated, originalChars, preview}`，不假装数据原本就小
- [x] `pi-rt compact [--dry-run] [--vacuum]`：删除噪音 → 截断历史超长行 → 回收空间
- [x] 实测：19,738 行 / 7.5 MB → 302 行 / 197 KB；数据库 10.80 MB → **0.49 MB（-95.5%）**
- [x] 新运行只写 7 行 / 1.1 KB（此前约 750 行）

> 删之前先备份：`data/runtime.db.bak-before-compact`

## Phase 2.9 — serve 的闲置提炼 ✅

- [x] `src/maintenance.ts`：一次 tick = 清理过期短状态 + 提炼闲置线程
- [x] `busy` 锁：正在回复的线程不会被提炼（避免看到半截对话）
- [x] 单个线程失败不影响其他线程；prune 失败也不阻断提炼
- [x] `PI_RT_MAINTENANCE_MINUTES`（默认 5）+ `--no-maintenance`
- [x] 每 tick 只打一行汇总（逐线程日志会把输出淹没）
- [x] 端到端：两条 webhook 消息（低于 10 轮阈值）→ 下一 tick 自动提炼出 `trip_budget_cny`
- [x] 副作用清理：测试线程的记忆已从开发库移除

## Phase 3 — 工具与子 Agent

- [ ] 自定义工具注册（JSON Schema + 结果回传契约）
- [ ] MCP 接入（pi 已内置，但要接上我们的注册表）
- [ ] 子 Agent：spawn 一个隔离上下文的 pi 子进程，聚合结果
- [ ] 嵌套深度与并发上限（这是线上事故的常见来源）

> "子 Agent 的上下文怎么隔离？并发上限加在哪一层？"

## Phase 4 — 沙箱与安全

- [ ] 装 Docker（当前机器没有），non-root + `--read-only` + `--network none` + `--pids-limit`
- [ ] 只挂载 workspace，凭证用宿主代理注入（容器里只给占位符）
- [ ] 越界测试集：10 个危险动作，统计拦截率
- [ ] HITL：危险操作进 outbox 等确认，确认后从断点继续

> "你的沙箱能防住什么、防不住什么？"

## Phase 5 — 评测（差异化关键）

- [x] 20 组标注用例（正例 8 / 负例 6 / 状态迁移 6）+ 自动判定 + 指标
- [x] `pi-rt eval` 一键跑，输出 `eval/latest.json` 与 `eval/report-<ts>.md`
- [x] 首轮基线：precision 78.9% / recall 88.2% / F1 83.3% / 通过 16/20
- [x] 修两个真缺陷（截断 JSON 修复、invalidate 与 update 边界提示）后：**precision 94.4% / recall 100% / F1 97.1% / 通过 19/20**
- [x] v3 扩到 28 组（新增跨主体归属、群规则、争议、助手独占信息、显式 correct、混合主体、三人群聊、第三人转述）→ 连跑两次 28/28
- [x] 发现并修正判据缺陷：类别不该当硬门槛（改软指标）、失效判"旧话不再活跃"而非"槽位为空"、主体已校验后不再要求内容重复人名
- [x] 留出集（hold-out）：`eval/holdout.json`，10 组写完只跑一次 → **9/10**
  - 唯一失败：`h01_secret`——把数据库密码当普通偏好存了（无敏感信息过滤）
  - 该组已因 h01 报销，修复必须在**新的**留出集上验证
- [x] 敏感信息守卫：`src/secrets.ts`，在写入边界拒绝（不靠提示词）
  - 拦截：关键字+值、供应商 token 前缀、Bearer、私钥块、高熵串、卡号/PIN
  - 误报控制：策略陈述放行、UUID/hex 摘要排除；9 拦 7 放的单元测试
  - 审计：被拦时写 `memory_blocked` 事件（内容为**脱敏预览**）
  - 新留出集 `eval/holdout-secrets.json` 一次运行：**9/10，值泄漏 0，FP 0**
  - 唯一失败是过保守：无害的 sha256 摘要没被记（记录为权衡，不调参）
- [ ] 事件层脱敏：原始消息仍明文存在 `conversation_events`（守卫只覆盖记忆行）
- [ ] 多次运行取均值：单次跑已观察到 26/28 ~ 28/28 的抖动，报告应写均值与区间
- [ ] `correct` vs `invalidate` 判定不稳：同一句"晨跑彻底停了"，两次运行分别给出 correct 与 invalidate（后者正确）。需要更强的不变量或二次确认
- [ ] 回归自动化：每次改 prompt 自动跑并记录指标变化曲线
- [ ] **故意构造一个"指标被刷高"的案例**，证明评测能识破
- [ ] 轨迹评测 + LLM-as-Judge（当前只评记忆提取，不评任务执行质量）

> "你怎么知道完成率是真的提升了，不是指标被刷高？"

## Phase 6 — 可观测与成本

- [ ] 每步一个 span（工具调用、模型请求、压缩）
- [ ] token / 成本归因到 task
- [ ] 失败分层：模型 / 工具 / 上下文 / 环境

> "Agent 失败了，你怎么在 5 分钟内定位到是哪一层？"

## Phase 7 — 壳

- [x] 通道抽象：`ingest()` 统一入口，消息先落事件再调模型（失败也不丢证据）
- [x] 身份层 `members`：channel + external_id → 稳定的人，owner 标记
- [x] owner 由配置决定（`ownerName: Rick`），不再"谁先说话谁是 owner"；历史 `subject=user` 自动迁移为 `Rick`
- [x] 本地 `feed --as <名字>`：无需任何外部凭证即可模拟群聊（也是测试手段）
- [x] Telegram 长轮询适配器（无公网、无依赖，`TELEGRAM_BOT_TOKEN` 即用）
- [x] **飞书长连接适配器**（`@larksuiteoapi/node-sdk` WSClient，无公网 IP；`FEISHU_APP_ID/SECRET`）
- [x] 传输层幂等：`claimMessage(channel, message_id)`，重投消息不会变成第二个事件
- [x] 离线测试 `tests/channels.test.mjs`：9 项（提及剥离、p2p、富文本忽略、空消息、坏 JSON、幂等）
- [x] 群聊多主体实测：三人各说一句 → 三条记忆分别归属 `member:张三/李四/王五`
- [ ] 飞书实网验证（缺你的 App 凭证；富文本/图片/文件/转发尚未处理）
- [ ] 昵称/真名映射与跨渠道身份合并（同一个人两个账号）

> "同一条消息重复投递两次，你怎么保证不执行两遍？"
