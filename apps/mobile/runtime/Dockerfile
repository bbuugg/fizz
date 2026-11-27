# syntax=docker/dockerfile:1
# 构建机使用 Docker；手机只运行产物，不需要 Docker / Termux / root。
FROM node:24-bookworm AS engine-build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_audit=false npm_config_fund=false
COPY . .
RUN npm ci && npm run build:server && npm prune --omit=dev

FROM node:24-bookworm-slim AS system
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git openssh-client python3 python3-pip \
      ripgrep procps less lrzsz \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/fizz /data /workspace /root /tmp /dev/shm /proc /sys /run
# Docker 注入的 resolv.conf 不能带到手机；启动时原生层写入当前网络的 DNS。
RUN rm -f /etc/mtab && ln -s /proc/mounts /etc/mtab

FROM system AS system-archive
# Android 打包工具会自动解开 .gz 资源并剥掉后缀；.tgz 保留 gzip 字节和原文件名。
RUN mkdir /out && tar --format=gnu --hard-dereference -czf /out/system.tgz \
      --exclude=./out --exclude=./dev --exclude=./proc --exclude=./sys \
      --exclude=./etc/hosts --exclude=./etc/hostname --exclude=./etc/resolv.conf \
      -C / .

# PRoot 是 Android/Bionic 程序，不能用上面 Debian 的 Linux proot 替代。
FROM --platform=$BUILDPLATFORM node:24-bookworm AS launcher
ARG TARGETARCH
WORKDIR /build
COPY apps/mobile/runtime/prepare-launcher.mjs ./
RUN node prepare-launcher.mjs "$TARGETARCH"

FROM engine-build AS engine-archive
RUN mkdir -p /engine/apps/server /out \
    && cp -a node_modules package.json /engine/ \
    && cp -a apps/server/dist /engine/apps/server/ \
    && cp -a acp plugins skills /engine/
COPY apps/mobile/runtime/entry.mjs /engine/mobile-entry.mjs
COPY apps/mobile/runtime/mobile-dns.mjs /engine/mobile-dns.mjs
RUN tar --format=gnu --hard-dereference -czf /out/engine.tgz -C /engine .

FROM scratch AS bundle
COPY --from=system-archive /out/system.tgz /assets/fizz-runtime/system.tgz
COPY --from=engine-archive /out/engine.tgz /assets/fizz-runtime/engine.tgz
COPY --from=launcher /build/jniLibs/ /jniLibs/
COPY --from=launcher /build/notices/ /assets/fizz-runtime/notices/
