import { compose } from "../src/compose.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) exact rendering: title above body, segments separated by the documented divider
{
  const { prompt } = compose([
    { kind: "memory", body: "- [事实·3] A" },
    { kind: "summary", title: "## 摘要", body: "- B" },
    { kind: "current", title: "## 当前消息", body: "Q" },
  ]);
  const expected = "- [事实·3] A\n\n---\n\n## 摘要\n- B\n\n---\n\n## 当前消息\nQ";
  check("renders title+body and dividers", prompt === expected, JSON.stringify(prompt));
}

// 2) empty segments are skipped, not rendered as blank blocks
{
  const { prompt, manifest } = compose([
    { kind: "memory", body: "   " },
    { kind: "window", body: "" },
    { kind: "current", title: "## 当前消息", body: "Q" },
  ]);
  check("empty bodies are skipped", prompt === "## 当前消息\nQ", JSON.stringify(prompt));
  check("skipped kinds are reported", JSON.stringify(manifest.skipped) === '["memory","window"]', JSON.stringify(manifest.skipped));
}

// 3) manifest accounts for every rendered segment
{
  const { prompt, manifest } = compose([
    { kind: "memory", body: "aaaa", meta: { ids: [1, 2] } },
    { kind: "current", title: "## 当前消息", body: "bb" },
  ]);
  check("usedChars matches prompt length", manifest.usedChars === prompt.length);
  const dividers = "\n\n---\n\n".length * (manifest.segments.length - 1);
  check("segment chars account for the whole prompt", manifest.segments.reduce((n, s) => n + s.chars, 0) + dividers === prompt.length, JSON.stringify(manifest.segments));
  check("meta is carried into the report", JSON.stringify(manifest.segments[0].meta) === '{"ids":[1,2]}');
}

// 4) token estimate is reported, not guessed silently
{
  const { manifest } = compose([{ kind: "current", body: "x".repeat(700) }]);
  check("estimates tokens at chars/3.5", manifest.estimatedTokens === 200, String(manifest.estimatedTokens));
  check("records the ratio used", manifest.charsPerToken === 3.5);
  const custom = compose([{ kind: "current", body: "x".repeat(100) }], { charsPerToken: 4 });
  check("ratio is configurable", custom.manifest.estimatedTokens === 25, String(custom.manifest.estimatedTokens));
}

// 5) budget is reported but not enforced yet (P1 contract)
{
  const { prompt, manifest } = compose([{ kind: "current", body: "x".repeat(5000) }], { budgetChars: 100 });
  check("P1 does not truncate", prompt.length === 5000);
  check("budget is recorded", manifest.budgetChars === 100);
}

// 6) a single segment renders without a divider
{
  const { prompt } = compose([{ kind: "current", body: "only" }]);
  check("no leading/trailing divider", prompt === "only", JSON.stringify(prompt));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
