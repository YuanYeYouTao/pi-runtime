import { Gate } from "../src/gate.ts";
import { buildDigest, buildSplitPrompt, canSpawn, parseSubtasks, runWithLimit } from "../src/subagent.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) depth guard
{
  check("root may spawn", canSpawn(0, 1) === true);
  check("child may not spawn when maxDepth is 1", canSpawn(1, 1) === false);
  check("depth 2 allowed when configured", canSpawn(1, 2) === true);
}

// 2) split prompt asks for strict JSON and carries the task
{
  const prompt = buildSplitPrompt("重构这三个模块", 3);
  check("mentions the count", prompt.includes("3 个"), prompt.slice(0, 60));
  check("asks for JSON", prompt.includes('"tasks"'));
  check("carries the task", prompt.includes("重构这三个模块"));
}

// 3) subtask parsing survives fences and prose
{
  const clean = '{"tasks":[{"title":"A","prompt":"do a"},{"title":"B","prompt":"do b"}]}';
  check("parses bare JSON", parseSubtasks(clean, 2).length === 2);
  check("parses fenced JSON", parseSubtasks("```json\n" + clean + "\n```", 2).length === 2);
  check("parses JSON inside prose", parseSubtasks(`好的：\n${clean}\n以上。`, 2).length === 2);
  check("respects the requested count", parseSubtasks(clean, 1).length === 1);
  check("drops empty prompts", parseSubtasks('{"tasks":[{"title":"A","prompt":"  "}]}', 2).length === 0);
  check("garbage yields nothing", parseSubtasks("我做不到", 3).length === 0);
  check("indices are sequential", parseSubtasks(clean, 2).map((s) => s.index).join(",") === "1,2");
}

// 4) digest includes every child, marks failures, and caps long output
{
  const long = "x".repeat(3000);
  const digest = buildDigest(
    [
      { index: 1, title: "好的", status: "ok", output: "结论 A" },
      { index: 2, title: "坏的", status: "failed", output: "", error: "超时" },
      { index: 3, title: "长的", status: "ok", output: long },
    ],
    1200,
  );
  check("mentions every child", digest.includes("1. 好的") && digest.includes("2. 坏的") && digest.includes("3. 长的"));
  check("marks the failure", digest.includes("失败") && digest.includes("超时"));
  check("tells the parent what is missing", digest.includes("明确说明这部分缺失"));
  check("caps long output", digest.includes("已截断") && !digest.includes("x".repeat(1500)), String(digest.length));
  check("asks for a synthesis", digest.includes("综合"));
}

// 5) the limit helper never exceeds its bound and keeps order
{
  let inFlight = 0;
  let peak = 0;
  const order = [];
  const results = await runWithLimit([1, 2, 3, 4, 5], 2, async (item) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    order.push(item);
    return item * 10;
  });
  check("respects the concurrency limit", peak <= 2, String(peak));
  check("actually runs in parallel", peak === 2, String(peak));
  check("preserves result order", results.join(",") === "10,20,30,40,50", results.join(","));
  check("runs everything", order.length === 5);
}

// 6) a child gate is independent of the parent gate
{
  const parent = new Gate(1, 0);
  const children = new Gate(3, 0);
  const releases = await Promise.all([children.acquire(), children.acquire(), children.acquire()]);
  check("child gate admits its own limit", releases.length === 3);
  releases.forEach((release) => release());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
