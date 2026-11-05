/**
 * Monaco 编辑器（从根应用 `shared/components/MonacoEditor.tsx` 迁移到 shadcn/原生）：
 * 语言标签/切换、行号与自动换行开关、格式化、复制、下载、只读徽标。
 *
 * 工具栏里的语言下拉是 shadcn `Select`（`shared/ui/select`），其余开关是原生 `button`
 * —— 工具栏只有 24px 高，`Button` 那套尺寸用不上。`SelectTrigger` 自带一组挂在
 * `[data-size=…]` 上的高度类（`px-3 py-2` / `shadow-xs` 同理），**属性选择器的特异度高于
 * 单个类**，所以那串覆盖必须带 `!`（同 `composer.tsx` 的 `CHAT_PILL`）。
 *
 * ⚠️ 这里刻意**不写出那些类的字面量**：Tailwind v4 按**原始文本**扫源码（不解析注释），
 * 注释里写一个「属性选择器形状 + 通配占位」的假类名，会被它当成真类名、生成一条**非法**的
 * 选择器规则塞进产物 —— LightningCSS 对非法**选择器**不报警，只有非法**声明值**才报，
 * 所以这类脏规则会静悄悄地留在 CSS 里（真要去翻，搜产物里的 `data-size` 就能看到那条）。
 *
 * Monaco 资源不走 CDN：loader.config 指向本地静态目录 /monaco-editor/vs
 * （由 scripts/copy-monaco.cjs 在 dev / build 前复制到 public/monaco-editor）。
 *
 * 加载态：`@monaco-editor/react` 在 `editor.main` 落地前会把 `loading` 节点塞进一个
 * 居中容器（`height/width:100%` + `justify-center items-center`），默认值是**裸的
 * `"Loading..."` 文本** —— 既没样式、也不跟语言走。这里换成 shadcn 的 `Spinner` +
 * 一句 `加载中…`（这条文案在 `i18n` 里有英文对照，别写死）。
 */
import Editor, { loader } from '@monaco-editor/react'
import { Braces, Check, Code, Copy, Download, Hash, Lock, WrapText } from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import { Spinner } from '@fizz/ui/spinner'
import { scalePx } from '@fizz/agent-kit/shared/lib/ui-scale'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import {
  buildMonacoTheme,
  readSyntaxColors,
  useThemeRevision
} from '@fizz/agent-kit/shared/lib/code-theme'

loader.config({
  paths: {
    // Monaco 静态目录挂在站点根：web（http）下用绝对路径 `/monaco-editor/vs`；
    // 桌面端是 `file://` 加载（loadFile），绝对路径会被解析成文件系统根
    // （`file:///C:/monaco-editor/...`）→ ERR_FILE_NOT_FOUND，必须相对 index.html 解析
    // （public/monaco-editor 会随构建拷到 renderer 产物旁边）。
    // 若以后 web 配了 basePath，`/monaco-editor/vs` 这里要跟着加前缀。
    vs:
      window.location.protocol === 'file:'
        ? new URL('monaco-editor/vs/', document.baseURI).href
        : '/monaco-editor/vs'
  }
})

/**
 * Chrome 扩展（MV3）下的 worker 引导壳替换。
 *
 * monaco 起 worker 的方式是「blob 包一层」：`new Worker(URL.createObjectURL(new Blob([
 * "importScripts('<真实的 worker 文件>');postMessage({type:'vscode-worker-ready'})"])))`。
 * worker 本体是同源文件（`vs/assets/*.worker-*.js`），blob 只是引导壳 —— 但 MV3 扩展页面的
 * CSP **不允许** `worker-src blob:`（Chrome 装扩展时直接拒："Insecure CSP value \"blob:\"
 * in directive 'worker-src'"）。
 *
 * `scripts/copy-monaco.cjs` 在拷贝时生成了两个替代品：
 * `vs/worker-map.json`（带哈希的 worker 文件名 → 语义名，哈希随版本变只能拷贝时扫出来）
 * 和 `vs/worker-proxy.js`（同源的经典脚本壳，从 `?u=` 读目标地址，语义与 blob 壳逐行一致）。
 * 这里把 `MonacoEnvironment.getWorker` 换成「查 map → 拼代理地址」的实现。
 *
 * 时机：必须装在 **editor.main 求值之后** —— monaco 会把自己的 `getWorker` **整个覆写**上
 * `self.MonacoEnvironment`，先装会被顶掉。`beforeMount` 恰好在 loader 加载完、建第一个编辑
 * 实例之前，且换目标组件也不会重复装（`shimInstalled` 兜底）。
 *
 * 只在 `chrome-extension://` 下生效：web / desktop / mobile 没有这份 CSP 约束，别动它们的
 * 原生路径。map 取不到（旧拷贝产物没有这两个文件）就保持原样 —— 那 blob 会照旧被 CSP 拦，
 * monaco 对 worker 创建失败有降级（语言服务退回主线程），不至于白屏。
 */
