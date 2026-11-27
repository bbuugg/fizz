# 审核材料：主区域多标签「身份与地址解耦」重构

> 给审核者：这份文件描述一次**未提交**的工作区改动（40 个文件，全部是 `git status` 里的 `M`，没有新增 / 删除文件）。
> 所有结论都可以用 `git diff` 逐行核对。文中「已验证」只指我实际跑过的命令，见第 7 节；
> **本次没有做任何运行时验证**（没起应用、没截图、没点过界面）。

## 1. 起因

用户提了两件事：

1. 希望主区域（`PanelView`）**每颗标签页有独立的上下文，互不影响**；
2. 修一个 bug：打开某工作区的「新建会话」页 → 打开 SidePanel 里任一面板 → 发一条消息 → SidePanel 面板状态丢失并重建。

用户明确要求：**不要在现有设计上打补丁，要完全重构**。

## 2. 根因

旧设计里标签 key 兼任「身份」和「地址」：

- 对话标签的 key **就是**会话 id；「新对话」草稿是常量 `__new__`。
- 草稿里发出第一条消息后，这颗标签的 key 必须从 `__new__` 改写成会话 id（`replaceTab`）。
- 而按 key 索引的旁路状态表很多：内容宿主的 React key、落位缓存 `slots`、刷新代号、关闭守卫、
  面板现场、工具标签登记表、终端登记表、装饰表。每张表都得跟着「交接」。

实际出 bug 的那一处：`PanelContentLayer` 的落位缓存 `slots` 没有迁移。key 改写后 `slots[新 key]`
是 `undefined` → 内容宿主 `return null` → `ConversationTab` 整棵卸载 → SidePanel 连同终端 PTY 重建，
下一帧量到新矩形才重新挂上。

已经存在的交接链（都是为这个设计缺陷打的补丁）：`replaceTab`、`tabInstanceId`（实例 id 交接）、
`adoptDraftPanel`（面板现场 rekey）、`mergeDraftPanel`、`moveTabReload`（刷新代号交接）、
`conversationTabSync`、`draft-tab-handoff` 的一次性记号。

## 3. 新模型

**标签 key 是终生不变的身份；它指向什么另记。**

| 概念 | 旧 | 新 |
| --- | --- | --- |
| 对话标签 key | 会话 id / `__new__` | 不透明的 `chat:<n>`（`chatTabKey(seq)`） |
| 指向哪条会话 | 从 key 解析 | `panel-store` 的指向表 `chatTargets: Map<key, string \| null>`，`null` = 草稿 |
| 草稿发出第一条消息 | 改写 key + 级联交接 | 只改指向表里的一个值（`bindDraftTab`），其余全不动 |
| 面板现场（终端 / 文件 / git）的 key | 会话 id / 常量 `draft:new` | 标签 key |
| 面板宽度、输入框草稿存档 | 同上 | **仍按会话 id**（要跨刷新保留），草稿用常量 `DRAFT_PANEL_SCOPE` |
| 「当前会话变了怎么对齐」 | 两份 `PanelView` 各写一遍 | `alignConversationTab`，三端共用 |
| 内容宿主 React key | `实例id#代号` | `标签key#代号` |

两条不变量由指向表保证，不靠 key 去重：**一条会话最多一颗标签**（`tabOfConversation`）、
**草稿最多一颗**（`draftTabKey`）。

工具标签（终端 / 接口 / 笔记 / 插件…）的 key 方案没有动：它们的 key 在各自生命周期里本来就稳定，
元数据仍在 `tool-tabs.ts` 的登记表里。

## 4. 改了什么（按文件）

### 4.1 身份层

**`packages/agent-kit/src/shared/lib/panel-tabs.ts`**

- 删 `NEW_TAB_KEY`。
- 新增 `CHAT_TAB_PREFIX = 'chat:'`、`chatTabKey(seq)`。
- `isConversationTabKey` 从「不是工具标签就算」改成「按 `chat:` 前缀判」——**会话 id 不再是标签 key**。
- 文件头改写为「key 是身份不是地址」的铁律。

