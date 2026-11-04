---
name: create-fizz-plugin
description: Create/modify Fizz plugins in .fizz/plugins using ctx.tools, ctx.prompt, ctx.hooks, ctx.ui. Use when asked to 创建/修改 Fizz 插件 or add a plugin tool. Do not use for third-party skill installs.
---

# 创建 Fizz 插件

Fizz 插件 = 磁盘上的一个**目录**：目录里必须有 `plugin.json`（身份描述），入口文件由它指定。`@fizz/plugin`（Cordis 风格精简版）在**每一轮对话开始时**把插件挂到一个 turn context 上。插件通过 `ctx` 提供的服务给 Agent **加 / 覆盖工具、往系统提示词里插话、拦截工具调用、声明设置项**。

本 skill 讲「怎么在本仓库里写出一个能跑起来的插件」。动手前先读完下面的位置与生效规则。

## 1. 放哪、怎么生效

| 位置 | 说明 |
| --- | --- |
| `<仓库根>/plugins/<id>/`（随包分发，**要提交进 git**） | **内置**插件，随产品走、所有项目都会扫到（如 `plugins/oss/`）。目录标记见同级的 `builtin-plugins.json`。⚠️ 只放「对所有使用者都成立」的能力 —— 需要个人账号 / 配额 / 私有服务的第三方集成放**用户级**（如 `~/.fizz/plugins/storage-to/`） |
| `<项目>/.fizz/plugins/<id>/` | **项目级**插件，只在那个项目里生效 |
| `~/.fizz/plugins/<id>/`（Windows 为 `%USERPROFILE%\.fizz\plugins`） | **用户级**插件，所有项目都会扫到 |

- **只认目录 + `plugin.json`**：根目录里的散装 `.ts` / `.js` 一律忽略（单文件插件不再支持）。扫描会跳过 `.` 开头的目录。
- 最小结构：

  ```text
  my-plugin/
    plugin.json
    index.ts
  ```

  `plugin.json` 的 `id` / `name` / `version` / `apiVersion` / `entry` **必填**，可选 `description` / `author`；未知字段会被拒绝。`id` 只能 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，`apiVersion` 目前只认 `1`，`entry` 是目录内的相对路径（`.ts` / `.js`，不能是绝对路径、不能带 `..`）。
- 默认**全部启用**。启停**按位置分两个面管，互不牵动**：
  - **内置 + 用户级**：**全局开关**，在 **设置 →「插件」** 里勾选（服务端存全局一份，`GET/POST /api/plugins?scope=global`）。这两类对所有项目生效，所以**没有**「按项目单独停用」这回事。
  - **项目级**（`<项目>/.fizz/plugins`）：在**侧栏项目「更多」→「插件」**弹窗里勾选（服务端按 workspaceId 存，见 `apps/server/src/api/plugins/route.ts`）。
- 内置根**不在库层探测**：`standardPluginRoots` 只收 `builtinDir` 参数，由宿主决定（服务端见 `apps/server/src/server/plugin-roots.ts`；路径探测在 `builtin-dirs.ts`：环境变量 `FIZZ_BUILTIN_PLUGINS_DIR` → 打包态的 `resourcesPath` → 从 cwd 往上找，后两条要求 `builtin-plugins.json` 标记）。
- 挂载发生在每轮对话开始：**新增**一个插件目录，下一轮即可见。
- **改已有插件支持热重载**：加载器按**整个目录**的源码指纹（递归相对路径 + mtime + size）判断有没有变（`packages/plugin/src/loader.ts` 的 `pluginSourceSignature` / `moduleCache`），变了就重新 import —— 存盘后**下一轮对话**即是新代码，不用重启服务端。
  - 新一轮生效的进度：正在跑的那一轮不受影响（每轮重建 turn context 并重新加载）。
  - 插件 import 的**相对依赖文件**（同目录里的 helper）改动也能读到新内容。
  - 走「安装 / 卸载」接口时服务端会**主动作废**缓存（`invalidatePluginModule`）。

### 安装与卸载（面板里就能做）

插件面板（设置 →「插件」/ 项目「更多」→「插件」）上有两个按钮：

| 操作 | 行为 |
| --- | --- |
| **安装插件** | 选一个本地**插件目录**（里面要有 `plugin.json`）→ 服务端把目录内所有文件写进**对应作用域的插件根**（全局 → `~/.fizz/plugins`，项目 → `<项目>/.fizz/plugins`），安装目录名取 manifest 的 `id`。客户端只给相对路径，**不接受绝对路径 / `..`** |
| **卸载**（卡片上的垃圾桶） | 把插件**整个目录**删掉（两步确认），并清掉它残留的**设置值**与**启停名单**里的记录 |

几条规矩（服务端 `api/plugins/install` / `uninstall` 里写死的）：

- **协议是 JSON + base64**：desktop 的 IPC 桥 body 只支持字符串，multipart 过不去。
- **id 重名 → 409**：不悄悄覆盖别人的插件，也不许顶掉内置插件（要更新就先卸载再装）。
- **装完立刻体检**：`plugin.json` 校验 + apply 一遍，跑不起来 → **删掉刚写的目录并报错**，不留一个每次扫盘都报错的坏目录。
- **内置插件不能卸载**：它随产品分发（进 git、打包后可能只读），只能用开关停用。
- 装 / 卸之后**立刻生效**：模块缓存与上传源的长驻 context 当场作废，响应就是重扫后的完整清单 —— 前端直接覆盖，不必再拉一次。

