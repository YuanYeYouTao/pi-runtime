#!/usr/bin/env node
import { spawn } from "node:child_process";
import { DB_PATH, DATA_DIR, PI_CLI, ensureDirs, loadConfig, piArgs, piEnv } from "./config.ts";
import { Store } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import type { MemoryCategory } from "./memory.ts";
import { distillBatch } from "./distill.ts";
import type { DistillResult } from "./distill.ts";
import { runEval } from "./eval.ts";
import { PiRpc } from "./rpc.ts";
import { runTask } from "./worker.ts";
import { Members } from "./members.ts";
import { ingest } from "./gateway.ts";
import type { Incoming } from "./gateway.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import { FeishuChannel } from "./channels/feishu.ts";
import { startFeishuWebhook } from "./channels/feishu-webhook.ts";

const USAGE = `pi-runtime — a personal agent runtime built on pi

tasks:
  node src/cli.ts doctor                     check pi, model and config state
  node src/cli.ts login                      run pi's /login against the isolated config dir
  node src/cli.ts ask "<prompt>"             run one task now (queued + persisted)
  node src/cli.ts ask "..." [--thread <t>]   keep turns in a conversation thread
  node src/cli.ts ask "..." --extract        force memory extraction after the run
  node src/cli.ts worker [--once]            daemon: drain queue, distil idle threads
  node src/cli.ts list [n]                   recent tasks
  node src/cli.ts show <task-id>             one task, result and event trail

memory:
  node src/cli.ts remember "<text>" --key <slot> [--category preference|fact|event]
                                          [--importance 1-5] [--target self|group|member:张三]
                                          [--evidence "<原话>"] [--event <event-id>]
  node src/cli.ts memories [category] [--all]
  node src/cli.ts history <key>              full supersede / invalidate / contest chain
  node src/cli.ts events <thread>            the numbered conversation events
  node src/cli.ts resolve <key> <keep-id>    adjudicate a contested slot
  node src/cli.ts forget <id>
  node src/cli.ts distill [--thread t] [--limit n]
  node src/cli.ts stats                      task + memory counters
  node src/cli.ts eval [--keep] [--only id]  run the memory-extraction benchmark

channels:
  node src/cli.ts feed "<text>" --chat <id> --as <name> [--id <uid>] [--dm] [--run]
                                             ingest a message as a specific speaker
  node src/cli.ts members                    known identities
  node src/cli.ts serve --channel telegram    long-poll Telegram (needs TELEGRAM_BOT_TOKEN)
  node src/cli.ts serve --channel feishu      Feishu long connection (needs FEISHU_APP_ID/SECRET)
  node src/cli.ts serve --channel feishu-webhook [--port 8787]
                                             Feishu webhook mode (testable locally)

env / config.json:
  PI_RT_WORKSPACE   folder the agent works in   (default: cwd)
  PI_RT_PROVIDER / PI_RT_MODEL
  PI_RT_MAX_MINUTES  wall-clock cap per task    (default: 30)
  PI_RT_BATCH_TURNS  distil after N turns       (default: 10)
  PI_RT_IDLE_MINUTES distil idle threads after  (default: 15)
`;

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dim = (text: string) => process.stderr.write(`\x1b[2m[${text}]\x1b[0m\n`);

/** Memory rows are keyed by the owner's name, so every command must agree on it. */
function openMemory(): MemoryStore {
  return new MemoryStore(DATA_DIR, loadConfig().ownerName);
}