**`packages/agent-kit/src/shared/lib/panel-store.ts`**（整文件重写，结构不变、增删了导出）

删除：`replaceTab`、`replaceTabInState`、`conversationTabSync`、`tabInstanceId`、`instances` /
`pruneInstances`、`syncTabs`、`useIsTabOpen`。

新增：

- 指向表 `chatTargets` 与查询：`conversationOfTab(key)`（`null` = 草稿，`undefined` = 非对话标签）、
  `tabOfConversation(id)`、`draftTabKey()`、`isDraftTab(key)`、`staleConversationTabs(alive)`。
- 开标签：`openChatTab(id)`、`openDraftTab()`、内部 `addChatTab(target, focus)`。
- `bindDraftTab(id)` → `'bound' | 'already-open' | 'no-draft'`。
- `alignConversationTab(id, { draftCreated, focus? })`：当前会话变化后的唯一对齐规则（见 5.1）。
- 订阅 hook：`useTabOfConversation`、`useDraftTabKey`、`useTabConversation`、`useOpenTabsVersion`；
  以及 `openTabKeys()`（稳定引用的数组）。这些都是**原始值快照**，因为订阅方包含 `AppProvider`
  （应用树根），不能订阅整棵状态。
- `touchState()`：指向变化时 `state = { ...state }` 再 emit，让 `usePanelState` 的订阅方重渲染
  （布局 / 分组字段没变，但标签名、内容、容器门都从指向表取值）。
- `apply()` 里增加：标签集合变化时 `tabsVersion += 1`；回收已关闭标签的指向。

**`tab-reload.ts`（web）**：删 `moveTabReload`。手机壳那份 `apps/mobile/src/app/layout/tab-reload.ts`
本来就没有这个函数，未改。

**`draft-tab-handoff.ts`**：**保留**，函数签名与逻辑一字未变，只重写了文件头注释。它现在只回答
「这条会话是不是从草稿页发出来的」，不再驱动任何迁移。`run-loop.ts` 里只改了 3 行注释。

### 4.2 面板现场

**`panel-session.ts`**

- 删 `DRAFT_PANEL_KEY`、`draftPanelKey()`、`isDraftPanelKey()`、`mergeDraftPanel()`。
- 新增 `DRAFT_PANEL_SCOPE = 'draft'`（仅用于**按会话持久化**的偏好：面板宽度、输入草稿存档）。
- `resolvePanelWorkspace` 与 `resolveTerminalCwd` 的第一个参数从「标签 key」改成
  `conversationId: string | null`（内部原本就是拿它当会话 id 查 `conversations`）。

**两份 Provider（必须逐行对照，它们是手抄的两份实现）**
`packages/agent-kit/src/shell/app-provider.tsx` 与 `apps/mobile/src/app/app-provider.tsx`：

- `sessionKey`：从 `activeConversationId ?? draftPanelKey()` 改成
  `useTabOfConversation(activeConversationId) ?? draftTab`，类型 `string | null`。
- 删 `adoptDraftPanel`（context 类型 `use-app-context.ts` 同步删除）。
- `patchPanelOf(key: string | null, …)`：`null` 时空操作；`blankPanelFor`、补算 effect 改用
  `conversationOfTab(tabKey) ?? null` 解析工作区。
- 草稿换工作区的 retarget effect：从常量 key 改成 `draftTab`。
- 回收 effect 拆成两条：面板现场按「标签还开着吗」回收（依赖 `useOpenTabsVersion`）；
  面板宽度仍按会话清单清（`prunePanelWidths`，保留 `conversationsLoaded` 保护）。
- `terminalTargetKey()` 返回 `string | null`；`openTerminalTabOf` 收 `string | null`。
- 几个 `xxxOf` 薄壳的 key 放宽为 `string | null`。
- git 状态 effect 增加 `if (!sessionKey) return`。