## 2. 最小插件

```ts
export default function myPlugin(ctx) {
  // 往系统提示词里插一段（priority 越大越靠后；空文本段会被跳过）
  ctx.prompt.section('my-hint', '回答前先读 AGENTS.md。', { priority: 10 })
}
```

三种导出形态都被接受（`packages/plugin/src/types.ts`）：

- **函数**：`export default (ctx, config) => { ... }`
- **类**：`export default class { constructor(ctx, config) {...} dispose() {...} }`
- **对象**：`export default { name, inject: ['tools'], apply(ctx, config) {...} }`

`apply` 的返回值（若有）是**卸载时要跑的清理函数**；也可以在里面用 `ctx.effect(fn)` 登记。

## 3. 七个服务（插件能力的唯一入口）

| 服务 | 干什么 | 关键方法 |
| --- | --- | --- |
| `ctx.tools` | 加 / 覆盖 Agent 工具 | `register(name, tool, opts)`、`registerAll(tools, opts)`、`conflicts()` |
| `ctx.prompt` | 往系统提示词插段 | `section(id, text, { priority, source })`、`remove(id)` |
| `ctx.hooks` | 拦截 / 通知 Agent 行为 | `on(hookName, listener)` |
| `ctx.ui` | 声明设置项 / 面板（面板目前只读展示） | `setting(item)`、`panel(item)` |
| `ctx.uploads` | 注册**上传源**（附件换个地方存） | `register(spec)`、`list()` |
| `ctx.models` | 往**设置 →「模型」**里注册只读模型配置（网关 + 模型清单 + 每模型配置） | `register(config)`、`list()` |
| `ctx.workspace` | 这一轮绑定的**工作区根**：把模型给的相对路径解析成绝对路径 | `path`、`label`、`resolve(p)`、`contains(p)` |

⚠️ `ctx.workspace` **只有绑定了目录的回合**才有（未绑定目录的会话、设置页那次 inspect 都没有）。所以别把它写进顶层 `inject` —— 那会让插件在 inspect 里被整体推迟，连设置表单都不出现。要它就用 `ctx.inject(['tools', 'workspace'], …)` 单独注册那一半（见 3.4 末尾）。

另外：`ctx.events`（`fiber-local` 的 `on` / `emit`，父层看不见）、`ctx.logger`（`info` / `warn` / `error` / `extend`）、`ctx.get(name)`（读任意已提供的服务）。

### 3.1 注册工具（`ctx.tools`）

工具对象按 AI SDK 的形状写：`{ description, inputSchema, execute }`。

```ts
import { z } from 'zod'
import { tool } from 'ai'

export default function (ctx) {
  ctx.tools.register(
    'word_count',
    tool({
      description: '数一段文本的字符数',
      inputSchema: z.object({ text: z.string().describe('要数的文本') }),
      execute: async ({ text }) => `${text.length} 字`
    }),
    { source: 'word-count', mutating: false }
  )
}
```

`register` 的 opts：`priority`（缺省 0）、`origin`（`'plugin'` | `'builtin'`）、`source`（冲突报错里显示的名字）、`mutating`（是否改东西，审批闸门据此决定要不要确认）。

**覆盖规则（信任模型，见 `packages/plugin/src/services/tools.ts`）**：同名工具 **priority 最高者胜出**；最高 priority **并列时加载期直接抛错**。内置工具以 priority 0 注册，所以插件想覆盖内置工具必须**显式把 priority 调到 > 0**，否则整轮装配就炸。

工具返回值一般是字符串（模型直接读）；出错就 `throw`，会变成一次 tool error（仓库价值观：不许静默失败）。

**工具对象必须是 AI SDK 的形状 —— 少了 `execute` 会被当场拒绝**（真实踩过的坑）：

| 你写的 | 结果 |
| --- | --- |
| `{ description, execute }` | ✅ **无参工具就这样写**（省略 `inputSchema`，SDK 会补一个空对象 schema） |
| `{ description, inputSchema: z.object({...}), execute }` | ✅ 需要能 `import { z } from 'zod'`（见第 4 节） |
| `{ description, inputSchema: jsonSchema({...}), execute }` | ✅ 需要能 `import { jsonSchema } from 'ai'` |
| `{ description, inputSchema: { type: 'object', ... }, execute }` | ❌ 裸 JSON Schema 会被 SDK 当函数调用 → 发请求时 `TypeError: schema is not a function` |
| `{ description, handler }` / 任何**没有 `execute`** 的对象 | ❌❌ **最坑**：`ctx.tools.register()` **装配期直接抛错**（报错点明工具名与 `execute`），错误显示在「项目插件」弹窗顶部 —— 这个插件本轮不生效，但**不会拖垮会话**。为什么非得是 `execute`：以前这种形状能混进工具表，AI SDK 把它当「客户端工具」——不执行、不产出 tool-result，那一轮在 tool-call 之后就结束，前端**永远显示「执行中」**。`handler` 是别家的叫法，这里必须叫 `execute` |

