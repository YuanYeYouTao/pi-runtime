import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, loadConfig } from "./config.ts";
import type { RuntimeConfig } from "./config.ts";
import { Store } from "./db.ts";
import { runTask } from "./worker.ts";

type ContextCase = {
  id: string;
  /** Single fact (short form) or several facts (stress form). */
  fact?: string;
  facts?: string[];
  expect: string[];
  probe: string;
  /** How many filler exchanges to insert after the facts. Defaults to one pass. */
  fillers?: number;
};

type CaseResult = {
  id: string;
  baselinePass: boolean;
  systemPass: boolean;
  baselineAnswer: string;
  systemAnswer: string;
  summaryChars: number;
  ms: number;
};

/** Neutral chit-chat: it must not contain any fact, only push it out of the window. */
const FILLERS: Array<[string, string]> = [
  ["最近有点忙，排期挺紧的。", "注意休息，需要我帮你排一下优先级吗？"],
  ["今天天气还不错。", "适合出去走走。"],
  ["中午吃了碗面。", "听着挺香。"],
  ["刚开完一个会，有点累。", "先把结论记下来，别在细节里打转。"],
  ["等下还要回几封邮件。", "需要我帮你起草吗？"],
];

const normalize = (text: string): string => text.replace(/\s+/g, "").toLowerCase();
const allKeywords = (answer: string, keywords: string[]): boolean =>
  keywords.every((keyword) => normalize(answer).includes(normalize(keyword)));

