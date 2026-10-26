import { parseOneBotEvent, buildSendBody, sendTargetFromChatId, toPlainText, shouldAnswer } from "../src/channels/onebot.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const BOT = "12345";

const group = (overrides = {}) => ({
  post_type: "message",
  message_type: "group",
  self_id: Number(BOT),
  user_id: 999,
  group_id: 555,
  message_id: 7,
  message: [{ type: "text", data: { text: "帮我记一下" } }],
  sender: { nickname: "张三" },
  ...overrides,
});

// 1) private message is always addressed
{
  const parsed = parseOneBotEvent(
    { post_type: "message", message_type: "private", self_id: Number(BOT), user_id: 999, message_id: 1, message: [{ type: "text", data: { text: "你好" } }] },
    { botUin: BOT },
  );
  check("private is addressed", parsed?.addressed === true);
  check("private chat id has no channel prefix", parsed?.chatId === "user:999", parsed?.chatId);
}

// 2) group without an @ is not addressed
{
  const parsed = parseOneBotEvent(group(), { botUin: BOT });
  check("plain group message is not addressed", parsed?.addressed === false);
  check("group chat id has no channel prefix", parsed?.chatId === "group:555", parsed?.chatId);
  check("text is extracted", parsed?.text === "帮我记一下");
  check("nickname is carried", parsed?.nickname === "张三");
}

// 3) group with @bot is addressed
{
  const parsed = parseOneBotEvent(
    group({ message: [{ type: "at", data: { qq: BOT } }, { type: "text", data: { text: " 帮我记一下" } }] }),
    { botUin: BOT },
  );
  check("mentioning the bot is addressed", parsed?.addressed === true);
  check("mention segment is not in the text", parsed?.text === "帮我记一下", parsed?.text);
}

// 4) mentioning someone else is not addressed
{
  const parsed = parseOneBotEvent(group({ message: [{ type: "at", data: { qq: "777" } }, { type: "text", data: { text: "hi" } }] }), { botUin: BOT });
  check("mentioning another user is not addressed", parsed?.addressed === false);
}

// 5) the bot's own messages are ignored
{
  check("own message ignored", parseOneBotEvent(group({ user_id: Number(BOT) }), { botUin: BOT }) === null);
}

// 6) non-message events and empty text are ignored
{
  check("heartbeat ignored", parseOneBotEvent({ post_type: "meta_event", meta_event_type: "heartbeat" }) === null);
  check("image-only ignored", parseOneBotEvent(group({ message: [{ type: "image", data: { file: "a.jpg" } }] })) === null);
}

// 7) CQ-code string form is understood
{
  const parsed = parseOneBotEvent(group({ message: "[CQ:at,qq=12345] 明天三点开会" }), { botUin: BOT });
  check("parses CQ string", parsed?.text === "明天三点开会", parsed?.text);
  check("CQ at counts as addressed", parsed?.addressed === true);
}

// 8) send bodies target the right endpoint
{
  const priv = buildSendBody({ kind: "private", id: "999" }, "hi");
  const grp = buildSendBody({ kind: "group", id: "555" }, "hi");
  check("private endpoint", priv.endpoint === "send_private_msg" && priv.body.user_id === 999, JSON.stringify(priv));
  check("group endpoint", grp.endpoint === "send_group_msg" && grp.body.group_id === 555, JSON.stringify(grp));
}

// 9) markdown is stripped for QQ plain text
{
  const raw = "**结论**：可以。\n\n## 步骤\n- 第一步 `npm ci`\n- 第二步";
  const plain = toPlainText(raw);
  check("bold markers removed", !plain.includes("**"), plain);
  check("heading marker removed", !plain.includes("##"), plain);
  check("inline code unwrapped", plain.includes("npm ci") && !plain.includes("`"), plain);
  check("bullets preserved as text", plain.includes("· 第一步"), plain);
  check("content survives", plain.includes("结论") && plain.includes("第二步"));
}

// 10) chat id round-trips to a send target
{
  check("private target", JSON.stringify(sendTargetFromChatId("user:999")) === JSON.stringify({ kind: "private", id: "999" }));
  check("group target", JSON.stringify(sendTargetFromChatId("group:555")) === JSON.stringify({ kind: "group", id: "555" }));
  check("legacy qq: prefix still parses", JSON.stringify(sendTargetFromChatId("qq:group:555")) === JSON.stringify({ kind: "group", id: "555" }));
}

// 11) group messages answer on mention, exemption, or wake word
{
  const group = (text, addressed) => ({ chatType: "group", chatId: "group:1", text, addressed });
  check("dm always answers", shouldAnswer({ chatType: "dm", chatId: "user:1", text: "hi" }) === true);
  check("group ignores plain chatter", shouldAnswer(group("今天吃什么", false)) === false);
  check("group answers a real mention", shouldAnswer(group("随便", true)) === true);
  check("exempt group answers without mention", shouldAnswer(group("随便", false), { noMentionGroups: new Set(["group:1"]) }) === true);
  check("other group stays silent", shouldAnswer(group("随便", false), { noMentionGroups: new Set(["group:2"]) }) === false);
  check("wake word answers", shouldAnswer(group("油桃 你在吗", false), { wakeWords: ["油桃"] }) === true);
  check("wake word is case exact for CJK", shouldAnswer(group("油桃", false), { wakeWords: ["桃"] }) === true);
  check("no wake word match", shouldAnswer(group("油桃", false), { wakeWords: ["小桃"] }) === false);
  check("empty wake word never matches", shouldAnswer(group("任意", false), { wakeWords: [""] }) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