`inputSchema` 的这几种边界都不是猜的：`scripts/verify-plugin-tool-shape.mjs` 直接问 AI SDK 的 `asSchema` 钉死了它们。

**工具会不会改动东西，要如实申报**：`ctx.tools.register(name, tool, { source, mutating })` 里的 `mutating: true` 表示「它会写盘 / 执行命令 / 改远端 / 把数据发出去」。宿主据此在装配期套审批闸门（`packages/agent/src/plugins.ts` 的 `wrapToolsWithApproval`）：

| 会话权限 | `mutating: true` | `mutating: false`（缺省） |
| --- | --- | --- |
| 只读模式 | 直接拒绝（不执行、也不弹确认） | 照常执行 |
| 确认模式 | **先问用户**，同意才执行 | 照常执行 |
| 完全访问 | 照常执行 | 照常执行 |

三个要点：确认模式下**没有确认通道**（无界面 / 未接审批）时**失败关闭**（拒绝执行）—— 插件工具是第三方代码，静默放行等于把用户选的确认模式降级；拒绝时返回的是一句**说明**（不是抛错），模型能看到原因并向用户解释；确认对话框里显示的是 `工具名(入参)（来自插件 xxx）`，且看到的是 `tool:call` 钩子**改写之后**的入参。内置工具与 MCP 工具不走这道闸（前者自己管自己的，后者不带 `mutating`）。验收：`node scripts/verify-plugin-tool-approval.mjs`。

### 3.2 拦截钩子（`ctx.hooks`）

钩子名固定在 `HOOKS`（`packages/plugin/src/hooks.ts`）：

| 钩子 | 形态 | 监听器签名 |
| --- | --- | --- |
| `'tool:call'` | waterfall | `(toolName, input, next) => unknown` |
| `'tool:result'` | waterfall | `(toolName, output, next) => unknown` |
| `'prompt:render'` | waterfall | `(text, next) => unknown` |
| `'turn:start'` / `'turn:finish'` | emit | `(payload) => void` |

waterfall（拦截改写）用 **around 范式**：先 `next()` 放行拿到下游结果，再加工返回；不调 `next()` 直接返回 = 中断链路。

```ts
export default function (ctx) {
  ctx.hooks.on('tool:call', (name, input, next) => {
    if (name === 'execute_command') console.log('要跑命令了', input)
    return next() // around：放行后再返回；不调 next() 就直接返回自己的值 = 中断
  })
}
```

⚠️ `next(新值)` **不会**把新值传给链上的下一个监听器（框架恒以原始 args 调用下一个）。想串联改写一律用 around 范式，别想「按入参把新值往后推」。

### 3.3 声明设置项与面板（`ctx.ui`）

只做**声明**、不做渲染：登记 schema，前端（设置 →「插件」/ 项目「更多 → 插件」）读同一份结构
自行渲染。**设置项是可编辑的表单**，值由服务端存；面板（`panel`）目前仍只是只读展示。

```ts
export default {
  inject: ['uploads'],
  apply(ctx, config) {
    ctx.ui.setting({ id: 'strict', title: '严格模式', type: 'boolean', default: false })
    ctx.ui.setting({ id: 'level', title: '档位', type: 'select', options: [{ label: '低', value: 'low' }] })
    ctx.ui.setting({ id: 'token', title: 'API 令牌', type: 'string', secret: true }) // ← 密钥项
    ctx.ui.panel({ id: 'stats', title: '统计面板' })
    // 读值：约定「设置项 id 就是 config 里的键名」
    const token = typeof config?.token === 'string' ? config.token : process.env.MY_TOKEN
  }
}
```

| 要点 | 说明 |
| --- | --- |
| **id = config 键名** | 设置值在挂载前合进 `config`（`plugins.yml` 的 config < 设置页里存的值），插件用 `config.<id>` 读；环境变量留在插件自己手里兜底（容器 / 无界面部署） |
| **`secret: true`** | 值落盘经 `SecretBox` 加密、**明文不回传浏览器**（GET 只给 `hasValue`，同模型配置的 `hasApiKey`）；界面留空 = 保持原值，清空要点「清除」。**密钥进 git 是红线**，所以别写进插件源码 |
| **类型与校验** | `boolean` / `string` / `number` / `select`（要给 `options`）；保存时服务端只收**你声明过的**键、按声明收敛类型 —— `id` 缺省、`type` 不认识、`select` 没候选都会在 apply 时**当场抛错**（红字显示在插件列表顶部） |
| **生效时机** | 保存后**立刻生效**：挂载缓存按「插件目录源码 + 设置值」判指纹，值一变就重新挂载（不必重启服务端） |
| **默认值** | `default` 只是**界面上的初值**，不会自动进 `config` —— 插件要自己处理「没配过」的情况 |
| **图标** | `ctx.ui.icon('data:image/png;base64,…')` 声明插件列表里的图标。**只收 `data:image/*` 的 data URI**（不收远程 URL：渲染端可能跑在 `file://` 下、离线不可用、还会暴露你在看哪些插件；也不收裸 SVG 源码：本仓库规矩是 SVG 一律经 `<img>` 渲染，绝不注入 DOM），上限 96KB。列表里按 **24px** 渲染：**优先给矢量 SVG**（`data:image/svg+xml,` + URL 编码，几百字节、任何尺寸都清晰、可 diff）；给位图就按 96×96 以上准备，**别拿 favicon 那种细节图凑**（缩到 24px 会糊成一团）。非正方形（横版 logo）也能用，前端 `object-contain` 不拉伸 |

