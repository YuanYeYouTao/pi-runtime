/**
 * Which RPC records are worth persisting.
 *
 * pi streams a `message_update` per text delta and wraps turns in start/end pairs. Those are
 * useful live and useless afterwards: the finished answer is already stored as a conversation
 * event, and the deltas only exist to be joined. Keeping them cost 83 % of the event table
 * (4.5 MB of 6.6 MB over 25 runs) and made every `SELECT` slower.
 *
 * What remains is what cannot be reconstructed: tool calls, tool errors, agent completion and
 * explicit errors.
 */
const NOISE = new Set([
  "message_update",
  "message_start",
  "message_end",
  "turn_start",
  "turn_end",
  "agent_start",
  // incremental tool output: the final result is captured by tool_execution_end
  "tool_execution_update",
]);

export const NOISE_TYPES: string[] = [...NOISE];

export const DEFAULT_MAX_PAYLOAD = 2_000;

export function isNoise(type: string): boolean {
  return NOISE.has(type);
}

export type Persisted = { type: string; payload: unknown } | null;

/** Replace an oversized payload with a marker plus a preview, keeping the row honest. */
export function truncatePayload(value: unknown, maxChars = DEFAULT_MAX_PAYLOAD): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    return { truncated: true, error: "unserialisable payload" };
  }
  if (json.length <= maxChars) return value;
  return {
    truncated: true,
    originalChars: json.length,
    preview: json.slice(0, maxChars),
  };
}

function compact(type: string, record: Record<string, any>, maxChars: number): unknown {
  if (type.startsWith("tool_execution")) {
    return truncatePayload(
      {
        type,
        toolName: record.toolName ?? record.name ?? null,
        toolCallId: record.toolCallId ?? record.id ?? null,
        isError: record.isError ?? record.error ? true : record.isError,
        output: record.result ?? record.output ?? record.error ?? null,
      },
      maxChars,
    );
  }
  if (type === "agent_end") {
    return truncatePayload(
      {
        type,
        stopReason: record.stopReason ?? null,
        error: record.error ?? null,
      },
      maxChars,
    );
  }
  return truncatePayload(record, maxChars);
}

/** `null` means "do not persist this record at all". */
export function persistRecord(record: any, maxChars = DEFAULT_MAX_PAYLOAD): Persisted {
  if (!record || typeof record !== "object") return null;
  const type = String(record.type ?? "unknown");
  if (NOISE.has(type)) return null;
  return { type, payload: compact(type, record, maxChars) };
}
