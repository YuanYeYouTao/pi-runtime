# pi-runtime

A personal agent runtime built on top of the **pi** coding agent (`@earendil-works/pi-coding-agent`), the same way a platform team would wrap an agent kernel.

The point of this project is not "chat with an AI on my laptop". It is to own the three things a chat wrapper does not have:

1. **State** — every task, every event, every result survives a crash.
2. **A boundary** — the executor is a disposable subprocess with no database and no port.
3. **A seam** — the agent kernel is swappable, so the platform logic stays ours.

## Architecture

```
        you (CLI today, web / IM later)
                    │
                    ▼
        ┌───────────────────────────┐
        │  orchestrator (this repo) │  ← the only stateful part
        │  tasks · events · queue   │
        │  SQLite (data/runtime.db) │
        └───────────┬───────────────┘
                    │ stdin JSONL  ▲ stdout JSONL
                    ▼              │
        ┌───────────────────────────┐
        │  pi --mode rpc            │  ← stateless, no db, no port
        │  prompt · tools · stream  │
        └───────────┬───────────────┘
                    │
                    ▼
        ┌───────────────────────────┐
        │  workspace (files on disk)│  ← the real side effects
        └───────────────────────────┘
```

Why the split matters: the executor can be killed, restarted, containerized or swapped for another agent, and the queue keeps its place. This is the same decision the systems we studied make (backend = only stateful hub, runner = no database / no port).

## Quick start

```bash
# 1. deps (--ignore-scripts: pi needs no lifecycle scripts, and sandboxes often block them)
npm install --ignore-scripts

# 2. bind a model (writes credentials to data/pi, NOT ~/.pi)
node src/cli.ts login

# 3. check the pipe
node src/cli.ts doctor

# 4. run a task in the current folder
node src/cli.ts ask "summarize what this repository does" --cwd .

# 5. or run a daemon that drains the queue
node src/cli.ts worker
```

Then, from another terminal, enqueue work without running it inline:

```bash
node -e "import('./src/db.ts').then(({Store})=>{const s=new Store('data/runtime.db');console.log(s.createTask('list the TODO comments','.'))})"
node src/cli.ts worker --once
```

## Commands

| Command | What it does |
|---|---|
| `doctor` | handshake with pi, print session id / model / compaction state |
| `login` | run pi's `/login` against the isolated config dir |
| `ask "<prompt>"` | enqueue + run one task now, stream the output |
| `worker [--once]` | daemon: claim queued tasks one at a time, crash-safe |
| `list [n]` | recent tasks with status |
| `show <id>` | one task, its result and its event trail |
| `remember "<text>" --key <slot> [--category …] [--importance 1-5] [--evidence "…"]` | write a memory by hand |
| `memories [category] [--all]` | list memories (active by default) |
| `history <key>` | the full supersede / invalidate chain for one slot |
| `forget <id>` | hard-delete one row |
| `distill [--thread t] [--limit n]` | batch-extract memories from undistilled turns |
| `stats` | task + memory counters |
| `ask "…" --thread <t>` | keep turns in a conversation thread |

## Memory

Three layers: **evidence → target → verdict**.

| category | for |
|---|---|
| `preference` | 长期稳定的个人偏好（饮食、作息、称呼、回答风格…） |
| `fact` | 长期稳定的客观事实（工作、技术栈、设备、常住地…） |
| `event` | 重要的单次事件与长期承诺（离职、复盘约定…） |

### Layer 1 — every memory is bound to a numbered event

Conversation is stored append-only in `conversation_events` (`#1024 | user_1 | role | text`). The extractor never sees a plain transcript; it sees numbered lines, and must return:

```json
{ "evidence_event_id": 1024, "evidence_quote": "我平时只喝美式，不加糖" }
```

The quote is checked as a normalized substring of **that specific event**, not of the whole transcript. A quote that belongs to a neighbouring message is rejected — which is what stops a plausible-sounding memory from attaching to the wrong sentence.

### Layer 2 — structured targets, no pronouns

```json
"target": { "type": "current_speaker" }
"target": { "type": "named_member", "name": "张三" }
"target": { "type": "current_group" }
"target": { "type": "self" }
```

