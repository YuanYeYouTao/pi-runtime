import { compose, findConflicts, stripPrefix } from "../src/compose.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) the case that matters: same topic, different value, almost no shared wording
{
  const memory = "- [事实·4] 部署端口是 3000";
  const window = "[Rick] 部署端口改成 8080 了";
  const conflicts = findConflicts(memory, window);
  check("value change is a conflict", conflicts.length === 1, JSON.stringify(conflicts));
  check("the memory line is quoted", conflicts[0]?.memory.includes("3000"), JSON.stringify(conflicts[0]));
}

// 2) an exact duplicate is dedupe's job, not a conflict
{
  const line = "对花生严重过敏，点菜必须避开";
  const conflicts = findConflicts(`- [事实·4] ${line}`, `[Rick] ${line}`);
  check("duplicates are not conflicts", conflicts.length === 0, JSON.stringify(conflicts));
}

// 3) unrelated lines are not conflicts
{
  const conflicts = findConflicts("- [偏好·3] 喜欢简洁回答", "[Rick] 今天上海下雨，记得带伞");
  check("unrelated lines are ignored", conflicts.length === 0, JSON.stringify(conflicts));
}

// 4) wording drift without numbers is still caught
{
  const conflicts = findConflicts("- [事实·4] 用户对花生过敏，必须完全避开", "[Rick] 用户对花生其实轻微过敏，偶尔吃一点没事");
  check("wording drift is a conflict", conflicts.length === 1, JSON.stringify(conflicts));
}

// 5) the same topic with the same number is not a conflict
{
  const conflicts = findConflicts("- [事实·4] 部署端口是 8080", "[Rick] 部署端口 8080 已经确认可用");
  check("same value is not a conflict", conflicts.length === 0, JSON.stringify(conflicts));
}

// 6) one hint per memory line, keeping the strongest match
{
  const memory = "- [事实·4] 部署端口是 3000";
  const window = ["[Rick] 部署端口改成 8080 了", "[Rick] 部署端口 8080 上线了"].join("\n");
  const conflicts = findConflicts(memory, window);
  check("one hint per memory line", conflicts.length === 1, JSON.stringify(conflicts));
}

// 7) at most `limit` hints
{
  const memory = ["- 部署端口是 3000", "- 缓存端口是 6379", "- 网关端口是 80", "- 监控端口是 9090"].join("\n");
  const window = ["[Rick] 部署端口改成 8080", "[Rick] 缓存端口改成 6380", "[Rick] 网关端口改成 8088", "[Rick] 监控端口改成 9091"].join("\n");
  check("limit is enforced", findConflicts(memory, window, 2).length === 2, String(findConflicts(memory, window, 2).length));
}

// 8) compose renders the hint before the current message and records it
{
  const { prompt, manifest } = compose(
    [
      { kind: "memory", body: "- [事实·4] 部署端口是 3000" },
      { kind: "window", title: "## 最近对话", body: "[Rick] 部署端口改成 8080 了" },
      { kind: "current", title: "## 当前消息", body: "端口是多少？" },
    ],
    { budgetChars: 10_000 },
  );
  check("manifest records the conflict", manifest.conflicts.length === 1, JSON.stringify(manifest.conflicts));
  const hintIndex = prompt.indexOf("## 上下文冲突提示");
  const currentIndex = prompt.indexOf("## 当前消息");
  check("hint is rendered", hintIndex > -1);
  check("hint precedes the current message", hintIndex > -1 && hintIndex < currentIndex, `${hintIndex} vs ${currentIndex}`);
  check("hint states the precedence", prompt.includes("以最近对话为准"), prompt.slice(Math.max(0, hintIndex), hintIndex + 120));
}

// 9) no conflicts, no hint
{
  const { prompt, manifest } = compose(
    [
      { kind: "memory", body: "- [偏好·3] 喜欢简洁回答" },
      { kind: "window", body: "[Rick] 今天上海下雨" },
      { kind: "current", body: "Q" },
    ],
    { budgetChars: 10_000 },
  );
  check("no hint when nothing conflicts", !prompt.includes("上下文冲突") && manifest.conflicts.length === 0);
}

// 10) prefixes are stripped before comparison
{
  check("strips memory prefix", stripPrefix("- [事实·4] 内容") === "内容");
  check("strips speaker prefix", stripPrefix("[Rick] 内容") === "内容");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
