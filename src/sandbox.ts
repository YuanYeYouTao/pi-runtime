import path from "node:path";
import os from "node:os";

export type SandboxMode = "readonly" | "safe" | "full";

export const DEFAULT_MODE: SandboxMode = "safe";

const MODES: SandboxMode[] = ["readonly", "safe", "full"];

export function normalizeMode(input?: string | null): SandboxMode {
  const value = (input ?? "").trim().toLowerCase();
  return (MODES as string[]).includes(value) ? (value as SandboxMode) : DEFAULT_MODE;
}

/**
 * What each mode removes, and why.
 *
 * These are enforced by pi itself (`--exclude-tools`), not by the prompt: an instruction the
 * model can ignore is not a boundary. This is **capability limiting**, not OS isolation — the
 * agent can still read any file the user can read. It removes the sharpest edges:
 *
 * - `full`     — nothing removed (the previous behaviour);
 * - `safe`     — no shell: no `rm`, no `git push`, no curl, no arbitrary process;
 * - `readonly` — no shell, no write, no edit: the agent can look, not change.
 */
export function excludedTools(mode: SandboxMode): string[] {
  switch (mode) {
    case "readonly":
      // `mcp__*` is included on purpose. An MCP server declares its own capabilities and we
      // cannot inspect them, so a "read-only" mode that leaves MCP enabled is not read-only —
      // one `pi mcp add` (by anyone) would silently reopen write access.
      return ["bash", "write", "edit", "mcp__*"];
    case "safe":
      // MCP stays available here, but the runtime records which servers were enabled, because
      // "safe" only promises no shell — it does not promise every external tool is harmless.
      return ["bash"];
    case "full":
    default:
      return [];
  }
}

/** pi CLI flags for a mode. */
export function toolArgs(mode: SandboxMode): string[] {
  const excluded = excludedTools(mode);
  return excluded.length === 0 ? [] : ["--exclude-tools", excluded.join(",")];
}

export function describePolicy(mode: SandboxMode): string {
  switch (mode) {
    case "readonly":
      return "只读：禁用 bash / write / edit，可以读文件但不能改";
    case "safe":
      return "安全：禁用 bash（不能执行命令），可以读写工作区文件";
    case "full":
      return "完全：不限制工具（等同于旧行为）";
  }
}

/**
 * Environment variables that must survive: Windows and Node need them to even start.
 * Everything else is dropped, so a shell (in `full` mode) cannot echo a token from the env.
 */
const KEEP_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS",
  "USERNAME",
  "USERDOMAIN",
  "LANG",
  "LC_ALL",
  "TZ",
];

/**
 * Build the child environment: an OS whitelist plus explicitly passed values.
 *
 * The model credentials are *not* needed here — pi reads them from its own config directory —
 * which is what makes this scrub safe rather than an outage.
 */
export function scrubEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of KEEP_ENV) {
    const value = base[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export type WorkspaceVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Refuse workspaces that hand the agent the whole machine.
 *
 * Running in `C:\` or in the user's home directory means every absolute path the model invents
 * is in scope, and a single `write` mistake lands somewhere important. Two segments is an
 * arbitrary but reasonable floor (`C:\Users\name\project` passes, `C:\Users\name` does not).
 */
export function checkWorkspace(workspace: string): WorkspaceVerdict {
  const resolved = path.resolve(workspace);
  const parsed = path.parse(resolved);
  const home = path.resolve(os.homedir());

  if (resolved === parsed.root) return { ok: false, reason: `工作区不能是磁盘根目录：${resolved}` };
  if (resolved.toLowerCase() === home.toLowerCase()) return { ok: false, reason: `工作区不能是用户主目录：${resolved}` };

  // A mount point like /workspace is a single segment and is perfectly safe; what must be
  // refused is a *system* directory, where a stray write breaks the machine. The earlier
  // "at least two segments" rule was a proxy that got this exactly backwards.
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (segments.length === 0) return { ok: false, reason: `工作区不能是根目录：${resolved}` };

  const first = segments[0].toLowerCase();
  // `opt` is deliberately absent: applications legitimately live there, and this runtime's own
  // deployment uses /opt/pi-runtime — blocking it made the guard reject its own install.
  const systemDirs = new Set([
    "etc", "usr", "bin", "sbin", "lib", "lib32", "lib64", "boot", "dev", "proc", "sys",
    "var", "root", "home", "run",
    "windows", "program files", "program files (x86)", "programdata", "system32",
  ]);
  // A project checked out under the user's home (~/projects/foo) is the most common layout on
  // Linux, and GitHub Actions puts the repo under /home/runner/work. Rejecting everything
  // whose first segment is a system directory rejected those too, so only the *bare* system
  // directory and paths outside our own home stay blocked.
  const insideOwnHome = resolved.startsWith(home + path.sep);
  if (systemDirs.has(first) && !insideOwnHome) {
    return { ok: false, reason: `工作区不能是系统目录：${resolved}` };
  }

  return { ok: true };
}

export type SandboxReport = {
  mode: SandboxMode;
  description: string;
  excluded: string[];
  workspace: string;
  workspaceOk: boolean;
  workspaceReason?: string;
};

export function sandboxReport(mode: SandboxMode, workspace: string): SandboxReport {
  const verdict = checkWorkspace(workspace);
  return {
    mode,
    description: describePolicy(mode),
    excluded: excludedTools(mode),
    workspace: path.resolve(workspace),
    workspaceOk: verdict.ok,
    workspaceReason: verdict.ok ? undefined : verdict.reason,
  };
}
