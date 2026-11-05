'use client'

/**
 * Markdown 编辑器 —— 「笔记」与「外部文件」两个功能区**共用**的一份。
 *
 * 之所以抽到 `shared/`：这两处用的是同一套交互（手动保存、双模式、关闭守卫），
 * 而其中若干条是**踩过坑才对的**（见下面「滞后」一节）。各写一份必然分叉 ——
 * 实际发生过的样子就是「修了笔记的、外部文件那份还漏着」，而漏的那份表现为
 * **静默丢字**，不报错、不提示。
 *
 * ## 只手动保存
 *
 * 与主机脚本的**防抖自动保存**刻意不同（用户明确要的）：写东西时「半句话、随手敲的符号」
 * 是常态，自动保存会把每次停顿都落盘 —— 想反悔时没有「不保存」这条路。所以只有
 * 保存钮 / `Ctrl(Cmd)+S` 才写盘，改过之后头部亮一个「未保存」。
 *
 * ## 两种模式，正文只有一份
 *
 * - **富文本**：`@milkdown/crepe` 的所见即所得。它**只往外报**（`markdownUpdated`），
 *   不往回灌 —— 受控回灌会把光标打回开头，是这类编辑器最经典的坑。
 * - **源码**：Monaco（复用 `features/files/MonacoEditor`，语言 `markdown`），直接改原文。
 *   为什么不再是一个 `<textarea>`：写 markdown 原文时最常用的三件事（查找替换、多光标、
 *   语法高亮）它一个都没有。而 Monaco 本来就在产物里（文件面板 / 接口调试都在用），
 *   loader 与静态资源是白拿的，不额外付包体 —— 自己再包一个 `@monaco-editor/react`
 *   实例才是多一份要维护的 loader / 主题 / CSP worker 壳。
 *   ⚠️ 它比 textarea 多一手 keydown 处理，所以 `Ctrl/Cmd+S` 那条监听改到了 **capture 阶段**。
 *   两条正文仍然只有 `source` 这一份状态，切换 = 卸载重挂，下面的「滞后」一节照旧适用。
 *
 * 两边共用同一份 `source` state（markdown 原文），切换模式 = **卸载 / 重挂**编辑器，
 * 重挂时用当前 `source` 当初始值。这样不用去碰「把新文档灌进已有编辑器」那套 API
 * （`replaceAll` 之类的 action），少一处会错的地方。代价是撤销历史在切模式时清空 —— 可接受。
 *
 * ## `source` 是**滞后**的，保存时不能只认它
 *
 * `markdownUpdated` 在 `@milkdown/plugin-listener` 里是 `debounce(handler, 200)` —— 敲完
 * 最后一下要等 200ms 才报上来。所以：① 保存取的是 `crepe.getMarkdown()`（同步，见 `liveRef`），
 * 不是 `source`，否则「打完字立刻 Ctrl+S」会**静默漏掉最后那几个字**；② `dirty` 由
 * 「当前正文 ≠ 磁盘基线」（`savedRef`）算出来，不是一个纯布尔 —— 保存成功后那次迟到的
 * 回调报的是同一份文本，纯布尔会被它翻回「未保存」。
 *
 * ## 两个调用方只差三件事
 *
 * `load` / `save` 的实现体（笔记走 notes API、外部文件走主进程 fs）、`label` 的文案、
 * 以及 `defaultMode`（自建笔记富文本；**用户自己的文件默认源码** —— 那类文件多半在 git 里，
 * 富文本保存会把整篇按 milkdown 的规则重新序列化，diff 会大面积变红）。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Crepe, CrepeFeature } from '@milkdown/crepe'
// 链接用 link-tooltip 那一份命令（Crepe 工具条的「链接」按钮也是它）：弹浮层让人填地址。
// ⚠️ 别换成 `preset/commonmark` 里同名的那个 —— 那个是「直接给标记套 attrs」，
// **空选区时会抛错**。
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip'
/*
 * ⚠️ 这一行取到的 `KeymapReady` / `keymapCtx` / `editorViewCtx` 必须与 `@milkdown/crepe`
 * **内部用的是同一份** `@milkdown/ctx`。它们的 id 是 `Symbol()`（`ctx/lib` 的 `TimerType` /
 * `SliceType`），**跨副本永远不相等** —— 一旦 node_modules 里出现第二份（crepe 锁死了
 * `@milkdown/kit` 的精确版本，我们的 kit 版本落后一档就会各自装一套），
 * `ctx.wait(KeymapReady)` 会直接抛 `Timer "KeymapReady" not found, do you forget to record it?`，
 * 而 `create()` 因此整条 reject → 编辑器根本出不来。
 *
 * 所以 `packages/agent-kit/package.json` 里 crepe 与 kit **都写死同一个精确版本**，
 * 别把其中一个改回 `^`。升级时两个一起改，装完确认
 * `node_modules/@milkdown/crepe/node_modules` 不存在。
 */