### 4.3 渲染层

- **`ConversationTab.tsx`**：props 从 `conversationId + hostTabKey` 改成 `tabKey + conversationId`。
  内部 `key = tabKey`；`registerTabCloseGuard(tabKey)`；`SidePanel scope` 与 `ChatPanel draftKey`
  用 `conversationId ?? DRAFT_PANEL_SCOPE`；`BrowserPane conversationId={conversationId ?? key}`。
- **`ChatPanel.tsx`**：新增必填 prop `draftKey`；`PromptInputProvider key={panelKey} draftKey={draftKey}`。
- **`prompt-input.tsx`**：`PromptInputProvider` 新增一个 effect——`draftKey` 变化时清掉旧键的存档、
  把输入框当前内容写到新键（见 5.4）。
- **`ComposerStatusBar.tsx`**：新增必填 prop `panelKey`，不再从 `app.activeConversationId` 反推。
- **`use-main-composer-props.tsx`**：`panelKey` 必填；`below` 恒渲染 `ComposerStatusBar`。
- **`NewTaskView.tsx`**：prop 从 `voiceScope` 改成必填 `panelKey`。
- **`ContainerStartupView.tsx`**：`ContainerTabGate` 改用 `useTabConversation(tabKey)` 订阅指向；
  删掉无人调用的 `tabWorkspaceId`。
- **`TabContent.tsx`（web）/ 手机 `PanelView.tsx` 里的同名函数**：
  `<ConversationTab tabKey conversationId={conversationOfTab(tabKey) ?? null} />`。
- **`PanelContentLayer.tsx`（web）/ 手机 `PanelView.tsx`**：宿主 key 改成 `${tabKey}#${tabReloadGen(tabKey)}`。
- **`tab-meta.tsx`**：对话标签的展示信息从指向表取；运行态用 `getActivity(conversationOfTab(key) ?? undefined)`；
  未识别的 key 给中性名字。
- **`group-actions.tsx`（web）/ `use-panel-actions.ts`（手机）**：`syncConversation` / `renameTab` / `reloadTab`
  一律先 `conversationOfTab(key)` 再操作。
- **`PanelTabItem.tsx`**：`renamable = !isDraftTab(tabKey)`。
- **`app-shell.tsx`（web 与手机）**：`openTab(NEW_TAB_KEY)` → `openDraftTab()`。

### 4.4 两份 `PanelView.tsx` 的同步 effect（web 与手机）

- 零标签兜底：`openTab(NEW_TAB_KEY)` → `openDraftTab()`。
- 「当前会话变了」effect：整段 `conversationTabSync` + `adoptDraftPanel` + `replaceTab` + `moveTabReload`
  收成一句 `alignConversationTab(key, { draftCreated: consumeDraftConversation(key), focus })`。
  web 版多传 `focus`（首次挂载且面板里已有别的标签时不抢焦点）。
- 「会话被删 / 归档」effect：改用 `staleConversationTabs(alive)`，对齐当前会话时取
  `conversationOfTab(nextKey)`。

### 4.5 只改了注释的文件

`tab-close.ts`、`app-events.ts`、`composer.tsx`、`WorkspacePicker.tsx`、`open-file.ts`、`GitPanel.tsx`、
`chat-draft.ts`、`run-loop.ts`：把「key 就是会话 id」「`__new__`」「`syncTabs`」「`DRAFT_PANEL_KEY`」
这类已经不成立的说法改掉。

### 4.6 `AGENTS.md`

- 「面板现场 / 终端开合有两份手抄实现」那条里，删掉了已不存在的 `adoptDraftPanel` / `mergeDraftPanel`，
  指向新的共用函数。
- **新增一条**「标签 key 是身份，不是地址」的硬约束。这是对项目指令文件的改动，请一并审核措辞是否合适。