let shimInstalled = false
function installCspSafeWorkerShim(): void {
  if (shimInstalled) return
  shimInstalled = true
  if (window.location.protocol !== 'chrome-extension:') return
  const env = (self as unknown as { MonacoEnvironment?: { getWorker?: (label: string) => Worker } })
    .MonacoEnvironment
  if (!env) return

  const vsBase = new URL('monaco-editor/vs/', document.baseURI).href
  fetch(`${vsBase}worker-map.json`)
    .then((res) => (res.ok ? (res.json() as Promise<Record<string, string>>) : null))
    .then((map) => {
      if (!map) return
      const fileFor = (label: string): string => {
        if (label === 'json') return map.json
        if (label === 'css' || label === 'scss' || label === 'less') return map.css
        if (label === 'html' || label === 'handlebars' || label === 'razor') return map.html
        if (label === 'typescript' || label === 'javascript') return map.ts
        return map.editor
      }
      const proxy = `${vsBase}worker-proxy.js`
      env.getWorker = (label: string): Worker => {
        const target = new URL(fileFor(label), vsBase).href
        return new Worker(`${proxy}?u=${encodeURIComponent(target)}`)
      }
    })
    .catch(() => {
      // map 读不到就保持 monaco 原生路径，别让扩展页因为这个挂掉
    })
}

/** `beforeMount` 拿到的就是 monaco 命名空间 */
type Monaco = Parameters<NonNullable<ComponentProps<typeof Editor>['beforeMount']>>[0]

const MONO_FALLBACK = "'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace"

/**
 * 等宽字体跟随主题：`--fizz-font-mono` 是主题 / 自定义字体的一部分，而 Monaco 的
 * `fontFamily` 是像素级选项、不吃 `font-mono` 工具类 —— 必须手动同步一次。
 */
function themeMonoFamily(el: Element | null): string {
  if (!el) return MONO_FALLBACK
  const value = getComputedStyle(el).getPropertyValue('--fizz-font-mono').trim()
  return value || MONO_FALLBACK
}

/**
 * 把当前配色主题编译成两套 Monaco 主题注册进去（名字固定，换主题时重新 define 同名即可）。
 *
 * 颜色读的是 `--syntax-*`（`readSyntaxColors`），与 Shiki 代码块同一份 —— 切主题后
 * 编辑器和聊天里的代码不会变成两种配色。
 */
function defineFizzThemes(monaco: Monaco): void {
  const light = readSyntaxColors('light')
  const dark = readSyntaxColors('dark')
  monaco.editor.defineTheme(
    'fizz-light',
    buildMonacoTheme('light', light, light.background, light.foreground)
  )
  monaco.editor.defineTheme(
    'fizz-dark',
    buildMonacoTheme('dark', dark, dark.background, dark.foreground)
  )
}

/** 常用语言列表，用于语言切换下拉框 */
export const MONACO_LANGUAGES = [
  { value: 'plaintext', label: 'Plain Text' },
  { value: 'json', label: 'JSON' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'xml', label: 'XML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'yaml', label: 'YAML' },
  { value: 'ini', label: 'Properties / INI' },
  { value: 'shell', label: 'Shell' },
  { value: 'sql', label: 'SQL' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'java', label: 'Java' },
  { value: 'cpp', label: 'C++' }
]

/** 按文件扩展名推断 Monaco 语言（推断不出返回 undefined = plaintext） */
const EXT_TO_LANGUAGE: Record<string, string> = {
  json: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  ini: 'ini',
  properties: 'ini',
  conf: 'ini',
  env: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  sql: 'sql',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  vue: 'html',
  toml: 'ini',
  dockerfile: 'dockerfile'
}

export function monacoLanguageOf(fileName: string | null): string {
  if (!fileName) return 'plaintext'
  const lower = fileName.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  return EXT_TO_LANGUAGE[ext] ?? 'plaintext'
}

/** Monaco 编辑器实例的最小接口（仅用到 getAction / layout） */
type EditorInstance = {
  getAction: (id: string) => { run: () => void } | null
  layout: () => void
  updateOptions: (options: { fontFamily?: string }) => void
} | null

/** 亮/暗跟随 <html> 的 dark 类（与 applyThemeClass 一致），MutationObserver 实时切主题 */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => setDark(el.classList.contains('dark')))
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

