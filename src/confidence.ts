export type ConfidenceCategory = "preference" | "fact" | "event";

export type ConfidenceInput = {
  category: ConfidenceCategory;
  /** True when the quote came from the user's own message, false for an assistant paraphrase. */
  fromUser: boolean;
  /** The assertion text, used only for hedging detection. */
  text: string;
  /** Independent confirmations of the same slot, including this one. */
  confirmations?: number;
  /** Days since the last confirmation. */
  ageDays?: number;
  /** How often this memory was actually injected and used. */
  useCount?: number;
};

export type ConfidenceStatus = "active" | "tentative" | "discard";

export type ConfidenceResult = {
  score: number;
  status: ConfidenceStatus;
  /** Human-readable breakdown, stored in `note` so a score can be explained later. */
  factors: string[];
};

/** Below this, the row is not created at all: the event layer still has the original text. */
export const DISCARD_BELOW = 0.35;
/** At or above this, the row is trusted enough to be injected. */
export const ACTIVE_FROM = 0.6;

const BASE_FROM_USER = 0.7;
const BASE_FROM_ASSISTANT = 0.4;
const HEDGE_FACTOR = 0.6;
const CONFIRMATION_BONUS = 0.15;
const MAX_CONFIRMATION_BONUS = 0.3;
const USAGE_BONUS = 0.05;
const MAX_USAGE_BONUS = 0.15;
const MAX_SCORE = 0.95;

/**
 * Hedging is detected in text rather than asked from the model: "might", "maybe", "I think"
 * are observable, while a self-reported confidence number is not calibrated across statements.
 */
const HEDGE = /(可能|也许|大概|好像|似乎|听说|估计|或许|大致|不确定|记不清|好像是|maybe|perhaps|probably|might|could be|i think|not sure|approximately)/i;

/** Half-life in days; `null` means the category does not decay. */
const HALF_LIFE: Record<ConfidenceCategory, number | null> = {
  preference: null,
  fact: 90,
  event: 365,
};

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const factors: string[] = [];

  let score = input.fromUser ? BASE_FROM_USER : BASE_FROM_ASSISTANT;
  factors.push(input.fromUser ? `来源=用户原话(${BASE_FROM_USER})` : `来源=助手转述(${BASE_FROM_ASSISTANT})`);

  if (HEDGE.test(input.text)) {
    score *= HEDGE_FACTOR;
    factors.push(`含糊措辞×${HEDGE_FACTOR}`);
  }

  const confirmations = Math.max(1, Math.round(input.confirmations ?? 1));
  if (confirmations > 1) {
    const bonus = Math.min(MAX_CONFIRMATION_BONUS, CONFIRMATION_BONUS * (confirmations - 1));
    score += bonus;
    factors.push(`独立确认+${bonus.toFixed(2)}×${confirmations}`);
  }

  const useCount = Math.max(0, Math.round(input.useCount ?? 0));
  if (useCount > 0) {
    const bonus = Math.min(MAX_USAGE_BONUS, USAGE_BONUS * useCount);
    score += bonus;
    factors.push(`被使用+${bonus.toFixed(2)}`);
  }

  score = Math.min(MAX_SCORE, score);

  const halfLife = HALF_LIFE[input.category];
  if (halfLife !== null) {
    const ageDays = Math.max(0, input.ageDays ?? 0);
    if (ageDays > 0) {
      const decay = Math.pow(0.5, ageDays / halfLife);
      // Recent use slows decay: a fact still being referenced is less likely to be stale.
      const effective = useCount > 0 ? Math.sqrt(decay) : decay;
      score *= effective;
      factors.push(`时间衰减×${effective.toFixed(2)}(${input.category} 半衰期 ${halfLife} 天)`);
    }
  } else {
    factors.push("偏好不衰减");
  }

  score = Math.round(Math.max(0, Math.min(MAX_SCORE, score)) * 1000) / 1000;

  const status: ConfidenceStatus = score >= ACTIVE_FROM ? "active" : score >= DISCARD_BELOW ? "tentative" : "discard";
  return { score, status, factors };
}

/** Convenience: does this score qualify for injection? */
export function isInjectable(result: ConfidenceResult): boolean {
  return result.status === "active";
}
