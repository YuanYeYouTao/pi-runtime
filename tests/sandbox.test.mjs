import path from "node:path";
import os from "node:os";
import {
  normalizeMode,
  excludedTools,
  toolArgs,
  describePolicy,
  scrubEnv,
  checkWorkspace,
  sandboxReport,
  DEFAULT_MODE,
} from "../src/sandbox.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) mode parsing falls back to the default rather than guessing
{
  check("default is safe", DEFAULT_MODE === "safe");
  check("parses known modes", normalizeMode("readonly") === "readonly" && normalizeMode("FULL") === "full");
  check("unknown falls back", normalizeMode("yolo") === "safe" && normalizeMode(undefined) === "safe");
}

// 2) capability removal per mode
{
  check("full removes nothing", excludedTools("full").length === 0);
  check("safe removes the shell", excludedTools("safe").join(",") === "bash");
  check("readonly removes shell and writers", excludedTools("readonly").sort().join(",") === "bash,edit,write");
  check("flags are passed to pi", toolArgs("safe").join(" ") === "--exclude-tools bash");
  check("full adds no flags", toolArgs("full").length === 0);
  check("every mode is described", ["readonly", "safe", "full"].every((mode) => describePolicy(mode).length > 0));
}

// 3) env scrubbing: secrets do not reach the child
{
  const base = {
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    FEISHU_APP_SECRET: "super-secret",
    DEEPSEEK_API_KEY: "sk-should-not-leak",
    GITHUB_TOKEN: "ghp_should_not_leak",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  };
  const env = scrubEnv(base, { PI_RT_MODEL: "deepseek-flash", PI_TELEMETRY: "0" });
  check("keeps PATH", env.PATH === base.PATH);
  check("keeps SystemRoot", env.SystemRoot === "C:\\Windows");
  check("drops the app secret", env.FEISHU_APP_SECRET === undefined);
  check("drops the model key", env.DEEPSEEK_API_KEY === undefined);
  check("drops the github token", env.GITHUB_TOKEN === undefined);
  check("drops the aws key", env.AWS_SECRET_ACCESS_KEY === undefined);
  check("keeps explicit extras", env.PI_RT_MODEL === "deepseek-flash" && env.PI_TELEMETRY === "0");
  check("no value from the parent leaks", Object.values(env).every((value) => !String(value).includes("secret")));
}

// 4) workspace guard refuses whole-machine scopes
{
  const root = path.parse(process.cwd()).root;
  check("rejects drive root", checkWorkspace(root).ok === false, root);
  check("rejects the home directory", checkWorkspace(os.homedir()).ok === false, os.homedir());
  check("allows a mount point like /workspace", checkWorkspace(path.join(root, "workspace")).ok === true);
  check("rejects system directories", ["etc", "usr", "var", "root", "home"].every((dir) => checkWorkspace(path.join(root, dir)).ok === false));
  check("accepts a project directory", checkWorkspace(process.cwd()).ok === true, process.cwd());
  check("accepts a nested path", checkWorkspace(path.join(root, "a", "b", "c")).ok === true);
}

// 5) the report is internally consistent
{
  const report = sandboxReport("readonly", process.cwd());
  check("report carries the mode", report.mode === "readonly");
  check("report lists exclusions", report.excluded.length === 3);
  check("report resolves the workspace", path.isAbsolute(report.workspace));
  check("report flags a bad workspace", sandboxReport("safe", path.parse(process.cwd()).root).workspaceOk === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