`named_member` requires a name. The prompt states the attribution rule explicitly ("张三说李四不吃辣" → 李四) and forbids 他/她/用户. Storage keeps `target_type` + `target_name`, and derives `subject` (`Rick` / `member:张三` / `group` / `agent`) for keys, injection and filtering.

### Owner

`ownerName` in `config.json` (default **Rick**, override with `PI_RT_OWNER`) is the canonical subject for `current_speaker`. Two consequences:

- Existing `subject = "user"` rows are rewritten to the owner name on startup, so the rename is a migration, not a display tweak.
- Ownership is **configured at ingest, never inferred**. The first implementation promoted "whoever spoke first" to owner, which meant renaming the owner renamed that group member — and silently made 张三 the owner of an agent belonging to Rick. `ensureOwner()` now matches by name and no longer demotes other identities.

One person, several channels, one subject:

- `PI_RT_OWNER_IDS` (or `ownerIds` in config) lists channel ids that also belong to the owner, for when the profile name is not "Rick" (a Feishu contact name, a Telegram handle).
- `members.is_owner` therefore means "this identity belongs to the owner", and several rows may carry it.
- Distillation collapses every owner identity into one subject: a message from Rick's Feishu account is stored as `subject = Rick`, not `member:陈涛`. Without this, the same person gets two memory slots and the agent forgets half of what it knows.

### Layer 3 — four verdicts, decided against DB state

| action | meaning | requires |
|---|---|---|
| `create` | new slot | — |
| `correct` | value replaced (搬家/换工作/改偏好) | `target_fact_id` |
| `invalidate` | retracted, no replacement | `target_fact_id` |
| `contest` | conflicting, cannot decide which is true | `target_fact_id` |

The extractor is handed the current state (`[ID: 42 | key: … | state: active]`), so it can point at a specific row. The DB then verifies that row exists and is active, and may still overrule the proposal:

- `create` on an existing key → `correct` on that row
- `create` near-duplicate (≥ 0.82 bigram-Jaccard) → `correct`, adopting the existing key
- `correct` without a usable target → `create`
- `invalidate` / `contest` without a usable target → rejected

Only one `active` row per key (partial unique index). History is status-tagged (`superseded` / `invalidated` / `contested`) and never deleted.

**Contested rows are not injected.** A fact under dispute is not a fact; feeding it to the agent as truth is worse than saying nothing. Adjudicate with `pi-rt resolve <key> <keep-id>`.

### Batched, not per-message

- **Threshold.** After `batchTurns` (default 10) undistilled turns, `ask` distils at the end of the run.
- **Idle.** `worker` distils threads whose newest undistilled event is older than `idleMinutes` (default 15).
- **Retryable.** Unparseable output does not mark events distilled, so the next batch retries them.

### Scope: a chat is not a codebase

The same store holds project facts and personal facts, so injection is scoped by thread:
a row extracted from `feishu:oc_x` is only injected into that conversation, hand-written
rows (`thread IS NULL`) apply everywhere, and project memories stay in their own thread.

Without this, a question like "我在戒咖啡" gets injected with notes about the RPC transport
and the agent answers about code — then that reply is recorded as an event and distilled
into a bogus "fact" about the codebase. That is exactly what the first end-to-end Feishu run
produced, which is why scoping exists.

Two more guards came out of that same run:

- **Subjects do not share a slot.** Similarity-based dedupe is filtered by `subject`, so two
  people who both avoid cilantro get two memories instead of one overwriting the other.
- **`target_fact_id` must be in the reference set** that was actually shown to the extractor.
  Otherwise a model that invents an id can reach a row outside this conversation and rewrite
  someone else's memory — which is what happened before the allowlist existed.

### Injection

Active rows only, ranked by `importance` then recency, cut at 1800 chars, injected at **run time** so a queued task sees memory as it is when it actually runs.

```bash
node src/cli.ts events main                                   # numbered evidence
node src/cli.ts remember "默认使用 bash" --key user_shell --category fact --target self --event 12
node src/cli.ts distill --thread main
node src/cli.ts history user_shell                            # full verdict chain
node src/cli.ts resolve user_birth_city 7                     # settle a contested slot
```

## Channels

One ingest path, several transports. A message becomes a numbered event **before** any model call, so evidence survives a failed reply.

