import { PI_CLI, piArgs, piEnv } from "./config.ts";
import type { RuntimeConfig } from "./config.ts";
import { PiRpc } from "./rpc.ts";
import { normalize } from "./memory.ts";
import type { ApplyResult, MemoryAction, MemoryCategory, MemoryStore, TargetType } from "./memory.ts";
import type { ConversationEventRow, Store } from "./db.ts";

export type ExtractItem = {
  action: MemoryAction;
  target: { type: TargetType; name?: string | null };
  category: MemoryCategory;
  key: string;
  content: string;
  importance: number;
  evidence_event_id: number;
  evidence_quote: string;
  reason: string;
  target_fact_id?: number | null;
};

export type DistillResult = {
  events: number;
  applied: ApplyResult[];
  rejected: Array<{ item: unknown; why: string }>;
  raw: string;
};

const ACTIONS: MemoryAction[] = ["create", "correct", "invalidate", "contest"];
const CATEGORIES: MemoryCategory[] = ["preference", "fact", "event"];
const TARGETS: TargetType[] = ["current_speaker", "named_member", "current_group", "self"];

const SYSTEM_PROMPT = `你是记忆提取与知识沉淀引擎。输入是一段「群聊/对话事件流」，每条消息都有唯一编号。
你的任务是提炼有长期价值的信息，并把它绑定到支撑它的那条事件上。

# 过滤原则
1. 坚决不记：临时寒暄、一次性查询、玩笑与推测、短暂情绪宣泄。
2. 重点记录：长期稳定的客观事实；明确且持久的个人偏好；重要的事件与长期承诺。

# 约束一：证据必须绑定事件
- 每条记忆必须给出 evidence_event_id，就是支持它的那条消息的编号。
- evidence_quote 必须从「该编号对应的正文」里逐字摘录，不得改写、拼接、跨条合并。
- 严禁凭空推造。找不到某一条能直接支撑，就不要输出这条记忆。

# 约束二：主体（target）必须消歧，禁止代词
target 只有四种：
- {"type": "current_speaker"}：当前发言者本人的偏好/事实。
- {"type": "named_member", "name": "张三"}：发言中明确提到的某个具体人。
- {"type": "current_group"}：针对整个群/团队的规则或共同约定。
- {"type": "self"}：Agent 对自己的认知或经验。
严禁把别人的信息记到发言者头上。例："张三说李四不吃辣" → target 必须是李四，不是张三。
也严禁使用"他/她/用户"这类模糊指代，必须落到具体的人或上面四种类型。

# 约束三：与已有记忆做裁决（action）
下面会给你「已有相关记忆」，每条带 [ID: n | key: ... | state: ...]。逐条对比后判定：
- create：全新事实，库中没有重叠。
- correct：用户状态改变或更正（如换了工作、改了偏好）。必须填 target_fact_id = 被替换那条的 ID。
- invalidate：用户明确表示以前的说法不作数/是玩笑/已彻底不再成立，且没有新值可替代。必须填 target_fact_id。
- contest：两处信息冲突，无法判断哪方正确。必须填 target_fact_id（与之冲突的那条），把两条都标为争议。
不要为了凑数而 correct：内容没有实质变化就不要输出。
注意：已有记忆里 subject/target 不同的条目**不算重复**。不同的人可以有相同偏好（两人都不吃香菜 = 两条记忆），不要因为"这条已经有了"就跳过对另一个人的提取。

# 输出格式
只输出 JSON 数组，不要解释、不要 markdown 代码块。没有长期价值信息就输出 []：
[
  {
    "action": "create",
    "target": { "type": "current_speaker" },
    "category": "preference",
    "key": "user_drink_preference",
    "content": "只喝美式，不加糖",
    "importance": 3,
    "evidence_event_id": 1024,
    "evidence_quote": "我平时只喝美式，不加糖",
    "reason": "明确的长期饮食偏好",
    "target_fact_id": null
  }
]

约束：
- category 只能是 preference | fact | event；action 只能是 create | correct | invalidate | contest。
- key 用小写英文 + 下划线，语义稳定（如 user_job、user_editor、group_review_schedule）。
- content 不超过 60 个汉字，自包含。
- importance：1-2 临时；3 常规事实；4-5 重大转折或原则性问题。
- evidence_event_id 必须是下面出现过的编号。
`;