import { commandsCtx, editorViewCtx, KeymapReady, keymapCtx, type CmdKey } from '@milkdown/kit/core'
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import {
  addBlockTypeCommand,
  codeBlockSchema,
  createCodeBlockCommand,
  headingSchema,
  inlineCodeKeymap,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand
} from '@milkdown/kit/preset/commonmark'
import { insertTableCommand, strikethroughKeymap } from '@milkdown/kit/preset/gfm'
import type { Command } from '@milkdown/kit/prose/state'
// 结构样式（块手柄 / 斜杠菜单 / 表格 / 代码块…）保留官方的
import '@milkdown/crepe/theme/common/style.css'
/*
 * ⚠️ **故意不引 `@milkdown/crepe/theme/classic.css`**。
 *
 * 那个文件（`lib/theme/crepe/style.css`，整份只有 30 行）**内容就是**在 `.milkdown` 上
 * 写死一套只认浅色的变量。变量解析取**最近的祖先声明**，所以它会压过我们在 `:root` 上的
 * 映射：编辑器**正文**吃它那套写死的浅色、而 portal 到 body 的浮动 UI（块手柄 / 斜杠菜单 /
 * 选中工具条）吃我们的映射 —— 两边各拿一半，切暗色时正文直接白底黑字糊在深色面板上。
 *
 * 所以不跟它抢，改成由 `markdown-editor.css` 在 `:root` 上**给全**它定义的那 23 个变量
 * （17 个颜色 + 4 个字体/字号 + 2 个阴影），一份来源、正文与浮动 UI 都继承得到。
 *
 * 若将来升级 `@milkdown/crepe` 后主题文件里**多出非变量的规则**，要把它加回来 ——
 * 判断方法：打开 `lib/theme/crepe/style.css` 看是否每条声明都还是 `--crepe-*`。
 */