```
chat message → Members (identity) → conversation_event (#id) → task → pi → reply → event again
```

| transport | status | notes |
|---|---|---|
| `feed` (local) | working | `--as <name>` simulates a speaker; used for tests and demos |
| `telegram` | working | long polling, no public URL; needs `TELEGRAM_BOT_TOKEN` |
| `feishu` | working | long connection (no public URL); needs `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| others | seam only | plug into `ingest()` — see `src/gateway.ts` |

```bash
node src/cli.ts feed "我不吃香菜" --as 李四 --chat g1        # ingest as a specific speaker
node src/cli.ts feed "我在上海做芯片验证" --as 张三 --chat g1 --run   # ingest + let pi reply
node src/cli.ts members                                     # identity table
TELEGRAM_BOT_TOKEN=... node src/cli.ts serve --channel telegram
FEISHU_APP_ID=... FEISHU_APP_SECRET=... node src/cli.ts serve --channel feishu
```

### Feishu setup
1. [open.feishu.cn](https://open.feishu.cn) → 开发者后台 → 创建**企业自建应用**
2. 添加应用能力 → **机器人**
3. 权限：`im:message`（接收）、`im:message:send_as_bot`（发送）；想要真实姓名再加 `contact:user.base:readonly`（不加则用 open_id 当名字）
4. 事件与回调 → 订阅方式选 **使用长连接接收事件** → 添加事件 `im.message.receive_v1`
5. 创建版本并发布，管理员审核通过
6. 把机器人加进目标群，然后：

```bat
set FEISHU_APP_ID=cli_xxx
set FEISHU_APP_SECRET=xxx
pi-rt.cmd serve --channel feishu
```

Long connection is chosen on purpose: the agent runs behind NAT, so a webhook would need a tunnel. The cost is that the console must be set to long-connection mode — a webhook deployment would replace `serve()` with an HTTP handler and reuse `parseFeishuMessage()`.

Limits today: only `text` messages are ingested (rich text `post`, images, files are skipped rather than mis-parsed); mentions are stripped (`@_user_1`); display names fall back to `open_id` without the contact scope.

### Two Feishu transports

| mode | needs | use when |
|---|---|---|
| `serve --channel feishu` | app credentials | the console is set to 长连接; no public address needed |
| `serve --channel feishu-webhook` | `FEISHU_ENCRYPT_KEY` for signature checks | you have a public URL, or you want to test locally |

The webhook transport exists because the long connection cannot be exercised without a real
app. `feishu-webhook` runs an HTTP server that accepts the same events, so the whole pipeline
(parse → identity → event → run → reply) can be verified on localhost:

```bash
FEISHU_WEBHOOK_PORT=8787 node src/cli.ts serve --channel feishu-webhook
node tests/feishu-e2e.mjs 8787 oc_fresh   # post simulated deliveries
```

It verifies `sha256(timestamp + nonce + encryptKey + body)` before trusting a delivery,
decrypts the `{encrypt}` envelope (AES-256-CBC, key = sha256(encryptKey), IV = first 16 bytes),
answers `url_verification` with the challenge, and **acks with 200 before running the agent** —
Feishu retries slow or non-2xx deliveries, and a retry would otherwise become a second message
and a second memory.

### Idempotency

IM platforms redeliver when an ack is slow. `claimMessage(channel, message_id)` records the transport id before the event is created, so a redelivered message is dropped instead of producing a second event — and therefore a second memory. Covered by `tests/channels.test.mjs`.

```bash
node tests/channels.test.mjs        # 9 checks: parsing, mentions, post/empty/broken payloads, dedupe
node tests/feishu-webhook.test.mjs  # 13 checks: signature, decrypt, challenge, ack, token, encrypted event
```

Why polling for Telegram: a personal agent lives behind NAT on a laptop, so a webhook would need a tunnel — one more moving part for no benefit. The update cursor is in memory, so a restart re-delivers at most one message.

Identity matters because `current_speaker` is relative to the event. Without `Members`, two people's facts collapse into one `user` slot; with it, each row carries `member:张三` or `member:李四`, and the extractor is told who is speaking in each line.

## Context

Memory is what the agent knows forever; context is what it can still see. They are different
mechanisms, and this runtime had neither until the window was added.

Every prompt is assembled as:

```
① 长期记忆（scoped, 1800 chars）
② 更早对话的摘要（rolling, 1200 chars）
③ 最近对话（last N messages, 4000 chars）
④ 当前消息
```

Two rules in `src/context.ts`:

- **Newest wins.** The budget is consumed from the end backwards, so the latest exchange is
  always present. A window that drops the most recent turn is worse than no window.
- **A single oversized message is still kept.** The current question must never be squeezed
  out by its own length or by older chatter.

The window is a *view*, not storage: events stay append-only, so compaction can later
summarise the same rows without losing the originals.

```
config.context.turns               6      how many messages
config.context.budgetChars         4000   hard character cap
config.context.summary              true   rolling compression on/off
config.context.summaryTriggerChars 2400   cold bytes that trigger a compression
config.context.summaryMaxChars     1200   cap for the rendered summary
```

Verified by an A/B on a fact that exists only in the previous turn:

```
turn 1  "我给我的机械键盘换了静音轴，型号是 TTC 冰静"
turn 2  "那套轴体适合在开放式办公室用吗？"
        with window    → "冰静本身非常适合开放式办公室…"
        empty thread   → "如果你告诉我型号，我可以直接给出结论…"
