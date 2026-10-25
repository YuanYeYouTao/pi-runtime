import { parseFeishuMessage } from "../src/channels/feishu.ts";
import { Store } from "../src/db.ts";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

const wrap = (message, sender = { open_id: "ou_abc", user_id: "u1" }) => ({
  schema: "2.0",
  header: { event_id: "e1", event_type: "im.message.receive_v1" },
  event: { sender: { sender_id: sender, sender_type: "user" }, message },
});

// 1) group text with a mention placeholder
const group = parseFeishuMessage(
  wrap({
    message_id: "om_1",
    chat_id: "oc_1",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "@_user_1 我不吃香菜" }),
    create_time: "1729770000000",
  }),
);
check("group text stripped of mention", [group.text, group.chatType, group.externalId, group.messageId], ["我不吃香菜", "group", "ou_abc", "om_1"]);

// 2) p2p
const dm = parseFeishuMessage(
  wrap({ message_id: "om_2", chat_id: "oc_2", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "早" }) }),
);
check("p2p maps to dm", dm.chatType, "dm");

// 3) rich text is not supported yet -> ignored rather than mis-parsed
check(
  "post ignored",
  parseFeishuMessage(wrap({ chat_id: "oc_1", chat_type: "group", message_type: "post", content: '{"title":"x"}' })),
  null,
);

// 4) mention-only message has no content after stripping
check(
  "mention-only ignored",
  parseFeishuMessage(
    wrap({ chat_id: "oc_1", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1" }) }),
  ),
  null,
);

// 5) malformed content JSON
check(
  "broken content ignored",
  parseFeishuMessage(wrap({ chat_id: "oc_1", chat_type: "group", message_type: "text", content: "{not json" })),
  null,
);

// 6) missing ids
check("missing sender ignored", parseFeishuMessage(wrap({ chat_id: "oc_1", message_type: "text", content: '{"text":"hi"}' }, {})), null);

// 7) transport idempotency: same message id twice
const dir = path.join("eval", "tmp-idem");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const store = new Store(path.join(dir, "runtime.db"));
check("first delivery claimed", store.claimMessage("feishu", "om_1"), true);
check("redelivery rejected", store.claimMessage("feishu", "om_1"), false);
check("different channel is independent", store.claimMessage("telegram", "om_1"), true);
store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
