import { PiRpc } from "./rpc.ts";
import type { RpcRecord } from "./rpc.ts";
import type { Store, TaskRow } from "./db.ts";
import type { MemoryStore } from "./memory.ts";
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
  const injected = memory && cfg.memoryEnabled ? memory.contextBlock(cfg.memoryBudgetChars) : { text: "", ids: [] };
  const finalPrompt = injected.text ? `${injected.text}\n\n---\n\n${task.prompt}` : task.prompt;
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
    rpc.start();
    hooks.onStatus?.(`pi pid=${(rpc as any).child?.pid ?? "?"} cwd=${task.cwd}`);

    // The user's message becomes a numbered event before the run starts, so even a failed
    // run leaves evidence that the extraction step could bind to.
    if (hooks.recordUserEvent !== false) {
      const userEventId = store.addConversationEvent(task.thread, cfg.ownerName, "user", task.prompt, task.id);
      hooks.onStatus?.(`event #${userEventId} recorded`);
    }

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
