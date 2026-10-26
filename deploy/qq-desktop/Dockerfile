# QQ + 虚拟桌面 + noVNC：在浏览器里看到 QQ 窗口并扫码登录
#
# 为什么需要它：QQ 的协议端（NapCat / SnowLuma）都要求有一个真实 QQ 进程可注入，
# 而云服务器没有桌面。Xvfb 提供虚拟显示，x11vnc 把画面导出，noVNC 再把它变成网页。
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LANG=C.UTF-8

# 换阿里云镜像：从 deb.debian.org 拉包在这台机器上每个包要几十秒
RUN for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do [ -f "$f" ] && sed -i 's|deb.debian.org|mirrors.aliyun.com|g' "$f"; done; grep -h 'URIs\|^deb' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null | head -3

# QQ 的运行时依赖 + 虚拟桌面 + noVNC 栈
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify supervisor \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxkbcommon0 \
      libxdamage1 libatk-bridge2.0-0 libdrm2 libxcomposite1 libxrandr2 \
      libxtst6 libxkbcommon-x11-0 libcups2 libpulse0 libnotify4 \
      libsecret-1-0 libsqlite3-0 libdbus-1-3 libexpat1 libgl1 \
      fonts-noto-cjk ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/*

# 安装 QQ（先 dpkg 再补依赖，避免版本漂移导致的依赖名变化）
COPY qq.deb /tmp/qq.deb
RUN dpkg -i /tmp/qq.deb || true
RUN apt-get update && apt-get -f install -y --no-install-recommends && rm -rf /var/lib/apt/lists/* /tmp/qq.deb

COPY supervisord.conf /etc/supervisor/conf.d/qq.conf

EXPOSE 6080
CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
