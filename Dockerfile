# syntax=docker/dockerfile:1

# =============================================================================
# Fizz server —— 一个容器同时提供 HTTP/SSE 接口 **和** web 页面。
#
# 同源托管（server 直接发 apps/web/dist）意味着浏览器不需要跨域，也就不需要配
# FIZZ_CORS_ORIGINS —— 部署在服务器上时这是最省事的形态。
#
#   docker build -t fizz-server .
#   docker run -d --name fizz -p 7801:7801 \
#     -e FIZZ_AUTH_PASS= -e FIZZ_JWT_SECRET=换成随机串 \
#     -e FIZZ_HOST=0.0.0.0 \
#     -v fizz-data:/data \
#     -v /srv/my-project:/workspace \
#     fizz-server
#
# 日常用 docker-compose.yml 就够了。
#
# 容器里已经装好 git（「源代码管理」面板与 agent 的 git 命令都要它）。
# 首次提交前给容器一个 git 身份，否则提交会报「Please tell me who you are」：
#   docker exec fizz git config --global user.name  "你的名字"
#   docker exec fizz git config --global user.email "you@example.com"
# 这些写进 /data（见下面的 GIT_CONFIG_GLOBAL），容器重建不会丢。
# =============================================================================

# -----------------------------------------------------------------------------
# 1. 构建
# -----------------------------------------------------------------------------
# 必须用完整版（不是 -slim）：
#   node-pty 1.1.0 的 prebuilds/ 里只有 darwin-* 与 win32-*，**没有 linux**，
#   Linux 上 install 脚本会走 `node scripts/prebuild.js || node-gyp rebuild` 的
#   后半段，需要 python3 + make + g++。node:22-bookworm 基于 buildpack-deps，自带
#   这套工具链；node:22-bookworm-slim 没有，装依赖会直接失败。
FROM node:22-bookworm AS builder

WORKDIR /app

# electron 只是根 devDependency（打包桌面端用），server 镜像用不到它 100+MB 的二进制
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_registry=https://registry.npmmirror.com

# 先只拷各 workspace 的 manifest：改源码不会让 npm ci 这层缓存失效。
# ⚠️ 必须**列全**（`workspaces` 是 `packages/*` + `apps/*`）：少一个 workspace，
# `npm ci` 会因为 lockfile 与 package.json 不同步直接失败。
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
COPY packages/contracts/package.json packages/contracts/
COPY packages/agent/package.json packages/agent/
COPY packages/agent-client/package.json packages/agent-client/
COPY packages/agent-host/package.json packages/agent-host/
COPY packages/agent-kit/package.json packages/agent-kit/
COPY packages/acp/package.json packages/acp/
COPY packages/git/package.json packages/git/
COPY packages/mcp/package.json packages/mcp/
COPY packages/plugin/package.json packages/plugin/
COPY packages/shells/package.json packages/shells/
COPY packages/skills/package.json packages/skills/
COPY packages/tools/package.json packages/tools/
COPY packages/ui/package.json packages/ui/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY packages/workspace/package.json packages/workspace/
RUN npm ci

COPY . .

# build:server = vite build -c apps/server/vite.config.ts
#   → apps/server/dist/index.js（单文件 ESM；第三方依赖保持 external，运行时靠 node_modules）
# build:web    = copy:monaco + vite build -c apps/web/vite.config.ts
#   → apps/web/dist（静态文件，由 server 同源托管；含 monaco 资源）
RUN npm run build:server && npm run build:web

# 只留运行时依赖：vite / typescript / electron / electron-builder / monaco 全部去掉。
# 产物里真正会 import 的第三方包（hono、@hono/node-server、ws、node-pty、ai、
# @ai-sdk/*、@agentclientprotocol/sdk、@modelcontextprotocol/sdk、zod）
# 都在各包的 dependencies 里，不会被剪掉。
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# 2. 运行
# -----------------------------------------------------------------------------
# 与构建阶段同为 bookworm，glibc 一致 → node-pty 编译出来的 .node 能直接跑
FROM node:22-bookworm-slim

WORKDIR /app

# FIZZ_HOST 默认是 127.0.0.1（见 apps/server/src/state.ts），容器里必须显式放开
ENV NODE_ENV=production \
    FIZZ_HOST=0.0.0.0 \
    FIZZ_PORT=7801 \
    FIZZ_DATA_DIR=/data \
    FIZZ_WEB_DIR=/app/apps/web/dist

# git 的**全局**配置写到已持久化的 /data 里。默认位置是 /root/.gitconfig，而 /root 不在任何
# 卷里 —— 那样 `git config --global user.email …` 在容器重建后就丢了，每次 up --build 都得重设。
ENV GIT_CONFIG_GLOBAL=/data/gitconfig