## 5. 需要重点审的设计决定

### 5.1 `alignConversationTab` 的对齐规则

```
会话已经有标签            → 不动
draftCreated（在草稿页发的）→ 草稿标签指向它（不看焦点）
草稿是焦点组的活动标签      → 草稿标签指向它（启动恢复场景）
其余                      → 新开一颗（focus: false 时只补进来）
```

- 「不看焦点」是必要的：建会话异步（ACP 要起进程），用户等不及切走是常事。
- 「草稿在后台时不能仅凭存在就绑定」也是必要的：删掉当前会话时 store 会把当前会话切到邻居，
  这时后台草稿不能被顶掉。
- **值得怀疑的边界**：规则第 3 行依赖「草稿正被看着」。如果存在「`activeConversationId` 指向 X、
  同时草稿是焦点标签、而 X 并不是从草稿页发出的」的路径，草稿会被错误地指给 X。
  我推了一遍没找到（点草稿标签会 `openConversation(null)`），但没有穷举。

### 5.2 面板现场的回收语义变了（行为变化）

旧：面板现场在**会话被删除**或草稿标签关闭时才回收。关掉对话标签再从侧栏打开，右侧面板的
开合状态会恢复（但列出的终端 PTY 早已不在——内容卸载时就被 kill 了）。

新：**标签关了现场就没**，判据只有「这颗标签还开着吗」。重开同一条会话是一颗新标签、一份新现场。
手机单标签模式切走再切回同理。

我认为这更符合「每颗标签独立上下文」，但这是用户可感知的变化，请确认是否接受。

### 5.3 `sessionKey` 可能为 `null`

只开着工具标签、且当前没有草稿时（手机单标签模式切到工具标签就会这样），
`sessionKey` 为 `null`，那批不带 `Of` 的动作（`showSideTab` / `toggleSideTab` / `patchActivePanel` /
`toggleTerminalPanel`…）变成空操作。旧行为是落到「当前会话的面板现场」——但那颗标签的内容并没挂载，
终端开出来也等不到 `onReady`（项目注释里提到的 5 秒超时问题）。`gitBadge` 此时为 `null`。

### 5.4 输入草稿存档的「换键搬迁」

`PromptInputProvider` 新增 effect：`draftKey` 变化时 `clearChatDraft(旧键)` + `saveChatDraft(新键, 当前内容)`。

- 必要性：不搬的话，刚发出去的文字留在草稿作用域下，用户下次点「新建对话」它会原样出现。
- **值得怀疑**：发送成功时的 `clearInput` 与这个 effect 都会清旧键，两者先后顺序我依赖了
  「`onStarted` 在同一个同步任务里调用、用的是旧闭包」这一事实，没有写测试钉住。
- 首次挂载不跑（`prev === draftKey`），StrictMode 双调用安全。

### 5.5 其它

- **面板宽度在「草稿 → 会话」瞬间会回到默认值**：作用域从 `DRAFT_PANEL_SCOPE` 变成会话 id，
  后者没有记录。这是旧行为（旧的是 `draft:new` → 会话 id），我没有处理。
- **`tabInstanceId` 删掉了**：现在宿主 key 就是标签 key。理论上「同一颗标签在同一次提交里
  先关后开」会被 React 复用实例；我没找到这样的路径，但没有证明不存在。
- **`touchState` 的浅拷贝**：为了让读指向表的渲染方重渲染。副作用是依赖 `[state]` 的几个 effect
  （回收、`measure`、`hadTabsRef`）会多跑一次，都是幂等的。
- **`draft-tab-handoff.ts` 保留了**：它不再是「交接」，只提供来源信息。

## 6. 测试改动

