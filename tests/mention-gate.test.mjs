import { parseFeishuMessage } from "../src/channels/feishu.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const BOT = "ou_bot_123";

const payload = ({ chatType = "group", mentions = [], text = "你好" } = {}) => ({
  event: {
    sender: { sender_id: { open_id: "ou_user_1" } },
    message: {
      chat_id: "oc_test",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions: mentions.map((openId) => ({ key: "@_user_1", id: { open_id: openId }, name: "x" })),
    },
  },
});

// 1) DM is always addressed
{
  const parsed = parseFeishuMessage(payload({ chatType: "p2p" }), { botOpenId: BOT });
  check("dm is addressed", parsed?.addressed === true, JSON.stringify(parsed?.addressed));
}

// 2) group with the bot mentioned
{
  const parsed = parseFeishuMessage(payload({ mentions: [BOT] }), { botOpenId: BOT });
  check("group mentioning the bot is addressed", parsed?.addressed === true);
}

// 3) group where somebody else was mentioned
{
  const parsed = parseFeishuMessage(payload({ mentions: ["ou_other"] }), { botOpenId: BOT });
  check("mentioning someone else is not addressed", parsed?.addressed === false);
}

// 4) group with no mention at all
{
  const parsed = parseFeishuMessage(payload({ mentions: [] }), { botOpenId: BOT });
  check("plain group chatter is not addressed", parsed?.addressed === false);
}

// 5) without a known bot id we cannot tell, so a group message stays unanswered
{
  const parsed = parseFeishuMessage(payload({ mentions: [BOT] }), {});
  check("unknown bot id means not addressed", parsed?.addressed === false);
}

// 6) the mention placeholder is still stripped from the text
{
  const parsed = parseFeishuMessage(
    { event: { sender: { sender_id: { open_id: "ou_user_1" } }, message: { chat_id: "oc", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1 帮我记一下" }), mentions: [{ id: { open_id: BOT } }] } } },
    { botOpenId: BOT },
  );
  check("mention placeholder stripped", parsed?.text === "帮我记一下", parsed?.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
