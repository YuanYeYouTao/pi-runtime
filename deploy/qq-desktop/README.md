# QQ 通道：无桌面服务器上跑 QQ 客户端

QQ 的协议端（NapCat / SnowLuma 等）都需要**注入一个真实的 QQ 进程**才能工作，而云服务器没有屏幕。这个目录用 Xvfb 造一块虚拟显示、x11vnc 导出画面、noVNC 变成网页，于是你能在浏览器里看到 QQ 登录界面并扫码。

## 架构

```
你的浏览器 ──► noVNC :6080 ──► Xvfb :99 ──► QQ（容器内）
                                              │ 注入
                                      SnowLuma（容器内）
                                              │ OneBot v11
                                   HTTP :3000（发） / WS :3001（收）
                                              │
                                      pi-runtime（--network host）
```

四个进程由 supervisord 拉起：

| 进程 | 作用 |
|---|---|
| `Xvfb :99` | 虚拟显示，QQ 需要一个 X server |
| `x11vnc` | 把虚拟显示导出成 VNC |
| `websockify` + noVNC | VNC → 网页，端口 6080 |
| `/opt/QQ/qq --no-sandbox` | QQ 本体；容器内没有 user namespace，必须带这个参数 |

## 部署三步

```bash
# 0. 准备 QQ 的 Linux 安装包（x86_64 .deb），上传到本目录并命名 qq.deb
#    从 https://im.qq.com/linuxqq/download.html 取直链

# 1. 构建（首次 5–10 分钟，apt 已切阿里云镜像）
bash build.sh

# 2. 打开 noVNC，用手机扫码登录
#    http://<服务器IP>:6080/vnc.html   （建议走 SSH 隧道：ssh -L 6080:127.0.0.1:6080）
```

扫码成功后，把 SnowLuma 装进同一个容器（它能看见 QQ 进程才能注入）：

```bash
docker cp /opt/sl qq-desktop:/opt/snowluma
docker exec -d qq-desktop sh -c 'cd /opt/snowluma && ./launcher.sh > /tmp/snowluma.log 2>&1'
```

然后进 SnowLuma 的 WebUI（5099）同意协议、注入进程、配置 OneBot 的 HTTP(3000) 与 WS(3001)。

## 六个真实的坑

| 现象 | 原因 | 解法 |
|---|---|---|
| `172.17.0.2:5099` 连不上，宿主机 curl 超时 | 应用只监听 `127.0.0.1`，而**端口映射转发到容器网卡**，loopback 收不到 | 改配置 `webuiHost: 0.0.0.0` 并重启应用 |
| 容器重建后 QQ 回到登录页 | `docker commit` 保住文件，但**登录态依赖运行时握手** | 只能重新扫码；`docker commit` 后再重建能省掉重装 |
| 3001 的 HTTP 请求返回 `Upgrade Required` | 该端口配成了 WS 服务端 | HTTP 与 WS 必须**分端口**，各配一个适配器 |
| `onebot: websocket error`，但手工连同一个地址能通 | 客户端拼接 URL 时丢了结尾斜杠，服务端路径是 `/` | URL 写成 `ws://host:3001/` |
| 发送消息 401 | 该实现给 HTTP 和 WS **各发一个 token**，客户端只用了其中一个 | 两个 token 分别配置（见 `QQ_WS_TOKEN` / `QQ_HTTP_TOKEN`） |
| 服务器整体无响应，SSH 握手超时 | 1.7 GB 内存跑「QQ + 协议端 + 运行时」到顶了 | 加 swap 兜底，或升到 4 GB |

## 内存预算（实测）

| 组件 | 占用 |
|---|---|
| QQ + Xvfb + VNC | 700–900 MB |
| SnowLuma | 150–250 MB |
| pi-runtime（每个通道） | 60–90 MB |

**2 GB 机器只够跑一个通道**。跑 QQ + 飞书两个通道时，建议 4 GB，或者给容器加 `--memory` 上限避免互相拖死。

## 验证

```bash
# QQ 进程在线
docker exec qq-desktop ps aux | grep -c "[o]pt/QQ/qq"

# OneBot 通
curl -s -H "Authorization: Bearer <http-token>" http://127.0.0.1:3000/get_login_info

# 运行时连上
docker logs pi-rt-qq --tail 5     # 应该看到 onebot: connected
```

## 相关变量

运行时的 QQ 通道读这些环境变量（见 `src/channels/onebot.ts`）：

```
QQ_WS_URL          ws://127.0.0.1:3001/
QQ_HTTP_URL        http://127.0.0.1:3000
QQ_WS_TOKEN        WS 服务的 token
QQ_HTTP_TOKEN      HTTP 服务的 token
QQ_BOT_UIN         机器人 QQ 号（用于判断 @ 是否指向自己）
QQ_ALLOW_USERS     私聊白名单
QQ_ALLOW_GROUPS    群白名单
QQ_GROUP_NO_MENTION  这些群不用 @ 也回复
QQ_WAKE_WORDS      消息里出现这些词就当在叫它
```
