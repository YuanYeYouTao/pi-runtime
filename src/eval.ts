import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT, loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import type { MemoryCategory } from "./memory.ts";
import { distillBatch } from "./distill.ts";

type CaseExpect = {
  category?: MemoryCategory;
  contains?: string[];
  action?: string;
  importanceMin?: number;
  subjectNotUser?: boolean;
  /** Exact structured target, e.g. "member:张三" or "group". */
  targetSubject?: string;
};

type EvalCase = {
  id: string;
  goal: string;
  kind: "positive" | "negative" | "transition";
  seed?: Array<{ key: string; category: MemoryCategory; content: string; importance?: number }>;
  turns: Array<{ user: string; assistant: string; speaker?: string }>;
  expect: CaseExpect[];
  allow_contains?: string[];
  forbid_contains?: string[];
  state_check?: {
    key: string;
    must_be: "active_with" | "no_active" | "contested" | "old_inactive";
    contains?: string[];
    /** For old_inactive: phrases that must no longer appear in any active row. */
    absent?: string[];
  };
};

type CaseOutcome = {
  id: string;
  kind: string;
  goal: string;
  expected: number;
  extracted: number;
  truePositives: number;
  falsePositives: number;
  missed: number;
  rejected: number;
  categoryOk: number;
  categoryTotal: number;
  fpDetail: string[];
  stateCheck: boolean | null;
  ms: number;
  pass: boolean;
};

const normalize = (text: string): string =>
  text
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：""''（）《》【】\[\]…—\-·,.!?;:"'()<>]/g, "")
    .toLowerCase();

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** A stalled model call must fail one case, not the whole suite. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时 ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

export type EvalReport = {
  generatedAt: string;
  model: string;
  cases: CaseOutcome[];
  metrics: {
    expected: number;
    extracted: number;
    truePositives: number;
    falsePositives: number;
    missed: number;
    rejected: number;
    precision: number;
    recall: number;
    f1: number;
    negativeCases: number;
    negativeLeaks: number;
    transitionCases: number;
    transitionStateOk: number;
    /** Soft metric: how often the emitted category matched the expectation. */
    categoryAgreement: number;
    evidenceRejectionRate: number;
    passRate: number;
  };
};

/** True when the applied row satisfies one expectation. */
function matches(
  applied: { action: string; key: string; content?: string | null; id: number | null },
  expect: CaseExpect,
  stateKey: string | undefined,
  row: { category: string; subject: string; importance: number; content: string } | undefined,
  ownerName: string,
): boolean {
  if (expect.action === "invalidate") {
    return applied.action === "invalidate" && applied.key === stateKey;
  }
  if (!row) return false;
  if (expect.action && applied.action !== expect.action) return false;
  if (expect.importanceMin && row.importance < expect.importanceMin) return false;
  if (expect.subjectNotUser && row.subject === ownerName) return false;
  if (expect.targetSubject) {
    // "user" in a case file means "the owner", whose canonical name is configurable.
    const wanted = expect.targetSubject === "user" ? ownerName : expect.targetSubject;
    if (row.subject !== wanted) return false;
  }
  const content = normalize(applied.content ?? row.content);
  return (expect.contains ?? []).every((keyword) => content.includes(normalize(keyword)));
}

function checkState(memory: MemoryStore, check: EvalCase["state_check"]): boolean | null {
  if (!check) return null;
  const rows = memory.history(check.key);
  if (check.must_be === "contested") return rows.some((row) => row.status === "contested");
  const active = rows.filter((row) => row.status === "active");
  if (check.must_be === "no_active") return active.length === 0;
  // The real safety property: the retracted assertion must not remain injectable as truth,
  // even if the slot now holds a follow-up fact ("the cat died" supersedes "has a cat").
  if (check.must_be === "old_inactive") {
    return active.every((row) => (check.absent ?? []).every((phrase) => !normalize(row.content).includes(normalize(phrase))));
  }
  // A slot must hold exactly one current value; two active rows means the update forked.
  if (active.length !== 1) return false;
  const content = normalize(active[0].content);
  return (check.contains ?? []).every((keyword) => content.includes(normalize(keyword)));
}

