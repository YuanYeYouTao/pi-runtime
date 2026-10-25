import { PiRpc } from "./rpc.ts";
import type { RpcRecord } from "./rpc.ts";
import type { Store, TaskRow } from "./db.ts";
import type { MemoryStore } from "./memory.ts";
import { buildConversationContext } from "./context.ts";
import { summarizeThread } from "./summary.ts";
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

/**
 * Execute one task by spawning a fresh `pi --mode rpc` process.
 *
 * The process is disposable by design: it holds no database and listens on no port,
 * so a crash costs us one task, not the queue. Everything durable is written to `Store`.
 */
export async function runTask(
  store: Store,
  cfg: RuntimeConfig,
  task: TaskRow,
  hooks: RunHooks = {},
  memory: MemoryStore | null = null,
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

  // Memory is injected at run time, not at enqueue time: a queued task should see the
  // memory as it is when it actually runs, not as it was when it was created.
  const injected = memory && cfg.memoryEnabled
    ? memory.contextBlock(cfg.memoryBudgetChars, task.thread)
    : { text: "", ids: [] };
  if (injected.ids.length > 0) {
    store.appendEvent(task.id, "memory_injected", { ids: injected.ids, chars: injected.text.length });
    hooks.onStatus?.(`memory: 注入 ${injected.ids.length} 条 / ${injected.text.length} 字符`);
  }

  rpc.on("record", (record: RpcRecord) => {
    store.appendEvent(task.id, record.type, record);

    if (record.type === "message_update") {
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
    // The user's message becomes a numbered event before the run starts, so even a failed
    // run leaves evidence that the extraction step could bind to.
    if (hooks.recordUserEvent !== false) {
      const userEventId = store.addConversationEvent(task.thread, cfg.ownerName, "user", task.prompt, task.id);
      hooks.onStatus?.(`event #${userEventId} recorded`);
    }

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

    const sections: string[] = [];
    if (injected.text) sections.push(injected.text);
    if (summary.trim()) sections.push(`## 更早对话的摘要（已压缩，因果细节以最近对话为准）\n${summary.trim()}`);
    if (context.text) sections.push(`## 最近对话（同一会话，按时间顺序）\n${context.text}`);
    sections.push(`## 当前消息\n${task.prompt}`);
    const finalPrompt = sections.join("\n\n---\n\n");

    rpc.start();
    hooks.onStatus?.(`pi pid=${(rpc as any).child?.pid ?? "?"} cwd=${task.cwd}`);

    await rpc.prompt(finalPrompt, cfg.maxMinutes * 60_000 + 5_000);

    if (lastError) throw new Error(lastError);
    if (!transcript.trim()) {
      throw new Error("agent finished without producing text (check model credentials)");
    }

    memory?.markUsed(injected.ids);
    store.finishTask(task.id, transcript.trim());
    store.addConversationEvent(task.thread, "agent", "assistant", transcript.trim(), task.id);
    return transcript.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = rpc.stderrTail.trim();
    const detail = stderr ? `${message}\n--- pi stderr ---\n${stderr.slice(-1500)}` : message;
    store.failTask(task.id, detail);
    throw new Error(detail);
  } finally {
    clearTimeout(wallClock);
    await rpc.dispose();
  }
}
