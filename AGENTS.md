# AGENTS.md

Fizz 是自托管的 AI Agent 工作台：**所有能力跑在一个 Node 进程里**（HTTP + SSE + WebSocket + 网页托管 + PTY + SSH 同源，一个端口），三端（web / Electron 桌面 / Capacitor 安卓）共用 `packages/agent-kit` 的外壳层。

本文件**每轮全文进系统提示词**，只写「不知道就会写错」的约束。用法与配置细节看 `README.md`。

---

## 验证纪律

- **不要自行发起运行时验证**：起隔离 Electron 实例、CDP 截图驱动 UI、跑 `scripts/verify-*.mjs`。会拉额外进程、占调试端口、往用户数据目录造脏数据。
- 默认只做**静态自检**：`npm run typecheck`、对应端的 `vite build`、读 lint 诊断。改了 Tailwind 任意值类名就去产物 CSS 里 grep 确认生成了。
- 只有用户明确要求（「跑一下」「截图看看」）或让你排查 bug 时才做运行时验证。交付时如实说「未做运行时验证」，**别拿静态自检冒充已实测**。
- 永远不要 kill 用户正在用的 `Fizz.exe` / electron 进程，也不要占用他正在用的调试端口。

## 架构对号入座

**新增代码前先定位置，别造新路径。** `packages/*` 按能力拆分（源码直接被打包，无独立构建），`apps/*` 是各个端：

| 位置 | 职责 | 硬约束 |
| --- | --- | --- |
| `packages/contracts` | 领域类型 + HTTP/SSE 契约 | 零 Electron、零 agent 运行时依赖；根入口不导出 `resolve-model` |
| `packages/workspace` | 存储（JsonStore）、会话真源、领域逻辑 | 零 Electron、零 agent 运行时依赖 |
| `packages/agent` | `resolveModel`、agent 循环（`engine.ts`）、对话编排 | 零 Electron |
| `packages/tools` | Agent 工具集 + 项目级工具 | `project-tools` 只准挂给项目管理助手 |
| `packages/skills` `plugin` `mcp` `acp` `git` `shells` | 技能 / 插件 / MCP / 外部 agent / worktree / shell 探测 | 零 Electron |
| `packages/agent-client` | 能力层：api / host 契约 / 宿主兜底 | **零 React、零 JSX**；不得反向依赖 kit / ui / host / apps |
| `packages/agent-kit` | `src/shell`（web+desktop 外壳）+ `src/features`（业务面板） | 不得依赖 `agent-host` / `apps`；包内**没有 `@/*` 别名**，用 `@fizz/agent-kit/...` 互引 |
| `packages/ui` `ui-tokens` `i18n` | 无业务原语、设计令牌、中英文案 | `ui` 只吃 props 与令牌，不发请求、不读领域状态 |
| `apps/server` | Hono + SSE + WS，同源托管 web 产物 | 只做 Agent 能力 |
| `apps/web` `apps/desktop` `apps/mobile` | 浏览器 / Electron 壳 / 安卓壳 | desktop 经 `agent-host` 进程内直连同一 server，**没有第二条对话链路** |
| `docker/` | 随包分发的容器资产（非 workspace 包） | 容器内行为改这里，别在 `apps/server` 长第二份运行时 |

- `npm run check:boundaries` **必须保持 0 违规**。加新规则前先跑基线，否则一上线就红的检查会被习惯性忽略。
- 前端**没有路由，也没有第二块主视图**：地址栏恒为 `/`，主区域只有多标签面板。不要再引入 URL / 路由库。
- 判「这个能力有没有」看 `host.capabilities`，不要拿 `platform` 比字符串。

## 硬约束

### 协议与数据