import { installBlockDragDropFallback } from '@fizz/agent-kit/shared/components/block-drag-drop'
import '@fizz/agent-kit/shared/components/markdown-editor.css'
// 源码模式的编辑器：与文件面板**同一份** Monaco（loader / 主题 / 等宽字体 / CSP worker 壳
// 都在那边了）。`shared → features` 方向在本包内已有先例（`shared/lib/plugin-surfaces.ts`）。
import MonacoEditor from '@fizz/agent-kit/features/files/MonacoEditor'
import { Code2, Loader2, Pencil, RotateCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@fizz/ui/button'
import { useConfirm } from '@fizz/agent-kit/shared/components/ConfirmProvider'
import { registerTabCloseGuard } from '@fizz/agent-kit/shared/lib/tab-close'
import { markTabClean, markTabDirty } from '@fizz/agent-kit/shared/lib/dirty-tabs'
import { errorMessage } from '@fizz/agent-kit/shared/lib/stores/shared'

/**
 * 把「执行某个已注册命令」包成 keymap 需要的 `Command`。
 *
 * 命令管理器自己会读当前 view 的 state，所以这里不转发 state / dispatch / view ——
 * Milkdown 官方的 keymap 也是这个写法。
 */
function call<T>(ctx: Ctx, command: CmdKey<T>, payload?: T): Command {
  return () => ctx.get(commandsCtx).call(command, payload)
}

/**
 * 按当前块的标题级别上下移动一级（Typora 的 `Ctrl+=` / `Ctrl+-`）。
 *
 * 非标题一律按 0 级算：提升会变成「标题 1」；已经是正文还要降低就无从可降，
 * 返回 `false` 把按键让给后续处理（否则会把正文吞掉）。
 */
function stepHeading(ctx: Ctx, delta: number): Command {
  const commands = ctx.get(commandsCtx)
  const headingType = headingSchema.type(ctx)
  return (state, dispatch, view) => {
    const parent = state.selection.$from.parent
    const current = parent.type === headingType ? Number(parent.attrs.level) : 0
    const next = current + delta
    if (next < 1 && current < 1) return false
    return commands.get(wrapInHeadingCommand.key)(Math.min(next, 6))(state, dispatch, view)
  }
}

/**
 * Typora 风格键位 → 命令（**沿用 dogi 笔记那套，键位一一对齐**）。
 *
 * 只登记「Milkdown 默认没有 / 默认不一样」的键位。下面这些**沿用 Milkdown 内置**，
 * 本身就已经和 Typora 一致，不要在这里重复登记（重复登记会把内置行为顶掉）：
 *
 * | 键 | 作用 |
 * |---|---|
 * | `Mod-b` / `Mod-i` | 加粗 / 斜体 |
 * | `Mod-z` / `Mod-y` | 撤销 / 重做 |
 * | `Tab` / `Shift-Tab` | 列表缩进 / 减少缩进 |
 * | `Shift-Enter` | 软换行 |
 *
 * **删除线与行内代码也不走这里**：官方把它们的键位写在 preset 的 keymap 槽位里，而 Crepe
 * 工具条上的快捷键提示正是从那个槽位读的（`resolveKeymapShortcut`）—— 只在这里 `add`
 * 的话「实际绑定」和「工具条上显示的提示」会不一致。改槽位见 `CrepeSurface` 里的 `config`。
 *
 * ⚠️ **没有 `Mod-Shift-i`（插入图片）**：那一项依赖 Crepe 的 `ImageBlock` feature，而
 * 本组件刻意关着它（没有上传通道，留着只会多出一套「图片传不上去」的 UI）。绑一个按下就
 * 报错的键比不绑更糟。要真想用，得先把 ImageBlock 打开并接一个上传器。
 */
const TYPORA_KEYMAP: Array<{ key: string; onRun: (ctx: Ctx) => Command }> = [
  // 行内格式
  { key: 'Mod-k', onRun: (ctx) => call(ctx, toggleLinkCommand.key) },
  // 段落与块
  ...Array.from({ length: 6 }, (_, level) => ({
    key: `Mod-${level + 1}`,
    onRun: (ctx: Ctx) => call(ctx, wrapInHeadingCommand.key, level + 1)
  })),
  { key: 'Mod-0', onRun: (ctx) => call(ctx, wrapInHeadingCommand.key, 0) },
  { key: 'Mod-=', onRun: (ctx) => stepHeading(ctx, 1) },
  { key: 'Mod--', onRun: (ctx) => stepHeading(ctx, -1) },
  { key: 'Mod-Shift-q', onRun: (ctx) => call(ctx, wrapInBlockquoteCommand.key) },
  { key: 'Mod-Shift-k', onRun: (ctx) => call(ctx, createCodeBlockCommand.key) },
  // 列表与表格
  { key: 'Mod-Shift-]', onRun: (ctx) => call(ctx, wrapInBulletListCommand.key) },
  { key: 'Mod-Shift-[', onRun: (ctx) => call(ctx, wrapInOrderedListCommand.key) },
  { key: 'Mod-t', onRun: (ctx) => call(ctx, insertTableCommand.key) },
  {
    // 数学块就是「语言为 LaTeX 的代码块」——与 `/` 斜杠菜单里那一项同一个做法
    key: 'Mod-Shift-m',
    onRun: (ctx) =>
      call(ctx, addBlockTypeCommand.key, {
        nodeType: codeBlockSchema.type(ctx),
        attrs: { language: 'LaTeX' }
      })
  }
]

/**
 * 把 `TYPORA_KEYMAP` 注册进编辑器的 keymap。
 *
 * 官方键位是 `KeymapReady` 之后由 `keymapCtx.build()` **一次性**组装的，所以这里必须等同一个
 * 计时器（`$shortcut` 就是这么干的），条目才赶得上被 build 进去 —— 直接 `add` 会因为
 * 「build 已经跑过」而静默失效。
 *
 * `priority: 100`（默认 50）是为了万一将来官方绑了同一个键：优先级高的先跑，返回 true 就
 * 覆盖掉官方行为。
 *
 * 走 ProseMirror 的 keymap 意味着**天然只在正文聚焦时生效**，不需要额外加「编辑器聚焦吗」的闸。
 */
const typoraKeymapPlugin: MilkdownPlugin = (ctx) => async () => {
  /*
   * 这一整段必须兜住：`ctx.wait` 在计时器没登记时是**同步抛**的（`Timer "xxx" not found`），
   * 超时（3s）则是 reject —— 两种都会让 `crepe.create()` 整条失败，表现是**编辑器一片空白**
   * 而不是「少了几个快捷键」。键位是锦上添花，绝不能成为整个编辑器的单点故障。
   */
  try {
    await ctx.wait(KeymapReady)
    const keymap = ctx.get(keymapCtx)
    const disposers = TYPORA_KEYMAP.map(({ key, onRun }) => keymap.add({ key, priority: 100, onRun }))
    return () => disposers.forEach((dispose) => dispose())
  } catch (err) {
    console.warn('[markdown] 自定义键位未注册（编辑器其余功能不受影响）', err)
    return () => {}
  }
}

/**
 * milkdown 的**宿主**（一个薄封装）。
 *
 * 刻意做成独立组件：切模式时靠 React 卸载它来销毁编辑器，父组件那边一行分支就够了。
 */
function CrepeSurface({
  value,
  onChange,
  liveRef
}: {
  /** **初始**正文（挂载时喂一次，之后不再回灌） */
  value: string
  onChange: (markdown: string) => void
  /**
   * 由本组件填上的「按需取正文」入口（`crepe.getMarkdown()`）。
   *
   * 必需：`markdownUpdated` 是**200ms 防抖**的（`@milkdown/plugin-listener` 里
   * `debounce(handler, 200)`），刚敲完立刻保存时最后一次报上来的正文还是旧的 ——
   * 只认 `onChange` 就会**静默丢掉最后那几个字**。`getMarkdown()` 同步读当前文档，没有这道延迟。
   */
  liveRef: { current: (() => string) | null }
}): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  /** 初始值只在挂载时取一次 —— 见文件头「禁用受控回灌」 */
  const initialRef = useRef(value)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const crepe = new Crepe({
      root: host,
      defaultValue: initialRef.current,
      features: {
        // 不做图片粘贴（YAGNI）：留着它只会多出一套「图片传不上去」的 UI。
        [CrepeFeature.ImageBlock]: false,
        // 没配任何 LLM provider，留着只会出现点不动的 AI 按钮。
        [CrepeFeature.AI]: false
      },
      featureConfigs: {
        /**
         * 关掉 Crepe 默认的「虚拟光标」（prosemirror-virtual-cursor）。
         *
         * 它是为「光标落在非 inclusive 标记的哪一侧」画的一条提示光标，坐标用
         * `getBoundingClientRect()` 算出来的是**视口**差值，却被当成滚动内容里的 `top` 用。
         * 编辑区不滚动时两者恰好重合，**一滚动虚拟光标就整体偏移一个 scrollTop** ——
         * 屏幕上出现两个插入光标，跟着文字走的原生光标才是对的。
         *
         * 本组件的滚动容器正是编辑区内部（见 `markdown-editor.css`），所以直接关掉它，
         * 只留原生光标。drop 指示线（拖块时的落点线）是同一个 feature 的另一半，不受影响。
         */
        [CrepeFeature.Cursor]: { virtual: false }
      }
    })

    /*
     * 删除线与行内代码：官方把键位写在 preset 的 keymap 槽位里，而 Crepe 工具条的快捷键
     * 提示也读这份槽位（`resolveKeymapShortcut` 只取第一条）—— 改这里才能让「实际绑定」和
     * 「工具条上显示的提示」一起变成 Typora 的键位。只 add 不改槽位的话，按 Alt+Shift+5
     * 会生效、而工具条仍然提示 `Mod-Shift-x`。
     */
    crepe.editor.config((ctx) => {
      ctx.update(strikethroughKeymap.key, () => ({
        ToggleStrikethrough: { shortcuts: 'Alt-Shift-5' }
      }))
      ctx.update(inlineCodeKeymap.key, () => ({
        ToggleInlineCode: { shortcuts: 'Mod-Shift-`' }
      }))
    })
    // 追加 Typora 风格键位。**必须在 `create()` 之前 use** —— 官方插件也在这一步注册
    crepe.editor.use(typoraKeymapPlugin)

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prev) => {
        if (markdown === prev) return
        onChangeRef.current(markdown)
      })
    })

    /**
     * `create()` 是异步的，而 `destroy()` 在「还没建完」时调会炸 ——
     * React 严格模式下 effect 会**跑两遍**（挂载 → 清理 → 再挂载），这一条是必需的。
     */
    let alive = true
    let created = false
    /** 块拖拽的 drop 兜底（建完才装得上，见 `block-drag-drop.ts`） */
    let uninstallDropFallback: (() => void) | null = null
    void crepe
      .create()
      .then(() => {
        created = true
        if (!alive) return crepe.destroy()
        // 建完才交出入口：`getMarkdown()` 走 `editor.action`，编辑器没就绪 / 已销毁时会抛
        liveRef.current = () => crepe.getMarkdown()
        /*
         * 补一条原生 drop。**不给它就会「拖得动、松手不动」**：全应用的 react-dnd backend
         * 在 window 上以 capture 阶段把 drop `preventDefault` 掉了，prosemirror-view 的
         * 输入门因此整场看不到这个事件（完整链路见 `block-drag-drop.ts`）。
         *
         * 挂在 `host` 上（**`.ProseMirror` 的祖先**）：事件先过 PM 自己的处理器、
         * 冒泡到这里才轮到我们，这样才拿得到「PM 有没有处理过」的判据。
         */
        uninstallDropFallback = installBlockDragDropFallback(host, () => {
          try {
            return crepe.editor.action((ctx) => ctx.get(editorViewCtx))
          } catch {
            // 编辑器正在销毁：`action` 会抛，当作「没有 view」——兜底自然不做事
            return null
          }
        })
        return undefined
      })
      .catch((err: unknown) => {
        console.warn('[markdown] 富文本编辑器初始化失败', err)
      })

    return () => {
      alive = false
      liveRef.current = null
      uninstallDropFallback?.()
      if (created) void crepe.destroy()
    }
  }, [liveRef])

  /*
   * 滚动**不在这里**：`overflow-y` 落到 `.ProseMirror` 自己身上（见 `markdown-editor.css`
   * 的高度链）。Crepe 的块手柄 / 斜杠菜单按「块在视口里的位置」算坐标，让它待在**不滚动**的
   * 容器里、由 `.ProseMirror` 单独滚，是 dogi 那边已经跟这套手柄实测过的组合。
   */
  return <div ref={hostRef} className="flex min-h-0 flex-1 flex-col" />
}

