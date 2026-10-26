/**
 * Brevity guard: a mechanical cap on reply length, applied after the model answers.
 *
 * Why this exists: SOUL.md already said "短句", and replies were still 60–212 characters,
 * with the agent arguing about why it needed to explain itself. Asking a model to be brief is
 * a *preference*; the model happily overrides preferences when it believes the question
 * deserves detail. Length is therefore a product decision, not something to delegate.
 *
 * This is deliberately dumb: split on sentence boundaries, keep the first N that fit, cut the
 * rest. No model call, no heuristics about "importance" — those are exactly the judgements
 * that produced the long reply in the first place.
 *
 * When the user *did* ask for analysis, none of this applies: expansion is legitimate then,
 * and a cap would destroy the answer.
 */
export type BrevityMode = "group" | "dm";

export type BrevityLimits = {
  /** Sentence count to keep. */
  sentences: number;
  /** Hard character cap for the kept text. */
  chars: number;
};

export const DEFAULT_LIMITS: Record<BrevityMode, BrevityLimits> = {
  // A group is a room with other people in it: two sentences, then stop.
  group: { sentences: 2, chars: 60 },
  // Private chat can afford one more clause.
  dm: { sentences: 3, chars: 120 },
};

/**
 * Phrases that mean "I actually want the long version". Deliberately conservative: a false
 * positive costs a long reply, a false negative costs a destroyed answer.
 */
const EXPAND_HINTS = [
  "为什么", "怎么", "如何", "方案", "分析", "步骤", "详细", "展开", "对比", "区别",
  "设计", "实现", "原理", "举例", "列出", "清单", "教程", "代码", "报错", "排查",
  "帮我写", "解释一下", "具体",
];

export function wantsDetail(userText: string): boolean {
  const text = userText ?? "";
  return EXPAND_HINTS.some((hint) => text.includes(hint));
}

const SENTENCE_END = /(?<=[。！？!?；;\n])/;

/** Keep whole sentences while they fit the character cap. */
function keepSentences(text: string, limits: BrevityLimits): string {
  const sentences = text
    .split(SENTENCE_END)
    .map((part) => part.trim())
    .filter(Boolean);

  const kept: string[] = [];
  let used = 0;
  for (const sentence of sentences) {
    if (kept.length >= limits.sentences) break;
    if (used + sentence.length > limits.chars) break;
    kept.push(sentence);
    used += sentence.length;
  }

  if (kept.length > 0) return kept.join("");

  // A single sentence longer than the cap: hard-cut so the reply is still bounded, and keep
  // the ellipsis so the reader is not shown a lie about where the text ended.
  const flat = sentences.join("").replace(/\s+/g, " ").trim();
  return flat.length > limits.chars ? `${flat.slice(0, limits.chars - 1)}…` : flat;
}

export type BrevityResult = { text: string; trimmed: boolean; reason?: string };

/**
 * Enforce the cap. `userText` decides whether expansion was requested; `mode` picks the limits.
 */
export function enforceBrevity(
  reply: string,
  mode: BrevityMode,
  userText: string,
  limits: BrevityLimits = DEFAULT_LIMITS[mode],
): BrevityResult {
  const text = (reply ?? "").trim();
  if (text.length === 0) return { text, trimmed: false };
  if (wantsDetail(userText)) return { text, trimmed: false, reason: "user asked for detail" };
  if (text.length <= limits.chars) return { text, trimmed: false };

  const shortened = keepSentences(text, limits);
  if (shortened.length >= text.length) return { text, trimmed: false };
  return { text: shortened, trimmed: true, reason: `capped at ${limits.chars} chars / ${limits.sentences} sentences` };
}