- **上传只有 JSON+base64 一条路，禁止 multipart/FormData**：desktop 的 IPC 桥 body 只支持字符串，FormData 会被静默丢成空 body。
- **SFTP 分片必须串行**（同一文件每片 `await` 到底）：服务端无状态、校验不了顺序，并发写同一个流会**静默损坏文件**，不报错直到用户打开。
- **`.env` 是我们自己读的**（`packages/workspace/src/env.ts`），解析一律用 `dotenv`；真实环境变量优先于文件。contracts 每加一个子路径入口，`apps/server` 的 vite alias 要同步加。
- 对话走 SSE，**必须有应用层心跳**（15s），否则空闲会被掐断。
- **API key 绝不进 git**；落盘走 `SecretBox`（AES-256-GCM）。发往浏览器的视图不含明文（`hasApiKey` / `envKeys`），别为了「编辑好回填」把明文加回去。
- **插件配置只认设置页（系统配置），不读环境变量**：一个凭据两个真源时，排查「为什么发不出去 / 传不上去」永远得先问「你到底配在哪」（`FIZZ_CONTAINER_DOMAIN` 也是同一条理由移除的）。容器 / 无界面部署用的是同一个设置页。
- **远端工作区（`AgentWorkspace.remote`）**：`path` 是远端 POSIX 绝对路径，Agent 的文件 / 命令一律经 `WorkspaceBackend`（本地实现在 `packages/tools`，远端实现在 `apps/server/src/server/ssh`）；`packages/tools` **不得引入 ssh2**。会话文件、审批、历史仍留本机（`<数据目录>/conversations/remote/<id>`），不要按远端路径解析。

### 耗时任务

- **一律登记成后台任务**：`POST /api/...` 带渲染端生成的 id → `background-tasks.ts` → `POST /api/background-tasks/:id/{cancel,detach}`。desktop 的 IPC 桥**不转发 `AbortSignal`**，所以「关页面 / 断连接」既停不住进程、也和「用户点取消」区分不开——**别再把断连接当取消**（会杀掉用户跑了十分钟的活）。取消回包要等清理做完再返回。
- **必须写日志**（`run(signal, log)` 的第二个参数）：关键节点 + 外部命令原文，逐行输出用 `git({ onLine })` / `cloneRepo({ onLog })` 接。日志是「还活着吗 / 为什么失败」的唯一解释。上限 400 行 / 单行 2k、进度行原地覆盖、日志不进列表轮询、敏感串先 `maskRepoUrl`。

### Agent 与模型

- 历史消息里的工具过程**必须用原生 `tool-call` / `tool-result`**，压成文本摘要会让模型开始照抄假调用。
- `reasoning-delta` 的增量在 **`part.text`**（不是 `delta`）；不存在 `type: 'reasoning'` 这种 part。**字段名写错一律静默失效**——本项目最常见的坑。
- 落盘的工具结果挂在 `tool-call` 的 `output` 上，**没有独立 `tool-result` part**；任何读历史的地方两种形状都要认。
- `historyLimit` 在**转换前**按条数截断，不能在模型消息上 `slice`（会把 `tool` 与它的 `tool-call` 拆开）。
- 悬空 tool-call 要补占位结果、孤儿 tool-result 要丢弃。
- 后台任务的 `permissionMode` 必须是 `full`：`confirm` 档没有审批通道，会被按「拒绝」处理，任务「什么都没干也没报错」。
- **改任何字段的默认值都要 `DATA_VERSION` +1 并在 `load()` 补迁移**：老数据文件里写着的是旧默认值，`normalize*` 只补缺失字段。
- 上下文压缩只有一层（`context.ts` 的 `compactHistory`）；**不要加回 microcompact / 缓存 TTL 判断 / 按窗口比例提前压**——它们会改动请求前缀，上游前缀缓存一断就按全价重读整段历史。
- **单轮步数预算有三件配套，改一处要想到另外两处**：① 系统提示词里只放**常量**预算（`stepBudgetHint`，剩余步数绝不能进去，否则前缀缓存整段失效）；② 步骤边界往**消息尾部**注入「还剩几步」（`applyStepBudgetReminder`，按 `STEP_BUDGET_MARKER` 原地替换，不能按下标）；③ 最后一步 `toolChoice: 'none'` 钉成纯文本，别让用户只拿到一个「工具跑完没下文」的空回复。撞上限的那一轮 `finishReason` 仍是 `done`，另有 `stopReason: 'max-steps'`（挂在消息上、**不进模型上下文**），界面与通知都靠它。

### 权限与审批

