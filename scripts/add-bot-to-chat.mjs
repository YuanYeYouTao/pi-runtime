import { readFileSync } from "node:fs";
import * as Lark from "@larksuiteoapi/node-sdk";

const config = JSON.parse(readFileSync("config.json", "utf8"));
const chatId = process.argv[2];
const botAppId = config.feishu.appId;

const client = new Lark.Client({ appId: config.feishu.appId, appSecret: config.feishu.appSecret });

// Adding a bot is a chat-members write with member_id_type=app_id; the "member" is the app.
const response = await client.im.v1.chatMembers.create({
  params: { chat_id: chatId, member_id_type: "app_id", succeed_type: 1 },
  data: { id_list: [botAppId] },
});

console.log(JSON.stringify(response, null, 2));