收集这些声明时宿主会把插件 `apply` 一遍（见 `inspectPluginUi`），所以声明了**自定义服务名**的 `inject` 会因依赖不齐被推迟、声明收集不到。

### 3.4 注册上传源（`ctx.uploads`）

换掉「附件存哪儿」：注册之后，输入框回形针菜单里就能选它，字节由你的 `put` 落到自己的存储（图床 / S3 / 对象存储 / 内网服务），**交给输入框的始终只是一条 URL**。

```ts
export default {
  name: 'my-cdn',
  inject: ['uploads'],
  apply(ctx) {
    ctx.uploads.register({
      id: 'my-cdn',                       // 唯一 id（进上传请求与附件引用，定了别改）
      title: '我的图床',                   // 选择器里的名字
      urlPrefixes: ['https://cdn.example.com/fizz'],  // ← 必须声明，见下
      accept: { mime: ['image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024 },
      async put({ name, mediaType, bytes }) {
        const url = await uploadToMyCdn(bytes, mediaType, name)  // 你自己的实现
        return { url }
      }
    })
  }
}
```

**`urlPrefixes` 是硬要求，不是装饰**：服务端 `put` 返回后会立刻校验这条 URL 是否落在声明范围内，不在就**整条丢弃并报错**（fail-closed）。原因是附件 URL **直传**给模型（`ImagePart` / `FilePart` 里就是这条地址，服务端不下载、不校验），插件若返回任意地址，等于让模型去取那个地址。必须 https（`http://localhost` 例外），可带路径前缀。

每条成功签发的 URL 会记进服务端的「已签发」表（落盘）：**没走过一次真实上传的 URL 一律进不了历史**（手编一条会 400），服务端重启后老附件仍然有效。

生效时机与别的服务**不同**：上传发生在「还没有回合」的时候，所以 `ctx.uploads` 挂在**长驻 context**（每个项目一份）上，不是 turn context；插件目录改了**下一次上传**即新代码 —— 前端在上传源清单里看，而清单会**在打开回形针菜单时重拉**（不必等下一轮对话，也不必切项目）。缺省的上传源是内置存储（`local`，落数据目录 + `/api/uploads/<uuid>.<ext>`），不注册也能用。设置 →「插件」里能看到每个插件提供了哪些上传源。

**想同时提供「上传源」与「工具」时**（内置的 `plugins/oss/index.ts` 就是这个形态）：两半挂在**不同的 context** 上 —— 工具在每轮对话的 turn context（有 `tools` / `workspace`），上传源在长驻的 upload context（有 `uploads` / `ui`，**没有 `workspace`**）。所以顶层 `inject` 留空（任何 context 都 apply，设置项声明才在设置页那次 inspect 里收得到），两半各自声明：

```ts
export default {
  name: 'oss',
  inject: [],                       // ← 留空：别把 uploads / workspace / ui 写进顶层
  apply(ctx, config) {
    ctx.inject(['ui'], (c) => { /* 声明设置项、图标 */ })
    ctx.inject(['uploads'], (c) => { /* 注册上传源 */ })
    ctx.inject(['tools', 'workspace'], (c) => { /* 注册工具 */ })
  }
}
```

写成 `inject: ['uploads', 'tools']` 会**两边都不生效**：turn context 缺 `uploads`、upload context 缺 `workspace`，两处都被推迟，插件看起来「装了但什么都没发生」。

凭据**别写进插件源码**：优先声明成 `secret: true` 的设置项（用户在设置页里填，落盘加密、不回传浏览器），
`process.env` 作为兜底（容器 / 无界面部署）。内置插件目录（`<仓库根>/plugins`）**本身就是要提交进 git 的**，
项目 / 用户级目录也可能被提交 —— 把 token 写死进去等于把它推上 git。
可参考现成例子：
- `<仓库根>/plugins/oss/index.ts`（内置插件，S3 兼容对象存储：**既注册上传源、又注册工具**，
  两个开关各管一半，手写 AWS SigV4 签名）；
- `<仓库根>/plugins/api-upload/index.ts`（内置插件，**只要上传源、不要工具** —— 打一个
  `X-API-Key` 的自建文件上传服务，文档见仓库根 `API_UPLOAD.md`）；
- `~/.fizz/plugins/storage-to/index.ts`（**用户级**插件的完整例子：走官方三步流程上传到
  storage.to，API 令牌是一个 `secret: true` 的设置项，图标自绘成几百字节的 SVG）。

上传源还有一条容易漏的规矩：`urlPrefixes` 声明的域名必须**真的覆盖** `put` 返回的地址
—— 两者不一致是常态（上传接口一个域名、文件对外访问另一个静态域名）。所以要么像
`api-upload.ts` 那样把它做成一项设置并在上传后**当场比对**、要么像 `oss.ts` 那样让
用户填 `publicBaseUrl`。宿主会 fail-closed 校验这条，不匹配就抛错，且不带原因。