# 容器内运行身份（uid / gid），由 docker-entrypoint.sh 在启动时落地。
# 默认 0:0 = root（与以前一致）；设成宿主机用户的 `id -u` / `id -g` 后，
# 容器里写出来的文件在宿主机上就属于你 —— 不用再 sudo chown，git 也不会再报「dubious ownership」。
ENV PUID=0 \
    PGID=0

# ⚠️ 目录层级不能改：app.ts 用 `import.meta.dirname` 算 WEB_DIR
#    （../../web/dist），dist 的位置一变就找不到 web 产物，只剩 API。
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
# 容器型项目的**镜像构建上下文**：服务端要 `docker build -f docker/container-project/<env>.Dockerfile .`
# 才能把各运行环境的镜像做出来（构建上下文 = 仓库根，所以这些得在 /app 下按原层级存在）。
# 默认不生效 —— 这个镜像里没装 docker CLI，也没挂 docker socket，
# 所以设置页的「容器」会如实回「docker 不可用」，其余功能完全不受影响。
#
# ⚠️ 容器型项目**不要**用这个容器跑：它要挂的是**宿主机路径**，还得拿宿主机 docker。
#    请在宿主机上直接 `npm run server`（见 docker-compose.yml 里那段注释）。
COPY --from=builder /app/docker ./docker

# ACP 的**附属资源**：pi 的「工具调用求批准」扩展模板。建 ACP 会话时 server 会把它拷进
# 工作区的 `<项目>/.pi/extensions/confirm-tools.ts`（见 apps/server/src/server/acp-extension.ts）。
# 运行阶段的 cwd 是 /app，所以必须按仓库根的层级放进来，否则那里只会 warn 一句「找不到扩展源码」。
COPY --from=builder /app/acp ./acp

# /data    ：配置 / 会话 / 加密后的 API key（compose 里挂卷持久化）
# /workspace：给 agent 操作的目录（compose 里把宿主机目录挂到这里）
RUN mkdir -p /data /workspace

# -----------------------------------------------------------------------------
# agent / 面板要用的命令行工具（**git 是必须的**）
# -----------------------------------------------------------------------------
#   git             —— 「源代码管理」面板（状态 / 暂存 / 提交 / 检出 / 推送）全靠它；
#                      没装的话面板只会回一句「这个工作区不是 git 仓库（也可能没装 git）」
#   openssh-client  —— git@host:path 形式的远端；也给 agent 自己 ssh / ssh-keygen 用
#   ca-certificates —— https 远端与各种 TLS 请求的根证书
#   curl            —— agent 下载 / 探活常用，进容器排查也方便
#   less            —— git log / diff 的分页器（终端面板里看历史才顺手）
#   ripgrep         —— agent 搜代码时几乎必敲 rg（应用内置的 grep 不依赖它）
#   procps          —— ps / top / free：看容器里到底跑着什么
#   gosu            —— 启动时按 PUID/PGID 降权（见 docker-entrypoint.sh）；它是 exec 而不是
#                      fork，node 直接当 PID 1 收得到 SIGTERM，docker stop 才能优雅退出
#   lrzsz           —— 终端面板里的 **rz / sz**（web 端「终端」标签 = 容器里的 shell，
#                      在容器里敲 rz 才能把宿主的文件传进来；不装就只会 command not found）。
#                      终端 UI 认 ZMODEM 协议头是自动的，缺的只是被连那一侧的这两个程序。
# 合计约 +80MB；DEBIAN_FRONTEND 非交互，免得 apt 在构建时弹 debconf 提问卡住。
ENV DEBIAN_FRONTEND=noninteractive
# 默认 deb.debian.org 在境内很慢，整段替换为阿里云镜像（同时覆盖主源与 security 源）
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        openssh-client \
        ca-certificates \
        curl \
        less \
        ripgrep \
        procps \
        gosu \
        lrzsz \
    && rm -rf /var/lib/apt/lists/*

# ⚠️ 这条不能省：工作区是从宿主机 bind mount 进来的，属主通常是宿主机的用户，而容器里是 root。
#    不关掉「可疑所有权」检查的话，每条 git 命令都会 fatal: detected dubious ownership，
#    面板与 agent 的 git 操作全线不可用。容器是单一用途的（只跑这个 server），放宽可接受。
RUN git config --system --add safe.directory '*'

VOLUME ["/data"]

EXPOSE 7801

# /healthz 不需要 token（见 apps/server/src/app.ts）；slim 镜像里没有 curl/wget，用 node 自己探
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.FIZZ_PORT||7801)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# 启动入口：按 PUID / PGID 降权后再起 server（默认 0:0 = root，行为不变）。
# 用 exec 形式写 ENTRYPOINT：node 收到的就是它自己当 PID 1，docker stop 才能优雅退出。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 工作目录就是 /app，所以 `apps/server/dist/index.js` 里的相对定位与 .env 查找
# （cwd → apps/server → 仓库根）都按原样生效
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]
