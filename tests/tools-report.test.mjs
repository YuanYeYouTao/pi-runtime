import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { summarizeToolCalls, listMcpServers, formatToolReport } from "../src/tools-report.ts";
import { excludedTools, toolArgs } from "../src/sandbox.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const start = (name, id, seconds) => ({ type: "tool_execution_start", created_at: at(seconds), payload: JSON.stringify({ toolName: name, toolCallId: id }) });
const end = (name, id, seconds, isError = false) => ({
  type: "tool_execution_end",
  created_at: at(seconds),
  payload: JSON.stringify({ toolName: name, toolCallId: id, isError }),
});

// 1) counts, failure rate and duration
{
  const stats = summarizeToolCalls([
    start("read", "c1", 0),
    end("read", "c1", 1),
    start("read", "c2", 2),
    end("read", "c2", 5),
    start("edit", "c3", 6),
    end("edit", "c3", 7, true),
  ]);
  const byName = Object.fromEntries(stats.map((s) => [s.name, s]));
  check("counts calls", byName.read.calls === 2 && byName.edit.calls === 1, JSON.stringify(stats));
  check("counts failures", byName.edit.failures === 1 && byName.read.failures === 0);
  check("averages duration", byName.read.avgMs === 2000, String(byName.read.avgMs));
  check("sorts by call count", stats[0].name === "read", stats.map((s) => s.name).join(","));
}

// 2) a missing start degrades to unknown, not zero
{
  const stats = summarizeToolCalls([end("bash", "orphan", 3)]);
  check("orphan end still counts", stats[0].calls === 1);
  check("orphan end has no duration", stats[0].avgMs === null, String(stats[0].avgMs));
}

// 3) malformed payloads are skipped, not fatal
{
  const stats = summarizeToolCalls([
    { type: "tool_execution_end", created_at: at(0), payload: "{not json" },
    { type: "tool_execution_end", created_at: at(1), payload: JSON.stringify({ toolName: "", toolCallId: "x" }) },
    end("read", "ok", 2),
  ]);
  check("skips junk payloads", stats.length === 1 && stats[0].name === "read", JSON.stringify(stats));
}

// 4) MCP config parsing
{
  const dir = path.join("eval", "tmp-tools");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "pi"), { recursive: true });
  check("no file, no servers", listMcpServers(dir).length === 0);
  writeFileSync(
    path.join(dir, "pi", "mcp.json"),
    JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["-y", "fs"] }, dead: { command: "x", disabled: true } } }),
    "utf8",
  );
  const servers = listMcpServers(dir);
  check("reads servers", servers.length === 2, JSON.stringify(servers));
  check("carries the command", servers.find((s) => s.name === "filesystem")?.command === "npx");
  check("marks disabled servers", servers.find((s) => s.name === "dead")?.enabled === false);
  rmSync(dir, { recursive: true, force: true });
}

// 5) report formatting
{
  const stats = summarizeToolCalls([start("read", "a", 0), end("read", "a", 1), start("edit", "b", 2), end("edit", "b", 3, true)]);
  const lines = formatToolReport(stats, [{ name: "filesystem", enabled: true }]);
  const text = lines.join("\n");
  check("report names the MCP server", text.includes("filesystem"));
  check("report shows success rate", text.includes("100%") && text.includes("0%"), text);
  check("report shows average time", text.includes("1000ms"));
  check("empty stats still render", formatToolReport([], []).join("\n").includes("未配置"));
}

// 6) the sandbox now closes the MCP door in readonly
{
  check("readonly excludes MCP tools", excludedTools("readonly").includes("mcp__*"), JSON.stringify(excludedTools("readonly")));
  check("readonly flag reaches pi", toolArgs("readonly").join(" ").includes("mcp__*"), toolArgs("readonly").join(" "));
  check("safe leaves MCP enabled", !excludedTools("safe").includes("mcp__*"));
  check("full leaves MCP enabled", !excludedTools("full").includes("mcp__*"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