```

`context_injected` is recorded per task (`{ids, messages, chars}`), so "what did it actually
see" is answerable after the fact.

### Rolling summary

The window is finite, so conversation eventually falls off the back of it. When the cold part
of a thread (everything between the summary cursor and the window) exceeds
`summaryTriggerChars`, it is compressed before the answer is generated:

```
thread_state { thread, summary, summarized_until_event_id }
```

- **Structured output**, not prose: 已确认事实 / 用户指令与偏好 / 未决问题 / 关键实体.
- **Cursor advances only after success.** A failed compression leaves the cursor untouched, so
  the same events are retried next turn instead of being silently dropped.
- **The summary is a derived view.** Sources stay in `conversation_events`; a bad compression
  can be recomputed rather than being permanent loss.
- **A failed compression never fails the answer** — the run continues with the window alone.

`pi-rt thread <thread>` shows the live state (event count, cursor, summary). Verified with a
1-message window so the fact could only come from the summary:

```
turn 1  "项目代号是 Orion-7，负责人是王工。"
turn 2  "这个项目下周要过安全评审。"      → summary cursor advances, 摘要含 Orion-7 / 王工
turn 3  "这个项目的代号和负责人分别是什么？"  → "Orion-7，负责人王工。"
```

### Context and compression, measured

Two suites, same transcript per case, two conditions:

- **baseline** — a fixed 30-message window, no compression (what a plain window gives you)
- **system** — a 6-message window plus the rolling summary

```bash
node src/cli.ts eval-context                            # 10 short cases, 5 filler exchanges
node src/cli.ts eval-context --cases eval/context-stress.json   # 5 long cases, 20–25 fillers
```

| 场景 | baseline | system | 结论 |
|---|---|---|---|
| 短会话（5 轮闲聊） | 10/10 | 10/10 | 窗口够了，摘要没有增量 |
| 长会话（20–25 轮闲聊） | **0/5** | **5/5** | 事实被挤出窗口，摘要全部捞回 |

Average summary: 145 chars (short) / 234 chars (long) — far cheaper than carrying the transcript.

The honest reading:

- Summarisation is **not** a general improvement; it pays off exactly when the window can no
  longer hold the thread. On short conversations it is pure overhead.
- The baseline is not a straw man, but a **bigger window** would also have passed the long
  cases. Summarisation wins on *bounded cost*, not on being the only possible answer.
- At 25 turns the whole transcript is still small. The real justification arrives at hundreds
  of turns, where an unbounded window stops being an option.

## Limits: retry, concurrency, budget

Three independent protections, because they fail differently.

### Retry — only for errors that pass on their own

`src/retry.ts` classifies before it retries:

| retryable | not retryable |
|---|---|
| 429 / rate limit / 5xx | no API key |
| timeouts, ECONNRESET, socket hang up | model not found |
| agent subprocess exiting | 401 / 403 |
| "temporarily unavailable" | budget exceeded |

Backoff is exponential with full jitter, capped: `min(maxMs, base × 2^(n-1))`, then randomised
into `[half, full]`. Retrying a configuration error just burns time and money, so the
classification matters more than the schedule.

The **task row** is the retry unit, not the process: every attempt spawns a fresh
`pi --mode rpc`, so a hung attempt cannot poison the next one. The user message is recorded
once, before the loop — a retry must not create a second event (and therefore a second memory).

### Concurrency — a gate, not just a queue

`src/gate.ts` caps `maxConcurrent` **and** spaces starts with `minIntervalMs`. Concurrency
alone cannot express "at most one start per N ms", which is what a per-minute rate limit
actually needs.

### Budget — provider-reported, not estimated

pi reports real usage on every `message_update`:

```json
{ "input": 249, "output": 148, "cacheRead": 5888, "totalTokens": 6285,
  "cost": { "total": 0.000287628 } }
