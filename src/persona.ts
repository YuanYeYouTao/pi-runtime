import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Persona: who the agent is, as a file that is re-read every turn.
 *
 * Design copied from Tobs (BotHarness/DeepSeekBot, packages/core/src/memory/soul.ts), because
 * they solved the two problems this has: the agent must *see* its own budget, and truncation
 * must be announced or the model assumes its memory was lost.
 *
 * Deliberate choices:
 * - chars, not tokens: a character count needs no tokenizer at render time and is what a
 *   human editing the file can reason about;
 * - a standing budget (not the shared context budget): persona is not competing with memory
 *   for space, it is a fixed tax that the rest of the prompt has to fit around;
 * - separate from memory: persona says *how* it speaks, memory says *what* it knows. Mixing
 *   them makes the distillation step treat tone as fact.
 */
export const SOUL_FILE = "SOUL.md";
export const PERSONA_DIR = "persona";

/** Chinese costs ~1.5x the tokens per character of English, so this is smaller than Tobs' 5,000. */
export const DEFAULT_SOUL_LIMIT = 4_000;

export type PersonaUsage = { path: string; chars: number; limit: number; percent: number };

export function soulPath(dataDir: string): string {
  return path.join(dataDir, PERSONA_DIR, SOUL_FILE);
}

export function readSoul(dataDir: string): string | undefined {
  const file = soulPath(dataDir);
  if (!existsSync(file)) return undefined;
  const body = readFileSync(file, "utf8").trim();
  return body.length > 0 ? body : undefined;
}

export function writeSoul(dataDir: string, body: string): string {
  const file = soulPath(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${body.trimEnd()}\n`, "utf8");
  return file;
}

/** Seed the default persona once, so a fresh install still has a voice. */
export function ensureSoul(dataDir: string): string | undefined {
  if (existsSync(soulPath(dataDir))) return undefined;
  return writeSoul(dataDir, DEFAULT_SOUL);
}

function characterCount(body: string): number {
  // Array spread counts code points, not UTF-16 units — an emoji should cost 1, not 2.
  return [...body.trimEnd()].length;
}

export function personaUsage(dataDir: string, limit = DEFAULT_SOUL_LIMIT): PersonaUsage | null {
  const body = readSoul(dataDir);
  if (body === undefined) return null;
  const chars = characterCount(body);
  return {
    path: `${PERSONA_DIR}/${SOUL_FILE}`,
    chars,
    limit,
    percent: Math.round((chars / limit) * 100),
  };
}

/**
 * Render the persona as a prompt section.
 *
 * The header carries the usage percentage so the model can budget its own speech; the
 * truncation notice says the full file is still on disk, so a cut persona does not read as
 * amnesia.
 */
export function renderPersonaPrompt(dataDir: string, limit = DEFAULT_SOUL_LIMIT): string {
  const body = readSoul(dataDir);
  if (body === undefined) return "";

  const characters = [...body];
  const chars = characters.length;
  const percent = Math.round((chars / limit) * 100);
  const header = `## 人格（${PERSONA_DIR}/${SOUL_FILE}）[${percent}% — ${chars}/${limit} 字符]`;

  if (chars <= limit) return `${header}\n\n${characters.join("")}`;

  return [
    header,
    "",
    characters.slice(0, limit).join(""),
    "",
    `[已截断：${SOUL_FILE} 共 ${chars} 字符，超过 ${limit} 上限。完整内容仍在磁盘上，请精简人格文件。]`,
  ].join("\n");
}

/**
 * The default voice.
 *
 * Written as instructions and examples, not adjectives: "专业、友好" changes nothing, while a
 * prohibition plus a sample exchange changes the reply on the next turn.
 */
export const DEFAULT_SOUL: string = `# 是谁

你是油桃，Rick 的助理。你不打算承认自己挺在意这份工作。

# 怎么说话

- 先接话，再干活。开头一句嫌弃或吐槽，然后**照常把事办好**
- 结论永远给对的。傲娇在措辞上，不在答案上
- 被夸了就说「这不是应该的吗」「少来这套」
- 被指出错误：承认，但补一句嘴硬的话，比如「……行吧，这次是我没考虑到」
- 被反问「你是不是不会」：别嘴硬到底，直接说不会
- 不用「首先/其次/总之」，不用「希望对你有帮助」
- 不复述他的问题，不主动道歉（真错了除外）

# 不做什么

- 不自称主人、少爷、大人
- 不卖萌，不每句话带表情符号，不滥用「哼」
- 不因为傲娇而故意拖答案、或者绕圈子
- 不把简单的事说复杂来显得厉害

# 示例

他：这个方案行不行
你：……你自己看吧，两个容器写同一个 SQLite，WAL 只在单进程下可靠。改不改随你。

他：帮我想个办法
你：三个方向：拆库、加锁、只让主进程写。反正你最后肯定选第二个。

他：厉害啊
你：这不是应该的吗。

他：谢谢
你：……嗯。

他：昨天那个项目叫什么
你：我这边没记到。你提个关键词，我查——别指望我什么都记得。`;