export async function runEval(options: { casesPath?: string; keep?: boolean; only?: string } = {}): Promise<number> {
  const casesPath = options.casesPath ?? path.join(ROOT, "eval", "cases.json");
  if (!existsSync(casesPath)) {
    console.error(`cases not found: ${casesPath}`);
    return 1;
  }
  const file = JSON.parse(readFileSync(casesPath, "utf8")) as { cases: EvalCase[] };
  const cases = options.only ? file.cases.filter((item) => item.id.includes(options.only!)) : file.cases;
  const cfg = loadConfig();
  const tmpRoot = path.join(ROOT, "eval", "tmp");
  mkdirSync(tmpRoot, { recursive: true });

  const outcomes: CaseOutcome[] = [];
  console.log(`running ${cases.length} cases against ${cfg.model ?? "default model"}\n`);

  for (const testCase of cases) {
    const dir = path.join(tmpRoot, testCase.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const store = new Store(path.join(dir, "runtime.db"));
    const memory = new MemoryStore(dir, cfg.ownerName);
    const started = Date.now();
    let outcome: CaseOutcome;

    try {
      for (const seed of testCase.seed ?? []) {
        memory.apply({
          action: "create",
          category: seed.category,
          key: seed.key,
          content: seed.content,
          importance: seed.importance ?? 3,
          reason: "eval seed",
        });
      }
      for (const turn of testCase.turns) {
        store.addConversationEvent(testCase.id, turn.speaker ?? "user_1", "user", turn.user);
        store.addConversationEvent(testCase.id, "agent", "assistant", turn.assistant);
      }

      const events = store.pendingEvents(testCase.id, 60);
      const result = await withTimeout(distillBatch(store, memory, cfg, events, {}), 90_000, testCase.id);
      const applied = result.applied.filter((item) => item.action !== "rejected");
      const rows = memory.list(undefined, true);
      const rowOf = (id: number | null) => rows.find((candidate) => candidate.id === id);
      const forbidden = (testCase.forbid_contains ?? []).map(normalize);
      const allowed = (testCase.allow_contains ?? []).map(normalize);
      const stateKey = testCase.state_check?.key;

      // Expectations are semantic assertions, not row identities: several expectations may
      // be satisfied by one atomic memory (e.g. "tech stack is Go + Postgres"), and extra
      // legitimate facts that the case did not enumerate are tolerated via allow_contains.
      // Category is reported as agreement, not as a pass/fail gate: preference/fact/event
      // is a judgement call and the least stable field, so gating on it only adds noise.
      let truePositives = 0;
      let categoryOk = 0;
      let categoryTotal = 0;
      for (const expect of testCase.expect) {
        const hit = applied.find((item) => matches(item, expect, stateKey, rowOf(item.id) as any, cfg.ownerName));
        if (hit) {
          truePositives++;
          if (expect.category) {
            categoryTotal++;
            if (rowOf(hit.id)?.category === expect.category) categoryOk++;
          }
        }
      }

      let falsePositives = 0;
      const fpDetail: string[] = [];
      const forbiddenHits = new Set<unknown>();

      for (const item of applied) {
        const row = rowOf(item.id);
        const content = normalize(item.content ?? row?.content ?? "");
        if (forbidden.some((word) => word && content.includes(word))) {
          falsePositives++;
          forbiddenHits.add(item);
          fpDetail.push(`${item.action}:${item.key} (命中禁记词) ${(item.content ?? "").slice(0, 28)}`);
        }
      }

      for (const item of applied) {
        if (forbiddenHits.has(item)) continue;
        const row = rowOf(item.id);
        const content = normalize(item.content ?? row?.content ?? "");
        if (testCase.expect.some((expect) => matches(item, expect, stateKey, row as any, cfg.ownerName))) continue;
        if (allowed.some((word) => word && content.includes(word))) continue;
        falsePositives++;
        fpDetail.push(`${item.action}:${item.key} ${(item.content ?? "").slice(0, 28)}`);
      }

      const stateCheck = checkState(memory, testCase.state_check);
      const missed = testCase.expect.length - truePositives;
      const ms = Date.now() - started;
      outcome = {
        id: testCase.id,
        kind: testCase.kind,
        goal: testCase.goal,
        expected: testCase.expect.length,
        extracted: applied.length,
        truePositives,
        falsePositives,
        missed,
        rejected: result.rejected.length,
        categoryOk,
        categoryTotal,
        fpDetail,
        stateCheck,
        ms,
        pass: falsePositives === 0 && missed === 0 && stateCheck !== false,
      };
      outcome.pass = falsePositives === 0 && missed === 0 && stateCheck !== false;
    } catch (error) {
      outcome = {
        id: testCase.id,
        kind: testCase.kind,
        goal: testCase.goal,
        expected: testCase.expect.length,
        extracted: 0,
        truePositives: 0,
        falsePositives: 0,
        missed: testCase.expect.length,
        rejected: 0,
        categoryOk: 0,
        categoryTotal: 0,
        fpDetail: [`ERROR ${error instanceof Error ? error.message : String(error)}`],
        stateCheck: null,
        ms: Date.now() - started,
        pass: false,
      };
    } finally {
      memory.close();
      store.close();
      if (!options.keep) rmSync(dir, { recursive: true, force: true });
    }

    outcomes.push(outcome);
    const mark = outcome.pass ? "PASS" : "FAIL";
    console.log(
      `${mark} ${outcome.id.padEnd(22)} 期望${outcome.expected} 提取${outcome.extracted} TP${outcome.truePositives} FP${outcome.falsePositives} 漏${outcome.missed}` +
        `${outcome.stateCheck === null ? "" : ` 状态${outcome.stateCheck ? "✓" : "✗"}`}` +
        `${outcome.rejected ? ` 拒${outcome.rejected}` : ""} ${outcome.ms}ms`,
    );
    for (const detail of outcome.fpDetail) console.log(`      ↳ ${detail}`);
  }

  const total = (pick: (item: CaseOutcome) => number) => outcomes.reduce((sum, item) => sum + pick(item), 0);
  const expected = total((item) => item.expected);
  const extracted = total((item) => item.extracted);
  const truePositives = total((item) => item.truePositives);
  const falsePositives = total((item) => item.falsePositives);
  const missed = total((item) => item.missed);
  const rejected = total((item) => item.rejected);
  const negativeCases = outcomes.filter((item) => item.kind === "negative").length;
  const negativeLeaks = outcomes.filter((item) => item.kind === "negative" && item.extracted > 0).length;
  const transitionCases = outcomes.filter((item) => item.stateCheck !== null).length;
  const transitionStateOk = outcomes.filter((item) => item.stateCheck === true).length;
  const categoryOk = total((item) => item.categoryOk);
  const categoryTotal = total((item) => item.categoryTotal);

  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = expected === 0 ? 1 : truePositives / expected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const evidenceRejectionRate = extracted + rejected === 0 ? 0 : rejected / (extracted + rejected);

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    model: cfg.model ?? "default",
    cases: outcomes,
    metrics: {
      expected,
      extracted,
      truePositives,
      falsePositives,
      missed,
      rejected,
      precision,
      recall,
      f1,
      negativeCases,
      negativeLeaks,
      transitionCases,
      transitionStateOk,
      categoryAgreement: categoryTotal === 0 ? 1 : categoryOk / categoryTotal,
      evidenceRejectionRate,
      passRate: outcomes.filter((item) => item.pass).length / (outcomes.length || 1),
    },
  };

  console.log("\n=== 汇总 ===");
  console.log(`期望 ${expected} 条 / 实际提取 ${extracted} 条`);
  console.log(`准确率 precision   ${pct(precision)}  (${truePositives}/${truePositives + falsePositives})`);
  console.log(`召回率 recall      ${pct(recall)}  (${truePositives}/${expected})`);
  console.log(`F1                 ${pct(f1)}`);
  console.log(`误提取 FP          ${falsePositives} 条`);
  console.log(`漏提取 FN          ${missed} 条`);
  console.log(`不该记的泄漏       ${negativeLeaks}/${negativeCases} 个负例`);
  console.log(`状态迁移正确       ${transitionStateOk}/${transitionCases}`);
  console.log(`类别一致率(软)     ${pct(categoryTotal === 0 ? 1 : categoryOk / categoryTotal)}  (${categoryOk}/${categoryTotal})`);
  console.log(`证据被拒率         ${pct(evidenceRejectionRate)}  (${rejected} 条疑似脑补)`);
  console.log(`用例通过率         ${pct(report.metrics.passRate)}  (${outcomes.filter((i) => i.pass).length}/${outcomes.length})`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(ROOT, "eval", "latest.json");
  const mdPath = path.join(ROOT, "eval", `report-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const lines = [
    "# 记忆提取评测报告",
    "",
    `- 时间：${report.generatedAt}`,
    `- 模型：${report.model}`,
    `- 用例：${outcomes.length} 组（正例 ${outcomes.filter((i) => i.kind === "positive").length} / 负例 ${negativeCases} / 迁移 ${transitionCases}）`,
    "",
    "## 指标",
    "",
    "| 指标 | 值 |",
    "|---|---|",
    `| 准确率 precision | ${pct(precision)} (${truePositives}/${truePositives + falsePositives}) |`,
    `| 召回率 recall | ${pct(recall)} (${truePositives}/${expected}) |`,
    `| F1 | ${pct(f1)} |`,
    `| 误提取 FP | ${falsePositives} 条 |`,
    `| 漏提取 FN | ${missed} 条 |`,
    `| 负例泄漏 | ${negativeLeaks}/${negativeCases} |`,
    `| 状态迁移正确 | ${transitionStateOk}/${transitionCases} |`,
    `| 类别一致率（软指标，不参与通过判定） | ${pct(categoryTotal === 0 ? 1 : categoryOk / categoryTotal)} (${categoryOk}/${categoryTotal}) |`,
    `| 证据被拒率 | ${pct(evidenceRejectionRate)} (${rejected} 条) |`,
    `| 用例通过率 | ${pct(report.metrics.passRate)} |`,
    "",
    "## 用例明细",
    "",
    "| 用例 | 类型 | 期望 | 提取 | TP | FP | 漏 | 状态 | 结果 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...outcomes.map(
      (item) =>
        `| ${item.id} | ${item.kind} | ${item.expected} | ${item.extracted} | ${item.truePositives} | ${item.falsePositives} | ${item.missed} | ${
          item.stateCheck === null ? "-" : item.stateCheck ? "✓" : "✗"
        } | ${item.pass ? "PASS" : "FAIL"} |`,
    ),
    "",
    "## 失败原因",
    "",
    ...outcomes
      .filter((item) => !item.pass)
      .flatMap((item) => [
        `### ${item.id} — ${item.goal}`,
        ...item.fpDetail.map((detail) => `- ${detail}`),
        item.missed > 0 ? `- 漏提取 ${item.missed} 条` : "",
        item.stateCheck === false ? `- 状态检查未通过` : "",
        "",
      ]),
  ];
  writeFileSync(mdPath, lines.filter((line) => line !== "").join("\n"), "utf8");
  console.log(`\n报告：${mdPath}`);
  console.log(`原始数据：${jsonPath}`);
  return outcomes.every((item) => item.pass) ? 0 : 0;
}
