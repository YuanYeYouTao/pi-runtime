import { scoreConfidence, isInjectable, ACTIVE_FROM, DISCARD_BELOW } from "../src/confidence.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const base = { category: "fact", fromUser: true, text: "我对花生过敏" };

// 1) a plain user statement is trusted
{
  const r = scoreConfidence(base);
  check("user statement → active", r.status === "active" && r.score === 0.7, JSON.stringify(r));
}

// 2) an assistant paraphrase alone is not
{
  const r = scoreConfidence({ ...base, fromUser: false });
  check("assistant paraphrase → tentative", r.status === "tentative", JSON.stringify(r));
}

// 3) hedging downgrades a user statement
{
  const r = scoreConfidence({ ...base, text: "我可能在考虑学 Rust" });
  check("hedged statement → tentative", r.status === "tentative", JSON.stringify(r));
  check("hedge is recorded as a factor", r.factors.some((f) => f.includes("含糊")), JSON.stringify(r.factors));
}

// 4) independent confirmation promotes
{
  const r = scoreConfidence({ ...base, confirmations: 2 });
  check("second confirmation → active", r.status === "active" && r.score > 0.7, JSON.stringify(r));
  const capped = scoreConfidence({ ...base, confirmations: 9 });
  check("confirmation bonus is capped", capped.score <= 0.95, String(capped.score));
}

// 5) facts decay, preferences do not
{
  const oldFact = scoreConfidence({ ...base, ageDays: 180 });
  const oldPref = scoreConfidence({ ...base, category: "preference", ageDays: 180 });
  check("stale fact decays out", oldFact.status === "discard", JSON.stringify(oldFact));
  check("preference never decays", oldPref.status === "active" && oldPref.score === 0.7, JSON.stringify(oldPref));
}

// 6) use slows decay for facts
{
  const unused = scoreConfidence({ ...base, ageDays: 120 });
  const used = scoreConfidence({ ...base, ageDays: 120, useCount: 2 });
  check("recently used decays slower", used.score > unused.score, `${used.score} vs ${unused.score}`);
}

// 7) thresholds are exclusive/inclusive exactly as documented
{
  check("active threshold constant", scoreConfidence({ ...base, confirmations: 3 }).status === "active");
  check("discard threshold is 0.35", DISCARD_BELOW === 0.35 && ACTIVE_FROM === 0.6);
}

// 8) injection is only for active rows
{
  check("tentative is not injectable", !isInjectable(scoreConfidence({ ...base, fromUser: false })));
  check("active is injectable", isInjectable(scoreConfidence(base)));
}

// 9) score is bounded and deterministic
{
  const a = scoreConfidence(base);
  const b = scoreConfidence(base);
  check("deterministic", a.score === b.score);
  check("bounded", a.score >= 0 && a.score <= 0.95);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
