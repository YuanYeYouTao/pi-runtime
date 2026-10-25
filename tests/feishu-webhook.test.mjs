import { createCipheriv, createHash } from "node:crypto";
import { startFeishuWebhook } from "../src/channels/feishu-webhook.ts";
import { decryptFeishuPayload, verifyFeishuSignature } from "../src/channels/feishu.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const ENCRYPT_KEY = "test-encrypt-key";

function sign(timestamp, nonce, key, body) {
  return createHash("sha256").update(timestamp + nonce + key + body).digest("hex");
}

function encryptPayload(payload, key) {
  const k = createHash("sha256").update(key).digest();
  const iv = Buffer.from("0123456789abcdef", "utf8");
  const cipher = createCipheriv("aes-256-cbc", k, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body]).toString("base64");
}

function messageEvent({ openId = "ou_a", chatId = "oc_1", text = "我不吃香菜", messageId = "om_1" } = {}) {
  return {
    schema: "2.0",
    header: { event_id: "ev_1", event_type: "im.message.receive_v1", token: "vt" },
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: "user" },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
        create_time: "1729770000000",
      },
    },
  };
}

async function post(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/feishu/event`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

// --- pure helpers ---
const body = JSON.stringify({ hello: "world" });
const goodSig = sign("1700000000", "n1", ENCRYPT_KEY, body);
check("signature accepts valid hash", verifyFeishuSignature(
  { "x-lark-request-timestamp": "1700000000", "x-lark-request-nonce": "n1", "x-lark-signature": goodSig },
  body,
  ENCRYPT_KEY,
));
check("signature rejects tampered body", !verifyFeishuSignature(
  { "x-lark-request-timestamp": "1700000000", "x-lark-request-nonce": "n1", "x-lark-signature": goodSig },
  body + " ",
  ENCRYPT_KEY,
));
check("signature rejects missing headers", !verifyFeishuSignature({}, body, ENCRYPT_KEY));

const roundTrip = decryptFeishuPayload(encryptPayload({ a: 1, b: "中文" }, ENCRYPT_KEY), ENCRYPT_KEY);
check("decrypt round-trip", JSON.stringify(roundTrip) === JSON.stringify({ a: 1, b: "中文" }), JSON.stringify(roundTrip));

// --- webhook without encryption ---
{
  const received = [];
  const server = await startFeishuWebhook({ port: 0, verificationToken: "vt", onMessage: async (m) => received.push(m) });

  const challenge = await post(server.port, JSON.stringify({ type: "url_verification", challenge: "abc" }));
  const payload = await challenge.json();
  check("url_verification echoes challenge", payload.challenge === "abc", JSON.stringify(payload));

  const accepted = await post(server.port, JSON.stringify(messageEvent()));
  check("message event acked with 200", accepted.status === 200);
  await new Promise((r) => setTimeout(r, 120));
  check("handler received parsed message", received.length === 1 && received[0].text === "我不吃香菜" && received[0].externalId === "ou_a");

  const badToken = await post(server.port, JSON.stringify({ ...messageEvent({ messageId: "om_2" }), header: { event_type: "im.message.receive_v1", token: "wrong" } }));
  check("wrong verification token rejected", badToken.status === 403, `status ${badToken.status}`);

  const notFound = await fetch(`http://127.0.0.1:${server.port}/nope`, { method: "POST", body: "{}" });
  check("unknown path 404", notFound.status === 404);

  await server.close();
}

// --- webhook with encryption + signature ---
{
  const received = [];
  const server = await startFeishuWebhook({ port: 0, encryptKey: ENCRYPT_KEY, onMessage: async (m) => received.push(m) });
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = "abc";

  const plain = JSON.stringify(messageEvent({ messageId: "om_10", text: "我常驻上海" }));
  const bodyEncrypted = JSON.stringify({ encrypt: encryptPayload(JSON.parse(plain), ENCRYPT_KEY) });

  const unsigned = await post(server.port, bodyEncrypted);
  check("encrypted payload without signature rejected", unsigned.status === 401, `status ${unsigned.status}`);

  const signed = await post(server.port, bodyEncrypted, {
    "x-lark-request-timestamp": ts,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": sign(ts, nonce, ENCRYPT_KEY, bodyEncrypted),
  });
  check("signed encrypted payload accepted", signed.status === 200, `status ${signed.status}`);
  await new Promise((r) => setTimeout(r, 120));
  check("encrypted event decrypted and parsed", received.length === 1 && received[0].text === "我常驻上海", JSON.stringify(received));

  const challenge = await post(
    server.port,
    JSON.stringify({ encrypt: encryptPayload({ type: "url_verification", challenge: "xyz" }, ENCRYPT_KEY) }),
    { "x-lark-request-timestamp": ts, "x-lark-request-nonce": nonce, "x-lark-signature": sign(ts, nonce, ENCRYPT_KEY, JSON.stringify({ encrypt: encryptPayload({ type: "url_verification", challenge: "xyz" }, ENCRYPT_KEY) })) },
  );
  check("encrypted url_verification still works", (await challenge.json()).challenge === "xyz");

  await server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
