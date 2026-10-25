export type SpanRow = {
  id: number;
  task_id: string;
  parent_id: number | null;
  kind: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  attrs: string | null;
};

export type SpanNode = SpanRow & { ms: number | null; children: SpanNode[] };

/** Rebuild the tree from flat rows. Orphans become roots rather than disappearing. */
export function buildSpanTree(rows: SpanRow[]): SpanNode[] {
  const nodes = new Map<number, SpanNode>();
  for (const row of rows) {
    const started = Date.parse(row.started_at);
    const ended = row.ended_at ? Date.parse(row.ended_at) : NaN;
    nodes.set(row.id, {
      ...row,
      ms: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
      children: [],
    });
  }

  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Render a span tree the way an operator reads it: duration first (what is slow), name second
 * (what it was), attributes last (how much it moved).
 */
export function formatSpanTree(roots: SpanNode[], options: { totalChars?: number } = {}): string[] {
  const lines: string[] = [];

  const walk = (node: SpanNode, depth: number) => {
    const indent = "  ".repeat(depth);
    const marker = node.status === "error" ? "✗" : node.ended_at ? "•" : "…";
    const ms = node.ms === null ? "   -" : `${String(node.ms).padStart(4)}ms`;
    let attrs = "";
    if (node.attrs) {
      try {
        const parsed = JSON.parse(node.attrs);
        const parts = Object.entries(parsed)
          .slice(0, 4)
          .map(([key, value]) => `${key}=${typeof value === "string" ? value.slice(0, 24) : value}`);
        if (parts.length > 0) attrs = `  (${parts.join(", ")})`;
      } catch {
        /* attributes are decoration; never let them break the report */
      }
    }
    lines.push(`${indent}${marker} ${ms}  ${node.kind}/${node.name}${attrs}`);
    for (const child of node.children.sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1))) walk(child, depth + 1);
  };

  for (const root of roots.sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1))) walk(root, 0);

  if (options.totalChars !== undefined) {
    const total = roots.reduce((sum, node) => sum + (node.ms ?? 0), 0);
    lines.push("");
    lines.push(`共 ${roots.length} 个顶层 span，合计 ${total}ms`);
    lines.push("读法：时长越大越靠上；✗ 表示该层失败，问题就在那一层往下找。");
  }
  return lines;
}