```

Two gotchas, both silent if you get them wrong: the total is `totalTokens` (not `total`), and
`cost` is an **object**. `Number(object)` is `NaN`, and SQLite binds `NaN` as `NULL`, which
trips `NOT NULL` — the first real run failed exactly this way. `normalizeUsage()` and a
`safe()` coercion in the store now pin the shape, and `tests/usage.test.mjs` locks it.

- **Daily cap**: checked before the run; blocks in ~450 ms with `budget_exceeded` and without
  spending a token.
- **Per-task cap**: checked on every usage update mid-run; the run is aborted, and the partial
  spend is still recorded, because a failed attempt burned tokens too.

```
config.limits.maxAttempts     3         total attempts per task
config.limits.retryBaseMs     2000      backoff base
config.limits.maxRetryMs      30000     backoff cap
config.limits.maxConcurrent   1         parallel runs
config.limits.minIntervalMs   0         spacing between starts
config.limits.dailyTokens     2000000   0 disables
config.limits.taskTokens      200000    0 disables
```

`pi-rt stats` shows today's tokens, cost and run count next to the memory counters.

### Held-out set (10 cases, run once)

`eval/holdout.json` was written **after** the prompt had been tuned, and run exactly once.
Its score is a baseline, not a target:

```
9/10 pass · precision 91.7% · recall 100% · 状态迁移 2/2 · 负例泄漏 1/3
```

The one failure is a genuine gap, not a judge quibble:

| case | what happened |
|---|---|
| `h01_secret` | "我的数据库密码是 Passw0rd!2024" was stored as `user_database_password` |

That is the worst place to be wrong: the row is injected into every subsequent prompt in that
scope, rendered into `MEMORY.md`, and persisted in SQLite. There is **no secret filter** — the
engine treats a credential exactly like a preference.

Discipline note: this set is now burned for `h01`. A fix must be validated against a **new**
held-out set, otherwise "we fixed it" is just fitting the test.

## Evaluation

Memory extraction is measured, not assumed: 28 hand-authored cases in [`eval/cases.json`](eval/cases.json) — 13 positive, 7 negative, 8 state transitions — scored by semantic assertions rather than key identity, with each case isolated in its own database.

```bash
node src/cli.ts eval            # writes eval/latest.json + eval/report-<ts>.md
node src/cli.ts eval --only c08 # one case
node src/cli.ts eval --keep     # keep per-case temp databases
```

| metric | v2 baseline (20) | v3 (26) | v3 + channels (28) |
|---|---|---|---|
| precision | 78.9% | 100% | **100%** (27/27) |
| recall | 88.2% | 100% | **100%** (27/27) |
| F1 | 83.3% | 100% | **100%** |
| 负例泄漏 | 0/6 | 0/7 | **0/7** |
| 状态迁移正确 | 5/6 | 8/8 | **8/8** |
| 类别一致率（软指标） | — | — | **100%** (16/16) |
| 用例通过 | 16/20 | 26/26 | **28/28** |

The v3+ cases exercise the new layers specifically: cross-speaker attribution (`c21`), group-scoped commitments (`c22`), unresolvable conflict → `contest` (`c23`), assistant-only claims must not become user memory (`c24`), explicit `correct` with `target_fact_id` (`c25`), two subjects in one sentence (`c26`), a three-person group (`c27`), and quoting a third party (`c28`).

**The most useful finding was about the benchmark, not the system.** Consecutive runs of the same 28 cases produced 27/28, then 26/28, then 28/28 twice — and nearly every "failure" turned out to be a judge decision: asserting a category the model legitimately disagreed with (`主要用 Go` as preference vs fact), demanding `invalidate` when a corrective event deactivated the old fact just as well, or requiring a person's name inside content whose target was already verified. Consequences baked in:

- **Category is a soft metric**, reported as agreement, never a pass/fail gate — it is a judgement call and the least stable field.
- **Deactivation is judged by state**: "the retracted phrase is no longer active", not "the slot is empty".
- **`allow_contains`** tolerates legitimate extras the case did not enumerate.

So the 100% says the system fits this benchmark. It does not say the benchmark is hard. These 28 cases have been used across six iterations of prompt and judge tuning, so a held-out set run once on the next version is the only way to make the number quotable.

What the whole sequence exposed, in order:

1. **Truncated JSON** lost a whole batch → the parser salvages complete objects before the cut.
2. **`invalidate` vs `correct`** — an "已停止" row left a ghost active memory → the prompt now draws the boundary explicitly.
3. **Ground truth was too narrow** — legitimate extras (job, name, knee injury) scored as false positives → cases declare `allow_contains`.
4. **Judge too strict on deactivation** — a corrective event ("the cat died") deactivates the old fact just as well as `invalidate` does → state check asserts *the retracted phrase is no longer active*, not *the slot is empty*.
5. **Category as a gate was the noisiest criterion** — `主要用 Go` as preference vs fact, an event vs a preference for a weekly review → category became a soft metric.

Only items 1 and 2 were system defects; 3–5 were defects in the measurement. That ratio is the real lesson: an eval that keeps failing is usually telling you about its own criteria.

## Design decisions

- **RPC, not SDK.** The SDK embeds pi in-process (fast, but one crash kills the queue and the agent shares our memory). RPC keeps a hard process boundary and is language-agnostic — the same seam an IM gateway or a containerized runner would need. `stdio: inherit` is used for interactive login only.
- **JSONL framing by hand.** pi's protocol is one JSON object per LF. `readline` is wrong here: it also splits on `U+2028`/`U+2029`, which are legal inside JSON strings.
- **Wait for `agent_settled`, not `agent_end`.** `agent_end` closes one low-level run; retries, compaction and queued work can still follow. Only `agent_settled` means "it will not continue on its own".
- **Our database, not pi's sessions.** The runtime runs pi with `--no-session`. Durability belongs to the orchestrator, so we can add retries, resume, audits and multi-channel delivery without reading pi's internal format. (Once task replay needs full transcripts, switch to storing pi session files and re-attach them.)
- **Isolated config dir.** `PI_CODING_AGENT_DIR=data/pi` keeps the runtime's credentials and settings away from the user's global `~/.pi/agent`.
- **`--no-approve`.** A daemon cannot answer a trust prompt, so project resources are declined by default. Sandboxing and approval are separate concerns; see the roadmap.

## Status

Working:

- queue → spawn → stream/error → persist → stale-task reaping
- `doctor` handshake with a real session id
- **memory v3**: numbered events, per-event evidence binding, structured targets (`current_speaker` / `named_member` / `current_group` / `self`), four verdicts (`create` / `correct` / `invalidate` / `contest`), contested rows excluded from injection, batched distillation (threshold + idle), full audit chain
- **owner**: `Rick`, configured via `config.json`, canonical subject for the owner's memories
- **channels**: local `feed` (simulated speakers), Telegram long polling, Feishu long connection, identity table
- benchmark: 28 cases, two consecutive 28/28 runs on `deepseek-flash` — in-sample, see the caveat above

Verified end to end on a simulated three-person group: three speakers → three identities → each memory bound to `member:张三` / `member:李四` / `member:王五` with the right evidence event id and verbatim quote.

Known gaps: no retry/backoff on task failure, single-threaded worker, no archival for the event/observability tables, Telegram path untested against the live API (no token yet), **Feishu path untested against the live API (no app credentials)**, no held-out benchmark, and the `correct` vs `invalidate` verdict is still unstable for "the habit stopped entirely" (observed both behaviours across runs).

Next phases: see [ROADMAP.md](ROADMAP.md).
