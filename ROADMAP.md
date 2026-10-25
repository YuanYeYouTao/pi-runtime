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
- [ ] 留出集（hold-out）：现有 28 组已用于 6 轮调参，必须另写 10 组只在新版本验收时跑
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
