import { DEFAULT_LIMITS, enforceBrevity, wantsDetail } from "../src/brevity.ts";

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

// 1) the observed failure, verbatim-ish: a 212-char meta-answer to a casual question
{
  const long =
    "写了。这两份内容都在我这边：SOUL.md（13%，502/4000 字符）和 CONTRACTS.md（14%，428/3000 字符）。" +
    "每次对话都会注入，所以我现在知道自己的语气和执行纪律。你要看原文的话我可以贴出来。";
  const result = enforceBrevity(long, "group", "我还没有给你写入soul人格吗");
  check("long meta-answer gets capped", result.trimmed === true, String(result.text.length));
  check("capped under 60 chars", result.text.length <= 60, String(result.text.length));
  check("kept whole sentences", result.text.endsWith("。") || result.text.endsWith("…"), JSON.stringify(result.text.slice(-4)));
  check("no dangling half-word", !result.text.endsWith("，"), JSON.stringify(result.text.slice(-4)));
}

// 2) short replies pass through untouched
{
  const short = "嗯。";
  const result = enforceBrevity(short, "group", "谢谢");
  check("short reply unchanged", result.trimmed === false && result.text === short);
}

// 3) user asked for detail -> never trim
{
  const analysis = "三个方向：拆库、加锁、只让主进程写。拆库最稳但改动大；加锁最快但会影响读性能；单写者最干净，但需要把所有写入收口。我的建议是单写者。";
  const result = enforceBrevity(analysis, "group", "帮我想想怎么改数据库并发");
  check("detail request is respected", result.trimmed === false, String(result.text.length));
  check("detail hint detected", wantsDetail("帮我想想怎么改数据库并发") === true);
}

// 4) plain chat is capped even when the model thinks it is being helpful
{
  const chatty = "这个问题问得好。首先，人格文件确实写入了，而且每一轮对话都会重新注入一次。其次，它包含语气和纪律两份内容。最后，如果你觉得话还是长，可能是因为我把每件事都当成了需要解释的正式任务。";
  const result = enforceBrevity(chatty, "group", "你好长");
  check("chatter capped in group", result.trimmed === true);
  check("group cap is 2 sentences", result.text.split(/(?<=[。！？])/).filter(Boolean).length <= 2, JSON.stringify(result.text));
}

// 5) dm is looser than group
{
  const medium = "行。两个容器写同一个 SQLite 会有 WAL 竞争，只让主进程写最省事。改不改随你。";
  check("medium reply fits dm", enforceBrevity(medium, "dm", "这个方案行不行").trimmed === false);
  check("group cap is tighter", DEFAULT_LIMITS.group.chars < DEFAULT_LIMITS.dm.chars);
}

// 6) single giant sentence still bounded
{
  const wall = "测试".repeat(200);
  const result = enforceBrevity(wall, "group", "随便问问");
  check("wall of text bounded", result.text.length <= DEFAULT_LIMITS.group.chars, String(result.text.length));
  check("wall gets ellipsis", result.text.endsWith("…"));
}

// 7) markdown-ish output does not survive as a list
{
  const listy = "- 第一点关于记忆系统的设计取舍\n- 第二点关于上下文编排的淘汰顺序\n- 第三点关于提醒的时区解析\n- 第四点关于通道的幂等处理\n- 第五点关于沙箱的边界";
  const result = enforceBrevity(listy, "group", "在吗");
  check("list shortened", result.text.length < listy.length);
}

// 8) empty reply
{
  const result = enforceBrevity("", "group", "在吗");
  check("empty stays empty", result.text === "" && result.trimmed === false);
}

// 9) detail hints are conservative
check("plain greeting is not a detail request", wantsDetail("在吗") === false);
check("thanks is not a detail request", wantsDetail("谢谢") === false);
check("question with 怎么 is", wantsDetail("怎么部署") === true);

console.log(`\n${pass} passed, ${fail} failed`);