### 3.5 注册模型配置（`ctx.models`）

插件可以往**设置 →「模型」**里加一份或多份**只读**模型配置 —— 和用户手建的完全同构：
网关（kind / baseURL / apiKey）+ 模型清单 + 每个模型自己的上下文窗口与进阶设置。

```ts
export default {
  name: 'my-gateway',
  apply(ctx, config) {
    ctx.ui.setting({ id: 'token', title: '网关令牌', type: 'string', secret: true })
    const token = typeof config?.token === 'string' ? config.token : process.env.MY_TOKEN
    if (!token) return

    ctx.models.register({
      id: 'gateway',                       // 插件内唯一；宿主会拼成 plugin:<插件路径>:gateway
      name: '我的网关',
      kind: 'openai-compatible',
      baseURL: 'https://gateway.example.com/v1',
      apiKey: token,                       // 明文只进宿主内存；列表视图只给 hasApiKey
      models: [
        { id: 'fast', contextWindow: 128_000 },
        { id: 'smart', contextWindow: 200_000, settings: { imageInput: false, maxOutputTokens: 8_000 } }
      ],
      // temperature / maxTokens / contextMessages / apiStyle 也都能给
    })
  }
}
```

要点：

1. **只读、不落盘**：真源是插件。设置页里这份配置标「插件」并隐藏编辑 / 删除 / 增删模型；
   要改就改插件源码或它的设置项。插件停用 / 卸载后配置从列表消失，正在用它的会话会收到
   「配置不存在」的明确报错。
2. **只收集全局插件**（内置 `plugins/` 与 `~/.fizz/plugins`）—— 模型列表是全局的；
   项目级插件里注册的模型**不会**出现在设置页（避免「A 项目有、B 项目没有」的隐形状态）。
3. **id 自动加前缀**：`plugin:<插件 manifest id>:<你给的 id>`，两个插件都用 `local` 也不会撞。
   会话里存的是拼好的 id；卸载插件后旧绑定会悬空（报错让用户重选）。
4. **apiKey 走插件的设置项**（`secret: true`），不要写死在源码里；环境变量只作无界面部署兜底。
5. **注册时机**：服务端启动、每轮对话 / 定时任务 / 助手回合前、保存插件设置 / 安装卸载后都会
   按「插件目录源码 + 设置值」指纹重建；改完插件下一轮对话就生效。

### 3.6 注册界面（`ctx.ui.icon` / `view`）

插件在界面上只有两样东西：

| 东西 | 落在哪 | 说明 |
| --- | --- | --- |
| `plugin.json` 的 `icon`（或 `apply()` 里 `ctx.ui.icon(dataUri)`） | **「插件」侧栏**里这一行的图标 | 清单里的 `icon` 优先，没写才用 `ctx.ui.icon(...)`；都没有就画一个占位 |
| `ctx.ui.view({ id, title, render, onAction? })` / 清单里的 `client.surfaces` | 主视图区的**标签页** | 点插件时打开 `order` 最小的那一面 |

**插件不占图标栏、也没有自己的侧栏。** 图标栏里只有一颗「插件」：侧栏是**插件列表**（一个插件一行），点一行就在主区域开它的标签页。这样加插件不会把图标栏挤满，用户也不用先记住「哪颗图标是哪个插件」。

```ts
export default {
  name: 'Redis 管理',
  inject: ['ui'],
  apply(ctx) {
    // 列表行那个图标（也可以写在 plugin.json 的 icon 里，静态声明更省事）
    ctx.ui.icon(ICON)
    ctx.ui.view({
      id: 'keys',
      title: 'Key 列表',
      order: 0,
      render: () => [{ kind: 'list', items: keys.map((k) => ({ id: k, label: k, actionId: 'open', args: { key: k } })) }]
    })
  }
}
```

> **早先的 `ctx.ui.activityBar(...)` 与 `ctx.ui.sider(...)` 仍然能调用**（老插件不会崩），但界面上已经没有它们的位置：既不占图标栏，也不出现在侧栏。老插件的 sider 面会作为**标签页**出现在插件列表里 —— 迁移只要把内容改成 `ctx.ui.view`，或者直接改写前端半（见 3.7）。新插件不要再用这两个。

五条要点：