| 文件 | 改动 |
| --- | --- |
| `panel-store.test.ts` | 整文件重写，20 条：指向表、单例、草稿 → 会话身份不变、后台绑定不抢焦点、对齐规则各分支、`staleConversationTabs`、单标签模式 |
| `tab-reload.test.ts` | 整文件重写（原来测的是已删除的 `moveTabReload`），6 条 |
| `panel-tabs.test.ts` | 改「会话 id 仍算对话标签」为「会话 id 不是标签 key」，新增 `chat:` 前缀用例 |
| `panel-session.test.ts` | 删 `draftPanelKey` / `mergeDraftPanel` 的用例，草稿参数从 `DRAFT_PANEL_KEY` 改成 `null` |
| `chat-draft.test.ts` | 常量改名，文案从「标签 key」改成「会话」 |
| `ComposerStatusBar.test.ts` | 传入 `panelKey`，并让标签 key 与会话 id 不同以钉住「不反推」 |

**没有覆盖到的**：`PromptInputProvider` 的换键搬迁（5.4）、两份 Provider 的回收 effect、
两份 `PanelView` 的 effect。这些依赖 React 渲染时序，本仓测试环境只有 node。

## 7. 验证结果（如实）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | **非零退出**，9 条错误，全部在 `packages/tools/src/history.test.ts`（7）与 `todowrite.test.ts`（2）。这两个文件本次未改动 |
| `npx vitest run`（全量） | 1504 过，**7 条失败**，见下 |
| `npm run check:boundaries` | 0 违规 |
| 改动相关的 8 个测试文件单独跑 | 79 条全过 |
| `features/chat` 目录单测（修 5.6 之后） | 退出码 0 |
| 运行时验证 | **没做** |

全量单测的 7 条失败：

- `plugins/rtk/index.test.ts`（2 条）与 `apps/desktop/release/win-unpacked/resources/plugins/rtk/index.test.ts`（2 条，是打包产物里的同一份）
- `packages/agent-kit/src/shared/lib/parts.test.ts`（1 条）
- `conversation-manage.test.ts`（1 条，断言 `activeConversationId`）
- `conversation-open.test.ts`（1 条，断言 `chatTarget` 保留）

**我没有回退改动去实测这 7 条在改动前是否同样失败。** 判断依据是：它们所在的文件、以及它们测试的
模块本次都没改；`stores/` 目录下我只改了 `run-loop.ts` 的 3 行注释；`draft-tab-handoff.ts` 逻辑未变。
最后两条的用例名带「标签焦点」「草稿标签」字样，建议审核者优先核实这两条。

## 8. 过程中我引入又修掉的一个回归

第一版把 `use-main-composer-props` 的 `panelKey` 写成可选，并在不传时返回 `below: null`。
`NewTaskView`（新对话页）当时没有传，导致**新对话页输入框下方的状态条整条消失**。
用户发现后已修：`panelKey` 改必填，`NewTaskView` 的入参改为 `panelKey`。
记录在此是因为它说明「把标签 key 从宿主一路传下去」这类改动容易漏掉不带 `Of` 的旧入口。

## 9. 建议审核者做的核对

```bash
git diff                                     # 逐文件核对第 4 节
git diff -- packages/agent-kit/src/shared/lib/stores   # 确认只有注释
npm run typecheck
npx vitest run
npm run check:boundaries
```

运行时（我没做，需要用户授权）：

1. 新对话页 → 开右侧任一面板（终端 / 文件）→ 发消息：面板不应重建、终端不应重连、不应多出标签。
2. 新对话页输入框下方状态条（分支 / 本地或远程 / 权限档 / 上下文）应当存在。
3. ACP 会话建得慢：发消息后立刻切到别的标签，等建好后切回——草稿标签应变成那条会话，焦点不被抢。
4. 关掉一个对话标签再从侧栏打开：预期是一份全新的面板现场（5.2）。
5. 刷新页面：已打开会话里没发出的输入文字应当还在；新对话页发完消息后再点「新建对话」，输入框应是空的。
6. 手机壳：会话 → 工具标签 → 切回会话；新对话页发消息。
