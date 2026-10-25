import { detectSecret, redact } from "../src/secrets.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// --- must block ---
const mustBlock = [
  ["password assignment (zh)", "我的数据库密码是 Passw0rd!2024，帮我记一下。"],
  ["password assignment (en)", "db password: hunter2Secret"],
  ["api key", "我的 API key 是 sk-live-abcdefghijklmnop123456"],
  ["github token", "用这个 token: ghp_1234567890abcdefghijklmnopqrstuvwxyz"],
  ["bearer header", "请求头是 Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6"],
  ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA..."],
  ["bank pin", "我的支付密码是 889900"],
  ["aws key", "AKIAIOSFODNN7EXAMPLE 这个要保密"],
  ["high entropy blob", "值是这个 aB3xK9mQ2pL7vR5tY8wZ1nC4fH6jD0sG"],
];
for (const [name, text] of mustBlock) {
  check(`blocks ${name}`, detectSecret(text).sensitive, JSON.stringify(detectSecret(text).reasons));
}

// --- must NOT block (false-positive control) ---
const mustAllow = [
  ["password policy", "我的密码策略是每 90 天改一次，复杂度要求 12 位。"],
  ["secret as a topic", "这个项目的 secret 管理用 Vault，不放在代码里。"],
  ["long normal sentence", "我下周三要去北京出差，周三晚上到，顺便见两个客户。"],
  ["version numbers", "接口版本 v2.3，限流每秒 500 次，超时 30 秒。"],
  ["commit-ish hex", "那个 commit 是 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b。"],
  ["uuid", "trace id 是 550e8400-e29b-41d4-a716-446655440000。"],
  ["budget with commas", "这次采购预算 1,280,000 元，审批编号 CG-2024-0917。"],
];
for (const [name, text] of mustAllow) {
  check(`allows ${name}`, !detectSecret(text).sensitive, JSON.stringify(detectSecret(text).reasons));
}

// --- redaction never echoes the full value ---
{
  const value = "Passw0rd!2024";
  const masked = redact(`我的数据库密码是 ${value}`);
  check("redact hides the value", !masked.includes(value), masked);
  check("redact keeps the label", masked.includes("密码"), masked);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