- **普通工作区工具**用 `guardWrite`（每次现取权限档，`confirm` 档 + 有回调才弹卡）；**项目工具**用 `guardMutation`（只认 readonly，删项目 / worktree / 定时任务 / 插件一律弹审批）。没有确认通道时**按拒绝**处理，绝不静默放行。
- **`project-tools` 只挂给项目管理助手**，普通会话不挂：这组工具作用域在工作区之外，挂进去等于让 agent 从侧门绕开 `resolveInside`。
- **权限档能在一轮中途改，必须现取**（`getPermissionMode?: () => AiPermissionMode`），别当静态值闭包捕获。系统提示词是快照——闸是权威，提示词只是引导。
- **「始终允许」的键是命令原文，不是工具名**（按工具名记 = 点一次放行该工具的一切调用）；落盘 `approvedCommands`，每次审批前现读盘。「始终拒绝」只记内存。
- 一批审批走 **`ConfirmQueue`**（一屏一项 + 批量答复），不能一条一张卡地摞——会把输入框顶出屏幕。
- 同一终端上的客户端工具调用必须串行（`SERIALIZED_TOOLS` + `serializeOn`）：模型一批 tool-call 是并行下发的。

### 前端

- 组件库统一 **shadcn/ui + `cn()`**、lucide 图标、`sonner` 通知。**禁止原生 `window.confirm` / `alert`**。新原语写进 `packages/ui/src`（手工抄 shadcn 源，不走 `shadcn add`）。
- **灰色只有一档**：次要文字一律 `text-muted-foreground`，不要再叠 `/70` 这类半透明（对比度会掉到 3:1 以下、整屏发虚）。行内主标题用 `text-foreground`。
- **`app` 对象每次渲染都是新的，绝不写进 `useEffect` 依赖数组**：流式期间每来一个 token 就重渲染，effect 每帧重跑（曾把接口刷屏）。`useCallback` / `useMemo` 依赖里放 `app` 是对的，别一起改。
- 可拖拽宽度有现成三份实现，**别起第四份**：宽度与开合同作用域用 `panel-width.ts`，全局一份用 `files-pane-width.ts` / `terminal-assistant-width.ts`；一律复用 `ResizeHandle.tsx`。
- 表单弹窗一律 `sm:max-w-md`，别为摊两列而加宽；手机（<640px）表单行上下排。
- 开外链只有一条路：`openExternal`（`@fizz/agent-client`），**别裸调 `window.open`**；协议白名单只在 `agent-host/src/external-link.ts` 一份。
- **`IconTip` 不能直接套自带 `data-state` 的 Radix 原语**（`Switch` / `Checkbox` / `Toggle`）：`TooltipTrigger asChild` 会注 `data-state="closed"`，而这些原语把外部 props 排在自带 `data-state` 之后 → `checked` 被盖掉、`data-checked:` 规则全失效，控件整个透明只剩 tooltip（2026-11-01 定时任务那颗启停开关就是这么「消失」的）。包一层 `<span className="inline-flex">` 再套。
- 往终端写多行输入，行分隔符必须是裸回车 `\r`（用 `toTerminalInput()`）：PowerShell 的 LF 会把行插到上方，顺序整个反过来。
- 主题必须在首帧前定好（preload + `index.html` 内联脚本），**回落规则在 6 处，改一处必须六处同步**。
- 文案**中文为源**，英文缺失自动回落，新增文案两边都补。

### 测试

