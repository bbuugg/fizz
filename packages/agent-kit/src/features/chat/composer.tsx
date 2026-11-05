/**
 * 会话输入区（composer）：外壳 + 发送 / 停止钮 + 左右两个 pill 槽位。
 *
 * 主会话（`ChatPanel`）与容器工作台（`flow/node-workbench`）的输入区本来是两份手写的
 * JSX —— 外壳、圆钮、pill 的类名各写一遍，只靠注释「与主会话对齐」维持一致，改一处
 * 忘一处就漂。这里把**真正共用的那部分**收成一个组件：
 * - 外壳：圆角卡片 + 恒定描边 + 无边框 textarea（Enter 发送 / Shift+Enter 换行）；
 * - 发送 / 停止圆钮：**同一个位置只放一颗钮**。没在跑 = 发送（空草稿时禁用占位）；
 *   跑着 + 空草稿 = 停止；跑着 + 有草稿 = 发送 / 发送方式选择器（队列消息 / 插话，
 *   仅调用方传了 `onSteer` 时）。停止快捷键仍是 Esc。
 * - 操作行布局：左 `leading`、右 `trailing`，发送 / 停止钮永远在最右。
 *
 * **刻意不共用**的是两侧 pill 里的东西：主会话那边是「工作区 / 后端模型（二级菜单）」，
 * 工作台那边是「权限 / 容器 Agent 的模型」—— 语义不同，所以做成槽位而不是写死。
 */
import { getAgentHost } from '@fizz/agent-client/host'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { useVoiceInput } from '@fizz/agent-kit/shared/hooks/useVoiceInput'
import { APP_EVENTS } from '@fizz/agent-kit/shared/lib/app-events'
import { permissionOption, permissionOptions } from '@fizz/agent-kit/shared/lib/permission'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'
import type { SlashCommand, SlashCommandContext } from '@fizz/agent-kit/shared/lib/slash-commands'
import { filterCommands, parseSlashInput } from '@fizz/agent-kit/shared/lib/slash-commands'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useVoiceSilenceTimeout } from '@fizz/agent-kit/shared/lib/voice-prefs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent } from '@fizz/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fizz/ui/select'
import type { AiPermissionMode } from '@fizz/contracts/types'
import {
  ChevronDown,
  Clock,
  Eye,
  ImagePlus,
  Loader2,
  Mic,
  Send,
  ShieldAlert,
  ShieldCheck,
  Square,
  Terminal,
  Zap
} from 'lucide-react'
import type { DragEvent as ReactDragEvent, ReactNode, RefObject } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * 输入行里的 pill 样式（工作区 / 权限 / 模型三个共用一份）。
 *
 * 它要同时喂给 shadcn 的 `SelectTrigger` 与手写 `button` 两套触发器，所以写了两种覆盖：
 * `h-8!` / `rounded-full!` / `shadow-none!` 是压掉 SelectTrigger 自带的
 * `rounded-md`、`border border-input`、`shadow-xs`、`dark:bg-input/30` —— 压掉才能跟手写的
 * 下拉触发器完全一致（手写那边这些类都没有，多写无害）。
 *
 * ⚠️ **hover 一律不加底色，只把文字 / 图标染成主题色**（用户明确要求：指向这些按钮时不许
 * 出现背景块）。两个 `bg-transparent!` 不是装饰，是必需的覆盖：
 * - `hover:bg-transparent!` / `dark:hover:bg-transparent!` 压掉 `SelectTrigger` 自带的
 *   `dark:hover:bg-input/50`（不加 `!` 时两者特异度相同、谁赢看产物 CSS 顺序，等于掷骰子）；
 * - `hover:[&_svg]:text-primary` 是必需的：pill 里的图标各自写着 `text-muted-foreground`，
 *   子元素自己的 class 永远压过父容器继承下来的颜色，只写 `hover:text-primary` 的话
 *   纯图标 pill（MCP / 附件 / 权限）hover 起来毫无变化。`[&_svg]:transition-colors`
 *   让这枚颜色变化跟着父容器的 `transition-all` 一起过渡。
 *
 * `text-foreground` 也**别删**：pill 的文字颜色必须自己带上，不能只靠 `body` 继承 ——
 * 这三个触发器一个是 Radix 的 `SelectTrigger`（角色是 combobox）、两个是手写 `button`，
 * 一旦某条链上没接到 `text-foreground`（UA 对表单控件的默认色 / 用户代理的暗色策略），
 * 暗色下就退回成黑字压暗底，整颗 pill 直接糊掉。显式声明后亮暗两色都由主题变量决定。
 *
 * 右侧箭头：**一律不显示**（各调用方自己不再渲染 `ChevronDown`，Select 走 `icon={false}`）。
 */
