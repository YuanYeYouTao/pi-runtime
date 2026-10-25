import path from "node:path";
import { PiRpc } from "./rpc.ts";
import type { RpcRecord } from "./rpc.ts";
import type { Store, TaskRow } from "./db.ts";
import type { MemoryStore } from "./memory.ts";
import { buildConversationContext } from "./context.ts";
import { compose } from "./compose.ts";
import type { ComposeSegment } from "./compose.ts";
import { ShortStateStore, parseTtl } from "./short-state.ts";
import { CalibrationStore } from "./calibration.ts";
import { persistRecord } from "./event-log.ts";
import { extractStateDirectives } from "./state-directive.ts";
import { Gate } from "./gate.ts";
import { summarizeThread } from "./summary.ts";
import { withRetry } from "./retry.ts";
import { PI_CLI, piArgs, piEnv } from "./config.ts";
import type { RuntimeConfig } from "./config.ts";

export type RunHooks = {
  onText?: (delta: string) => void;
  onStatus?: (message: string) => void;
  /** Channels ingest the user message themselves; set false to avoid a duplicate event. */
  recordUserEvent?: boolean;
};

/** Event types we surface on the status line instead of the transcript. */
const TOOL_EVENT = /^tool_|_tool_/;

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  cost?: number;
};

/**
 * pi reports `totalTokens` and a `cost` object; the store wants flat numbers. Getting this
 * wrong is silent — `Number(object)` is NaN and SQLite turns NaN into NULL.
 */
