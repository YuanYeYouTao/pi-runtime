const PORT = Number(process.argv[2] ?? 8791);

const event = ({ openId, text, messageId }) => ({
  schema: "2.0",
  header: { event_id: `ev_${messageId}`, event_type: "im.message.receive_v1", token: "vt" },
  event: {
    sender: { sender_id: { open_id: openId }, sender_type: "user" },
    message: {
      message_id: messageId,
      chat_id: "oc_grp",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  },
});

const messages = [
  { openId: "ou_rick", text: "我对花生过敏，比较严重。", messageId: "om_e2e_1" },
  { openId: "ou_lisi", text: "我不吃香菜，点菜注意下。", messageId: "om_e2e_2" },
  { openId: "ou_rick", text: "我常驻上海，做芯片验证。", messageId: "om_e2e_3" },
];

for (const message of messages) {
  const response = await fetch(`http://127.0.0.1:${PORT}/feishu/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event(message)),
  });
  console.log(`${message.messageId} -> ${response.status} ${await response.text()}`);
}

// Redelivery of the same message must be dropped by the idempotency claim.
const again = await fetch(`http://127.0.0.1:${PORT}/feishu/event`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(event(messages[0])),
});
console.log(`om_e2e_1 redelivered -> ${again.status} (should be accepted, then dropped as duplicate)`);