1. **`render` 跑在服务端**：每次前端请求 / 点刷新都跑一次，返回 `UiBlock[]`（**内容不缓存**，所以状态类的界面天然是实时的）。插件的 `config` / 凭据都在闭包里，直接用。
2. **块只有七种**：`text`、`kv`（键值表）、`list`（可点列表）、`buttons`（一排按钮）、`note`（提示条）、`input`（单个输入框 + 提交，`id` 就是参数名，值以 `args[<id>]` 提交）、`form`（**多字段表单** + 一个提交，一次把所有字段的值交回去）。都能带 `tone: 'normal' | 'muted' | 'success' | 'warn' | 'danger'` 改颜色。表单字段可带 `secret: true`（遮住）、`multiline: true`（渲染成 textarea，编辑一整段文本 / JSON 时用）。**列表项可带 `actions`**：行尾的图标按钮（`{ actionId, icon, label, danger? }`），平时藏起来、鼠标移到这一行才浮现 —— 与会话列表的行同一套交互；图标**按名字给**（`pencil` / `trash` / `copy` / `plug`… 这组白名单），插件给数据、宿主映射成组件。插件产出的是**不可信输入**：服务端只留认识的 `kind`、字段一律收敛成字符串、数量封顶 —— 写坏了也只是一块内容缺席。
3. **动作**：列表项 / 按钮 / 输入框 / 表单带 `actionId` → 服务端调 `onAction({ actionId, args, params })`。列表项要带 `args`（如 `args: { key }`）才分得出「点了哪一条」。返回什么决定接下来发生什么：

   | 返回 | 效果 |
   | --- | --- |
   | 一串块 | **整面替换**（省一次往返） |
   | `{ message }` | 弹一句提示，前端再拉一遍 |
   | `{ openView: { surfaceId, params?, label?, title? } }` | **请求宿主在主视图开一个标签页** |
   | `{ openDialog: { title, fields, actionId, description?, submitLabel? } }` | **请求宿主弹一个对话框**（shadcn Dialog，提交回同一个面的 `onAction`） |
   | 处理途中调 `toast(message, kind?)`（`onAction` 的参数之一） / 返回 `toasts` | 宿主用 **sonner** 弹（success / error / info / warning；封顶 5 条）。`message` 字段就是 `toast(message, 'success')` 的糖 |
   | 什么都不返回 | 前端自己重新拉一遍 |

   ⚠️ `openView` / `openDialog` 是**请求**不是命令：块里没有「开标签 / 弹窗」这种语义，那是宿主的能力，插件只能请求。事务性的破坏操作仍然**要两步**（没有「确认弹框」这一种形态）：第一次点击只切到确认态（一条 `note` + 确认 / 取消两个按钮），真的执行放在确认那一步 —— 见 `~/.fizz/plugins/redis/index.ts` 的删 key。
4. **面的参数（`params`）= 一个面开出多屏**：`render(ctx)` 的 `ctx.params` 与 `onAction` 的 `params` 是**打开这一屏时带的参数**（如「哪个连接」）。宿主只负责原样带回，插件自己区分实例 —— 于是「每个连接一个管理页」就是**同一个 view 面 + 不同参数**，写一遍代码开 N 个标签。列表里点一条时：

   ```ts
   if (actionId === 'openTab') {
     return { openView: { surfaceId: 'panel', params: { conn }, label: name, title: `${name} · Redis 管理` } }
   }
   ```

5. **失败不炸**：`render` / `onAction` 抛错 → 那一面显示一条错误提示（插件报的那句往往正是用户要看到的：「连不上 Redis」）。

#### 图标：用官方 logo，不加衬底

插件图标（`plugin.json` 的 `icon` / `ctx.ui.icon(...)`）只收 **`data:image/*` 的 data URI**（不收远程 URL、也不收裸 SVG 源码 —— 后者等于给插件一个往界面注入标记的口子），上限 64KB。

- **优先写在 `plugin.json` 里**：静态声明，插件不必先跑起来列表就能画对；`plugin.json` 没写才用 `apply()` 里的 `ctx.ui.icon(...)`。
- **直接用该项目的官方 logo**（Simple Icons 之类），**不要自己画一个带深色圆角底的方块**：列表里是 16px 展示，衬底会吃掉大半面积，剩下的只是一小块色块，图形本身反而看不清。
- 矢量 SVG 最佳：`data:image/svg+xml,` + `encodeURIComponent(svg源码)`，几百字符、任意尺寸都清楚。
- 没有图标的插件由宿主画一个同尺寸的占位图标，所以各行文字左边界是齐的。

**停用的插件不会出现在插件列表里**（与上传源同一取舍）。改完插件目录 / 设置，下一次请求就是新代码（挂载是每次现挂一次的，见 `apps/server/src/server/plugin-ui.ts`）。

### 3.7 自带前端半（`client`）与 npm 依赖（`dependencies`）

服务端 `render()` 吐 `UiBlock[]` 是默认路线；要拖拽画布、富交互这类块表达不了的界面，就写**前端半**。两者可以共存：服务端半继续提供工具 / 钩子 / `ctx.rpc` 处理器。

**先读仓库里的 `plugins/redis/`**：`plugin.json`（清单）+ `index.ts`（服务端半，只有 rpc）+ `client.jsx`（前端半源码）+ `client.js`（构建产物），是双面包的参考实现。

```json
{
  "id": "redis",
  "name": "Redis 管理",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.ts",
  "icon": "data:image/svg+xml,...",
  "client": {
    "entry": "client.js",
    "surfaces": [
      { "kind": "view", "id": "connections", "title": "连接", "order": 0 },
      { "kind": "view", "id": "keys", "title": "Redis Keys", "order": 10 }
    ]
  },
  "dependencies": { "ioredis": "^5.4.1" }
}
```

`surfaces` 里**只能写 `view`**：插件不占图标栏、也没有自己的侧栏。点插件时打开 `order` 最小的那一面，其余面由插件自己用 `openView` 开出来。

十一条要点：