export interface MonacoEditorProps {
  value?: string
  onChange?: (value: string) => void
  /** 默认语言，当 showLanguageSelector 为 true 时作为初始值 */
  language?: string
  readOnly?: boolean
  /** 是否显示语言切换下拉框，默认 false */
  showLanguageSelector?: boolean
  /** 语言切换时的回调 */
  onLanguageChange?: (language: string) => void
  /** 工具栏左侧自定义内容 */
  toolbar?: ReactNode
  /** 工具栏右侧自定义内容 */
  actions?: ReactNode
  /** 是否显示行号切换按钮 */
  showLineNumbersToggle?: boolean
  /** 是否显示自动换行切换按钮 */
  showWordWrapToggle?: boolean
  /**
   * 自动换行（**受控**）：传了就以外部为准，内部按钮只会回调 `onWordWrapChange`。
   * 不传时用组件内部状态（默认 `'on'`）。
   *
   * 为什么要受控：文件面板把开关做在了**自己那条标签条**上（本组件的工具栏被
   * `showHeader={false}` 收起来了），而偏好要落盘，就由外部持有。
   */
  wordWrap?: 'on' | 'off'
  onWordWrapChange?: (wordWrap: 'on' | 'off') => void
  /** 是否显示行号（**受控**，同上） */
  lineNumbers?: boolean
  onLineNumbersChange?: (lineNumbers: boolean) => void
  /** 是否显示复制按钮 */
  showCopyButton?: boolean
  /** 是否显示下载按钮 */
  showDownloadButton?: boolean
  /** 下载回调 */
  onDownload?: () => void
  /** 是否显示顶部工具栏（语言标签 / 各切换按钮 / toolbar / actions），默认 true */
  showHeader?: boolean
}

