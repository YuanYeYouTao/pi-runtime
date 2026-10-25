import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ToolCallRow = { type: string; payload: string | unknown; created_at: string };

export type ToolStat = {
  name: string;
  calls: number;
  failures: number;
  /** Mean wall time from tool_execution_start to tool_execution_end, when both were recorded. */
  avgMs: number | null;
  lastAt: string | null;
};

const parse = (payload: string | unknown): any => {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

/**
 * Aggregate tool executions from the event log.
 *
 * `tool_execution_end` is authoritative for outcome (it carries `isError`); the start event is
 * only used to measure duration, so a missing start degrades to "unknown time" rather than a
 * wrong zero. This is the metric the harness job description asks for — "tool call success
 * rate" — and it cannot be derived from token counts.
 */
export function summarizeToolCalls(rows: ToolCallRow[]): ToolStat[] {
  const stats = new Map<string, ToolStat>();
  const starts = new Map<string, number>();

  const touch = (name: string): ToolStat => {
    const existing = stats.get(name);
    if (existing) return existing;
    const created: ToolStat = { name, calls: 0, failures: 0, avgMs: null, lastAt: null };
    stats.set(name, created);
    return created;
  };

  for (const row of rows) {
    const payload = parse(row.payload);
    if (!payload || typeof payload !== "object") continue;
    const name = String(payload.toolName ?? payload.name ?? "").trim();
    if (!name) continue;
    const at = Date.parse(row.created_at);

    if (row.type === "tool_execution_start") {
      const id = String(payload.toolCallId ?? payload.id ?? "");
      if (id) starts.set(id, at);
      touch(name);
      continue;
    }

    if (row.type !== "tool_execution_end") continue;

    const stat = touch(name);
    stat.calls++;
    if (payload.isError === true) stat.failures++;
    if (!stat.lastAt || row.created_at > stat.lastAt) stat.lastAt = row.created_at;

    const id = String(payload.toolCallId ?? payload.id ?? "");
    const startedAt = id ? starts.get(id) : undefined;
    if (typeof startedAt === "number" && Number.isFinite(at)) {
      const ms = Math.max(0, at - startedAt);
      const previous = stat.avgMs ?? 0;
      stat.avgMs = Math.round((previous * (stat.calls - 1) + ms) / stat.calls);
    }
  }

  return [...stats.values()].sort((a, b) => b.calls - a.calls);
}

export type McpServer = { name: string; command?: string; enabled: boolean };

/**
 * Read the MCP servers this runtime would hand to pi.
 *
 * We read the file rather than shelling out to `pi mcp list`, so the report works when pi is
 * not on PATH and stays a pure function of our own configuration directory.
 */
export function listMcpServers(dataDir: string): McpServer[] {
  const file = path.join(dataDir, "pi", "mcp.json");
  if (!existsSync(file)) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const servers = parsed?.mcpServers ?? parsed?.servers ?? parsed;
  if (!servers || typeof servers !== "object") return [];

  return Object.entries(servers).map(([name, raw]: [string, any]) => ({
    name,
    command: typeof raw?.command === "string" ? raw.command : raw?.url ? String(raw.url) : undefined,
    enabled: raw?.disabled !== true && raw?.enabled !== false,
  }));
}

/** Render the report the CLI prints. Kept here so tests cover the formatting too. */
export function formatToolReport(stats: ToolStat[], servers: McpServer[]): string[] {
  const lines: string[] = [];
  const mcp = servers.length === 0 ? "未配置" : servers.map((s) => `${s.name}${s.enabled ? "" : "（已禁用）"}`).join(" · ");
  lines.push(`MCP      ${mcp}`);
  if (stats.length === 0) {
    lines.push("调用     （还没有工具调用记录）");
    return lines;
  }
  lines.push("调用");
  for (const stat of stats) {
    const rate = stat.calls === 0 ? "-" : `${Math.round(((stat.calls - stat.failures) / stat.calls) * 100)}%`;
    const time = stat.avgMs === null ? "-" : `${stat.avgMs}ms`;
    lines.push(`  ${stat.name.padEnd(34)} 次数 ${String(stat.calls).padStart(3)}  成功 ${rate.padStart(4)}  平均 ${time}`);
  }
  return lines;
}