1. **`client.entry` 是已经构建好的单文件 JS**。浏览器跑不了 TS/TSX，宿主也不做运行时转译（等于把编译器塞进服务端）。仓库里现成一条路：把源码写成 `client.jsx`（或 `.js`），跑 `npm run build:plugins`（`scripts/build-plugin-client.mjs`，用仓库自带的 `typescript` 做 `--jsx react` 经典转换 → 产物里全是 `React.createElement`），产出 `client.js`。产物里**出现任何 `import` / `export` 都会直接报错退出**（进不了 `new Function`）；要 React 就从 `host` 取，别打包一份进去。**可直接抄 `assets/client-bundle-template.js`**：契约、`ctx.rpc`、`injectStyle`、`dispose` 都在里面写全了。
2. **`surfaces` 只声明「有哪些面」**，不描述长什么样。插件列表 / 标签条由服务端一次返回全部（`listPluginSurfaces`），bundle 按 `id` 认领 —— 让 bundle 再注册一遍就会出现两份真源（刷新前后顺序还会变）。清单里写 `activityBar` / `sider` 会被 loader 直接拒绝。
3. **bundle 契约**：顶层**同步**注册，`render` 返回 React 节点。`render` 是**纯渲染**（宿主在自己的渲染函数里同步调它），所以**不许在 `render` 里调 hooks** —— 要状态就返回一个组件，hooks 写在组件里。

   ```js
   window.__FIZZ_PLUGIN__('redis', (host) => {
     const { React, ui, icons, lib, injectStyle } = host
     injectStyle('.redis-key { font-family: var(--font-mono) }')

     // rpc / openView 是 **ctx** 上的（不是 host 上的）：由 render 的参数传进来
     function Keys({ rpc, openView }) {
       const [keys, setKeys] = React.useState([])
       React.useEffect(() => { void rpc('keys', { match: '*' }).then(setKeys) }, [rpc])
       return React.createElement(
         'div',
         { className: lib.cn('flex flex-col gap-2 p-3') },
         keys.map((key) =>
           React.createElement(
             ui.Button,
             {
               key,
               variant: 'ghost',
               size: 'sm',
               // 点一个 key → 请宿主开新标签（同一个面 + 不同 params = 另一屏）
               onClick: () => openView({ surfaceId: 'key', params: { key }, label: key })
             },
             key
           )
         )
       )
     }

     return {
       render: (surfaceId, ctx) => (surfaceId === 'keys' ? React.createElement(Keys, ctx) : null)
     }
   })
   ```

4. **React 只能从 `host` 取**（自带一份 = 两个 React，hooks 直接报错）。`host.ui` 是 `@fizz/ui` 的原语（`Button` / `Input` / `Card` / `Badge` / `Tabs` / `Progress` / `Spinner` / `Table` / `Select` / `Dialog*` …），`host.lib.cn` 是那份 `cn()`，`host.icons` 是常用 lucide 图标；不认识的组件自己写原生元素 + 类名即可。
5. **`injectStyle(css)` 只插一次**，插件停用 / 卸载 / 热更新时宿主会把带 `data-fizz-plugin` 标记的样式整段删掉。别往 `document.head` 里裸插 `<style>`。
6. **bundle 里不能 import**（`new Function` 执行，没有模块解析）：第三方依赖要么打进 bundle，要么从 `host` 取。也**不要用顶层 await**。
7. **`ctx.rpc(method, payload)` 是前端半唯一的后端入口**：服务端半用 `ctx.rpc.handle(method, fn)` 注册，超时 60s，抛错原话回前端。别从插件前端直接 `fetch('/api/...')` —— 桌面端渲染进程没有 HTTP 端口。注意**每次调用都会现挂一次插件实例**（与服务端渲染同一口径），所以 handler 要无状态：连接池 / 缓存放模块作用域，别指望实例字段活到下一次调用。
8. **面的崩溃被 ErrorBoundary 兜住**（一屏红字 + 重试），不会带崩整个主界面；但**别在 render 里做副作用**，每次都可能是新实例。
9. **`ctx.openView({ surfaceId, params, label, title })` 是它开新标签的唯一手段**（列表里点一条连接 → 开出它的详情页）。标签的 key / 拖拽分屏 / 关闭保护都归宿主；同一个面 + 同一份 `params` 只会聚焦已有标签，不重复开。别自己造「第二块屏」。
10. **弹窗用 `host.ui` 的 `Dialog*` 那一套**（`Dialog` / `DialogContent` / `DialogHeader` / `DialogTitle` / `DialogDescription` / `DialogFooter` / `DialogClose`），别自绘遮罩 —— focus trap、`Esc`、滚动锁都在原语里。服务端 blocks 那条路的 `openDialog` 在 client 面没有对应物，自己 `useState` 管开合。
11. **client 面的头部（含顶栏按钮）由插件自己画**。清单里写 `headerActions` 对 client 面**不生效**：宿主不替它渲染 `SidebarTopBar`。理由是按钮回调往往要改插件组件的 state（打开弹窗 / 重拉列表），而宿主渲染的按钮只能拿到模块级回调。标签页里从 `PluginTabContent` 往下整块都是插件的，宿主只画标签条。

