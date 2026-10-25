import { similarity } from "./memory.ts";

export type ComposeSegment = {
  /** Stable identifier, used in the manifest and the policy table. */
  kind: "instructions" | "memory" | "short_state" | "summary" | "window" | "retrieved" | "current" | string;
  /** Section header, rendered above the body. */
  title?: string;
  body: string;
  /** Anything worth recording: selected ids, counts, reasons. Never rendered. */
  meta?: Record<string, unknown>;
};

export type DropOrder =
  /** Drop from the beginning, keep the newest lines (conversation window). */
  | "oldest"
  /** Drop from the end, keep the highest-priority lines (ranked memory). */
  | "lowest"
  /** Drop from the end, keep the leading sections (structured summary). */
  | "tail"
  | "none";

export type SegmentPolicy = {
  /** Guaranteed characters, granted before any proportional distribution. */
  floor: number;
  /** Hard cap, applied even when there is budget to spare. */
  cap: number;
  drop: DropOrder;
  /** Never truncated (instructions, the current message). */
  protected?: boolean;
};

export type ComposeOptions = {
  budgetChars?: number;
  charsPerToken?: number;
  policies?: Record<string, SegmentPolicy>;
  /** Similarity above which a lower-priority line is considered a duplicate. */
  dedupeThreshold?: number;
};

export type SegmentReport = {
  kind: string;
  chars: number;
  floor: number;
  cap: number;
  truncated: boolean;
  droppedChars: number;
  meta?: Record<string, unknown>;
};

export type ComposeManifest = {
  budgetChars: number;
  usedChars: number;
  estimatedTokens: number;
  charsPerToken: number;
  overBudget: boolean;
  segments: SegmentReport[];
  skipped: string[];
  dedup: Array<{ kind: string; dropped: string; keptIn: string; similarity: number }>;
  evictions: Array<{ kind: string; droppedChars: number }>;
};

const MAX = Number.MAX_SAFE_INTEGER;

export const DEFAULT_POLICIES: Record<string, SegmentPolicy> = {
  instructions: { floor: 0, cap: MAX, drop: "none", protected: true },
  memory: { floor: 150, cap: 900, drop: "lowest" },
  short_state: { floor: 0, cap: 300, drop: "lowest" },
  summary: { floor: 0, cap: 1000, drop: "tail" },
  window: { floor: 1200, cap: 2800, drop: "oldest" },
  retrieved: { floor: 0, cap: 800, drop: "lowest" },
  current: { floor: 0, cap: MAX, drop: "none", protected: true },
};

const FALLBACK_POLICY: SegmentPolicy = { floor: 0, cap: MAX, drop: "none" };

/** Cheapest to lose first. `current` and `instructions` are never in this list. */
export const EVICTION_ORDER = ["retrieved", "short_state", "memory", "summary", "window"];

const DIVIDER = "\n\n---\n\n";

/**
 * Strip the presentation prefixes before comparing lines: a memory line is rendered as
 * `- [事实·4] …` and a window line as `[Rick] …`. Leaving them in makes dedupe depend on
 * formatting noise instead of content.
 */
const PREFIX = /^(?:[-*]\s*)?(?:\[[^\]]{1,24}\]\s*)+/;

export function stripPrefix(line: string): string {
  return line.replace(PREFIX, "").trim();
}

/** Which segments are allowed to shadow which: a later segment wins. */
const DEDUPE_PRIORITY = ["window", "short_state", "memory", "summary"];

function policyFor(kind: string, overrides?: Record<string, SegmentPolicy>): SegmentPolicy {
  return overrides?.[kind] ?? DEFAULT_POLICIES[kind] ?? FALLBACK_POLICY;
}

/**
 * Trim a body to `maxChars` by dropping whole lines in the policy's order.
 * Lines are kept in their original order; only the selection changes.
 */
export function trimLines(text: string, maxChars: number, order: DropOrder): { text: string; dropped: number } {
  if (maxChars === MAX || text.length <= maxChars) return { text, dropped: 0 };
  const lines = text.split("\n");
  const keep: string[] = [];
  let used = 0;

  const sequence = order === "oldest" ? [...lines].reverse() : lines;
  for (const line of sequence) {
    const cost = line.length + 1;
    if (used + cost > maxChars && keep.length > 0) break;
    keep.push(line);
    used += cost;
  }

  const selected = order === "oldest" ? [...keep].reverse() : keep;
  const result = selected.join("\n");
  return { text: result, dropped: text.length - result.length };
}

/**
 * Assemble the prompt: dedupe duplicates across segments, allocate the budget by policy,
 * trim what does not fit, then render.
 *
 * Pure and deterministic: same segments and budget always produce the same prompt, which is
 * what makes a prompt diffable between refactors.
 */