const MonacoEditor = ({
  value = '',
  onChange,
  language = 'json',
  readOnly = false,
  showLanguageSelector = false,
  onLanguageChange,
  toolbar,
  actions,
  showLineNumbersToggle = false,
  showWordWrapToggle = false,
  wordWrap: wordWrapProp,
  onWordWrapChange,
  lineNumbers: lineNumbersProp,
  onLineNumbersChange,
  showCopyButton = false,
  showDownloadButton = false,
  onDownload,
  showHeader = true
}: MonacoEditorProps) => {
  const tr = useT()
  const isDark = useIsDarkTheme()
  /** 配色主题的 revision：换主题 / 改代码色时重算 Monaco 主题 */
  const revision = useThemeRevision()
  const [currentLanguage, setCurrentLanguage] = useState(language)
  /** 「行号 / 换行」的内部状态：只在外部没传受控 prop 时用（见下面两行） */
  const [innerLineNumbers, setInnerLineNumbers] = useState(true)
  const [innerWordWrap, setInnerWordWrap] = useState<'on' | 'off'>('on')
  /** 受控优先：传了 prop 就以外部为准 */
  const showLineNumbers = lineNumbersProp ?? innerLineNumbers
  const wordWrap = wordWrapProp ?? innerWordWrap
  const [copied, setCopied] = useState(false)
  /** 编辑器挂载完成后再显示依赖 editor 实例的按钮 */
  const [mounted, setMounted] = useState(false)

  const editorRef = useRef<EditorInstance>(null)
  /** `beforeMount` 拿到的 monaco 命名空间（重算主题 / setTheme 用） */
  const monacoRef = useRef<Monaco | null>(null)
  /**
   * 编辑器字号：**13px 是「16px 根字号下」的值**，跑一遍 `scalePx` 换算成当前根字号下的
   * px —— 手机端根字号被抬到 18px（见 `styles.css` 的「手机端整体放大」），Monaco 这套
   * px 选项不吃 rem，不换算就会变成「界面长大了、代码没长」。
   *
   * 只算一次（挂载时）：Monaco 本来就是把 `fontSize` 当**初始选项**收的，和终端那边
   * `loadFontSize()` 挂载读一次同源；想再调有滚轮缩放（`mouseWheelZoom`）。
   */
  const editorFontSize = useMemo(() => scalePx(13), [])
  /** 编辑器所在容器：自己盯它的尺寸（见下面那个 ResizeObserver 的说明） */
  const containerRef = useRef<HTMLDivElement | null>(null)
  /** 上一次已同步过的容器尺寸，用来避免 layout → 尺寸回调 → layout 的来回触发 */
  const laidOutSize = useRef({ w: 0, h: 0 })

  const handleEditorDidMount = (editor: unknown): void => {
    editorRef.current = editor as EditorInstance
    setMounted(true)
  }

  /**
   * 补一次 `layout()`，把编辑器从 5×5 的保底尺寸拉回容器真实大小。
   *
   * Monaco 在容器 0×0（藏在 display:none 里）时创建会把尺寸夹到 5×5，
   * 之后容器被撑开它不会自愈，必须显式 layout。
   * ResizeObserver 主力 + 定时器兜底：窗口被遮挡时 Chromium 连 RO 的初始回调都不来，
   * 定时器不受影响；尺寸一对上就自己停，不留常驻开销。
   */
  useEffect(() => {
    if (!mounted) return

    const syncLayout = (): boolean => {
      const el = containerRef.current
      if (!el) return false
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return false
      if (w === laidOutSize.current.w && h === laidOutSize.current.h) return true
      laidOutSize.current = { w, h }
      editorRef.current?.layout()
      return true
    }

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => void syncLayout())
    if (observer && containerRef.current) observer.observe(containerRef.current)

    const timer = window.setInterval(() => {
      if (syncLayout()) window.clearInterval(timer)
    }, 150)

    return () => {
      observer?.disconnect()
      window.clearInterval(timer)
    }
  }, [mounted])

  /**
   * 主题变化（配色主题 / 自定义代码色 / 明暗）时重新 define + setTheme，
   * 并把等宽字体同步给编辑器。
   *
   * `defineTheme` 只影响**之后**创建的实例，所以已挂载的编辑器要再 `setTheme` 一次才刷新。
   * 依赖带 `mounted`：首帧时 editor 实例还没建好，挂载后要再补一次字体。
   */
  useEffect(() => {
    editorRef.current?.updateOptions({ fontFamily: themeMonoFamily(containerRef.current) })
    const monaco = monacoRef.current
    if (!monaco) return
    defineFizzThemes(monaco)
    monaco.editor.setTheme(isDark ? 'fizz-dark' : 'fizz-light')
  }, [revision, isDark, mounted])

  const handleFormat = (): void => {
    editorRef.current?.getAction('editor.action.formatDocument')?.run()
  }

  /** 切换行号：内部状态先动（不受控时立即生效），再通知外部（受控时由外部改回来） */
  const toggleLineNumbers = (): void => {
    const next = !showLineNumbers
    setInnerLineNumbers(next)
    onLineNumbersChange?.(next)
  }

  const toggleWordWrap = (): void => {
    const next = wordWrap === 'on' ? 'off' : 'on'
    setInnerWordWrap(next)
    onWordWrapChange?.(next)
  }

  useEffect(() => {
    setCurrentLanguage(language)
  }, [language])

  const handleLanguageChange = (lang: string): void => {
    setCurrentLanguage(lang)
    onLanguageChange?.(lang)
  }

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(value || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  /** 工具栏小按钮统一样式（原生 button，替代旧版 Button） */
  const toolBtn =
    'inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* showHeader=false 时整条收起（只留编辑区），用 hidden 而非不渲染 ——
          工具栏里有依赖 mounted 的按钮，卸载重建会多一次挂载开销 */}
      <div
        className={cn(
          'flex shrink-0 items-center justify-between gap-2 px-2 py-1',
          !showHeader && 'hidden'
        )}
      >
        {/* Left side */}
        <div className="flex min-w-0 items-center gap-1.5">
          {showLanguageSelector ? (
            /*
              语言下拉：工具栏只有 24px 高，而 `SelectTrigger` 自带
              `data-[size=default]:h-9`（属性选择器特异度高于单个类）、`px-3 py-2`、
              `text-sm`、`shadow-xs`、`dark:bg-input/30` —— 不加 `!` 一个都压不掉，
              表现就是「语言框比旁边的图标钮高出一截、还带一圈边框」。
              这套 `!` 覆盖与 `composer.tsx` 的 `CHAT_PILL` 同源，改的时候一起看。
            */
            <Select value={currentLanguage} onValueChange={handleLanguageChange}>
              <SelectTrigger
                title="语言"
                aria-label="语言"
                className="h-6! min-w-24 gap-1 border-none! bg-transparent px-1.5! py-0! text-xs! font-medium text-foreground shadow-none! outline-none hover:bg-foreground/5 dark:bg-transparent dark:hover:bg-foreground/5 [&_svg]:size-3.5!"
              >
                <SelectValue />
              </SelectTrigger>
              {/* popper + align=start：贴着触发器的左缘往下展开，长列表限高自己滚 */}
              <SelectContent position="popper" align="start" className="max-h-72">
                {MONACO_LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value} className="text-xs">
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-bold tracking-wide text-muted-foreground uppercase">
              <Braces className="size-3" />
              {currentLanguage.toUpperCase()}
            </span>
          )}

          {toolbar}

          {showLineNumbersToggle && (
            <button
              type="button"
              title="切换行号"
              aria-label="切换行号"
              className={cn(toolBtn, !showLineNumbers && 'opacity-40')}
              onClick={toggleLineNumbers}
            >
              <Hash className="size-3" />
            </button>
          )}
          {showWordWrapToggle && (
            <button
              type="button"
              title="切换自动换行"
              aria-label="切换自动换行"
              className={cn(toolBtn, wordWrap === 'off' && 'opacity-40')}
              onClick={toggleWordWrap}
            >
              <WrapText className="size-3" />
            </button>
          )}
        </div>

        {/* Right side */}
        <div className="flex shrink-0 items-center gap-1">
          {actions}

          {!readOnly && mounted && (
            <button type="button" title="格式化" aria-label="格式化" className={toolBtn} onClick={handleFormat}>
              <Code className="size-3" />
            </button>
          )}

          {showCopyButton && (
            <button
              type="button"
              title="复制"
              aria-label="复制"
              disabled={!value}
              className={toolBtn}
              onClick={handleCopy}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </button>
          )}
          {showDownloadButton && (
            <button
              type="button"
              title="下载"
              aria-label="下载"
              disabled={!value}
              className={toolBtn}
              onClick={onDownload}
            >
              <Download className="size-3" />
            </button>
          )}

          {readOnly && (
            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-emerald-600 dark:text-emerald-400">
              <Lock className="size-2.5" />
              只读
            </span>
          )}
        </div>
      </div>

      {/* Editor Area */}
      <div ref={containerRef} className="min-h-0 flex-1">
        <Editor
          height="100%"
          language={currentLanguage}
          theme={isDark ? 'fizz-dark' : 'fizz-light'}
          value={value}
          /*
            默认值是一个裸的 `"Loading..."` 字符串（见文件头）。这里换成 shadcn `Spinner` +
            一句已翻译的「加载中…」：外层那个居中容器由 `@monaco-editor/react` 给，
            所以只需要排一行、不必自己撑高。
          */
          loading={
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {tr('加载中…')}
            </span>
          }
          beforeMount={(monaco) => {
            // 先装 worker 壳替换再定义主题：替换只做一次，装晚了第一个 worker 就走 blob 被 CSP 拦
            installCspSafeWorkerShim()
            monacoRef.current = monaco
            defineFizzThemes(monaco)
          }}
          onMount={handleEditorDidMount}
          onChange={(v) => onChange?.(v || '')}
          options={{
            fontSize: editorFontSize,
            mouseWheelZoom: true,
            minimap: { enabled: false },
            readOnly,
            wordWrap,
            lineNumbers: showLineNumbers ? 'on' : 'off',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            folding: true,
            renderLineHighlight: 'all',
            fontFamily: MONO_FALLBACK,
            tabSize: 2
          }}
        />
      </div>
    </div>
  )
}

export default MonacoEditor