function printDistill(result: DistillResult): void {
  for (const applied of result.applied) {
    console.log(`  ${applied.action.padEnd(10)} ${applied.key}${applied.id ? ` (#${applied.id})` : ""} — ${applied.reason}`);
  }
  for (const rejected of result.rejected) {
    console.log(`  REJECTED   ${rejected.why} :: ${JSON.stringify(rejected.item).slice(0, 140)}`);
  }
  console.log(`  ${result.events} 条事件 → 应用 ${result.applied.length} 条，拒绝 ${result.rejected.length} 条`);
}

async function cmdDoctor(): Promise<number> {
  const cfg = loadConfig();
  console.log("runtime config");
  console.log(`  pi cli      ${PI_CLI}`);
  console.log(`  database    ${DB_PATH}`);
  console.log(`  workspace   ${cfg.workspace}`);
  console.log(`  provider    ${cfg.provider ?? "(pi default)"}`);
  console.log(`  model       ${cfg.model ?? "(pi default)"}`);
  console.log(`  memory      enabled=${cfg.memoryEnabled} budget=${cfg.memoryBudgetChars} turn/batch=${cfg.batchTurns} idle=${cfg.idleMinutes}m auto=${cfg.autoExtract}`);

  const rpc = new PiRpc({ cliPath: PI_CLI, cwd: cfg.workspace, args: piArgs(cfg), env: piEnv(cfg) });
  rpc.start();
  try {
    const state = await rpc.getState();
    const model = state?.model ?? {};
    console.log("\npi rpc handshake: ok");
    console.log(`  session     ${state?.sessionId}`);
    console.log(`  model       ${model.id ?? "unknown"} (${model.provider ?? "unknown"})`);
    console.log(`  compaction  autoCompaction=${state?.autoCompactionEnabled} streaming=${state?.isStreaming}`);
    if (!model.id || model.id === "unknown") {
      console.log("\n  ! no model bound yet — the pipe works, but a task cannot run.");
      console.log("    fix: `node src/cli.ts login`, or set PI_RT_PROVIDER / PI_RT_MODEL + a key.");
    }
    return 0;
  } finally {
    await rpc.dispose();
  }
}

async function cmdLogin(): Promise<number> {
  const cfg = loadConfig();
  console.log(`opening pi with config dir: ${piEnv(cfg).PI_CODING_AGENT_DIR}`);
  console.log("inside pi: run /login, pick a provider, then /quit when done.\n");
  const child = spawn(process.execPath, [PI_CLI], {
    cwd: cfg.workspace,
    env: { ...process.env, ...piEnv(cfg) } as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
  return await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
  });
}

async function cmdAsk(args: string[]): Promise<number> {
  const cwdFlag = flagValue(args, "--cwd");
  const thread = flagValue(args, "--thread") ?? "default";
  const extract = args.includes("--extract");
  if (extract) args.splice(args.indexOf("--extract"), 1);
  const prompt = args.join(" ").trim();
  if (!prompt) {
    console.error('usage: node src/cli.ts ask "<prompt>" [--cwd <dir>] [--thread <t>] [--extract]');
    return 2;
  }

  const cfg = loadConfig();
  if (cwdFlag) cfg.workspace = cwdFlag;
  const store = new Store(DB_PATH);
  const memory = openMemory();
  const id = store.createTask(prompt, cfg.workspace, thread);
  console.log(`task ${id} queued  (thread: ${thread}  workspace: ${cfg.workspace})\n`);

  let printedStatus = false;
  const onStatus = (message: string) => {
    if (!printedStatus) process.stdout.write("\n");
    printedStatus = true;
    dim(message);
  };

  try {
    const result = await runTask(store, cfg, store.getTask(id)!, { onText: (delta) => process.stdout.write(delta), onStatus }, memory);
    console.log(`\n\ntask ${id} done — ${result.length} chars\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n\ntask ${id} failed\n${message}\n`);
    memory.close();
    store.close();
    return 1;
  }

  try {
    const pending = store.pendingTurnCount(thread);
    if (extract) {
      dim(`强制提炼：${pending} 轮待处理`);
      await runDistill(store, memory, cfg, thread, 20, onStatus);
    } else if (cfg.autoExtract && pending >= cfg.batchTurns) {
      dim(`累积 ${pending} 轮 ≥ 阈值 ${cfg.batchTurns}，后台提炼中…`);
      await runDistill(store, memory, cfg, thread, 20, onStatus);
    } else if (pending > 0) {
      dim(`记忆：${pending}/${cfg.batchTurns} 轮待提炼`);
    }
    return 0;
  } finally {
    memory.close();
    store.close();
  }
}

async function runDistill(
  store: Store,
  memory: MemoryStore,
  cfg: ReturnType<typeof loadConfig>,
  thread: string | undefined,
  limit: number,
  onStatus?: (message: string) => void,
): Promise<DistillResult> {
  // limit counts turns; one turn is a user event plus an assistant event.
  const events = store.pendingEvents(thread, Math.max(2, limit * 2));
  if (events.length === 0) {
    console.log("没有待提炼的对话事件");
    return { events: 0, applied: [], rejected: [], raw: "" };
  }
  const members = new Members(DATA_DIR);
  const ownerNames = members.list().filter((m) => m.is_owner).map((m) => m.display_name);
  members.close();
  const result = await distillBatch(store, memory, cfg, events, { onStatus }, ownerNames);
  printDistill(result);
  return result;
}

function parseTarget(raw: string | undefined): { targetType: "current_speaker" | "named_member" | "current_group" | "self"; targetName: string | null } {
  if (!raw || raw === "speaker" || raw === "current_speaker") return { targetType: "current_speaker", targetName: null };
  if (raw === "self" || raw === "agent") return { targetType: "self", targetName: null };
  if (raw === "group" || raw === "current_group") return { targetType: "current_group", targetName: null };
  if (raw.startsWith("member:")) return { targetType: "named_member", targetName: raw.slice(7) };
  return { targetType: "current_speaker", targetName: null };
}

function cmdRemember(args: string[]): number {
  const category = (flagValue(args, "--category") ?? flagValue(args, "--kind") ?? "fact") as MemoryCategory;
  const key = flagValue(args, "--key");
  const importanceRaw = flagValue(args, "--importance");
  const evidence = flagValue(args, "--evidence");
  const targetRaw = flagValue(args, "--target");
  const eventRaw = flagValue(args, "--event");
  const { targetType, targetName } = parseTarget(targetRaw);
  const content = args.join(" ").trim();

  if (!content || !key) {
    console.error('usage: node src/cli.ts remember "<text>" --key <slot> [--category …] [--importance 1-5] [--target self|group|member:张三] [--evidence "…"] [--event <id>]');
    return 2;
  }

  const memory = openMemory();
  const result = memory.apply({
    action: "create",
    targetType,
    targetName,
    category,
    key,
    content,
    importance: importanceRaw ? Number(importanceRaw) : 3,
    evidenceQuote: evidence ?? null,
    evidenceEventId: eventRaw ? Number(eventRaw) : null,
    reason: "手工写入",
  });
  memory.close();

  if (result.action === "rejected") {
    console.error(`rejected: ${result.reason}`);
    return 1;
  }
  console.log(`${result.action.padEnd(10)} ${result.key}${result.id ? ` (#${result.id})` : ""} — ${result.reason}`);
  return 0;
}

function cmdMemories(args: string[]): number {
  const showAll = args.includes("--all");
  const category = args.filter((arg) => !arg.startsWith("--"))[0] as MemoryCategory | undefined;
  const memory = openMemory();
  const rows = memory.list(category, showAll);
  if (rows.length === 0) {
    console.log('no memories yet — try: node src/cli.ts remember "只喝美式" --key user_drink_preference --category preference');
    memory.close();
    return 0;
  }
  for (const row of rows) {
    const evidence = row.evidence_quote
      ? ` 「${row.evidence_quote.slice(0, 40)}」${row.evidence_event_id ? `#${row.evidence_event_id}` : ""}`
      : "";
    console.log(`#${String(row.id).padEnd(4)} [${row.category.padEnd(10)}|${row.importance}] ${row.status.padEnd(11)} ${row.content}`);
    console.log(`      key=${row.key} target=${row.subject} used=${row.use_count}${evidence}`);
  }
  const stats = memory.stats();
  console.log(`\n活跃 ${stats.active}（偏好 ${stats.byCategory.preference ?? 0} / 事实 ${stats.byCategory.fact ?? 0} / 事件 ${stats.byCategory.event ?? 0}），历史 ${stats.superseded + stats.invalidated} 条`);
  memory.close();
  return 0;
}

function cmdHistory(args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error("usage: node src/cli.ts history <key>");
    return 2;
  }
  const memory = openMemory();
  const rows = memory.history(key);
  if (rows.length === 0) {
    console.log(`no history for key: ${key}`);
    memory.close();
    return 1;
  }
  for (const row of rows) {
    console.log(`#${row.id} ${row.status.padEnd(11)} [${row.category}|${row.importance}] ${row.content}`);
    console.log(`    ${row.created_at} → ${row.updated_at}`);
    if (row.evidence_quote) console.log(`    证据：「${row.evidence_quote}」`);
    if (row.note) console.log(`    备注：${row.note}`);
  }
  memory.close();
  return 0;
}

function cmdResolve(args: string[]): number {
  const key = args[0];
  const keepId = Number(args[1]);
  if (!key || !Number.isInteger(keepId)) {
    console.error("usage: node src/cli.ts resolve <key> <keep-id>");
    return 2;
  }
  const memory = openMemory();
  const ok = memory.resolve(key, keepId);
  memory.close();
  console.log(ok ? `resolved ${key}: kept #${keepId}, others superseded` : `no contested rows to resolve for ${key} (or #${keepId} not among them)`);
  return ok ? 0 : 1;
}

function cmdEvents(args: string[]): number {
  const thread = args[0];
  if (!thread) {
    console.error("usage: node src/cli.ts events <thread>");
    return 2;
  }
  const store = new Store(DB_PATH);
  const events = store.conversationEvents(thread, 100);
  if (events.length === 0) {
    console.log(`no events for thread: ${thread}`);
    store.close();
    return 1;
  }
  for (const event of events) {
    const mark = event.distilled_at ? "✓" : "·";
    console.log(`${mark} [#${String(event.id).padEnd(5)} | ${event.speaker.padEnd(8)}] ${event.text.replace(/\s+/g, " ").slice(0, 90)}`);
  }
  console.log(`\n${events.length} events (✓ = 已提炼)`);
  store.close();
  return 0;
}

function cmdForget(args: string[]): number {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) {
    console.error("usage: node src/cli.ts forget <id>");
    return 2;
  }
  const memory = openMemory();
  const removed = memory.forget(id);
  memory.close();
  console.log(removed ? `memory #${id} deleted` : `memory #${id} not found`);
  return removed ? 0 : 1;
}

async function cmdDistill(args: string[]): Promise<number> {
  const thread = flagValue(args, "--thread");
  const limitRaw = flagValue(args, "--limit");
  const limit = Math.max(1, Number(limitRaw ?? 20) || 20);

  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  const memory = openMemory();
  try {
    await runDistill(store, memory, cfg, thread, limit, dim);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    memory.close();
    store.close();
  }
}

async function cmdEval(args: string[]): Promise<number> {
  const keep = args.includes("--keep");
  const only = flagValue(args, "--only");
  const casesPath = flagValue(args, "--cases");
  return runEval({ keep, only, casesPath });
}

function cmdMembers(): number {
  const members = new Members(DATA_DIR);
  members.ensureOwner(loadConfig().ownerName);
  const rows = members.list();
  if (rows.length === 0) {
    console.log("no identities yet — feed a message first");
  }
  for (const row of rows) {
    console.log(`#${String(row.id).padEnd(3)} ${row.channel.padEnd(9)} ${row.external_id.padEnd(16)} ${row.display_name}${row.is_owner ? "  (owner)" : ""}`);
  }
  members.close();
  return 0;
}

async function cmdFeed(args: string[]): Promise<number> {
  const chatId = flagValue(args, "--chat") ?? "local";
  const channel = flagValue(args, "--channel") ?? "local";
  const name = flagValue(args, "--as");
  const externalId = flagValue(args, "--id");
  const isDm = args.includes("--dm");
  if (isDm) args.splice(args.indexOf("--dm"), 1);
  const wantRun = args.includes("--run");
  if (wantRun) args.splice(args.indexOf("--run"), 1);
  const text = args.join(" ").trim();

  if (!text || !name) {
    console.error('usage: node src/cli.ts feed "<text>" --as <name> [--chat <id>] [--id <uid>] [--dm] [--run]');
    return 2;
  }

  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  const members = new Members(DATA_DIR);
  members.ensureOwner(cfg.ownerName);
  const deps = { store, members, dataDir: DATA_DIR, ownerName: cfg.ownerName, ownerIds: cfg.ownerIds };

  const result = ingest(deps, {
    channel,
    chatId,
    chatType: isDm ? "dm" : "group",
    externalId: externalId ?? `${channel}:${name}`,
    displayName: name,
    text,
  });
  console.log(`event #${result.eventId} [${result.speaker}${result.isOwner ? " · owner" : ""}] → ${result.thread}`);

  if (wantRun) {
    const memory = openMemory();
    try {
      const taskId = store.createTask(text, cfg.workspace, result.thread);
      const reply = await runTask(store, cfg, store.getTask(taskId)!, { onStatus: dim, recordUserEvent: false }, memory);
      console.log(`\n[agent → ${result.speaker}]\n${reply}`);
    } catch (error) {
      console.error(`reply failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      memory.close();
    }
  }

  members.close();
  store.close();
  return 0;
}

async function cmdServe(args: string[]): Promise<number> {
  const channel = flagValue(args, "--channel") ?? "telegram";
  const portFlag = flagValue(args, "--port");
  if (channel !== "telegram" && channel !== "feishu" && channel !== "feishu-webhook") {
    console.error(`channel "${channel}" is not implemented (available: telegram, feishu, feishu-webhook)`);
    return 2;
  }

  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  const members = new Members(DATA_DIR);
  members.ensureOwner(cfg.ownerName);
  const memory = openMemory();
  const deps = { store, members, dataDir: DATA_DIR, ownerName: cfg.ownerName, ownerIds: cfg.ownerIds };

  // One handler for every transport: identity → event → run → reply → maybe distil.
  const handler = async (message: Incoming, send: (chatId: string, text: string) => Promise<void>) => {
    const result = ingest(deps, message);
    if (result.duplicate) {
      dim(`duplicate message ${message.messageId} ignored`);
      return;
    }
    dim(`event #${result.eventId} ${result.speaker} @ ${result.thread}`);
    try {
      const taskId = store.createTask(message.text, cfg.workspace, result.thread);
      const reply = await runTask(
        store,
        cfg,
        store.getTask(taskId)!,
        { onStatus: dim, recordUserEvent: false },
        memory,
      );
      await send(message.chatId, reply);
      const pending = store.pendingTurnCount(result.thread);
      if (pending >= cfg.batchTurns) {
        dim(`累积 ${pending} 轮，提炼记忆…`);
        await runDistill(store, memory, cfg, result.thread, 20, dim);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`failed to handle message: ${reason}`);
      await send(message.chatId, `执行失败：${reason.slice(0, 300)}`).catch(() => {});
    }
  };

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  try {
    if (channel === "telegram") {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        console.error("set TELEGRAM_BOT_TOKEN first (get one from @BotFather)");
        return 1;
      }
      const telegram = new TelegramChannel({
        token,
        allowedChats: process.env.TELEGRAM_CHAT_ALLOW?.split(",").map((id) => id.trim()).filter(Boolean),
      });
      console.log("telegram polling — ctrl+c to stop");
      await telegram.serve((message) => handler(message, (chatId, text) => telegram.send(chatId, text)), controller.signal);
      return 0;
    }

    // Feishu family: the same handler, two transports. Sending replies always needs the
    // app credentials; receiving does too in WS mode, but webhook mode can run without them.
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
    const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
    const allowedChats = process.env.FEISHU_CHAT_ALLOW?.split(",").map((id) => id.trim()).filter(Boolean);
    const sender =
      appId && appSecret
        ? new FeishuChannel({ appId, appSecret, encryptKey, verificationToken, allowedChats })
        : null;

    if (channel === "feishu-webhook") {
      const port = Number(portFlag ?? process.env.FEISHU_WEBHOOK_PORT ?? 8787);
      const server = await startFeishuWebhook({
        port,
        encryptKey,
        verificationToken,
        allowedChats,
        resolveName: sender ? (openId) => sender.nameFor(openId) : undefined,
        onMessage: (message) =>
          handler(message, async (_chatId, text) => {
            if (sender) await sender.send(message.chatId, text);
            else console.log(`[reply suppressed — no app credentials]\n${text}`);
          }),
      });
      console.log(`feishu webhook listening on http://127.0.0.1:${server.port}/feishu/event`);
      console.log(sender ? "replies: enabled" : "replies: disabled (set FEISHU_APP_ID / FEISHU_APP_SECRET)");
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve()));
      await server.close();
      return 0;
    }

    if (!appId || !appSecret) {
      console.error("set FEISHU_APP_ID / FEISHU_APP_SECRET first (open.feishu.cn → 开发者后台 → 应用凭证)");
      return 1;
    }
    console.log("feishu long connection starting — ctrl+c to stop");
    await sender!.serve((message) => handler(message, (chatId, text) => sender!.send(chatId, text)));
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve()));
    sender!.close();
    return 0;
  } finally {
    memory.close();
    members.close();
    store.close();
  }
}

