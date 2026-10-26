import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CONTRACTS,
  DEFAULT_CONTRACTS_LIMIT,
  contractsUsage,
  ensureStanding,
  readContracts,
  renderContractsPrompt,
  standingUsage,
  writeContracts,
  DEFAULT_SOUL,
  PERSONA_DIR,
  SOUL_FILE,
  ensureSoul,
  personaUsage,
  readSoul,
  renderPersonaPrompt,
  soulPath,
  writeSoul,
} from "../src/persona.ts";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "pi-persona-"));

// 1) nothing to render before the file exists
check("empty persona renders nothing", renderPersonaPrompt(dir) === "");
check("no usage before init", personaUsage(dir) === null);

// 2) seeding is idempotent
const seeded = ensureSoul(dir);
check("seed wrote a file", typeof seeded === "string" && seeded.endsWith(SOUL_FILE), String(seeded));
check("seed is idempotent", ensureSoul(dir) === undefined);
check("seeded body readable", (readSoul(dir) ?? "").includes("怎么说话"));

// 3) header carries usage, not just the body
{
  writeSoul(dir, "你是测试助手。");
  const rendered = renderPersonaPrompt(dir, 100);
  check("header names the file", rendered.includes(`${PERSONA_DIR}/${SOUL_FILE}`), rendered.split("\n")[0]);
  check("header shows percent", /\d+%/.test(rendered.split("\n")[0]), rendered.split("\n")[0]);
  check("body included", rendered.includes("你是测试助手。"));
  check("no truncation under limit", !rendered.includes("已截断"));
}

// 4) over budget truncates and says the file is intact
{
  const long = "字".repeat(120);
  writeSoul(dir, long);
  const rendered = renderPersonaPrompt(dir, 100);
  check("truncation announced", rendered.includes("已截断"), rendered.slice(-80));
  check("says full file remains", rendered.includes("完整内容仍在磁盘上"));
  check("cut at the limit", rendered.includes("字".repeat(100)) && !rendered.includes("字".repeat(101)));
}

// 5) usage math
{
  writeSoul(dir, "字".repeat(50));
  const usage = personaUsage(dir, 100);
  check("usage chars", usage?.chars === 50, String(usage?.chars));
  check("usage percent", usage?.percent === 50, String(usage?.percent));
}

// 6) counts code points, not UTF-16 units
{
  writeSoul(dir, "🙂🙂");
  check("emoji counted once each", personaUsage(dir, 10)?.chars === 2, String(personaUsage(dir, 10)?.chars));
}

// 7) blank file is treated as absent
{
  writeSoul(dir, "   \n\n");
  check("blank persona is absent", renderPersonaPrompt(dir) === "");
}

// 8) default soul stays inside its budget
check("default soul fits budget", [...DEFAULT_SOUL].length < 4000, String([...DEFAULT_SOUL].length));
check("default soul has examples", DEFAULT_SOUL.includes("示例"));

// 9) the second standing file: discipline is separate from voice
{
  const second = mkdtempSync(path.join(tmpdir(), "pi-contracts-"));
  check("no contracts before seeding", renderContractsPrompt(second) === "");
  const written = ensureStanding(second);
  check("seeds two files", written.length === 2, String(written.length));
  check("contracts seeded", (readContracts(second) ?? "").length > 0);
  check("contracts render has header", renderContractsPrompt(second).includes("执行纪律"));
  check("contracts budget separate", contractsUsage(second)?.limit === DEFAULT_CONTRACTS_LIMIT);
  writeContracts(second, "字".repeat(80));
  const cut = renderContractsPrompt(second, 60);
  check("contracts truncate announced", cut.includes("已截断"), cut.slice(-60));
  check("standingUsage lists both roles", standingUsage(second).length === 2);
  check("default contracts fit budget", [...DEFAULT_CONTRACTS].length < DEFAULT_CONTRACTS_LIMIT);
  check("contracts mention evidence rule", DEFAULT_CONTRACTS.includes("工具回执"));
  try {
    rmSync(second, { recursive: true, force: true });
  } catch {
    /* handle stays open briefly on Windows */
  }
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* Windows keeps the handle briefly */
}

console.log(`\n${pass} passed, ${fail} failed`);
