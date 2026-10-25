import type { ConversationEventRow } from "./db.ts";

export type ContextOptions = {
  /** How many recent messages to consider. */
  turns: number;
  /** Hard cap on the rendered characters, so one long reply cannot eat the window. */
  budgetChars: number;
  /** Speaker label for the agent's own messages. */
  agentLabel?: string;
};

export type ContextBlock = {
  text: string;
  messages: number;
  chars: number;
  /** Event ids that ended up in the block, oldest first. */
  ids: number[];
};

const estimateChars = (text: string): number => text.length;

/**
 * Render the recent conversation window, oldest first.
 *
 * Two rules matter here:
 * 1. Newest messages win. Budget is consumed from the end backwards, so the most recent
 *    exchange is always present — a window that drops the last turn is worse than no window.
 * 2. The window is a *view*: events stay append-only in the database, so compaction can
 *    later summarise the same rows without losing anything.
 */
export function buildConversationContext(events: ConversationEventRow[], options: ContextOptions): ContextBlock {
  const agentLabel = options.agentLabel ?? "助手";
  const usable = events.filter((event) => event.role === "user" || event.role === "assistant");
  const picked: ConversationEventRow[] = [];
  let used = 0;

  for (let index = usable.length - 1; index >= 0; index--) {
    const event = usable[index];
    const line = `[${event.role === "assistant" ? agentLabel : event.speaker}] ${event.text}`;
    if (picked.length >= options.turns) break;
    if (used + estimateChars(line) > options.budgetChars && picked.length > 0) break;
    picked.push(event);
    used += estimateChars(line);
  }

  picked.reverse();
  if (picked.length === 0) return { text: "", messages: 0, chars: 0, ids: [] };

  const text = picked
    .map((event) => `[${event.role === "assistant" ? agentLabel : event.speaker}] ${event.text}`)
    .join("\n");

  return { text, messages: picked.length, chars: text.length, ids: picked.map((event) => event.id) };
}