function cmdStats(): number {
  const store = new Store(DB_PATH);
  const memory = openMemory();
  const tasks = store.listTasks(1_000);
  const byStatus = new Map<string, number>();
  for (const task of tasks) byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1);
  console.log("tasks");
  for (const [status, count] of byStatus) console.log(`  ${status.padEnd(9)} ${count}`);
  console.log(`  pending distil  ${store.pendingCount()}`);
  const stats = memory.stats();
  console.log("memory");
  console.log(`  active      ${stats.active} (preference ${stats.byCategory.preference ?? 0} / fact ${stats.byCategory.fact ?? 0} / event ${stats.byCategory.event ?? 0})`);
  console.log(`  superseded  ${stats.superseded}`);
  console.log(`  invalidated ${stats.invalidated}`);
  memory.close();
  store.close();
  return 0;
}

function cmdList(args: string[]): number {
  const limit = Number(args[0] ?? 20) || 20;
  const store = new Store(DB_PATH);
  const rows = store.listTasks(limit);
  if (rows.length === 0) {
    console.log("no tasks yet");
    store.close();
    return 0;
  }
  for (const row of rows) {
    const preview = row.prompt.replace(/\s+/g, " ").slice(0, 52);
    console.log(`${row.status.padEnd(8)} ${row.id}  ${row.created_at.slice(11, 19)}  [${row.thread}]  ${preview}`);
  }
  store.close();
  return 0;
}