export function compose(
  segments: ComposeSegment[],
  options: ComposeOptions = {},
): { prompt: string; manifest: ComposeManifest } {
  const charsPerToken = options.charsPerToken ?? 3.5;
  const budgetChars = options.budgetChars ?? 0;
  const threshold = options.dedupeThreshold ?? 0.7;

  const prepared = segments.map((segment) => ({
    ...segment,
    body: (segment.body ?? "").trim(),
    policy: policyFor(segment.kind, options.policies),
  }));

  // ---- cross-segment dedupe -------------------------------------------------------------
  const dedup: ComposeManifest["dedup"] = [];
  const reference = new Map<string, string[]>(); // winning lines per priority level
  for (const kind of DEDUPE_PRIORITY) {
    const segment = prepared.find((item) => item.kind === kind && item.body);
    if (!segment) continue;
    const kept: string[] = [];
    for (const line of segment.body.split("\n")) {
      const bare = stripPrefix(line);
      if (bare.length < 8 || line.startsWith("#")) {
        kept.push(line);
        continue;
      }
      const shadow = DEDUPE_PRIORITY.slice(0, DEDUPE_PRIORITY.indexOf(kind))
        .flatMap((higher) => reference.get(higher) ?? [])
        .find((candidate) => similarity(stripPrefix(candidate), bare) >= threshold);
      if (shadow) {
        dedup.push({
          kind,
          dropped: bare.slice(0, 60),
          keptIn: "higher-priority segment",
          similarity: Number(similarity(stripPrefix(shadow), bare).toFixed(2)),
        });
        continue;
      }
      kept.push(line);
    }
    segment.body = kept.join("\n").trim();
    reference.set(kind, kept);
  }

  const active = prepared.filter((segment) => segment.body.trim().length > 0);
  const skipped = prepared.filter((segment) => segment.body.trim().length === 0).map((segment) => segment.kind);

  // ---- budget allocation ----------------------------------------------------------------
  const renderedBase = (segment: (typeof active)[number]): string =>
    segment.title ? `${segment.title}\n${segment.body}` : segment.body;

  const dividerCost = DIVIDER.length * Math.max(0, active.length - 1);
  const protectedSegments = active.filter((segment) => segment.policy.protected);
  const flexible = active.filter((segment) => !segment.policy.protected);

  const protectedChars = protectedSegments.reduce((sum, segment) => sum + renderedBase(segment).length, 0);
  let available = budgetChars > 0 ? budgetChars - dividerCost - protectedChars : Number.MAX_SAFE_INTEGER;

  const target = new Map<string, number>();
  for (const segment of flexible) {
    const rendered = renderedBase(segment).length;
    target.set(segment.kind, Math.min(rendered, segment.policy.cap));
  }

  const demand = [...target.values()].reduce((sum, value) => sum + value, 0);
  const evictions: ComposeManifest["evictions"] = [];

  if (available < 0) available = 0;

  if (demand > available) {
    // 1) grant floors in eviction order (cheapest to lose first gets its floor last)
    let floorsTotal = 0;
    for (const kind of EVICTION_ORDER) {
      const segment = flexible.find((item) => item.kind === kind);
      if (!segment) continue;
      const floor = Math.min(segment.policy.floor, target.get(kind) ?? 0);
      floorsTotal += floor;
      target.set(kind, floor);
    }

    // 2) if floors already exceed the budget, shrink them in reverse eviction order
    while (floorsTotal > available) {
      let shrunk = false;
      for (const kind of [...EVICTION_ORDER].reverse()) {
        const current = target.get(kind) ?? 0;
        if (current > 0) {
          const cut = Math.min(current, floorsTotal - available);
          target.set(kind, current - cut);
          floorsTotal -= cut;
          shrunk = true;
          if (floorsTotal <= available) break;
        }
      }
      if (!shrunk) break;
    }

    // 3) distribute the remainder proportionally to each segment's unmet demand
    const remaining = Math.max(0, available - floorsTotal);
    const unmet = flexible.reduce((sum, segment) => sum + Math.max(0, Math.min(renderedBase(segment).length, segment.policy.cap) - (target.get(segment.kind) ?? 0)), 0);
    if (remaining > 0 && unmet > 0) {
      for (const segment of flexible) {
        const ceiling = Math.min(renderedBase(segment).length, segment.policy.cap);
        const current = target.get(segment.kind) ?? 0;
        const share = Math.floor((remaining * (ceiling - current)) / unmet);
        target.set(segment.kind, Math.min(ceiling, current + share));
      }
    }
  }

  // ---- trim + render ---------------------------------------------------------------------
  const rendered: string[] = [];
  const reports: SegmentReport[] = [];
  let usedChars = 0;

  for (const segment of active) {
    const full = renderedBase(segment);
    const limit = segment.policy.protected ? MAX : Math.min(full.length, target.get(segment.kind) ?? full.length);
    let text = full;

    if (limit < full.length) {
      const { text: trimmed } = trimLines(full, limit, segment.policy.drop);
      text = trimmed || full.slice(0, limit);
      evictions.push({ kind: segment.kind, droppedChars: full.length - text.length });
    }

    // A trimmed memory block should keep its section header out of the way of counting.
    rendered.push(text);
    usedChars += text.length;
    reports.push({
      kind: segment.kind,
      chars: text.length,
      floor: segment.policy.floor,
      cap: segment.policy.cap,
      truncated: text.length < full.length,
      droppedChars: full.length - text.length,
      meta: segment.meta,
    });
  }

  usedChars += dividerCost;

  return {
    prompt: rendered.join(DIVIDER),
    manifest: {
      budgetChars,
      usedChars,
      estimatedTokens: Math.ceil(usedChars / charsPerToken),
      charsPerToken,
      overBudget: budgetChars > 0 && usedChars > budgetChars,
      segments: reports,
      skipped,
      dedup,
      evictions,
    },
  };
}
