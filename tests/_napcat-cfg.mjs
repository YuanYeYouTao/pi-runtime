import { createHash } from "node:crypto";

const BASE = "http://127.0.0.1:6099/api";
const TOKEN = "41954c2d2306";
const hash = createHash("sha256").update(`${TOKEN}.napcat`).digest("hex");

let credential = "";

async function call(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const login = await call("/auth/login", { hash });
credential = login?.data?.Credential ?? "";
console.log("login:", login.code === 0 ? "ok" : JSON.stringify(login).slice(0, 120), credential ? "(有 Credential)" : "(无 Credential)");

const got = await call("/OB11Config/GetConfig");
if (got.code !== 0) {
  console.log("GetConfig 失败:", JSON.stringify(got).slice(0, 200));
  process.exit(1);
}

const cfg = typeof got.data === "string" ? JSON.parse(got.data) : got.data;
console.log("现有 network 键:", Object.keys(cfg.network ?? {}).join(", ") || "(无)");

cfg.network = {
  httpServers: [
    {
      name: "pi-rt-http",
      enable: true,
      host: "0.0.0.0",
      port: 3001,
      token: "pi-rt-qq",
      messagePostFormat: "array",
      debug: false,
      enableForcePushEvent: true,
    },
  ],
  httpSseServers: [],
  httpClients: [],
  websocketServers: [
    {
      name: "pi-rt-ws",
      enable: true,
      host: "0.0.0.0",
      port: 3002,
      token: "pi-rt-qq",
      messagePostFormat: "array",
      reportSelfMessage: false,
      enableForcePushEvent: true,
      heartInterval: 30000,
      debug: false,
    },
  ],
  websocketClients: [],
};

const saved = await call("/OB11Config/SetConfig", { config: JSON.stringify(cfg) });
console.log("SetConfig:", JSON.stringify(saved).slice(0, 160));

const again = await call("/OB11Config/GetConfig");
const after = typeof again.data === "string" ? JSON.parse(again.data) : again.data;
console.log(
  "写入后: http=" +
    (after.network.httpServers ?? []).map((s) => s.port).join(",") +
    "  ws=" +
    (after.network.websocketServers ?? []).map((s) => s.port).join(","),
);