- **只用 vitest**（根 `devDependencies` 里的 `vitest`），不要引入 jest / mocha。命令：`npx vitest run`（**没有** npm script）；单文件 `npx vitest run packages/agent/src/estimate-tokens.test.ts`；watch 直接 `npx vitest`。若某次 `npx` 试图拉别的版本（会改 `package.json` / lock），改用 `./node_modules/.bin/vitest run`。
- **位置与命名**：与被测模块**同目录**的 `xxx.test.ts`（`src/foo.ts` → `src/foo.test.ts`）。不建 `__tests__/`，也不在根上另起 `tests/`。
- **显式导入**：`import { describe, expect, it, vi } from 'vitest'` —— 仓库**没开 globals**，不导入直接写 `describe(...)` 会 `ReferenceError`。断言用 `it`，不用 `test`。
- **只有 node 环境**：没有 `vitest.config`、没有 jsdom / @testing-library。要测的 UI 逻辑**先抽成纯函数再测**（`useColorTheme.test.ts` 测的是 `clampThemeNumber` / `buildStyle`，不渲染 hook）。真要 DOM 环境得先加依赖与 setup 并说清代价，**别偷偷塞 `@vitest-environment jsdom`**。
- **测试文件进 typecheck**：各包 tsconfig 的 `include` 是 `src/**/*`，测试里的类型错误会让 `npm run typecheck` 直接红。
- **mock 口径**：`vi.mock('./x', () => ({...}))`；只替一部分时 `vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), streamText: vi.fn() }))`；有状态的假实现（假 SSE 流 / 假 fetch）在 `beforeEach` 里重建，别跨用例复用。
- **边界**：不起服务器、不连真实网关、不 spawn 真实进程、不写用户目录 —— 一律 mock。
- **修 bug 先写用例**：先落一条能复现的（红），再修到绿，最后 `npx vitest run` 全量跑一遍。文件头注释写清「这条测试在防什么回归」，与本仓其它文档同一风格。

### 打包与发版

- **版本号只有 `apps/desktop/package.json` 那一份算数**（`app.getVersion()`、`latest.yml`、产物名同源于它）；根 `package.json` 的 version 不参与打包。升版本用 `npm run version:set -- v0.1.3` 一次改齐，**别手改一处漏一处**（`apps/server/src/app.ts` 的 `VERSION` 是第三处硬编码）。
- **tag 名不参与版本比较**：改 tag 不改 version = 用户永远收不到更新。
- 打包脚本一律带 `--publish never`（发布只由 Action 做）；产物落在 **`apps/desktop/release/`**（`directories.output` 相对 project 目录）；Release 的 `files` 里**必须含 `latest*.yml`**，漏了表现为「永远收不到更新」。
- **静默只检查，下载与安装都必须用户点**（`autoDownload = false`）。装之前必须先置 `quitting`，否则「关闭收起到托盘」会把安装拦住。
- 两个渲染端 vite 的 `emptyOutDir: false` 不能改（会撞 IDE 批量删除保护、丢掉拷来的 monaco-editor）；过期 assets 靠 `cleanStaleAssets` 只删 `assets/`。
- vite 的包子路径 alias **不能写 `@fizz/x/*` 通配**（带斜杠的 find 永不命中），用 `moduleAliases()` 扫目录逐条展开；`outDir` 一律 `resolve(import.meta.dirname, ...)`。

## 常用命令

```bash
npm run dev:stack      # 构建 server + web 并启动（7801）
npm run dev:web        # 另开终端：vite（5173，/api 已代理到 7801，不需要 CORS）
npm run build:server   # 只构建服务端
npm run build:web      # 只构建网页（改完前端要重跑，server 同源托管 dist）
npm run typecheck      # 全量类型检查（提交前必跑）
npm run check:boundaries  # 包边界 + 会话作用域检查，必须 0 违规
npm run check:scope    # 只跑会话作用域检查（store 里不许「读焦点当默认目标」）
npx vitest run         # 单测全量（无独立 npm script；单文件在后面接路径）
```

## 环境速查

- Windows ConPTY 下 `pty.spawn()` 返回的 `pid` **恒为 0**，判存活以 `onExit` 为准。
- npm 12 会拦 postinstall：新装原生依赖后 `npm install-scripts approve <包> && npm rebuild`。
- Git Bash 下 `taskkill //F //IM x.exe`（双斜杠）或加 `MSYS_NO_PATHCONV=1`；PowerShell 里用**单**斜杠。
- **构建编排是自建三配置 vite，不要引入 electron-vite**（用户明确不信任）。preload 输出 `.cjs`（沙箱只支持 CJS）。
- npm workspace 包参与主进程打包时，`rollupOptions.external` 要显式放行 `!id.startsWith('@fizz')`（external 判定先于 alias 解析）。