function cmdShow(args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error("usage: node src/cli.ts show <task-id>");
    return 2;
  }
  const store = new Store(DB_PATH);
  const task = store.getTask(id);
  if (!task) {
    console.error(`task not found: ${id}`);
    store.close();
    return 1;
  }
  console.log(`id          ${task.id}`);
  console.log(`status      ${task.status}`);
  console.log(`thread      ${task.thread}`);
  console.log(`workspace   ${task.cwd}`);
  console.log(`distilled   ${task.distilled_at ?? "no"}`);
  console.log(`prompt      ${task.prompt}`);
  if (task.error) console.log(`error       ${task.error}`);
  if (task.result) console.log(`\nresult\n------\n${task.result}`);

  const events = store.eventsOf(task.id);
  console.log(`\nevents      ${events.length}`);
  for (const event of events.slice(-10)) console.log(`  #${event.seq} ${event.type}`);
  store.close();
  return 0;
}

async function cmdWorker(args: string[]): Promise<number> {
  const once = args.includes("--once");
  const cfg = loadConfig();
  const store = new Store(DB_PATH);
  const memory = openMemory();
  const reaped = store.reapStale();
  if (reaped) console.log(`requeued ${reaped} stale task(s)`);
  console.log(`worker up — db=${DB_PATH} workspace=${cfg.workspace} batch=${cfg.batchTurns} idle=${cfg.idleMinutes}m`);

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\nstopping after current task…");
  });

  while (!stopping) {
    const task = store.claimNext();
    if (!task) {
      if (once) break;
      // Idle path: threads that went quiet long enough get their memory extracted.
      for (const idle of store.idleEventThreads(cfg.idleMinutes)) {
        console.log(`\n--- distil idle thread ${idle.thread} (${idle.pending} events) ---`);
        try {
          await runDistill(store, memory, cfg, idle.thread, 20, dim);
        } catch (error) {
          console.error(`distil failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await sleep(1_000);
      continue;
    }
    console.log(`\n--- ${task.id} running ---`);
    try {
      await runTask(
        store,
        cfg,
        task,
        { onText: (delta) => process.stdout.write(delta), onStatus: (message) => dim(message) },
        memory,
      );
      console.log(`\n--- ${task.id} done ---`);
    } catch (error) {
      console.error(`--- ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  memory.close();
  store.close();
  return 0;
}

async function main(): Promise<number> {
  ensureDirs();
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "doctor":
    case "check":
      return cmdDoctor();
    case "login":
    case "auth":
      return cmdLogin();
    case "ask":
    case "run":
      return cmdAsk(rest);
    case "list":
    case "ls":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    case "worker":
    case "daemon":
      return cmdWorker(rest);
    case "remember":
    case "mem":
      return cmdRemember(rest);
    case "memories":
    case "memory":
      return cmdMemories(rest);
    case "history":
      return cmdHistory(rest);
    case "events":
      return cmdEvents(rest);
    case "resolve":
      return cmdResolve(rest);
    case "forget":
      return cmdForget(rest);
    case "distill":
      return cmdDistill(rest);
    case "stats":
      return cmdStats();
    case "eval":
    case "bench":
      return cmdEval(rest);
    case "feed":
      return cmdFeed(rest);
    case "members":
      return cmdMembers();
    case "serve":
      return cmdServe(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