export const CHAT_PILL =
  'flex h-8! max-w-48 min-w-0 items-center gap-1.5 rounded-full! border-none bg-transparent px-3 text-sm text-foreground shadow-none! outline-none transition-all hover:bg-transparent! hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-transparent! dark:hover:bg-transparent! [&_svg]:transition-colors hover:[&_svg]:text-primary'

/**
 * 纯图标 pill：与 `CHAT_PILL` 同一 hover / 焦点 / 配色，但收成一颗方形小图标位 ——
 * 触发器上不放文字（信息挪进下拉与 tooltip）。`size-8` 与右侧语音 / 发送圆钮同高，
 * 一行排开高度一致；`shrink-0` 防止被挤没（图标没了就什么都不剩了）。
 *
 * 与 `CHAT_PILL` 同理，这里必须用 `!`：`SelectTrigger` 自带 `w-fit`（宽度撑到内容 + `px-3`）、
 * `data-[size=default]:h-9`（属性选择器特异度高于单个类）与 `px-3 py-2`，不加 `!` 就会被它压过去
 * —— 表现为**权限那颗（Select）比 MCP（手写 button）宽一截、扁一排**。
 * `p-0!` 一并压掉内边距：`size-8!` 锁死 32px 后，`px-3` 会把内容盒挤到只剩 8px，图标跟着缩水。
 *
 * hover 与 `CHAT_PILL` 完全同款（无底色、只染主题色），原因见上面那段。
 *
 * ⚠️ 唯一的例外是**权限 pill 的图标**：它的颜色是档位语义（琥珀 = 完全访问的警示），
 * 不许被 hover 染成主题色 —— 那边用 `!` 压掉了这条规则，见 `PermissionIcon`。
 */
export const CHAT_ICON_PILL =
  'flex size-8! shrink-0 items-center justify-center rounded-full! border-none bg-transparent p-0! text-foreground shadow-none! outline-none transition-all hover:bg-transparent! hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-transparent! dark:hover:bg-transparent! [&_svg]:transition-colors hover:[&_svg]:text-primary'

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  /** 发送（Enter 或点发送钮） */
  onSubmit: () => void
  /**
   * 插话：把草稿插进**正在跑的这一轮**，在下一个工具步骤边界生效（不算新一轮）。
   *
   * 不传 = 没有这个能力（初始页 / ACP 会话 / 容器工作台）—— 此时「跑着 + 有字」仍只给
   * 普通发送钮（主会话会入队）。传了才会把「跑着 + 有字」的发送钮换成
   * 「队列消息 / 插话」选择器（见 `sendChooser`）。
   */
  onSteer?: () => void
  /** 停止（点停止钮，或输入框里按 Esc） */
  onCancel: () => void
  streaming: boolean
  /** 输入框与发送钮一并不可用（会话未就绪 / 没选工作区…） */
  disabled?: boolean
  /**
   * 只禁**发送**、不禁输入（手动压缩进行中）：发送钮灰掉、Enter 不出手，
   * 字照常打 —— 压缩只挡「发」这个动作，不挡编辑草稿。
   */
  sendDisabled?: boolean
  /**
   * 禁发时发送钮 tooltip 的具体原因（如「附件上传中，等上传完成后再发」）。
   * 不传回落「上下文压缩中，稍后再发」—— 历史默认只在压缩进行中禁发。
   */
  sendDisabledHint?: string
  /**
   * 有附件没文字也允许发送（附件本身就是有效内容）：发送钮不再因「草稿为空」禁用。
   * 由调用方按附件区状态计算；Enter 的拦截仍走 `sendDisabled`（上传中不能发）。
   */
  allowEmptySend?: boolean
  /**
   * 已提交、但这一轮还没真正开跑（正在建会话 / 起外部 agent）：发送钮换成转圈、不可点。
   *
   * 与 `streaming` 的区别：`streaming` 是「这一轮在跑」（停止钮 / 入队选择器那一套），
   * 这里还什么都没开始 —— 只是提交之后那一段空窗。不转圈的话用户会以为没点上而反复点。
   */
  sending?: boolean
  placeholder?: string
  /** 操作行左侧（工作区 / 权限） */
  leading?: ReactNode
  /** 操作行右侧、**发送钮左边**（模型） */
  trailing?: ReactNode
  /**
   * 输入框上方的内容（如待发送队列）：渲染在**同一张卡片内**，与 textarea 浑然一体。
   * 自带底部分隔线，不需要调用方再包边框。
   */
  header?: ReactNode
  /** 暴露 textarea 引用（编辑队列消息写回输入框后聚焦用） */
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  /**
   * 粘贴 / 拖拽进来的文件（截图、复制的图片、从资源管理器拖来的文件）。
   *
   * 附件能力在调用方（`ChatPanel` 的 `onPickFiles`）：这里只负责「把文件捞出来」，
   * 校验 / 上传 / 预览一概不管。不传 = 这个输入框没有附件区（容器工作台、ACP 会话）
   * —— 那时既不拦粘贴，也不接管拖拽。
   */
  onAttachFiles?: (files: File[]) => void
  /**
   * 斜线命令（不传 = 无此功能，工作台不受影响）。输入以 `/` 开头时在输入框
   * **上方**浮出命令列表（绝对定位浮层，不挤压输入框高度），交互：
   * ↑↓ 选择、Tab/点击补全、Enter 执行（只有命令名没参数时先补全）、Esc 只关浮层。
   */
  slashCommands?: SlashCommand[]
  /** 命令执行上下文（与 slashCommands 一同传） */
  slashContext?: SlashCommandContext
  /**
   * 紧凑输入框：初始高度收成一行的量级（而不是默认的三行）。
   *
   * 给**窄面板**里的助手用 —— 面板只有 ~384px 宽（可拖到 320），默认 `min-h-[72px]`
   * 的三行框在那种宽度下显得又高又空。`field-sizing-content` 仍然会在内容变长时自己
   * 长高，所以收的只是**初始**高度，不牺牲长文本编辑。
   *
   * 一行 + `py-2.5` ≈ 43px（比早先的 36px 高一档：36px 在窄面板里贴着边、显得局促）。
   * 高度用 `1lh + 内边距` 表达，与正文行高天然一致 —— 空态和刚敲一个字不会差几像素。
   */
  compact?: boolean
}

