import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.PI_RT_DATA_DIR ? path.resolve(process.env.PI_RT_DATA_DIR) : path.join(ROOT, "data");
/** Isolated pi config dir, so the runtime never touches ~/.pi/agent. */
export const PI_CONFIG_DIR = process.env.PI_RT_PI_DIR
  ? path.resolve(process.env.PI_RT_PI_DIR)
  : path.join(DATA_DIR, "pi");
export const DB_PATH = path.join(DATA_DIR, "runtime.db");
export const PI_CLI = path.join(
  ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

export type FeishuConfig = {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
};

export type RuntimeConfig = {
  provider?: string;
  model?: string;
  /** Working directory the agent operates in. */
  workspace: string;
  /** Hard wall-clock cap per task, in minutes. */
  maxMinutes: number;
  /** The person this agent belongs to. Becomes the canonical subject for the owner. */
  ownerName: string;
  /** Channel user ids that also count as the owner (names differ across channels). */
  ownerIds: string[];
  /** Character budget for the injected memory block. */
  memoryBudgetChars: number;
  /** Inject memories into every prompt. */
  memoryEnabled: boolean;
  /** Distil automatically once this many undistilled turns pile up in a thread. */
  batchTurns: number;
  /** Also distil when a thread has been idle this long, even below batchTurns. */
  idleMinutes: number;
  /** Set false to disable automatic distillation (manual `distill` only). */
  autoExtract: boolean;
  /** Feishu app credentials; env wins over config.json. */
  feishu: FeishuConfig;
  /** Recent-message window carried into every prompt. */
  contextTurns: number;
  contextBudgetChars: number;
  /** Rolling compression of the cold part of a thread. */
  summaryEnabled: boolean;
  summaryTriggerChars: number;
  summaryMaxChars: number;
};

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, PI_CONFIG_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): RuntimeConfig {
  const file = path.join(ROOT, "config.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return {
    provider: process.env.PI_RT_PROVIDER ?? raw.provider,
    model: process.env.PI_RT_MODEL ?? raw.model,
    workspace: path.resolve(process.env.PI_RT_WORKSPACE ?? raw.workspace ?? process.cwd()),
    maxMinutes: Number(process.env.PI_RT_MAX_MINUTES ?? raw.maxMinutes ?? 30),
    ownerName: String(process.env.PI_RT_OWNER ?? raw.ownerName ?? "Rick"),
    ownerIds: String(process.env.PI_RT_OWNER_IDS ?? (raw.ownerIds ?? []).join(","))
      .split(",")
      .map((id: string) => id.trim())
      .filter(Boolean),
    memoryBudgetChars: Number(process.env.PI_RT_MEMORY_BUDGET ?? raw.memory?.budgetChars ?? 1_800),
    memoryEnabled: (process.env.PI_RT_MEMORY ?? String(raw.memory?.enabled ?? true)) !== "false",
    batchTurns: Number(process.env.PI_RT_BATCH_TURNS ?? raw.memory?.batchTurns ?? 10),
    idleMinutes: Number(process.env.PI_RT_IDLE_MINUTES ?? raw.memory?.idleMinutes ?? 15),
    autoExtract: (process.env.PI_RT_AUTO_EXTRACT ?? String(raw.memory?.autoExtract ?? true)) !== "false",
    feishu: {
      appId: process.env.FEISHU_APP_ID ?? raw.feishu?.appId,
      appSecret: process.env.FEISHU_APP_SECRET ?? raw.feishu?.appSecret,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? raw.feishu?.encryptKey,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? raw.feishu?.verificationToken,
    },
    contextTurns: Number(process.env.PI_RT_CONTEXT_TURNS ?? raw.context?.turns ?? 6),
    contextBudgetChars: Number(process.env.PI_RT_CONTEXT_BUDGET ?? raw.context?.budgetChars ?? 4_000),
    summaryEnabled: (process.env.PI_RT_SUMMARY ?? String(raw.context?.summary ?? true)) !== "false",
    summaryTriggerChars: Number(process.env.PI_RT_SUMMARY_TRIGGER ?? raw.context?.summaryTriggerChars ?? 2_400),
    summaryMaxChars: Number(process.env.PI_RT_SUMMARY_MAX ?? raw.context?.summaryMaxChars ?? 1_200),
  };
}

/** Environment handed to every pi subprocess. */
export function piEnv(cfg: RuntimeConfig): Record<string, string | undefined> {
  return {
    PI_CODING_AGENT_DIR: PI_CONFIG_DIR,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_RT_PROVIDER: cfg.provider,
    PI_RT_MODEL: cfg.model,
  };
}

/** CLI flags for the pi subprocess. */
export function piArgs(cfg: RuntimeConfig): string[] {
  const args = ["--no-session", "--no-approve"];
  if (cfg.provider) args.push("--provider", cfg.provider);
  if (cfg.model) args.push("--model", cfg.model);
  return args;
}
