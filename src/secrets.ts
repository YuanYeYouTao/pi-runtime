export type SecretFinding = { sensitive: boolean; reasons: string[]; redacted: string };

/**
 * Credential detection for anything about to be persisted as memory.
 *
 * The goal is not "detect all secrets" (impossible) but "never persist an obvious credential
 * as a chat fact". Two failure directions matter:
 * - False negative: a password lands in SQLite, in `MEMORY.md`, and in every prompt of that
 *   scope. That is the bug this module exists for.
 * - False positive: "我的密码策略是 90 天改一次" gets blocked, and the system becomes annoying
 *   enough that people turn it off. So assignment-shaped patterns require a *value* after the
 *   keyword, not just the keyword.
 */
const PROVIDER_TOKENS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk_live_[A-Za-z0-9]{10,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
];

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** keyword + separator + an actual value (at least 6 chars) */
const ASSIGNMENT = new RegExp(
  [
    "(?:密码|口令|密钥|私钥|令牌|银行卡密码|password|passwd|pwd|secret|token|api[_ -]?key|access[_ -]?key)",
    "\\s*(?:是|为|:|：|=|->|is)\\s*",
    "[\"'`]?([^\\s\"'`,，。;；]{6,})",
  ].join(""),
  "i",
);

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/;
const CARD_LIKE_PIN = /(?:银行卡|信用卡|支付密码|pin)\D{0,6}\d{6,}/i;

/** Long unbroken token that looks generated rather than typed. */
const RANDOM_CANDIDATE = /[A-Za-z0-9+/=_-]{28,}/g;

/** Identifiers that are long and mixed-class but are not credentials. */
const NOT_A_SECRET = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{32,}$/i, // hex digest
];

function looksGenerated(value: string): boolean {
  if (value.length < 28) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  // UUIDs and lowercase hex digests have at most two classes and are common in normal text.
  return classes >= 3;
}

export function redact(text: string): string {
  return text
    .replace(/([A-Za-z0-9+/=_-]{12})[A-Za-z0-9+/=_-]{6,}/g, "$1***")
    .replace(/((?:密码|口令|密钥|私钥|令牌|password|passwd|pwd|secret|token)\s*(?:是|为|:|：|=)\s*)[\S]{4,}/gi, "$1***");
}

export function detectSecret(text: string): SecretFinding {
  const reasons: string[] = [];
  const value = text ?? "";

  if (PRIVATE_KEY_BLOCK.test(value)) reasons.push("private-key-block");
  for (const pattern of PROVIDER_TOKENS) {
    if (pattern.test(value)) {
      reasons.push("provider-token");
      break;
    }
  }
  if (BEARER.test(value)) reasons.push("bearer-token");
  if (CARD_LIKE_PIN.test(value)) reasons.push("card-or-pin");

  const assignment = ASSIGNMENT.exec(value);
  if (assignment) {
    const candidate = assignment[1];
    // "密码策略" style statements have no value-shaped token after the separator.
    if (candidate && candidate.length >= 6 && !/^(策略|规则|习惯|要求|长度|复杂度)/.test(candidate)) {
      reasons.push("keyword-assignment");
    }
  }

  for (const match of value.match(RANDOM_CANDIDATE) ?? []) {
    if (NOT_A_SECRET.some((pattern) => pattern.test(match))) continue;
    if (looksGenerated(match)) {
      reasons.push("high-entropy");
      break;
    }
  }

  return { sensitive: reasons.length > 0, reasons, redacted: redact(value) };
}
