# 构建并启动「QQ + noVNC 桌面」容器
# 用法：在本目录执行 bash build.sh
set -uo pipefail

cd "$(dirname "$0")" || exit 1

echo "== 1) 准备 deb =="
if [ ! -f qq.deb ]; then
  if [ -f /opt/qq.deb ]; then
    cp /opt/qq.deb qq.deb
  else
    echo "  缺少 qq.deb（先上传到 /opt/qq.deb）"; exit 1
  fi
fi
ls -lh qq.deb

echo "== 2) 构建镜像（首次约 5-10 分钟）=="
docker build -t qq-desktop:latest . || { echo "  构建失败"; exit 1; }

echo "== 3) 启动容器 =="
docker rm -f qq-desktop >/dev/null 2>&1
docker run -d --name qq-desktop --restart unless-stopped \
  --shm-size=512m \
  --memory=1150m --memory-swap=1800m \
  -p 6080:6080 \
  qq-desktop:latest >/dev/null && echo "  已启动"

sleep 20
echo "== 4) 状态 =="
docker ps --filter name=qq-desktop --format '  {{.Names}} {{.Status}}'
echo "  内存: $(docker stats --no-stream --format '{{.MemUsage}}' qq-desktop)"
echo "== 5) QQ 是否在跑 =="
docker exec qq-desktop ps aux 2>/dev/null | grep -c "[o]pt/QQ/qq" || echo "  0"
echo "== 6) 日志 =="
docker logs qq-desktop --tail 12 2>&1
echo
echo "noVNC: http://<服务器IP>:6080/vnc.html   （或建 SSH 隧道访问 127.0.0.1:6080）"
