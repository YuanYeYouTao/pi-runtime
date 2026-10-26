#!/usr/bin/env bash
# 给 QQ 通道装上 MCP fetch，并启用 bash。
#
# 为什么两个一起改：
# - pi 没有内置联网工具，而 safe 模式禁 bash → 之前的 bot 完全不能上网；
# - 你要的是 bash，safe 模式恰好排除它，所以只能切到 full。
#
# ⚠️ full 意味着没有任何工具限制：agent 能以 root 在容器内执行任意命令。容器本身是边界，
#    但请确认这台机器上没有别的敏感服务挂在同一网络里。
set -uo pipefail

MCP_DIR=/srv/pi-rt/workspace/mcp
CONF_DIR=/srv/pi-rt/data/pi/agent

echo "== 1) 放置 MCP server =="
mkdir -p "$MCP_DIR" "$CONF_DIR"
cp /opt/pi-runtime/mcp/fetch-server.mjs "$MCP_DIR/fetch-server.mjs"
ls -l "$MCP_DIR/fetch-server.mjs"

echo "== 2) 写 MCP 配置 =="
cat > "$CONF_DIR/mcp.json" <<'JSON'
{
  "mcpServers": {
    "fetch": {
      "command": "node",
      "args": ["/workspace/mcp/fetch-server.mjs"],
      "toolExposure": ["fetch"]
    }
  }
}
JSON
cat "$CONF_DIR/mcp.json"

echo "== 3) 重启运行时（full 沙箱 + 简短化 + 人格 + 提醒）=="
docker rm -f pi-rt-qq >/dev/null 2>&1
docker run -d --name pi-rt-qq --restart unless-stopped --network host \
  -v /srv/pi-rt/data:/data -v /srv/pi-rt/workspace:/workspace \
  -e PI_RT_DATA_DIR=/data -e PI_RT_WORKSPACE=/workspace -e PI_RT_SANDBOX=full \
  -e QQ_WS_URL=ws://127.0.0.1:3001/ -e QQ_HTTP_URL=http://127.0.0.1:3000 \
  -e QQ_WS_TOKEN=IlxTkBjY0GOAuERbWmroSNanM7suGf5VgJde3ACvQAs \
  -e QQ_HTTP_TOKEN=0PXZYJSk8V7I23kMmMHzyAVr5GHe9sulWDygoNbMhwM \
  -e QQ_BOT_UIN=3385592563 -e QQ_WAKE_WORDS=油桃 \
  pi-runtime:latest node src/cli.ts serve --channel qq --no-maintenance >/dev/null
sleep 10

echo "== 4) 验证 =="
docker logs pi-rt-qq --tail 5 2>&1 | tr -d '\r'
echo "--- MCP 清单 ---"
docker exec pi-rt-qq node src/cli.ts tools 2>&1 | head -25
echo "--- 沙箱策略 ---"
docker exec pi-rt-qq node src/cli.ts sandbox 2>&1 | head -10
