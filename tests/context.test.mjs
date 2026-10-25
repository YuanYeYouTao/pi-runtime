import { buildConversationContext } from "../src/context.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const event = (id, role, text, speaker = "Rick") => ({
  id,
  thread: "t1",
  speaker: role === "assistant" ? "agent" : speaker,
  role,
  text,
  task_id: null,
  distilled_at: null,
  created_at: "2026-10-25T00:00:00Z",
});

// 1) keeps chronological order and labels speakers
{
  const block = buildConversationContext(
    [event(1, "user", "我在上海"), event(2, "assistant", "记住了"), event(3, "user", "那天气呢")],
    { turns: 6, budgetChars: 4000 },
  );
  check(
    "chronological order + labels",
    block.text === "[Rick] 我在上海\n[助手] 记住了\n[Rick] 那天气呢",
    block.text,
  );
  check("ids oldest-first", JSON.stringify(block.ids) === "[1,2,3]", JSON.stringify(block.ids));
}

// 2) turn limit keeps the NEWEST messages, not the oldest
{
  const events = Array.from({ length: 10 }, (_, i) => event(i + 1, i % 2 === 0 ? "user" : "assistant", `m${i + 1}`));
  const block = buildConversationContext(events, { turns: 4, budgetChars: 4000 });
  check("turn limit keeps newest", JSON.stringify(block.ids) === "[7,8,9,10]", JSON.stringify(block.ids));
}

// 3) budget drops the oldest until it fits, never the newest
{
  const events = [
    event(1, "user", "x".repeat(100)),
    event(2, "assistant", "y".repeat(100)),
    event(3, "user", "short"),
  ];
  const block = buildConversationContext(events, { turns: 10, budgetChars: 120 });
  check("budget fills to the limit, oldest dropped", JSON.stringify(block.ids) === "[2,3]", JSON.stringify(block.ids));
  check("budget respected", block.chars <= 120, `${block.chars} chars`);
}

// 4) a single oversized newest message is still kept (it is the actual question)
{
  const events = [event(1, "user", "old"), event(2, "user", "z".repeat(500))];
  const block = buildConversationContext(events, { turns: 10, budgetChars: 50 });
  check("newest never dropped by budget", JSON.stringify(block.ids) === "[2]", JSON.stringify(block.ids));
}

// 5) empty history renders nothing
{
  const block = buildConversationContext([], { turns: 6, budgetChars: 100 });
  check("empty history is empty", block.text === "" && block.messages === 0);
}

// 6) only user/assistant roles are rendered (no system/agent-internal noise)
{
  const events = [event(1, "user", "hi"), { ...event(2, "tool", "rm -rf"), role: "tool" }];
  const block = buildConversationContext(events, { turns: 6, budgetChars: 400 });
  check("non-chat roles filtered", block.messages === 1, String(block.messages));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
