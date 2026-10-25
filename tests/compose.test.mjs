import { compose, DEFAULT_POLICIES, trimLines } from "../src/compose.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const POLICIES = {
  instructions: { floor: 0, cap: Number.MAX_SAFE_INTEGER, drop: "none", protected: true },
  memory: { floor: 100, cap: 400, drop: "lowest" },
  window: { floor: 200, cap: 600, drop: "oldest" },
  retrieved: { floor: 0, cap: 200, drop: "lowest" },
  current: { floor: 0, cap: Number.MAX_SAFE_INTEGER, drop: "none", protected: true },
};

// 1) under budget: nothing is touched, dividers unchanged
{
  const { prompt, manifest } = compose(
    [
      { kind: "memory", body: "- [事实·3] A" },
      { kind: "window", title: "## 最近对话", body: "[Rick] hi" },
      { kind: "current", title: "## 当前消息", body: "Q" },
    ],
    { budgetChars: 10_000, policies: POLICIES },
  );
  check("under budget keeps everything", prompt === "- [事实·3] A\n\n---\n\n## 最近对话\n[Rick] hi\n\n---\n\n## 当前消息\nQ", JSON.stringify(prompt));
  check("no truncation flags", manifest.segments.every((s) => !s.truncated), JSON.stringify(manifest.segments));
  check("usedChars matches prompt", manifest.usedChars === prompt.length);
}

// 2) caps apply even with budget to spare
{
  const long = Array.from({ length: 40 }, (_, i) => `- line ${i} ${"x".repeat(20)}`).join("\n");
  const { prompt, manifest } = compose([{ kind: "memory", body: long }, { kind: "current", body: "Q" }], {
    budgetChars: 100_000,
    policies: POLICIES,
  });
  const memoryReport = manifest.segments.find((s) => s.kind === "memory");
  check("memory capped at its ceiling", memoryReport.chars <= POLICIES.memory.cap + 1, String(memoryReport.chars));
  check("capping is reported", memoryReport.truncated === true);
  check("current message untouched", prompt.endsWith("Q"));
}

// 3) the current message is protected: an over-budget prompt truncates others, never it
{
  const huge = "z".repeat(5000);
  const { prompt, manifest } = compose([{ kind: "memory", body: huge }, { kind: "current", title: "## 当前消息", body: huge }], {
    budgetChars: 500,
    policies: POLICIES,
  });
  check("current message survives", prompt.includes(huge));
  check("prompt is over budget", manifest.overBudget === true);
  check("over-budget is explicit, not silent", manifest.budgetChars === 500 && manifest.usedChars > 500);
}

// 4) eviction order: retrieval is the first thing to go
{
  const filler = (prefix) => Array.from({ length: 20 }, (_, i) => `- ${prefix} ${i} ${"y".repeat(15)}`).join("\n");
  const { manifest } = compose(
    [
      { kind: "retrieved", body: filler("ret") },
      { kind: "memory", body: filler("mem") },
      { kind: "window", body: filler("win") },
      { kind: "current", body: "Q" },
    ],
    { budgetChars: 800, policies: POLICIES },
  );
  const retrieved = manifest.segments.find((s) => s.kind === "retrieved");
  const window = manifest.segments.find((s) => s.kind === "window");
  check("retrieval is evicted hardest", (retrieved?.chars ?? 0) < (window?.chars ?? 0), JSON.stringify(manifest.segments.map((s) => [s.kind, s.chars])));
  check("window keeps at least its floor", (window?.chars ?? 0) >= POLICIES.window.floor, String(window?.chars));
}

// 5) window truncation keeps the newest lines
{
  const body = ["oldest", "middle", "newest"].map((label) => `[Rick] ${label} ${"x".repeat(30)}`).join("\n");
  const { text } = trimLines(body, 60, "oldest");
  check("keeps the newest line", text.includes("newest"), JSON.stringify(text));
  check("drops the oldest line", !text.includes("oldest"), JSON.stringify(text));
}

// 6) memory truncation keeps the highest-priority (leading) lines
{
  const body = ["- high", "- middle", "- low"].map((line) => `${line} ${"x".repeat(20)}`).join("\n");
  const { text } = trimLines(body, 40, "lowest");
  check("keeps the leading line", text.includes("high"), JSON.stringify(text));
  check("drops the trailing line", !text.includes("low"), JSON.stringify(text));
}

// 7) cross-segment dedupe: a memory line already present verbatim in the window is dropped
{
  const shared = "对花生严重过敏，点菜必须避开";
  const { prompt, manifest } = compose(
    [
      { kind: "memory", body: `- [事实·4] ${shared}` },
      { kind: "window", title: "## 最近对话", body: `[Rick] ${shared}` },
      { kind: "current", body: "Q" },
    ],
    { budgetChars: 10_000, policies: POLICIES },
  );
  check("duplicate is removed from memory", !prompt.split("## 最近对话")[0].includes(shared), JSON.stringify(prompt));
  check("duplicate stays in the window", prompt.split("## 最近对话")[1].includes(shared));
  check("dedupe is recorded", manifest.dedup.length === 1, JSON.stringify(manifest.dedup));
}

// 8) unrelated lines are not treated as duplicates
{
  const { manifest } = compose(
    [
      { kind: "memory", body: "- [偏好] 喜欢简洁回答" },
      { kind: "window", body: "[Rick] 今天上海下雨" },
      { kind: "current", body: "Q" },
    ],
    { budgetChars: 10_000, policies: POLICIES },
  );
  check("no false dedupe", manifest.dedup.length === 0, JSON.stringify(manifest.dedup));
}

// 9) determinism and manifest accounting
{
  const input = [
    { kind: "memory", body: Array.from({ length: 10 }, (_, i) => `- m${i} ${"a".repeat(30)}`).join("\n") },
    { kind: "window", body: Array.from({ length: 10 }, (_, i) => `[Rick] w${i} ${"b".repeat(30)}`).join("\n") },
    { kind: "current", body: "Q" },
  ];
  const a = compose(input, { budgetChars: 700, policies: POLICIES });
  const b = compose(input, { budgetChars: 700, policies: POLICIES });
  check("deterministic", a.prompt === b.prompt);
  const sum = a.manifest.segments.reduce((n, s) => n + s.chars, 0);
  const dividers = (a.manifest.segments.length - 1) * "\n\n---\n\n".length;
  check("manifest accounts for every character", sum + dividers === a.manifest.usedChars, `${sum}+${dividers} vs ${a.manifest.usedChars}`);
}

// 10) documented defaults: the window has a floor, the current message is protected
{
  check("window floor is 1200", DEFAULT_POLICIES.window.floor === 1200);
  check("memory is capped", DEFAULT_POLICIES.memory.cap === 900);
  check("current is protected", DEFAULT_POLICIES.current.protected === true);
  check("instructions are protected", DEFAULT_POLICIES.instructions.protected === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