export interface MarkdownEditorProps {
  /** 本标签的 key：关闭守卫按它登记，脏计数也按它记 */
  tabKey: string
  /** 是不是正被看着的标签 —— `Ctrl/Cmd+S` 只有它该响应（所有标签常挂载） */
  active: boolean
  /** 头部显示的路径文案（笔记是根内相对路径，外部文件是绝对路径） */
  label: string
  /** 初始模式。自建笔记给 `rich`；**用户自己的文件给 `source`**（见文件头） */
  defaultMode: 'rich' | 'source'
  /**
   * 读一次正文。**只在挂载时调一次** —— 调用方即使给出不稳定的函数引用也不会触发重读
   * （重读会把「改了没保存」的现场冲掉，是这里最不能出的错）。
   */
  load: () => Promise<string>
  /** 写回正文；**抛错 = 失败**（这里会弹 toast，不往上冒） */
  save: (content: string) => Promise<void>
}

export function MarkdownEditor({
  tabKey,
  active,
  label,
  defaultMode,
  load,
  save
}: MarkdownEditorProps): ReactElement {
  const confirm = useConfirm()
  /** markdown 原文；`null` = 还没读出来 */
  const [source, setSource] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<'rich' | 'source'>(defaultMode)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // 各种「最新值」都走 ref：正文只在挂载时读一次，而这些值在保存 / 守卫被调用时才是最新的
  const loadRef = useRef(load)
  loadRef.current = load
  const saveRef = useRef(save)
  saveRef.current = save
  const sourceRef = useRef(source)
  sourceRef.current = source
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const modeRef = useRef(mode)
  modeRef.current = mode
  /** 富文本编辑器的「按需取正文」入口（见 `CrepeSurface` 的 `liveRef` 注释） */
  const liveRef = useRef<(() => string) | null>(null)
  /**
   * 磁盘上那份正文 —— `dirty` 一律由「当前正文 ≠ 基线」算出来，不是一个纯布尔。
   *
   * 理由是 `markdownUpdated` **有 200ms 防抖**：保存成功那一刻编辑器里可能还压着一次
   * 没报上来的变更，稍后才到。如果保存后只是简单 `setDirty(false)`，那次迟到的回调会把
   * 「已保存」又翻回「未保存」（用户看到保存完立刻又变成脏的）。用基线比较就自洽了：
   * 迟到的那份跟刚写下去的一样 → 仍然不脏。
   */
  const savedRef = useRef<string | null>(null)

  /**
   * 此刻编辑器里的正文。富文本模式**必须问编辑器要**，不能直接用 `source` ——
   * `markdownUpdated` 是 200ms 防抖的，`source` 可能落后于屏幕上的内容（见 `liveRef`）。
   * 编辑器还没建好 / 正在销毁时退回 `source`：比整个保存失败要好。
   */
  const currentContent = useCallback((): string | null => {
    if (modeRef.current === 'rich' && liveRef.current) {
      try {
        return liveRef.current()
      } catch {
        // 落到下面退回 `source`
      }
    }
    return sourceRef.current
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setLoadError(null)
    setSource(null)
    try {
      const content = await loadRef.current()
      savedRef.current = content
      setSource(content)
      setDirty(false)
    } catch (err) {
      setLoadError(errorMessage(err))
    }
  }, [])

  // 只在挂载时读一次正文（`load` 走 ref，故意不进依赖，见 props 注释）
  useEffect(() => {
    void reload()
  }, [reload])

  const submit = useCallback(async (): Promise<void> => {
    const content = currentContent()
    if (content === null) return
    setSaving(true)
    try {
      await saveRef.current(content)
      savedRef.current = content
      // 拿**此刻**的正文跟刚写下去的那份比，而不是无脑置 false：写盘期间用户可能又敲了字，
      // 那样这里会诚实地仍然是「未保存」。没敲的话（含 200ms 防抖里压着的那次回调）
      // 就是 false，不会出现「保存完又立刻变脏」。
      setDirty(currentContent() !== content)
      toast.success('已保存')
    } catch (err) {
      toast.error(`保存失败：${errorMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }, [currentContent])

  // 未保存就问一句（关闭标签与刷新共用一套文案）
  const askDiscard = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true
    return confirm({
      title: '放弃未保存的修改？',
      description: '这份文档改了还没保存，继续的话这些修改会丢掉。',
      confirmLabel: '放弃修改',
      cancelLabel: '留下',
      destructive: true
    })
  }, [confirm])

  useEffect(
    () =>
      registerTabCloseGuard(tabKey, {
        beforeClose: async () => ((await askDiscard()) ? 'close' : 'cancel'),
        // 「刷新标签」= 内容卸载重挂 = 正文重新从磁盘读 → 未保存的编辑同样会丢
        beforeReload: async () => ((await askDiscard()) ? 'reload' : 'cancel')
      }),
    [tabKey, askDiscard]
  )

  /**
   * 把脏状态登记到应用级计数（桌面端靠它做退出拦截）。
   *
   * 卸载时也要撤掉：标签关掉之后文档已经不在界面上了，留着会让退出时白问一句，
   * 更糟的是那个数永远不会回落 —— 变成「以后每次退出都弹」。
   */
  useEffect(() => {
    if (dirty) markTabDirty(tabKey)
    else markTabClean(tabKey)
  }, [dirty, tabKey])
  useEffect(() => () => markTabClean(tabKey), [tabKey])

  // `Ctrl/Cmd+S`：只认**正被看着**的那个标签 —— 所有标签常挂载，不加这道闸会一次存全部
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void submit()
    }
    /*
      第三个参数 `true` = **capture 阶段**，这是换 Monaco 之后必须的：
      源码模式下按键先进入 Monaco 的文本区处理器（它自己会 `preventDefault` 一部分键、
      也可能在将来某个版本给 `Ctrl+S` 绑上默认动作且 `stopPropagation`），冒泡阶段的
      窗口监听就再也收不到 —— 表现为「源码模式里按 Ctrl+S 什么都不发生」，不报错。
      窗口的 capture 监听是整条事件链上的**第一个**处理器，不看任何后代的脸色。
      富文本模式同样受益（ProseMirror 也是先吃 keydown）。
    */
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, submit])

  const editSource = useCallback((next: string): void => {
    setSource(next)
    // 跟基线比而不是直接置 true：保存成功后那次迟到的防抖回调报的是同一份文本，
    // 直接置 true 会把刚保存好的又标成「未保存」；反过来，用户改回原样也算干净了。
    setDirty(next !== savedRef.current)
  }, [])

  return (
    <div className="markdown-editor flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-9 shrink-0 items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={label}>
          {label}
        </span>
        {dirty && <span className="shrink-0 text-xs text-muted-foreground">未保存</span>}
        <Button
          variant="ghost"
          size="xs"
          disabled={source === null}
          title={mode === 'rich' ? '看 markdown 源码' : '回到富文本'}
          onClick={() => setMode((cur) => (cur === 'rich' ? 'source' : 'rich'))}
        >
          {mode === 'rich' ? <Code2 /> : <Pencil />}
          {mode === 'rich' ? '源码' : '富文本'}
        </Button>
        <Button
          size="xs"
          disabled={source === null || saving || !dirty}
          title="保存（Ctrl/Cmd+S）"
          onClick={() => void submit()}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>
      </header>

      {loadError !== null ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RotateCw />
            重试
          </Button>
        </div>
      ) : source === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : mode === 'rich' ? (
        <CrepeSurface key="rich" value={source} onChange={editSource} liveRef={liveRef} />
      ) : (
        /*
          外层 `min-h-0 flex-1 overflow-hidden` 是高度链的一环，**不能省**：
          MonacoEditor 根节点是 `h-full`，父级不给确定高度它会塌成 0（表现为整片空白）。
          `wordWrap="on"` 固定打开：那套开关的入口在文件面板的标签条上，这里没有，
          而 markdown 原文（长句、表格、中文段落）几乎必然要换行看。
        */
        <div key="source" className="min-h-0 flex-1 overflow-hidden">
          <MonacoEditor
            value={source}
            onChange={editSource}
            language="markdown"
            showHeader={false}
            wordWrap="on"
          />
        </div>
      )}
    </div>
  )
}