/**
 * 聊天输入区。
 *
 * 受控组件：草稿由调用方持有 —— 主会话的草稿在 `PromptInputProvider` 里（侧栏「编辑并
 * 重发」要往里灌文本），工作台的草稿是它自己的 `useState`。这里不替它们做决定。
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onSteer,
  onCancel,
  streaming,
  disabled,
  sendDisabled,
  sendDisabledHint,
  allowEmptySend,
  sending,
  placeholder,
  leading,
  trailing,
  header,
  textareaRef,
  onAttachFiles,
  slashCommands,
  slashContext,
  compact = false
}: ComposerProps) {
  // 订阅语言：下面这些文案都在渲染期求值（`t()`）
  const tr = useT()
  // ---------- 斜线命令 ----------
  /**
   * 浮层只在「前缀输入阶段」打开（`/` 或 `/st`）：一旦带了参数（空格后还有正文）
   * 就收起 —— 那时命令已经选定，列表只会挡住正在写的正文。提交时由调用方用
   * `parseSlashInput` 做最终分发（这里只管选与补全）。
   */
  // Esc 只关浮层不清草稿：dismissed 在草稿不再匹配命令形状时自动复位
  const [dismissed, setDismissed] = useState(false)
  const paletteOpen = useMemo(() => {
    if (!slashCommands || dismissed) return false
    const text = value.trimStart()
    return /^\/[a-z0-9-]*$/.test(text)
  }, [slashCommands, dismissed, value])
  useEffect(() => {
    if (!paletteOpen) setDismissed(false)
  }, [paletteOpen])
  const candidates = useMemo(
    () =>
      paletteOpen && slashCommands
        ? filterCommands(slashCommands, value.trimStart()).filter(
          (c) => !c.available || (slashContext ? c.available(slashContext) : true)
        )
        : [],
    [paletteOpen, slashCommands, slashContext, value]
  )
  const [highlight, setHighlight] = useState(0)
  useEffect(() => {
    // 候选变化时把高亮拉回第一项（打字过滤后原下标可能越界）
    setHighlight(0)
  }, [candidates.length, value])
  const completeCommand = (command: SlashCommand): void => {
    onChange(`/${command.name} `)
    requestAnimationFrame(() => textareaRef?.current?.focus())
  }
  const runHighlighted = (): void => {
    const command = candidates[highlight]
    if (!command || !slashContext) return
    const parsed = parseSlashInput(value)
    const args = parsed?.command === command.name ? parsed.args : ''
    // 无参命令直接跑：它的「参数」就是命令名本身，补全成 `/agents ` 只会让用户
    // 面对一个光标不知道该打什么（与 resolveSlashDispatch 的 noArgs 分支同一条判据）。
    if (!args && !command.noArgs) {
      // 只有命令名没参数：先补全（argsHint 提示用户接着写）
      completeCommand(command)
      return
    }
    onChange('')
    command.run(slashContext, args)
  }

  /**
   * 语音输入：只在浏览器支持时出按钮，收音结果并到输入框（受控组件的 value 归调用方管）
   * 静音超时（秒）→ 毫秒；0 = 不自动停（useVoiceInput 里 <=0 视为不限）
   *
   * ⚠️ desktop（Electron 渲染进程）暂时不可用：Chromium 的语音识别依赖宿主环境没有的
   * 语音服务，按钮点下去也不会有任何反应，所以先按平台把入口收掉（web 端保留）。
   * 恢复时删掉 `isDesktopHost` 这个判断即可，别去动 `useVoiceInput`。
   */
  const isDesktopHost = !getAgentHost().capabilities.voice
  const silenceSec = useVoiceSilenceTimeout()
  const voice = useVoiceInput({
    onTranscript: (text) => {
      const separator = value && !value.endsWith(' ') ? ' ' : ''
      onChange(value + separator + text)
    },
    silenceTimeoutMs: silenceSec > 0 ? silenceSec * 1000 : 0
  })

  /**
   * 接住「按住说话」快捷键：app-shell 在 keydown / keyup 时广播开启 / 取消。
   * - 开启：直接 start（不支持 / 未就绪时由 disabled 守卫挡掉；已经在听 —— 比如点了按钮
   *   开着的 —— 不接管，避免松手时误关掉别人的麦）。
   * - 取消（松手）：stop 停止收音（并清掉半句临时结果，即「取消输入」），再把焦点交回
   *   输入框，方便接着打字 —— 这正是「松手为取消 + 自动 focus 输入框」。
   * 会话进行中（streaming）也能用：麦克风按钮不再禁用，按住说的字并进草稿、本轮结束自动发。
   */
  const voiceStartedByShortcutRef = useRef(false)
  useEffect(() => {
    const onStart = (): void => {
      if (disabled) return
      // start() 返回 false = 本来就在听（比如已用按钮开着的麦），此时不接管，
      // 松手时也就不会去关掉别人的麦。start() 内部用同步镜像判断，不依赖这里
      // 可能过期的 voice.listening（事件 effect 只在 disabled/textareaRef 变化时重建）。
      if (voice.start()) voiceStartedByShortcutRef.current = true
    }
    const onStop = (): void => {
      if (!voiceStartedByShortcutRef.current) return
      voiceStartedByShortcutRef.current = false
      voice.stop()
      requestAnimationFrame(() => textareaRef?.current?.focus())
    }
    window.addEventListener(APP_EVENTS.voiceStart, onStart)
    window.addEventListener(APP_EVENTS.voiceStop, onStop)
    return () => {
      window.removeEventListener(APP_EVENTS.voiceStart, onStart)
      window.removeEventListener(APP_EVENTS.voiceStop, onStop)
    }
    // voice 每次渲染重建函数但只读内部 ref，旧闭包照样可用；textareaRef 是稳定 ref 对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, textareaRef])

  /**
   * 右下角这颗（或这两颗）圆钮显示什么。
   *
   * 按钮只表达**点了会发生什么**，所以按「此刻能做的事」挑：
   * - 没在跑 → 发送（空草稿时禁用占位）；
   * - 跑着 + 空草稿 → 停止；
   * - 跑着 + 有草稿 → 发送：
   *   - 支持插话（传了 `onSteer`）→ **发送方式选择器**：队列消息（本轮结束后按序自动发）
   *     还是插话（插进当前这一轮，下个工具步骤边界生效）；
   *   - 不支持插话 → 普通发送（主会话 `send` 会在跑时入队、本轮结束由泵自动发走，
   *     所以「正在跑」从来不是不能发的理由）。
   *
   * 同一位置只保留一颗钮（用户明确要求）。有草稿时若想中止本轮，清空草稿或按 Esc。
   */
  const hasDraft = value.trim() !== ''
  /**
   * 「有内容」= 有字**或**有可发送的附件（附件由调用方经 `allowEmptySend` 告知：
   * 附件本身就是有效内容，只发附件不打字是允许的）。
   *
   * 这两颗钮只表达「此刻能做什么」，所以判据必须是**内容**而不是「文字」：
   * 只认文字的话，「流式中 + 只有附件」会掉到停止钮那支上 —— 内容备好了却发不出去，
   * 插话（sendChooser）同样出不来。
   */
  const hasContent = hasDraft || !!allowEmptySend
  /**
   * 提交后到开跑前的空窗（`sending`）：这个位置换成一个转圈的假按钮。
   *
   * 只抢**发送钮**这个位置，不动停止钮 / 入队选择器 —— 空窗里 `streaming` 还是 false，
   * 那两支本来就出不来。`sending` 期间草稿**仍在输入框里**（建 ACP 会话失败时要还给
   * 用户，见 ChatPanel 的 `onStarted`），`hasContent` 仍为真，所以必须显式参与分支判断，
   * 否则会掉到「发送钮」那一支，点了就是重复提交。
   */
  const showSending = !!sending
  const sendChooser = !showSending && streaming && hasContent && !!onSteer
  const showSend = !showSending && (hasContent || !streaming)
  /** 停止钮只在没有草稿时占这个位置；有草稿时让给发送，见上面那段 */
  const showStop = !showSending && streaming && !hasContent
  const sendTitle = streaming ? tr('发送（本轮结束后自动执行）') : tr('发送')

  // ---------- 粘贴 / 拖拽上传附件 ----------
  /**
   * 只在调用方给了 `onAttachFiles`（= 这个输入框有附件区）时才接管粘贴与拖放：
   *
   * - 粘贴：剪贴板里有**文件**（截图、复制的图片）才拦 —— 不拦的话 Chromium 会把
   *   `<img>` / 图片的 alt 文本之类塞进 textarea（截图粘贴最常见的表现就是一串乱码 + 图裂）。
   *   纯文本粘贴 items 里没有 kind==='file'，照常放行，不影响普通复制粘贴。
   * - 拖放：监听**整张卡片**（不只 textarea），让「拖到输入框上」这个意图成立。
   *   `dragDepth` 计数抵消子元素之间 enter/leave 的抖动，否则光标一滑过内部元素高亮就闪。
   */
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const dragHasFiles = (e: ReactDragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!onAttachFiles) return
    const data = e.clipboardData
    if (!data) return
    const files: File[] = []
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
    // 少数平台 items 里拿不到 file（只有 files），兜一层
    if (files.length === 0) files.push(...Array.from(data.files))
    if (files.length === 0) return
    e.preventDefault()
    onAttachFiles(files)
  }

  const handleDragEnter = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!onAttachFiles || !dragHasFiles(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }
  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!onAttachFiles || !dragHasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (): void => {
    if (!onAttachFiles) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  const handleDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!onAttachFiles) return
    dragDepth.current = 0
    setDragActive(false)
    e.preventDefault()
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length > 0) onAttachFiles(files)
  }

  /**
   * 窗口级护栏：往输入框**外面**（消息列表 / 侧栏）拖文件松手时，Chromium 会直接
   * **导航到那个文件**，整个应用被替换成一个 file:// 页面 —— 拖歪了就得重启。
   * 带文件的拖拽一律吞掉默认行为；输入框自己那份 drop 在冒泡到达 window 之前已处理完。
   * 只认 `Files` 类型，应用内部的 HTML5 拖拽（文本 / 元素）不受影响。
   */
  const canAttach = !!onAttachFiles
  useEffect(() => {
    if (!canAttach) return
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const swallow = (e: DragEvent): void => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      // 在卡片外面松手：文件不会被接住，高亮也得收掉
      if (e.type === 'drop') reset()
    }
    // Esc 取消拖拽时浏览器不会再发 card 的 dragleave —— 唯一信号是鼠标已离开窗口
    // （clientX/Y 归零），靠它收掉高亮，否则浮层会一直挂着
    const onWindowLeave = (e: DragEvent): void => {
      if (e.clientX <= 0 && e.clientY <= 0) reset()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    window.addEventListener('dragleave', onWindowLeave)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
      window.removeEventListener('dragleave', onWindowLeave)
    }
  }, [canAttach])

  // 斜线命令浮层走 Radix Popover（Portal 到 body）：输入框外层的壳有
  // `overflow-y-auto`（滚动态护栏），absolute 定位的浮层上探一截就被它裁掉
  // ——「被消息列表挡住」就是这条裁剪。Portal + side="top" 与别处「向上弹」的
  // 下拉同一套模式；焦点必须留在 textarea（onOpenAutoFocus 阻止），打字才不中断。
  const paletteVisible = paletteOpen && candidates.length > 0
  return (
    <Popover open={paletteVisible}>
      <PopoverAnchor asChild>
        <div
          // 整张卡片是拖放区（不只 textarea）：拖到卡片任何位置都算「要加进这个输入框」；
          // `relative` 供拖拽高亮浮层定位
          className={cn(
            'relative rounded-xl border border-border bg-card/70 transition-colors',
            dragActive && 'border-primary ring-2 ring-primary/25'
          )}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* 拖拽高亮：`pointer-events-none` 必须——浮层不能挡住 drop 的命中目标 */}
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/5">
              <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground shadow-sm">
                <ImagePlus className="size-3.5 text-muted-foreground" />
                {tr('松开以添加附件')}
              </span>
            </div>
          )}
          {header}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              // 斜线命令浮层打开时先接管导航键：↑↓ 选择、Tab 补全、Enter 执行/补全、
              // Esc 只关浮层（不触发「停止本轮」——用户是在选命令，不是要刹车）
              if (paletteOpen && candidates.length > 0 && slashContext) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHighlight((h) => (e.key === 'ArrowDown' ? (h + 1) % candidates.length : (h - 1 + candidates.length) % candidates.length))
                  return
                }
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const command = candidates[highlight]
                  if (command) completeCommand(command)
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  runHighlighted()
                  return
                }
                if (e.key === 'Escape') {
                  // 只关浮层，草稿保留（换行 / 改一个字符都会重新浮出来）
                  e.preventDefault()
                  setDismissed(true)
                  return
                }
              }
              // Enter 发送、Shift+Enter 换行（输入法组合中的 Enter 不抢）
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                // 压缩进行中禁发（sendDisabled）：Enter 出不了手，草稿照常编辑；
                // 建会话途中（sending）同理 —— 草稿还在，不拦就是重复提交
                if (!sendDisabled && !sending) {
                  e.preventDefault()
                  onSubmit()
                }
                return
              }
              // Esc = 停止本轮（键盘党的快捷方式）。草稿非空时最右那颗钮是发送，
              // 这时 Esc 是中止本轮的入口（见 showStop / 上面的按钮分配说明）。
              // 弹窗开着时焦点被 Radix 锁在弹窗里、走不到这里，所以不会和「Esc 关弹窗」打架。
              if (e.key === 'Escape' && streaming) {
                e.preventDefault()
                onCancel()
              }
            }}
            rows={compact ? 1 : 3}
            placeholder={placeholder}
            disabled={disabled}
            className={cn(
              'block max-h-40 w-full resize-none bg-transparent px-3 text-sm leading-relaxed outline-none [scrollbar-width:none] placeholder:text-muted-foreground field-sizing-content disabled:opacity-50 [&::-webkit-scrollbar]:hidden',
              // 紧凑态：初始一行高（约 43px）+ 略宽的纵向内边距（py-2.5）；默认仍是三行 / 72px。
              //
              // 为什么 `min-h` 和 `placeholder-shown:h-*` 必须是**同一个算式**：
              // `field-sizing-content` 把 placeholder 也算进固有尺寸，所以空态得把高度钉死
              // （`placeholder-shown:` 那半），否则窄窗口 / 手机端（根字号 18px）里长 placeholder
              // 折行会把框撑高、敲一个字又缩回去。但钉的值若和「一行正文」的实际高度不一致，
              // 就变成空态一个高度、输入第一个字又跳一下 —— 早上那版 `h-9`(36px) vs 正文 38.75px
              // 就是这个残留。用 `1lh + 上下内边距` 写，两边天然相等，也不受根字号影响（不写死 px）。
              compact
                ? 'min-h-[calc(1lh_+_1.25rem)] py-2.5 placeholder-shown:h-[calc(1lh_+_1.25rem)]'
                : 'min-h-[72px] py-2.5 placeholder-shown:h-[72px]'
            )}
          />

          {/* 语音识别临时文本：边说边显，停止后消失。放在卡片内、操作行上方，与输入框浑然一体 */}
          {voice.interim && (
            <div className="px-3 pb-1 text-xs text-muted-foreground italic">{voice.interim}</div>
          )}

          {/* 操作行：左 `leading`、右 `trailing`（模型）+ 语音 + 发送 / 停止 */}
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-1">{leading}</div>
            {/* ⚠️ 右侧这组也必须 `min-w-0`：Flex 项默认 `min-width:auto`，不给就会按内容
            撑开、拒绝收缩 —— 窄面板下模型 pill（`CHAT_PILL` 的 `max-w-56`）把整组顶宽，
            连语音 / 发送钮一起挤出卡片（`justify-between` 撑不住溢出的内容）。
            给了之后 pill 才能随行宽收缩、内部文字按 `truncate` 截断，圆钮因为 `shrink-0` 原地不动。 */}
            <div className="flex min-w-0 items-center gap-2">
              {trailing}
              {!isDesktopHost && voice.supported && (
                <IconTip label={voice.listening ? tr('停止录音') : tr('语音输入（也可按住 Alt+V 说话）')}>
                  <button
                    type="button"
                    aria-label={voice.listening ? tr('停止录音') : tr('语音输入')}
                    disabled={disabled}
                    onClick={voice.listening ? voice.stop : voice.start}
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full transition-colors',
                      // 录音中那颗是**状态**（主色实底），与 hover 无关，保留；
                      // 未录音时与这一排 pill 同款：hover 不加底色，只把图标染成主题色
                      voice.listening
                        ? 'bg-primary text-primary-foreground animate-pulse'
                        : 'border border-border bg-transparent text-muted-foreground hover:text-primary'
                    )}
                  >
                    <Mic className="size-4" />
                  </button>
                </IconTip>
              )}
              {/*
            停止：红底白方块。跑着且草稿为空时占最右那颗钮的位置；一旦输入了新内容，
            这个位置让给发送 / 发送方式选择器（同一位置只保留一颗钮）。
          */}
              {showStop && (
                <IconTip label={tr('停止本轮')}>
                  <button
                    type="button"
                    aria-label={tr('停止')}
                    disabled={disabled}
                    onClick={onCancel}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive text-white transition-colors hover:bg-destructive/90 disabled:opacity-40"
                  >
                    <Square className="size-4 fill-current" />
                  </button>
                </IconTip>
              )}
              {showSending ? (
                /*
                  提交后到开跑前的空窗（见 `sending` 的说明）：**同一位置、同一尺寸**的转圈钮。
                  做成 disabled 的按钮而不是纯 div —— 尺寸 / 底色 / 圆角与发送钮逐像素一致，
                  空窗结束切回来时这颗位置不会跳。`aria-busy` 让读屏也知道「正在提交」。
                */
                <IconTip label={tr('正在创建会话…')}>
                  <button
                    type="button"
                    aria-label={tr('正在创建会话')}
                    aria-busy
                    disabled
                    className="flex size-8 shrink-0 cursor-default items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-100"
                  >
                    <Loader2 className="size-4 animate-spin" />
                  </button>
                </IconTip>
              ) : sendChooser ? (
                /*
                  发送方式选择器（跑着 + 有字 + 支持插话）：点开发送钮选「队列消息」还是「插话」。
                  两种去向都有现成落点 —— 队列 → onSubmit（主会话 send 会入队，进「待发送」列表）；
                  插话 → onSteer（进「插入中」列表，下个工具步骤边界生效）。
                  图标加一个小箭头，明示这颗钮是「先选再发」而不是直接发。
                */
                <DropdownMenu>
                  <IconTip
                    label={
                      sendDisabled ? (sendDisabledHint ?? tr('上下文压缩中，稍后再发')) : tr('选择发送方式：队列消息 / 插话')
                    }
                  >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={tr('选择发送方式：队列消息或插话')}
                        disabled={disabled || sendDisabled || !hasContent}
                        className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Send className="size-4" />
                        <ChevronDown className="size-3 opacity-80" />
                      </button>
                    </DropdownMenuTrigger>
                  </IconTip>
                  <DropdownMenuContent side="top" align="end" sideOffset={6} className="min-w-64">
                    <DropdownMenuItem onSelect={onSubmit}>
                      <Clock className="size-3.5" />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span>{tr('队列消息')}</span>
                        <span className="text-xs text-muted-foreground">{tr('本轮结束后按顺序自动发送')}</span>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onSteer?.()}>
                      <Zap className="size-3.5" />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span>{tr('插话')}</span>
                        <span className="text-xs text-muted-foreground">
                          {tr('插入当前轮，下一个工具步骤边界生效')}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : showSend ? (
                // 发送：主色圆钮，空草稿禁用（空草稿 + 跑着时这个位置是停止钮，见 showStop）；
                // sendDisabled（压缩进行中）只灰发送钮，不影响打字
                <IconTip label={sendDisabled ? (sendDisabledHint ?? tr('上下文压缩中，稍后再发')) : sendTitle}>
                  <button
                    type="button"
                    aria-label={tr('发送')}
                    disabled={disabled || sendDisabled || (!hasDraft && !allowEmptySend)}
                    onClick={onSubmit}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send className="size-4" />
                  </button>
                </IconTip>
              ) : null}
            </div>
          </div>
        </div>
      </PopoverAnchor>
      {paletteVisible && (
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          role="listbox"
          aria-label={tr('斜线命令')}
          className="w-[var(--radix-popover-trigger-width)] min-w-64 max-h-64 overflow-y-auto rounded-xl p-1"
        >
          {candidates.map((command, i) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className={cn(
                'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                i === highlight ? 'bg-foreground/10' : 'hover:bg-foreground/5'
              )}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => {
                const parsed = parseSlashInput(value)
                const args = parsed?.command === command.name ? parsed.args : ''
                if (!args && !command.noArgs) completeCommand(command)
                else {
                  onChange('')
                  command.run(slashContext!, args)
                }
              }}
            >
              <Terminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-xs text-foreground">/{command.name}</span>
                  <span className="text-xs font-medium text-foreground">{command.displayName}</span>
                  {command.argsHint && (
                    <span className="truncate text-xs text-muted-foreground">{command.argsHint}</span>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">{command.description}</span>
              </span>
            </button>
          ))}
        </PopoverContent>
      )}
    </Popover>
  )
}

