// Run every *.test.mjs and fail if any file fails.
//
// CI and local runs share this so the two cannot drift; a test file that forgets its own
// process.exit is still caught here, by the missing summary line.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const dir = path.join(process.cwd(), "tests");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(dir, file)], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const summary = output.match(/(\d+) passed, (\d+) failed/);

  if (!summary) {
    failed++;
    failures.push(`${file}: 没有输出汇总行（可能缺少 process.exit，或提前崩溃）`);
    console.log(`FAIL ${file} (no summary)`);
    continue;
  }

  const filePassed = Number(summary[1]);
  const fileFailed = Number(summary[2]);
  passed += filePassed;
  failed += fileFailed;

  if (fileFailed > 0 || result.status !== 0) {
    failures.push(`${file}: ${fileFailed} 项失败`);
    console.log(`FAIL ${file} (${filePassed} passed, ${fileFailed} failed)`);
  } else {
    console.log(`ok   ${file} (${filePassed})`);
  }
}

console.log(`\n${files.length} 个文件 · ${passed} 项通过 · ${failed} 项失败`);
if (failures.length > 0) {
  console.log("\n失败明细：");
  for (const line of failures) console.log(`  ${line}`);
  process.exit(1);
}