function normalizeUsage(raw: any): Usage {
  const num = (value: unknown): number => {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  return {
    input: num(raw.input),
    output: num(raw.output),
    cacheRead: num(raw.cacheRead),
    cacheWrite: num(raw.cacheWrite),
    total: num(raw.totalTokens ?? raw.total),
    cost: raw.cost && typeof raw.cost === "object" ? num(raw.cost.total) : num(raw.cost),
  };
}

let sharedGate: Gate | null = null;
let sharedGateKey = "";

/** One gate per process, keyed by the configured limits (tests can swap configs). */
function gateFor(cfg: RuntimeConfig): Gate {
  const key = `${cfg.limits.maxConcurrent}:${cfg.limits.minIntervalMs}`;
  if (!sharedGate || sharedGateKey !== key) {
    sharedGate = new Gate(cfg.limits.maxConcurrent, cfg.limits.minIntervalMs);
    sharedGateKey = key;
  }
  return sharedGate;
}

export class BudgetExceededError extends Error {}

/**
 * Execute one task: admission control → budget → attempt → retry.
 *
 * The task row is the unit of retry, not the process. Each attempt spawns a fresh
 * `pi --mode rpc` process, so a hung or crashed attempt cannot poison the next one, and the
 * user message is recorded once (not once per attempt) so the conversation history and the
 * memory evidence do not multiply.
 */
export async function runTask(
  store: Store,
  cfg: RuntimeConfig,
  task: TaskRow,
  hooks: RunHooks = {},
  memory: MemoryStore | null = null,
): Promise<string> {
  const release = await gateFor(cfg).acquire();
  try {
    const today = store.usageToday();
    if (cfg.limits.dailyTokens > 0 && today.total >= cfg.limits.dailyTokens) {
      const message = `budget_exceeded: 今日已用 ${today.total} tokens，达到上限 ${cfg.limits.dailyTokens}`;
      store.failTask(task.id, message);
      hooks.onStatus?.(message);
      throw new BudgetExceededError(message);
    }

    // Recorded once, outside the retry loop: a retry must not create a second user event.
    if (hooks.recordUserEvent !== false) {
      const userEventId = store.addConversationEvent(task.thread, cfg.ownerName, "user", task.prompt, task.id);
      hooks.onStatus?.(`event #${userEventId} recorded`);
    }

    // Memory is injected at run time, not at enqueue time: a queued task should see the
    // memory as it is when it actually runs, not as it was when it was created.
    const injected = memory && cfg.memoryEnabled
      ? memory.contextBlock(cfg.memoryBudgetChars, task.thread)
      : { text: "", ids: [] };
    if (injected.ids.length > 0) {
      store.appendEvent(task.id, "memory_injected", { ids: injected.ids, chars: injected.text.length });
      hooks.onStatus?.(`memory: 注入 ${injected.ids.length} 条 / ${injected.text.length} 字符`);
    }

    try {
      const result = await withRetry(
        (attempt) => runAttempt(store, cfg, task, hooks, memory, injected, attempt),
        { attempts: cfg.limits.maxAttempts, baseMs: cfg.limits.retryBaseMs, maxMs: cfg.limits.maxRetryMs },
        {
          onRetry: (attempt, delayMs, error) => {
            store.appendEvent(task.id, "task_retry", { attempt, delayMs, error: error.message.slice(0, 400) });
            hooks.onStatus?.(`retry ${attempt + 1}/${cfg.limits.maxAttempts} in ${delayMs}ms after: ${error.message.slice(0, 100)}`);
          },
        },
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.failTask(task.id, message);
      throw error;
    }
  } finally {
    release();
  }
}

/** One attempt: build the prompt, run pi, stream the answer, account for the spend. */
async function runAttempt(
  store: Store,
  cfg: RuntimeConfig,
  task: TaskRow,
  hooks: RunHooks,
  memory: MemoryStore | null,
  injected: { text: string; ids: number[] },
  attempt: number,
): Promise<string> {
  const rpc = new PiRpc({
    cliPath: PI_CLI,
    cwd: task.cwd,
    args: piArgs(cfg),
    env: piEnv(cfg),
    commandTimeoutMs: 120_000,
  });

  let transcript = "";
  let lastError: string | null = null;
  let usage: Usage | null = null;
  let budgetTripped = false;
  let promptChars = 0;

  rpc.on("record", (record: RpcRecord) => {
    // Only records that cannot be reconstructed are persisted; streaming deltas are dropped.
    const persisted = persistRecord(record, cfg.eventPayloadMax ?? 2000);
    if (persisted) store.appendEvent(task.id, persisted.type, persisted.payload);

    if (record.type === "message_update") {
      if (record.usage && typeof record.usage === "object") {
        usage = normalizeUsage(record.usage);
        const total = usage.total ?? 0;
        if (!budgetTripped && cfg.limits.taskTokens > 0 && total > cfg.limits.taskTokens) {
          budgetTripped = true;
          lastError = `budget_exceeded: 单任务 ${total} tokens 超过上限 ${cfg.limits.taskTokens}`;
          hooks.onStatus?.(lastError);
          void rpc.dispose();
        }
      }
      const event = record.assistantMessageEvent;
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        transcript += event.delta;
        hooks.onText?.(event.delta);
      }
      return;
    }

    if (record.type === "error") {
      lastError = String(record.error ?? record.message ?? "unknown error");
      hooks.onStatus?.(`error: ${lastError}`);
      return;
    }

    if (TOOL_EVENT.test(record.type)) {
      const name = record.toolName ?? record.name ?? record.type;
      hooks.onStatus?.(`tool → ${name}`);
    }
  });

  rpc.on("malformed", (line: string) => {
    store.appendEvent(task.id, "malformed", { line });
  });

  const wallClock = setTimeout(() => {
    hooks.onStatus?.(`wall-clock limit (${cfg.maxMinutes}m) reached, aborting`);
    void rpc.dispose();
  }, cfg.maxMinutes * 60_000);

  try {
    // History is read *after* the current message is stored (or skipped), so the window is
    // strictly "everything before this message" — the current text is never duplicated.
    const lastId = store.lastEventId(task.thread);
    const context = buildConversationContext(
      store.threadEventsBefore(task.thread, lastId, cfg.contextTurns * 6),
      { turns: cfg.contextTurns, budgetChars: cfg.contextBudgetChars },
    );
    if (context.messages > 0) {
      store.appendEvent(task.id, "context_injected", {
        ids: context.ids,
        messages: context.messages,
        chars: context.chars,
      });
      hooks.onStatus?.(`context: 携带 ${context.messages} 条历史 / ${context.chars} 字符`);
    }

    // Compress the cold part of the thread before answering: everything between the summary
    // cursor and the newest window is unreachable otherwise, and chat drifts past the window
    // quickly. Done before the main run so the summary is available to this prompt.
    const state = store.threadState(task.thread);
    let summary = state.summary;
    if (cfg.summaryEnabled) {
      const windowStart = context.ids.length > 0 ? context.ids[0] : lastId;
      const cold = store.threadEventsBetween(task.thread, state.summarizedUntil, windowStart, 80);
      const coldChars = cold.reduce((total, event) => total + event.text.length, 0);
      if (cold.length > 0 && coldChars >= cfg.summaryTriggerChars) {
        hooks.onStatus?.(`summary: 压缩 ${cold.length} 条较旧事件 / ${coldChars} 字符`);
        try {
          const updated = await summarizeThread(cfg, state.summary, cold, cfg.summaryMaxChars);
          if (updated) {
            const until = windowStart - 1;
            store.saveThreadState(task.thread, updated, until);
            store.appendEvent(task.id, "context_summarized", {
              from: state.summarizedUntil,
              to: until,
              events: cold.length,
              chars: updated.length,
            });
            summary = updated;
            hooks.onStatus?.(`summary: 已更新到 #${until}（${updated.length} 字符）`);
          }
        } catch (error) {
          // A failed compression must not fail the answer: the cursor stays put and the
          // next run retries with the same cold events.
          hooks.onStatus?.(`summary failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Short state is newer than long-term memory, so on a key collision its value is the one
    // the model should end up reading (it is placed first in the prompt).
    let shortStateBlock: { text: string; keys: string[] } = { text: "", keys: [] };
    {
      const shortState = new ShortStateStore(cfg.dataDir);
      try {
        shortStateBlock = shortState.contextBlock(300, task.thread);
        if (shortStateBlock.text) {
          store.appendEvent(task.id, "short_state_injected", {
            keys: shortStateBlock.keys,
            chars: shortStateBlock.text.length,
          });
          hooks.onStatus?.(`short state: ${shortStateBlock.keys.length} 条`);
          shortState.markUsed(shortStateBlock.keys, task.thread);
        }
      } finally {
        shortState.close();
      }
    }

    // Order is the contract: instructions → memory → short state → summary → window → current.
    const segments: ComposeSegment[] = [];
    segments.push({
      kind: "instructions",
      title: "## 约定",
      body: [
        "需要跨轮记住的**临时**信息（端口、分支、待办链接、进度），在回复最后单独一行写：",
        "<!--state: key=value; ttl=12h-->",
        "不要用它记长期事实（那些交给记忆系统），也永远不要写入密码/密钥/token。",
      ].join("\n"),
    });
    if (injected.text) segments.push({ kind: "memory", body: injected.text, meta: { ids: injected.ids } });
    if (shortStateBlock.text) {
      segments.push({ kind: "short_state", body: shortStateBlock.text, meta: { keys: shortStateBlock.keys } });
    }
    if (summary.trim()) {
      segments.push({
        kind: "summary",
        title: "## 更早对话的摘要（已压缩，因果细节以最近对话为准）",
        body: summary.trim(),
      });
    }
    if (context.text) {
      segments.push({
        kind: "window",
        title: "## 最近对话（同一会话，按时间顺序）",
        body: context.text,
        meta: { ids: context.ids, messages: context.messages },
      });
    }
    segments.push({ kind: "current", title: "## 当前消息", body: task.prompt });

    // The ratio is learned from provider-reported usage, falling back to the default until
    // there are enough samples to fit.
    const calibration = new CalibrationStore(cfg.dataDir);
    let charsPerToken = 3.5;
    try {
      charsPerToken = calibration.charsPerToken();
    } finally {
      calibration.close();
    }

    const { prompt: finalPrompt, manifest } = compose(segments, {
      budgetChars: cfg.contextBudgetChars,
      charsPerToken,
    });
    promptChars = finalPrompt.length;
    store.appendEvent(task.id, "context_plan", manifest);
    if (manifest.conflicts.length > 0) {
      store.appendEvent(task.id, "context_conflict", { conflicts: manifest.conflicts });
      hooks.onStatus?.(`context: ${manifest.conflicts.length} 处冲突（以最近对话为准）`);
    }

    // Parity harness for refactors: dump the exact prompt so two runs can be diffed byte-wise.
    if (process.env.PI_RT_PROMPT_DUMP) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(cfg.dataDir, `prompt-${task.id}.txt`), finalPrompt, "utf8");
    }

    rpc.start();
    hooks.onStatus?.(`pi pid=${(rpc as any).child?.pid ?? "?"} attempt=${attempt}`);

    await rpc.prompt(finalPrompt, cfg.maxMinutes * 60_000 + 5_000);

    if (lastError) throw new Error(lastError);
    if (!transcript.trim()) {
      throw new Error("agent finished without producing text (check model credentials)");
    }

    // Control tokens are parsed here, not by a second model turn: the slot is written before
    // the reply is stored, so "I remembered it" is true at the moment the user sees it.
    const parsed = extractStateDirectives(transcript);
    if (parsed.directives.length > 0) {
      transcript = parsed.cleaned;
      const shortState = new ShortStateStore(cfg.dataDir);
      try {
        for (const directive of parsed.directives) {
          try {
            const row = shortState.set(directive.key, directive.value, {
              scope: task.thread,
              ttlMs: directive.ttl ? parseTtl(directive.ttl) : undefined,
              sourceEventId: lastId,
            });
            store.appendEvent(task.id, "state_directive", { key: row.key, ttl: directive.ttl ?? null, expires_at: row.expires_at });
            hooks.onStatus?.(`state ← ${row.key}`);
          } catch (error) {
            store.appendEvent(task.id, "state_directive_rejected", {
              key: directive.key,
              reason: error instanceof Error ? error.message : String(error),
            });
            hooks.onStatus?.(`state rejected: ${directive.key}`);
          }
        }
      } finally {
        shortState.close();
      }
    }

    memory?.markUsed(injected.ids);
    store.finishTask(task.id, transcript.trim());
    store.addConversationEvent(task.thread, "agent", "assistant", transcript.trim(), task.id);
    return transcript.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = rpc.stderrTail.trim();
    throw new Error(stderr ? `${message}\n--- pi stderr ---\n${stderr.slice(-1500)}` : message);
  } finally {
    clearTimeout(wallClock);
    // Spend is recorded on failure too: a failed attempt still burned tokens.
    if (usage) {
      store.recordUsage(task.id, cfg.model ?? "default", usage);
      store.appendEvent(task.id, "usage", usage);
      if (promptChars > 0 && Number(usage.input ?? 0) > 0) {
        const calibration = new CalibrationStore(cfg.dataDir);
        try {
          calibration.record({ chars: promptChars, tokens: Number(usage.input), taskId: task.id });
        } finally {
          calibration.close();
        }
      }
    }
    await rpc.dispose();
  }
}