/**
 * 工具权限 pill：三档（确认 / 只读 / 完全访问）。
 *
 * 主会话与容器工作台共用 —— 两边的**文案与图标必须一致**，否则同一个概念在两个地方
 * 叫法不同，用户会以为是两回事。真正的语义两边各不相同：
 * - 主会话：服务端 `guardWrite` 拦工具调用；
 * - 容器工作台：容器 bridge 按档位答复 ACP 的 `session/request_permission`。
 */
export function PermissionPill({
  value,
  onChange,
  disabled
}: {
  value: AiPermissionMode
  onChange: (mode: AiPermissionMode) => void
  disabled?: boolean
}) {
  const tr = useT()
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AiPermissionMode)} disabled={disabled}>
      {/* 触发器只放图标：图标本身编码档位（只读 = 眼睛、确认 = 盾、完全访问 = 琥珀警示盾），
          档名进 tooltip 与下拉（选中项打勾）。SelectValue 换成手绘图标 —— 值是受控的，
          图标跟 `value` prop 走，不吃 Select 的自动展示。 */}
      <SelectTrigger
        className={CHAT_ICON_PILL}
        // 一排 pill 都不露右侧箭头（见 CHAT_PILL 的说明）：这颗是 Select，箭头由
        // SelectTrigger 自己渲染，所以关掉它的
        icon={false}
        aria-label={tr('工具权限：{label}', { label: permissionOption(value).label })}
      >
        {/* mx-auto 居中：SelectTrigger 自带 justify-between，单个子元素会被顶到左边 */}
        <span className="mx-auto flex items-center">
          <PermissionIcon mode={value} />
        </span>
      </SelectTrigger>
      {/* 几个 pill 的下拉表现必须一致：都是 popper + side="top" + sideOffset={6}。
          shadcn 的 Select 默认 position="item-aligned"（把选中项铺在触发器上、往下摊），
          而这些触发器都贴在窗口底部 —— 不改成 popper 就会跟模型那个浮层长得不一样 */}
      <SelectContent position="popper" side="top" align="start" sideOffset={6}>
        {permissionOptions().map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex items-center gap-1.5">
              <PermissionIcon mode={option.value} />
              <span>{option.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * 权限模式的图标：完全访问给个警示色，别让它悄无声息地开着。
 * 触发器和下拉项共用（Radix 的 SelectValue 渲染的正是选中项的内容）。
 */
function PermissionIcon({ mode }: { mode: AiPermissionMode }) {
  const Icon = mode === 'readonly' ? Eye : mode === 'full' ? ShieldAlert : ShieldCheck
  return (
    <span className="flex items-center">
      {/* 颜色挂在 svg 自己身上，别挂在外层 span 上：SelectTrigger 有一条
          `[&_svg:not([class*='text-'])]:text-muted-foreground`，会盖掉 span 继承下来的琥珀色
          ——「完全访问」的警示色在触发器里就是这么被吃掉的（下拉项里没事，那边没有这条规则） */}
      <Icon
        className={cn(
          'size-3.5',
          /*
           * 两个 `!` 压掉 pill 的 `hover:[&_svg]:text-primary`（父选择器 `[&_svg]` 的特异度
           * 高于图标自己这个 class，不加 `!` 必输）：这枚图标的颜色是**档位语义**
           * —— 琥珀 = 完全访问的警示，hover 时被染成主题色等于把警示抹掉，用户明确要求
           * 权限图标 hover 不许变主色调。其余 pill 的 hover 染色不受影响（那条规则还在）。
           */
          mode === 'full' ? 'text-amber-600! dark:text-amber-500!' : 'text-muted-foreground!'
        )}
      />
    </span>
  )
}

/**
 * 模型选择那颗 pill 已经整块搬到 `ModelPicker.tsx`（受控版）：
 * 定时任务表单要的是**会话详情同一颗**（分组 + 设置齿轮 + ACP 白名单），而不是这里原先
 * 那层平铺清单；留两份就是两个功能。本文件只保留 `PermissionPill` 与 `CHAT_PILL` 这层皮。
 */
