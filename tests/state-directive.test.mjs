import { extractStateDirectives } from "../src/state-directive.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) one directive is extracted and stripped from the visible reply
{
  const { directives, cleaned } = extractStateDirectives("端口改成 8080 了，已记下。\n<!--state: deploy_port=8080; ttl=7d-->");
  check("extracts one directive", JSON.stringify(directives) === JSON.stringify([{ key: "deploy_port", value: "8080", ttl: "7d" }]), JSON.stringify(directives));
  check("strips it from the reply", cleaned === "端口改成 8080 了，已记下。", JSON.stringify(cleaned));
}

// 2) ttl is optional and defaults to undefined
{
  const { directives } = extractStateDirectives("<!--state: branch=fix/auth-v3-->");
  check("ttl is optional", directives[0].ttl === undefined, JSON.stringify(directives));
}

// 3) several directives in one reply
{
  const { directives, cleaned } = extractStateDirectives(
    "记下了两条。\n<!--state: port=8080; ttl=12h-->\n<!--state: branch=fix/v3; ttl=3d-->",
  );
  check("extracts multiple", directives.length === 2, JSON.stringify(directives));
  check("cleans both", cleaned === "记下了两条。", JSON.stringify(cleaned));
}

// 4) values with spaces survive, trailing whitespace does not
{
  const { directives } = extractStateDirectives("<!--state: task_progress=第 2 步完成，等评审 ; ttl=3d-->");
  check("keeps inner spaces", directives[0].value === "第 2 步完成，等评审", JSON.stringify(directives[0].value));
}

// 5) keys are normalised to lower case
{
  const { directives } = extractStateDirectives("<!--state: DeployPort=8080-->");
  check("lowercases the key", directives[0].key === "deployport", JSON.stringify(directives[0]));
}

// 6) a malformed directive is left alone rather than half-parsed
{
  const text = "<!--state: bad key with spaces=1-->";
  const { directives, cleaned } = extractStateDirectives(text);
  check("ignores malformed keys", directives.length === 0, JSON.stringify(directives));
  check("leaves malformed text untouched", cleaned === text, JSON.stringify(cleaned));
}

// 7) plain text passes through unchanged
{
  const text = "就是一句普通的话。";
  check("no directive, no change", extractStateDirectives(text).cleaned === text);
}

// 8) empty and whitespace-only input is safe
{
  check("empty input", extractStateDirectives("").cleaned === "");
  check("whitespace input", extractStateDirectives("   \n\n").cleaned === "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
