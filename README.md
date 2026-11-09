<div align="center">

<img src="screenshots/account.png" alt="公众号：AI实习生" width="420" />

**关注公众号「AI实习生」** · 聚焦前沿 AI 资讯，每日精选行业动态与技术实践

</div>

# Fizz

**自托管的 AI Agent 工作台。**

把 Fizz 部署在一台机器上，你或同事用浏览器打开对应网址就能和 AI 对话，让它读代码、改文件、跑命令、管 Git、连服务器——不需要在每台电脑上装客户端。工作区可以在本机，也可以直接放在**已登记的 SSH 主机**上。

所有能力跑在**一个 Node 进程**里：HTTP 接口、SSE 对话流、Web 页面、终端（PTY）、SSH / SFTP 全部同源提供，部署只需要一个端口。除网页版外还提供 **Electron 桌面端**（把同一个 server 装进进程内跑）和 **Capacitor 安卓端**。

---

## 功能特性

### 对话与智能体

- **多模型接入**：OpenAI、Anthropic、Google、DeepSeek，以及任意 OpenAI 兼容网关（可配 baseURL / 模型列表 / 思考内容解析）。模型可在会话内随时切换。
- **工具能力**：读文件、写文件、编辑、删除、列目录、搜文件、搜内容、执行命令、Git 只读视图、联网抓取、截图、浏览器操作（Playwright）、主动追问。AI 想动文件或跑命令时**先问你**，你点同意它才动手。
- **三档权限**：`确认模式`（默认，改动前询问）/ `只读模式`（只看不改）/ `完全访问`（不问直接执行）。另有工具调用并发、命令审批超时、请求重试等细项，都在「设置 → AI → 偏好」。
- **子任务（Subagent）**：把「只读、产出噪声大、与主上下文无关」的活派给独立 agent（`explorer` 侦察 / `reviewer` 审查）。子 agent 只拿到只读工具白名单，可指定更便宜的模型，带空闲看门狗防卡死。
- **多智能体协作**：一条会话里挂若干可配置 agent；`@名字` 只点名对应的 agent，`@` 多个就多个一起处理，不 `@` 则全体判断「这条是不是我的」，无关就静默跳过。Agent 之间用 `SendMessage` 互相投递任务（投递不等待），所有回复都带作者名进同一条时间线。
- **上下文管理**：接近预算时自动压缩历史（摘要 + 检查点），也可在上下文指示条上手动点「压缩上下文」；压缩后原始消息一条不丢，清除检查点即回到全文。
- **会话操作**：分叉（从某条消息签出新会话，可顺手建 git worktree）、重命名、归档、搜索（标题 + 正文，归档会话照搜）、把外部 agent 侧已有会话导入绑定、把 ACP 会话转成内置 Agent 会话继续聊。
- **富媒体输入**：拖入图片 / PDF 直接交给模型；语音输入（按住 `Alt+V` 说话）；回复里的 Markdown 文档自动挂成可点击产物。
- **实时流式**：SSE 推送思考过程、工具调用与正文，带应用层心跳；断线可用 `requestId` 续接同一轮。

### 项目与工作区

