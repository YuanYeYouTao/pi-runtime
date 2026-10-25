import type { MemoryCategory, MemoryStore } from "./memory.ts";
import { isSensitiveName } from "./secrets.ts";
import type { ShortStateStore } from "./short-state.ts";

export type PromoteOptions = {
  scope?: string;
  category?: MemoryCategory;
  /** Memory key; defaults to `state_<key>` so promoted slots stay traceable. */
  memoryKey?: string;
  importance?: number;
};

export type PromoteResult = {
  ok: boolean;
  memoryKey: string;
  reason: string;
  action?: string;
};

/**
 * Turn a short-lived slot into a long-term memory.
 *
 * Promotion is a deliberate act, not an automatic one: a slot that was merely *used* is not
 * evidence that it is stable. The user (or the agent, with confirmation) decides; this
 * function only executes the move and keeps the provenance in `reason`.
 *
 * The value still goes through the memory guards, so promoting a slot that happens to hold a
 * credential is rejected exactly like any other write.
 */
export function promoteShortState(
  shortState: ShortStateStore,
  memory: MemoryStore,
  key: string,
  options: PromoteOptions = {},
): PromoteResult {
  const memoryKey = options.memoryKey ?? `state_${key}`;
  const row = shortState.get(key, options.scope ?? "global");
  if (!row) {
    return { ok: false, memoryKey, reason: `短状态 ${key} 不存在或已过期` };
  }

  // Defence in depth: the slot itself is guarded on write, but the *destination* key could
  // still be a credential-shaped name chosen by the caller.
  if (isSensitiveName(key) || isSensitiveName(memoryKey)) {
    return { ok: false, memoryKey, reason: `sensitive: ${key} / ${memoryKey} 名称表明是凭据，不晋升为长期记忆` };
  }

  const result = memory.apply({
    action: "create",
    category: options.category ?? "fact",
    key: memoryKey,
    content: row.value,
    importance: options.importance ?? 3,
    reason: `由短状态晋升（used=${row.use_count}, scope=${row.scope}）`,
  });

  if (result.action === "rejected") {
    return { ok: false, memoryKey, reason: result.reason };
  }

  shortState.remove(key, options.scope ?? "global");
  return { ok: true, memoryKey, reason: `已晋升为长期记忆（${result.action}）`, action: result.action };
}