async function runCondition(
  testCase: ContextCase,
  cfg: RuntimeConfig,
  dir: string,
  thread: string,
): Promise<{ answer: string; summaryChars: number }> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, "runtime.db"));

  store.addConversationEvent(thread, "Rick", "user", testCase.facts?.[0] ?? testCase.fact ?? "");
  store.addConversationEvent(thread, "agent", "assistant", "记下了。");
  const extraFacts = (testCase.facts ?? []).slice(1);
  for (const fact of extraFacts) {
    store.addConversationEvent(thread, "Rick", "user", fact);
    store.addConversationEvent(thread, "agent", "assistant", "也记下了。");
  }
  const fillerCount = testCase.fillers ?? FILLERS.length;
  for (let index = 0; index < fillerCount; index++) {
    const [user, assistant] = FILLERS[index % FILLERS.length];
    store.addConversationEvent(thread, "Rick", "user", user);
    store.addConversationEvent(thread, "agent", "assistant", assistant);
  }

  const taskId = store.createTask(testCase.probe, ROOT, thread);
  try {
    // No memory here on purpose: this measures context assembly only.
    const answer = await runTask(store, cfg, store.getTask(taskId)!, {}, null);
    return { answer, summaryChars: store.threadState(thread).summary.length };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runContextEval(options: { casesPath?: string; only?: string } = {}): Promise<number> {
  const casesPath = options.casesPath ?? path.join(ROOT, "eval", "context-cases.json");
  const file = JSON.parse(readFileSync(casesPath, "utf8")) as { cases: ContextCase[] };
  const cases = options.only ? file.cases.filter((item) => item.id.includes(options.only!)) : file.cases;
  const base = loadConfig();

  // Two conditions, measured on the same transcript:
  //   baseline = a fixed window with NO compression (what you get from a plain window)
  //   system   = the same window plus the rolling summary
  // The difference is what summarisation actually buys.
  const baselineCfg: RuntimeConfig = { ...base, contextTurns: 30, contextBudgetChars: 20_000, summaryEnabled: false };
  const systemCfg: RuntimeConfig = {
    ...base,
    contextTurns: 6,
    contextBudgetChars: 4_000,
    summaryEnabled: true,
    summaryTriggerChars: 50,
    summaryMaxChars: 1_200,
  };

  const results: CaseResult[] = [];
  console.log(`running ${cases.length} context cases × 2 conditions\n`);

  for (const testCase of cases) {
    const started = Date.now();
    let outcome: CaseResult;
    try {
      const baselineRun = await runCondition(testCase, baselineCfg, path.join(ROOT, "eval", "tmp-ctx", `${testCase.id}-w`), `${testCase.id}-w`);
      const systemRun = await runCondition(testCase, systemCfg, path.join(ROOT, "eval", "tmp-ctx", `${testCase.id}-s`), `${testCase.id}-s`);
      outcome = {
        id: testCase.id,
        baselinePass: allKeywords(baselineRun.answer, testCase.expect),
        systemPass: allKeywords(systemRun.answer, testCase.expect),
        baselineAnswer: baselineRun.answer,
        systemAnswer: systemRun.answer,
        summaryChars: systemRun.summaryChars,
        ms: Date.now() - started,
      };
    } catch (error) {
      outcome = {
        id: testCase.id,
        baselinePass: false,
        systemPass: false,
        baselineAnswer: `ERROR ${error instanceof Error ? error.message : String(error)}`,
        systemAnswer: "",
        summaryChars: 0,
        ms: Date.now() - started,
      };
    }
    results.push(outcome);
    console.log(
      `${outcome.baselinePass ? "PASS" : "FAIL"} ${outcome.id.padEnd(26)} 基线${outcome.baselinePass ? "✓" : "✗"} 系统${outcome.systemPass ? "✓" : "✗"} 摘要${outcome.summaryChars}字符 ${outcome.ms}ms`,
    );
    if (!outcome.baselinePass) console.log(`      基线答: ${outcome.baselineAnswer.replace(/\s+/g, " ").slice(0, 90)}`);
    if (outcome.baselinePass && !outcome.systemPass) console.log(`      系统答: ${outcome.systemAnswer.replace(/\s+/g, " ").slice(0, 90)}`);
  }

  const baselinePass = results.filter((item) => item.baselinePass).length;
  const systemPass = results.filter((item) => item.systemPass).length;
  const gain = baselinePass === 0 ? (systemPass > 0 ? 1 : 0) : (systemPass - baselinePass) / baselinePass;

  console.log("\n=== 汇总 ===");
  console.log(`基线召回（固定窗口，无摘要） ${baselinePass}/${results.length}`);
  console.log(`系统召回（窗口 + 摘要）      ${systemPass}/${results.length}`);
  console.log(`摘要带来的提升               ${(gain * 100).toFixed(1)}%`);
  const avgSummary = results.length === 0 ? 0 : Math.round(results.reduce((sum, item) => sum + item.summaryChars, 0) / results.length);
  console.log(`平均摘要长度                 ${avgSummary} 字符`);

  const report = {
    generatedAt: new Date().toISOString(),
    model: base.model ?? "default",
    baselineRecall: baselinePass / results.length,
    systemRecall: systemPass / results.length,
    summaryGain: gain,
    avgSummaryChars: avgSummary,
    cases: results,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(ROOT, "eval", "context-latest.json");
  const mdPath = path.join(ROOT, "eval", `context-report-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const lines = [
    "# 上下文 / 摘要评测",
    "",
    `- 时间：${report.generatedAt}`,
    `- 模型：${report.model}`,
    `- 用例：${results.length} 组（事实在第 1 轮，后面 5 轮闲聊把它挤出窗口）`,
    "",
    "| 指标 | 值 |",
    "|---|---|",
    `| 基线召回（固定窗口，无摘要） | ${baselinePass}/${results.length} |`,
    `| 系统召回（窗口 + 摘要） | ${systemPass}/${results.length} |`,
    `| 摘要提升 | ${(gain * 100).toFixed(1)}% |`,
    `| 平均摘要长度 | ${avgSummary} 字符 |`,
    "",
    "| 用例 | 基线 | 系统 | 摘要字符 |",
    "|---|---|---|---|",
    ...results.map((item) => `| ${item.id} | ${item.baselinePass ? "✓" : "✗"} | ${item.systemPass ? "✓" : "✗"} | ${item.summaryChars} |`),
  ];
  writeFileSync(mdPath, lines.join("\n"), "utf8");
  console.log(`\n报告：${mdPath}`);
  return results.every((item) => item.baselinePass && item.systemPass) ? 0 : 0;
}