- **文件面板**：文件树浏览、Monaco 编辑器读写、多标签、未保存标记。图片 / SVG、音视频、Markdown、HTML 有内置预览（Markdown 与 HTML 可切源码 / 预览）。
- **源代码管理**：分支切换 / 新建、改动树、逐文件 diff、暂存与还原、提交、推送、历史记录。回滚有策略保护。
- **终端**：真正的 PTY 终端（`node-pty`），支持命令补全建议、ZMODEM 上传下载、手机端扩展键位。
- **worktree**：在项目下按分支拉独立工作树（`<项目>/.worktree/<标识>`），登记成新项目，互不干扰。
- **远端 SSH 工作区**：工作区目录可以放在已登记的 SSH 主机上（如 `/srv/app`），Agent 的文件与命令操作全部在远端执行。详见下方「[远端 SSH 工作区](#远端-ssh-工作区)」。
- **容器型项目**：每个项目一个独立容器，AI 的所有操作都在容器内；目录由服务端按随机 slug 生成。内置运行环境：Node.js 24、PHP 8.5、Go 1.27、Node + Vite/React/Tailwind、Node + Next.js/Tailwind。后两种 Web 栈镜像自带模板与自动启动，新建完打开就有页面。
- **预览与对外发布**：容器内 dev server 的端口映射到本机预览面板；需要公网时把项目挂到 `*.<域名>` 下（独立监听端口 + 显式「对外发布」开关）。
- **脚本**：把常用命令存成带分组、带描述的脚本，选一台主机或本地直接跑。
- **后台任务**：克隆仓库这类耗时活儿登记成后台任务——关掉页面也照跑，状态栏可看进度、展开日志、取消或转后台。日志逐行记录（含外部命令原文），是「还活着吗 / 为什么失败」的唯一解释。

### 日常工具与运维

- **SSH 主机**：多主机清单与分组、加密保存凭据（密码 / 私钥 / 口令）、一键在终端里连上，状态栏实时显示焦点主机的 CPU / 内存 / 磁盘 / 负载 / uptime。
- **SFTP**：远端文件浏览与上传下载（分片串行传输，同名覆盖）。
- **SSH 隧道**：本地转发（`-L`）、远程转发（`-R`）、动态 SOCKS5 代理（`-D`），起停状态由服务端推送。
- **接口请求**：内置 HTTP / WebSocket 客户端，支持分组、历史、cURL 导入、OpenAPI 导入，可当日常调试工具用。
- **笔记**：登记若干目录，每个目录一棵 Markdown 树，可读可写（接口先做路径校验，未登记目录一律 403）。
- **应用日志**：按命名空间（SSH / 终端 / 隧道 / 插件…）分页查看全 App 业务事件。
- **导入导出**：主机、接口请求、脚本可导出成 zip 或单文件 JSON，换机器时导入（按 id 覆盖，导入前先预览）。凭据加密绑本机，**不随包带走**，导入后需重填。
- **用量统计**：跨会话 token 汇总（按天柱状图 + 最费的会话榜），只统计跑完的轮次。

### 扩展与自动化

- **技能（Skills）**：放一份 `SKILL.md` 进技能目录即可被发现。支持内置（随包分发）、项目级、用户级（`~/.fizz/skills`）、跨智能体共享（`~/.agents/skills`）。系统提示词里只放名称与描述，正文由模型按需读取。
- **插件（Plugins）**：TS 源码直接加载的插件框架，能注册工具、系统提示词片段、设置项、上传源、模型、Hooks，以及**自己的活动栏图标与 UI 面板**。随包内置 7 个：OSS 存储、API 文件上传、Redis 客户端、storage-to、企业微信通知、RTK 命令重写、系统提示词。
- **MCP**：挂载任意 MCP 服务器，把它的工具接进对话。
- **外部 Agent（ACP）**：通过标准协议接入 Claude Code、Codex 等，支持一键探测本机已安装的 agent；外部 agent 会话也能在同一个界面里继续聊。
- **项目规则注入**：工作区根目录的 `AGENTS.md`（`CLAUDE.md` 兼容）每轮**全文**进系统提示词，支持行内 `@相对路径` 导入；全局规则放 `<配置目录>/AGENTS.md`；子目录的规则在模型读到该目录时按需追加。
- **定时任务**：cron 表达式（5 段）或一次性定时（`at`）触发一轮会话，内置进程内调度器，不依赖外部服务；任务可不绑工作区（每次运行新建临时工作区），每轮跑出的会话都留在侧栏可回看。

### 多端与界面

- **三端同源**：web / 桌面 / 安卓共用同一套 `agent-kit` 外壳与状态层，差异只在宿主能力与版式（手机版是**单标签 + 无活动栏**：顶栏一条、侧栏固定为会话列表抽屉、内容整屏铺满）。
- **桌面端增强**：托盘常驻、会话浮窗（贴边小窗，可置顶、可跳回主窗口）、应用内自动更新（只静默检查，下载与安装都要你点）、局域网远程访问（把进程内 server 暴露成真实端口，手机 / 其他浏览器直连）。
- **安卓端**：独立 vite 工程 + Capacitor 壳，服务端地址在登录页填写并存本机，同一个 APK 可连不同服务器。
- **界面自定义**：明暗模式、内置配色主题、自定义主题（逐项改色）、主题背景（图片或视频）、可拖拽排序的活动栏与面板分屏。
- **中英双语**：中文为源文案与默认语言，英文缺失项自动回落，不会出现空白。

---

## 远端 SSH 工作区

工作区不必长在本机：把一台**已登记的 SSH 主机**上的目录接进来，就能像本地项目一样让 AI 读写与执行。

1. **添加主机**：先在「主机」里登记 SSH 地址与凭据（密码 / 私钥 / 口令，加密保存）。
2. **连接远端目录**：在「开始新对话」页的工作区下拉里选「连接远端服务器…」，选主机、填远端 POSIX 绝对路径（如 `/srv/app`）。路径是否存在由服务端经 SFTP 现探，失败原因就地提示；也可以直接浏览远端目录。
3. **照常使用**：Agent 的列目录 / 读 / 写 / 编辑 / 搜索 / 执行命令经 SFTP 与远端 shell 完成；终端走 SSH 通道，文件面板走 SFTP，源码管理的 git 命令也在远端执行。

会话、审批记录与对话历史**仍保存在本机**，远端只承载目录与命令执行。远端命令运行在 Linux 的 POSIX shell 中，路径是远端绝对路径。

> **首期限制**：不支持 worktree、多智能体协作会话、外部 Agent（ACP）、技能 / 插件、项目规则（`AGENTS.md`）注入、浏览器工具与后台命令（`runInBackground`）；全局 MCP 与子任务（Subagent）照常可用。SSH 连接不做主机指纹校验（与既有 SSH 功能一致），请自行确保网络可信。

---

## 界面一览

整个界面是「活动栏 + 侧边栏 + 主区域标签页 + 状态栏」四层（手机版是单标签，没有活动栏）：

| 区域 | 内容 |
| --- | --- |
| **活动栏**（最左，手机版没有） | AI Agent、主机、接口请求、笔记，以及插件自己声明的图标。顺序可拖拽 |
| **侧边栏** | 当前功能区的清单：会话 / 工作区树、主机与终端、请求分组与历史、笔记目录 |
| **主区域** | 多标签页：会话、文件、源码管理、终端、预览、笔记、脚本、定时任务、隧道、日志，可拖拽分屏 |
| **状态栏**（底部） | 左侧全局菜单（命令面板 / 导入导出 / 断开连接 / 设置），右侧随上下文变化：后台任务徽标、本机与焦点 SSH 主机的资源监控、日志入口、更新提示 |

常用入口：右上角按钮展开 / 收起右侧面板；`Ctrl/Cmd + Shift + P` 打开命令面板，工作区、会话、视图开关、搜索会话、跑脚本、看日志都在里面；主题与背景在「设置 → 外观」。

### 登录

部署完第一次打开就是登录页：第一次输入的密码会成为新密码，换取服务端签发的令牌。没配鉴权（或桌面端直连本机 server）时跳过这一页，直接进工作台。

![登录页](screenshots/pc_login.png)

### 首页 · 会话与工作区

左侧是「新对话 / 定时任务 / 任务 / 工作区」清单，中间直接下指令（`Enter` 发送，`Shift+Enter` 换行），右侧可并排开终端、文件、源码管理等标签页。底部状态栏显示服务端资源占用。

![首页](screenshots/home.png)

### 工作区 · 文件

点开文件即可在 Monaco 里读写，图片 / SVG、音视频、Markdown、HTML 有内置预览。右侧面板与会话并排（可拖拽分屏），边聊边改。

![工作区文件面板](screenshots/desktop_filepanel.png)

### 工作区 · 源码管理

分支切换、逐文件暂存 / 还原、提交、推送与历史记录都在浏览器里完成。下图是 53 个待提交改动的真实场景。

![工作区源码管理](screenshots/desktop_gitpanel.png)

### 设置

设置按「基础 / 终端 / AI」分组，模型、外部 Agent、MCP、技能、插件、运行环境、用量都在这一层。下图是插件页。

![设置 · 插件](screenshots/setting.png)

### 桌面端

Electron 壳 + 进程内 server：自绘标题栏、主题背景（图片 / 视频）透到整个窗口，另有托盘常驻与会话浮窗。

![桌面端](screenshots/desktop.png)

### 手机端

安卓壳是单标签形态：顶栏一颗抽屉、一颗新建，侧栏是会话列表，内容整屏铺满。对话、工具卡、模型切换与桌面端是同一套。

<p>
  <img src="screenshots/mobile_home.png" alt="手机端 · 首页" width="300" />
  <img src="screenshots/mobile_conversation.png" alt="手机端 · 会话" width="300" />
</p>

---

## 快速开始

### 方式一：Docker（推荐，跑工作台本体）

```bash
cp .env.example .env          # 至少填上 FIZZ_JWT_SECRET
docker compose up -d --build  # 首次启动或改过代码后
docker compose logs -f        # 启动日志里有访问地址与鉴权状态
docker compose down           # 停止（数据卷保留）
```

浏览器打开 `http://<服务器IP>:7801`。第一次登录时输入什么密码，它就会成为你的密码（只保存哈希）。

容器里已装好 Git，第一次提交前给容器一个提交身份（写进持久化的 `/data`，重建不丢）：

```bash
docker compose exec fizz git config --global user.email "you@example.com"
docker compose exec fizz git config --global user.name  "你的名字"
```

> **鉴权**：单用户，没有用户名。至少要配 `FIZZ_JWT_SECRET` 才会启用登录；`FIZZ_AUTH_PASS` 留空即可，首次登录时输入的密码会哈希后写回 `.env`。
>
> **数据卷**：`fizz-data` → `/data`（配置 / 会话 / 加密后的 Key / Git 全局配置）；`fizz-home` → `/home/fizz/.fizz`（自建技能目录，不挂载则重启丢失）；`./workspace` → `/workspace`（AI 可读写目录）。注册工作区时填**容器内路径** `/workspace`。
>
> **文件属主**：`PUID` / `PGID` 填宿主机 `id -u` / `id -g`，容器内新建的文件在宿主机上就属于你本人；工作区目录也要 `chown` 成同一属主。Compose 另有 `FIZZ_WORKSPACE`（宿主机上给 AI 操作的目录）与 `FIZZ_SSH_DIR`（宿主机 `.ssh`，只读挂载）两个变量。
>
> **限制**：容器型项目需要 `docker run` 起新容器，要求 server 跑在宿主机上；主 Docker 容器里没有 docker CLI，该功能会显示「docker 不可用」，其他功能不受影响。

### 方式二：本地直接运行

> Windows 需要先装 C++ 编译工具链——终端功能依赖原生模块 `node-pty`。

```bash
npm install
npm run build:server
npm run build:web
npm run build:mobile:hosted
npm run server      # 等价于 build:server && node apps/server/dist/index.js
```

打开 http://127.0.0.1:7801 。server 会同源托管构建好的网页，不需要配 CORS。

开发模式（两个终端）：

```bash
npm run dev:stack   # 构建 server + web 并启动 server
npm run dev:web     # 另开一个终端：vite dev server（5173，/api 已代理到 7801）
```

### 方式三：桌面端

```bash
npm run dev:desktop     # 开发模式（Electron + 进程内 server，vite 5175）
npm run pack:desktop    # 免安装目录
npm run dist:desktop    # 当前平台安装包（另有 dist:win / dist:mac / dist:linux）
```

桌面端与网页版共用数据目录（`~/.fizz-server`，可用 `FIZZ_DATA_DIR` 覆盖）。`npm run dev:desktop` 例外：它用独立的 `Fizz Dev` userData（数据目录在 `<userData>/server-data`），所以 **dev 版可以和安装好的客户端同时运行**，两边不会抢单实例锁，也不会互相覆盖存储。想让 dev 版连真实数据时显式设置 `FIZZ_DATA_DIR`（此时别同时开另一个实例写同一份数据）。`FIZZ_DATA_DIR` 是原样使用的，**不做 `~` 展开**，各平台都要写绝对路径。

### 方式四：安卓端

```bash
npm run add:android --workspace @fizz/mobile   # 新机器第一次必须先跑
npm run build:mobile                          # 构建 + cap sync
npm run android:build                         # 出 release APK
```

APK 首次登录必须填服务端绝对地址（页面 origin 是 `https://localhost`），填完存本机，换服务器不用重装。

**签名（重要）**：`android/` 是 `cap add android` 的生成物，默认没有签名配置。发布包必须用**固定 release keystore** 签名——用 `assembleDebug` 会让每台机器现场生成随机 debug keystore，覆盖安装时报「签名不一致」，只能卸载重装。keystore 只需生成一次并长期复用，丢失后无法再覆盖安装已发布的版本。

签名注入由 `apps/mobile/scripts/configure-android-signing.mjs` 在 `npm run sync` 时完成：CI 读 `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` 四个 Secret（缺任意一个直接失败，不会静默退回 debug 签名）；本地则导出对应的 `FIZZ_ANDROID_KEYSTORE`（路径）/ `FIZZ_ANDROID_KEYSTORE_PASSWORD` / `FIZZ_ANDROID_KEY_ALIAS` / `FIZZ_ANDROID_KEY_PASSWORD`。

---

## 基本使用

1. **配模型**：设置 → AI → 模型，填 provider、API Key、模型名（OpenAI 兼容网关还要填 baseURL）。
2. **建工作区**：在「开始新对话」页的工作区下拉里选择目录（Docker 部署时填容器内路径 `/workspace`）；也可以从 Git 导入、连接远端 SSH 目录、新建 worktree 或容器型项目。
3. **开聊**：直接描述要做的事，例如「帮我看看最近一次提交改了什么」「把这个函数的命名改规范」。需要动文件或跑命令时会弹确认卡片。
4. **边聊边改**：右侧面板切「文件 / 源码管理 / 终端」，改完让 AI 复核，或直接让它提交。
5. **调权限**：设置 → AI → 偏好，按信任程度在「只读 / 确认 / 完全访问」之间切。
6. **固化习惯**：把项目规矩写进 `AGENTS.md`，把常用流程写成 `SKILL.md`，把重复任务挂成定时任务。

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev:stack` / `npm run dev:web` | 本地开发（server / 前端） |
| `npm run dev:desktop` / `npm run dev:mobile` | 桌面端 / 安卓端开发 |
| `npm run build:server` / `npm run build:web` | 构建服务端 / 网页 |
| `npm run server` / `npm run restart` | 构建并启动 / 重启本地服务 |
| `npm run build:desktop` | 构建桌面端三份产物（main / preload / renderer） |
| `npm run pack:desktop` / `npm run dist:desktop` | 免安装打包 / 安装包 |
| `npm run build:mobile` / `npm run android:build` | 安卓构建与同步 / 出 APK |
| `npm run typecheck` | 全量 TypeScript 类型检查 |
| `make up` / `make down` / `make logs` | Docker 快捷命令 |

---

## 部署形态与限制

| 场景 | 说明 |
| --- | --- |
| **主 Docker 容器** | 工作区、会话、终端、主机、接口请求、笔记、后台任务都正常。镜像里没有 docker CLI，所以「容器型项目」不可用 |
| **宿主机直跑**（`npm run server`） | 全部功能可用，包括容器型项目（需要本机有 docker） |
| **桌面端** | server 跑在进程内，等于「宿主机直跑」，但数据目录独立；可通过「远程访问」把后端暴露成局域网端口给手机用 |
| **安卓端** | 只是客户端，必须连一个 server（地址登录时填） |
| **公网访问** | 需单独启用 `FIZZ_PUBLIC_HTTP_PORT`，DNS 泛解析到本机，自备反代在 443 终结 TLS 并透传 `Host` 与 WebSocket 升级 |

**鉴权是单用户模型**：只有一个密码，适合个人或小团队共用一台机器，不提供多用户与权限隔离。对外暴露时请务必配上鉴权，并在前面加一层 HTTPS 反代。

---

## 致谢

[linux.do](https://linux.do)