**`dependencies` 的代价**：所有插件声明的包合成**插件根目录的一份共享 `node_modules`**（pnpm + `nodeLinker: hoisted`，全进程只有一个 `@fizz/plugin` 实例）。同一个包的两个不兼容大版本只能生效一个 —— 冲突时给 warning，按插件 **id 字典序先到先得**。禁止写 `@fizz/*`（会覆盖宿主的包，`ctx` 的 `instanceof` 判定全乱）。

何时装：走「安装插件」时服务端自动装，失败会**撤回插件**；**手工拷进目录**的插件点设置页那颗「安装依赖」。装依赖要联网，离线环境下插件会因 `Cannot find module` 起不来（工具全缺席，但不会带崩其它插件）。

## 4. import 解析

插件由 jiti 直接跑 TS 源码。裸包名能不能解析，**取决于从插件文件往上找不找得到 `node_modules`** —— 但 `zod` 与 `ai` 是例外：**宿主给它们配了别名**（`packages/plugin/src/loader.ts` 的 `hostSharedAliases`），所以这两个不管插件放在哪都能 import：

| 导入的包 | 仓库内 / 项目级 / `~/.fizz/plugins` |
| --- | --- |
| `zod`、`ai` | ✅ 都行（宿主别名，版本与宿主一致）—— 带参数的工具因此可以放在**任意位置** |
| `@fizz/*`（仓库内部包） | 只在「沿目录树能命中仓库」时可用（`<仓库>/.fizz/plugins`），别指望 |
| 其它第三方包 | 先写进 `plugin.json` 的 `dependencies`（见 3.7），装好后由插件根的 `node_modules` 解析；没声明就是 `Cannot find module 'x'` |

所以：**带参数的工具就用 `zod`**（`inputSchema: z.object({...})`），它现在不挑插件位置。写 `import { z } from 'zod'` / `import { tool } from 'ai'` 都行；只想要最少的依赖面，就别用 `tool()` 包装，直接给 `{ description, inputSchema, execute }`（两者都对，见 3.1 的形态表）。

同理，用字符串字面量（`'tool:call'`）代替从 `@fizz/plugin` 导入 `HOOKS` 常量、用 `ctx.get('x')` 代替 import 类型，能让插件少一层对仓库的依赖。

## 5. 依赖注入与清理

- 对象插件写 `inject: ['tools']`，或命令式 `ctx.inject(['tools'], (ctx) => {...})`：依赖没齐时**推迟挂载**，依赖一被 `set` 就自动补跑 —— 挂载顺序无关紧要。
- 工具注册 / 监听器 / `effect` 的清理都记在**插件自己的 fiber** 上，插件卸载（或下一轮重建）时自动回收，**不必手写卸载**。

## 6. 可选配置 `plugins.yml`

放在**插件根目录内**（如 `<项目>/.fizz/plugins/plugins.yml`），按 `module` 的**相对路径**匹配：

```yaml
plugins:
  - module: ./word-count.ts
    enabled: true
    config: { language: zh }
```

读配置：`apply(ctx, config)` 的第二个参数即该插件的 `config`。映射式写法（键 = module，值 = config）也支持，见 `packages/plugin/src/config.ts`。

## 7. 交付前自检

1. 文件放好 → 确认它出现在列表里、开关能勾：**项目级**看**侧栏项目「更多」→「插件」**，**内置 / 用户级**看**设置 →「插件」**。**顶部若有红色错误，就是加载 / 校验没过**（比如工具缺 `execute`），照报错改完点「刷新」即可。
2. 若插件用了仓库类型，跑 `npm run typecheck`。
3. 相关验收脚本（改动框架本身时跑）：
   - `node scripts/verify-plugins-api.mjs` —— 路由按项目、落盘、回退、`errors` 上报
   - `node scripts/verify-plugins-discovery.mjs` —— 发现与 `enabled` 合并
   - `node scripts/verify-plugin-ui.mjs` —— UI 声明收集
   - `node scripts/verify-plugin-hot-reload.mjs` —— 热重载（改文件 / 改依赖 / 坏插件自愈）
   - `node scripts/verify-plugin-tool-shape.mjs` —— 工具形态（缺 `execute` 装配期报错并进 `errors`）+ `inputSchema` 边界
   - `node scripts/verify-agent-plugins.mjs` —— 装配结果等价 + **插件逐个隔离**（坏插件不影响同轮其它插件）
   - `node scripts/verify-oss-signature.mjs` —— 手写 AWS SigV4 的签名验证（AWS 官方示例向量，不联网、不需要凭据）
4. 改完存盘即可，无需重启服务端 —— 新代码在**下一轮对话**生效（正在跑的那一轮不算）。设置页的插件声明同理，点「刷新」就会重跑一遍。

## 8. 不要做的事

- 不要往 `packages/contracts` 加类型 —— 公共类型落点是 `packages/plugin`。
- 不要在插件里 import `@fizz/plugin` 的 Node-only 子路径 `config` / `loader`（那是宿主发现加载用的）。
- 不要指望同 priority 覆盖内置工具能悄悄生效 —— 会抛错，必须显式调高 `priority`。
- 不要把插件写成需要编译的产物；加载器直接跑 TS 源码。