function buildTranscript(events: ConversationEventRow[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const event of events) {
    const line = `[#${event.id} | ${event.speaker}]: ${event.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/**
 * Batch extraction over conversation events.
 *
 * Three checks make the output trustworthy rather than plausible:
 * 1. `evidence_event_id` must be one of the ids actually in this batch.
 * 2. `evidence_quote` must be a verbatim substring of THAT event's text — not of the
 *    transcript at large, which would let a quote drift onto the wrong message.
 * 3. `correct` / `invalidate` / `contest` must name an existing active row.
 */
export async function distillBatch(
  store: Store,
  memory: MemoryStore,
  cfg: RuntimeConfig,
  events: ConversationEventRow[],
  hooks: { onStatus?: (message: string) => void } = {},
  ownerNames: string[] = [],
): Promise<DistillResult> {
  if (events.length === 0) return { events: 0, applied: [], rejected: [], raw: "" };

  const transcript = buildTranscript(events, 14_000);
  // Reference state is scoped to the same conversation, so a chat batch is not compared
  // against project memories (which would suppress or wrongly "correct" them).
  const thread = events[0]?.thread ?? null;
  const existing = memory.stateBrief(3_000, thread);
  const speakers = [...new Set(events.filter((event) => event.role === "user").map((event) => event.speaker))];
  const chatType = speakers.length > 1 ? "群聊" : "私聊";
  const prompt = [
    SYSTEM_PROMPT,
    "# 会话背景",
    `类型：${chatType}`,
    `发言人：${speakers.join("、") || "（无）"}`,
    "current_speaker 指的是「该条事件的发言人本人」，不是固定的某个人；同一段对话里不同事件的发言人可以不同。",
    "若发言人是 A，事件 #12 里的\"我\"就是 A；转述他人时 target 必须落到被转述的那个人。",
    "",
    "# 已有相关记忆",
    existing,
    "",
    "# 对话事件流",
    transcript,
  ].join("\n");

  hooks.onStatus?.(`提炼 ${events.length} 条事件（${transcript.length} 字符，已有记忆 ${memory.active().length} 条）`);

  const rpc = new PiRpc({
    cliPath: PI_CLI,
    cwd: cfg.workspace,
    args: piArgs(cfg),
    env: piEnv(cfg),
    commandTimeoutMs: 120_000,
  });

  let raw = "";
  rpc.on("record", (record) => {
    if (record.type === "message_update") {
      const event = record.assistantMessageEvent;
      if (event?.type === "text_delta" && typeof event.delta === "string") raw += event.delta;
    }
  });

  try {
    rpc.start();
    await rpc.prompt(prompt, 240_000);
  } catch (error) {
    // Failed extraction stays retryable: events are not marked distilled.
    throw error;
  } finally {
    await rpc.dispose();
  }

  const items = parseArray(raw);
  if (items.length === 0 && !/\[\s*\]/.test(raw)) {
    throw new Error(`提炼输出无法解析为 JSON 数组，本轮未标记已提炼：${raw.slice(0, 200)}`);
  }

  const byId = new Map(events.map((event) => [event.id, event]));
  // The owner may appear under several display names (Feishu profile name, Telegram handle).
  // All of them must collapse into one subject, or the same person gets two memory slots.
  const ownerSet = new Set([cfg.ownerName, ...ownerNames].filter(Boolean));
  // Only ids that were actually shown may be acted on: a model that invents `target_fact_id`
  // must not be able to reach a row outside this conversation's scope.
  const allowedTargets = memory.scopeIds(thread);
  const applied: ApplyResult[] = [];
  const rejected: Array<{ item: unknown; why: string }> = [];

  for (const item of items) {
    const why = validate(item, byId, memory, allowedTargets);
    if (why) {
      rejected.push({ item, why });
      continue;
    }
    const event = byId.get(Number(item.evidence_event_id));
    // `current_speaker` is relative to the event that backs the quote. Resolve it into a
    // concrete person here, otherwise two speakers' facts collapse into one slot. The
    // owner keeps `current_speaker` so their memory stays in the owner's namespace.
    let targetType: TargetType = item.target.type;
    let targetName: string | null = typeof item.target.name === "string" ? item.target.name : null;
    const speaker = event?.speaker;
    const speakerIsOwner =
      !speaker || speaker === "user_1" || speaker === "agent" || ownerSet.has(speaker);
    if (targetType === "current_speaker" && !speakerIsOwner) {
      targetType = "named_member";
      targetName = speaker;
    }

    applied.push(
      memory.apply({
        action: item.action,
        targetType,
        targetName,
        category: item.category,
        key: String(item.key),
        content: String(item.content).trim(),
        importance: Number(item.importance),
        evidenceEventId: Number(item.evidence_event_id),
        evidenceQuote: String(item.evidence_quote),
        reason: typeof item.reason === "string" ? item.reason : null,
        targetFactId: typeof item.target_fact_id === "number" ? item.target_fact_id : null,
        sourceTaskId: events[events.length - 1]?.task_id ?? null,
        thread: events[events.length - 1]?.thread ?? null,
      }),
    );
  }

  store.markEventsDistilled(events.map((event) => event.id));
  return { events: events.length, applied, rejected, raw };
}

/** Returns a rejection reason, or null when the item is acceptable. */
function validate(
  item: any,
  byId: Map<number, ConversationEventRow>,
  memory: MemoryStore,
  allowedTargets: Set<number>,
): string | null {
  if (!item || typeof item !== "object") return "不是对象";
  if (!ACTIONS.includes(item.action)) return `action 非法: ${item.action}`;
  if (!CATEGORIES.includes(item.category)) return `category 非法: ${item.category}`;
  if (typeof item.key !== "string" || !/^[a-z0-9_\-]{2,48}$/.test(item.key.trim().toLowerCase())) return `key 非法: ${item.key}`;
  if (typeof item.content !== "string" || item.content.trim().length < 2) return "content 为空";
  if (item.content.length > 160) return "content 过长";
  if (typeof item.importance !== "number" || item.importance < 1 || item.importance > 5) return `importance 非法: ${item.importance}`;

  const target = item.target;
  if (!target || typeof target !== "object" || !TARGETS.includes(target.type)) return `target 非法: ${JSON.stringify(target)}`;
  if (target.type === "named_member" && (typeof target.name !== "string" || target.name.trim().length === 0)) {
    return "named_member 缺少 name";
  }

  const eventId = Number(item.evidence_event_id);
  if (!Number.isInteger(eventId)) return `evidence_event_id 非法: ${item.evidence_event_id}`;
  const event = byId.get(eventId);
  if (!event) return `evidence_event_id ${eventId} 不在本批事件里`;

  if (typeof item.evidence_quote !== "string" || item.evidence_quote.trim().length < 2) return "evidence_quote 为空";
  const quote = normalize(item.evidence_quote);
  if (!normalize(event.text).includes(quote)) {
    return `evidence_quote 不在事件 #${eventId} 的正文里（疑似脑补或跨条拼接）`;
  }

  if (item.action !== "create") {
    const targetFactId = Number(item.target_fact_id);
    if (!Number.isInteger(targetFactId)) return `${item.action} 缺少 target_fact_id`;
    if (!allowedTargets.has(targetFactId)) {
      return `target_fact_id ${targetFactId} 不在本次提供的参考记忆中（禁止跨作用域改写）`;
    }
    const row = memory.byId(targetFactId);
    if (!row) return `target_fact_id ${targetFactId} 不存在`;
    if (row.status !== "active") return `target_fact_id ${targetFactId} 状态为 ${row.status}，无法操作`;
  }
  return null;
}

/** Models wrap JSON in prose or fences, and truncation leaves a half-written object. */
function parseArray(text: string): any[] {
  const start = text.indexOf("[");
  if (start === -1) return [];
  const body = text.slice(start);

  const end = body.lastIndexOf("]");
  if (end !== -1) {
    try {
      const value = JSON.parse(body.slice(0, end + 1));
      if (Array.isArray(value)) return value;
    } catch {
      /* fall through to repair */
    }
  }

  const lastBrace = body.lastIndexOf("}");
  if (lastBrace === -1) return [];
  const repaired = `${body.slice(0, lastBrace + 1).replace(/,\s*$/, "")}]`;
  try {
    const value = JSON.parse(repaired);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
