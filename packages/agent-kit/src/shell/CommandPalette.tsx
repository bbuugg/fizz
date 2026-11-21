/**
 * 命令面板（Ctrl/Cmd + Shift + P）：Agent 应用的所有功能统一入口。
 *
 * 与根应用的 CommandPalette 同一定位，但用 shadcn 的 Command（cmdk）实现：
 * 搜索 / 键盘导航（↑↓ 选择、Enter 执行、Esc 关闭）由 cmdk 内置，
 * 这里只负责「命令从哪来」—— 工作区、会话、视图开关、设置 / 主题。
 * 底部固定一行键位提示（CommandFooter）把内置行为写出来给人看，文案随层级变。
 * 快捷键不在组件内监听：打开快捷键由宿主 AgentApp 统一分发（可配置）。
 *
 * ## 页面栈（深度不限）
 *
 * 命令可以是「目录」：选中后面板不关，整块内容换成该命令的下一级页面
 * （如「搜索会话」「新建工作区」）。层级用**栈**记（`stack`，栈顶 = 当前页），
 * 不是单个 `mode` 枚举 —— 那等于「最多两级」，只能回根级。
 *
 * 现在 `push` 进下一级、`pop` 回上一级，想压多深都行。两条现成的链：
 * - `新建工作区 → 选择文件夹… → 目录页`（本地目录，选完登记工作区）
 * - `新建工作区 → 连接远端服务器… → 远端主机页 → 远端目录页`（选主机再选目录）
 * 每按一次 Esc 退一层（最内层 → … → 新建工作区 → 关面板），不是「一下跳回命令列表」。
 * Esc 在某一层还有词时先清词（拦截挂在 CommandDialog 的 `onEscapeKeyDown` 上，Radix 层）。
 *
 * 两个目录页（`dir` / `remote-dir`）本体都是 `DirectoryBrowser`（与独立弹窗共用同一块
 * 浏览器，见 `ServerDirPicker`），差别只有数据源：本地走 `/api/fs/dirs`，远端走那台主机的
 * SFTP。桌面端只有**本地**目录页的底栏右下角多一枚「使用系统文件选择器」—— 远端目录在
 * 另一台机器上，本机系统框指不到。
 * 面板高度**跟随内容**（不写死 `h-*`）：命令少就是一块矮面板，多了由列表的
 * `max-h` 封顶后自己滚，二级切换同理 —— 只有功能与列表内容变化，外壳不变形。
 */
import {
  ADD_DIR_ACTION,
  ADD_REMOTE_ACTION,
  type WorkspaceAddActions
} from '@fizz/agent-kit/features/chat/workspace-add-actions'
import { ScriptPaletteList } from '@fizz/agent-kit/features/scripts/ScriptPaletteList'
import { hostPaletteFields } from '@fizz/agent-kit/features/hosts/host-format'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import {
  DirectoryBrowser,
  type DirPickerSource,
  SystemDirPickerLink
} from '@fizz/agent-kit/shared/components/ServerDirPicker'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { formatShortcut } from '@fizz/agent-kit/shared/lib/shortcuts'
import { openFilesTab, openLogsTab, openSysmonTab, openTunnelTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import type { HostConfig } from '@fizz/contracts/types'
import { Button } from '@fizz/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandFooterHint,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from '@fizz/ui/command'
import {
  ArrowLeft,
  ChevronRight,
  FileCode2,
  Gauge,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  Network,
  Cloud,
  FolderPlus,
  FolderTree,
  ScrollText,
  Search,
  Server,
  Settings,
  SquareTerminal,
  Sun
} from 'lucide-react'
import { useState } from 'react'
import type { CommandPaletteEntry } from '@fizz/agent-kit/shared/lib/command-palette'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'
import { CommandPaletteSearch } from './CommandPaletteSearch'

/**
 * 面板里的一页。栈顶那页就是当前显示的内容 —— 「返回上一级」= pop 一层。
 *
 * 第 0 项恒为 `root`（命令列表）；面板一关栈就复位成 `[ROOT_PAGE]`。
 */
type PalettePage =
  | { kind: 'root' }
  | { kind: 'new-workspace' }
  | { kind: 'hosts' }
  | { kind: 'scripts' }
  | { kind: 'search-sessions' }
  /**
   * 目录页。`onPick` 是「选中目录之后干什么」，由压栈的那条命令给
   * （「选择文件夹…」用它登记本地工作区、「连接远端服务器…」用它登记远端工作区），
   * 所以目录浏览器本身不认识业务。
   */
  | { kind: 'dir'; description?: string; onPick: (path: string) => void }
  /**
   * 远端主机页：列能承载远端工作区的 SSH 主机（`workspaceAdd.remoteHosts`）。
   * 选中一台就压一页 `remote-dir`，数据源换成那台主机的 SFTP。
   */
  | { kind: 'remote-hosts' }
  /**
   * 远端目录页：与 `dir` 同一块浏览器，只有数据源与出口不同 ——
   * 这里列的目录在**另一台机器**上，选中即登记成远端工作区。
   */
  | {
      kind: 'remote-dir'
      /** 主机名：页标题的副标题带上它，免得「选的是哪台」得靠记忆 */
      hostName: string
      source: DirPickerSource
      onPick: (path: string) => void
    }

const ROOT_PAGE: PalettePage = { kind: 'root' }

export function CommandPalette({
  app,
  open,
  onOpenChange,
  onOpenConversation,
  shortcuts,
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenHost,
  workspaceAdd,
  onNewConversation,
  globalPanels = true,
  initialPage = 'root'
}: {
  app: AgentApp
  /** 受控开关：快捷键分发在宿主 */
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * 打开时停在哪一页。默认 `root`（命令列表）。
   *
   * 只读一次（`useState` 的初始值）：换值不会改已挂载组件的栈，外壳靠 `key` 重挂来生效
   * （见 `app-shell` 的 `paletteSession`）。这样比「打开时用 effect 重置栈」少一帧闪烁 ——
   * effect 跑在首帧之后，会先闪一下根级列表再跳到目标页。
   */
  initialPage?: CommandPaletteEntry
  /** 打开一个会话：走宿主统一入口（跨项目先切项目、切到对话视图、写 URL） */
  onOpenConversation: (conversationId: string, workspaceId?: string) => void
  /** 当前快捷键配置：给命令行展示组合键提示 */
  shortcuts: { action: string; accelerator: string }[]
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSettings: () => void
  /**
   * 打开一台 SSH 主机：在主区域**新开一个内容标签**（一条到它的终端）。
   *
   * 落点与「主机」侧栏点一行完全一致 —— 两个入口走同一条路（`app/layout/tool-tabs.ts`），
   * 免得「命令面板开出来的终端」和「侧栏开出来的终端」两处行为慢慢分叉。
   * 主机配置在「主机」功能区里维护，这里只负责用。
   */
  onOpenHost: (host: HostConfig) => void
  /**
   * 「新建工作区」的四条入口：选文件夹 / 从 Git 导入 / 连接远端服务器 / 新建容器型项目。
   *
   * 只接 `actions` + `onAction` + `addDirectory`（`Pick` 掉 `dialogs`）。别在这里重做标签 /
   * 图标 / 顺序 /「服务端有 docker 才有容器型项目」的门控 —— 唯一来源是宿主那份
   * `useWorkspaceAddActions`（定时任务表单的下拉也从同一份里取，只是筛掉了远端那条）。
   *
   * 四条里有两条**不进弹窗**，面板就地压页：
   * - 「选文件夹」→ `dir` 页（`ADD_DIR_ACTION`），选完交给 `addDirectory`；
   * - 「连接远端服务器」→ `remote-hosts` 页（`ADD_REMOTE_ACTION`）→ 选主机 → `remote-dir` 页，
   *   选完交给 `addRemoteWorkspace`。
   *
   * 剩下两条（Git 导入 / 容器型项目）仍是「关面板 + 宿主弹窗」：它们要填表单，
   * 塞进面板等于自己做一套表单壳，而面板一关它们就得跟着卸载。
   */
  workspaceAdd: Pick<
    WorkspaceAddActions,
    | 'actions'
    | 'onAction'
    | 'addDirectory'
    | 'remoteHosts'
    | 'remoteDirSource'
    | 'addRemoteWorkspace'
  >
  /**
   * 根级「会话」组里的「新建会话」那一行（有活动工作区且传了回调才画）。
   *
   * 桌面 / web **不传**：那边标题栏常驻一颗「新会话」，面板里再来一行只是重复入口
   * （这也是这一行原先不存在的原因）。手机壳没有那条标题栏 —— 命令面板是它唯一的
   * 新建入口，换用本组件后必须把这个回调传进来，否则等于删掉一个功能。
   */
  onNewConversation?: (workspaceId: string) => void
  /**
   * 根级「设置」组里那三条全局面板入口（文件管理 / 系统监控 / 应用日志），默认开。
   *
   * 手机壳只接了「系统监控」「文件管理」两条标签分支、**没有日志面板**（见
   * `apps/mobile` 的 `PanelView`），给它画出来点下去会落到兜底的终端 —— 一条看着正常、
   * 点开是「莫名其妙一条终端」的死入口。所以移动端传 `false`，别在面板里按端判断。
   */
  globalPanels?: boolean
}) {
  const t = useT()

  /** 页面栈：栈顶 = 当前显示的那一页（深度不限，见文件头） */
  const [stack, setStack] = useState<PalettePage[]>(() =>
    initialPage === 'new-workspace' ? [ROOT_PAGE, { kind: 'new-workspace' }] : [ROOT_PAGE]
  )
  const page = stack[stack.length - 1] ?? ROOT_PAGE
  /** 二级搜索词：状态放这层而不是二级视图里 —— Esc「先清词再返回」在这层拦截处理 */
  const [keyword, setKeyword] = useState('')
  /**
   * 根级输入框里**已经敲的词**。
   *
   * 只服务一件事：「搜索会话」那一行换成「在所有会话中搜索『xx』」，并把词带进二级视图。
   * 根级清单的过滤仍然交给 cmdk，这里不参与任何过滤逻辑 —— 所以它晚一拍更新也无所谓。
   */
  const [rootQuery, setRootQuery] = useState('')

  /** 面板每次打开都从根级开始；关掉时把栈与输入现场全清掉，下次进来是干净的命令列表 */
  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setStack([ROOT_PAGE])
      setKeyword('')
      setRootQuery('')
    }
    onOpenChange(next)
  }

  /** 进下一级。每页都从空词开始：上一页的词留着也没处显示，还会把新页筛空 */
  const push = (next: PalettePage): void => {
    setKeyword('')
    setStack((prev) => [...prev, next])
  }

  /**
   * 回上一级。已经在根级就什么都不做（根级的「返回」= 关面板，归 Esc / 点外面）。
   *
   * 退到根级时顺手清 `rootQuery`：根级输入框会重新挂载成空的，不清的话「搜索会话」那一行
   * 还留着上一轮的词（`value` 里带着它，点进去就莫名其妙带词搜）。
   */
  const pop = (): void => {
    setKeyword('')
    if (stack.length <= 2) setRootQuery('')
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }

  /** 找动作当前的快捷键展示文本（未绑定返回 undefined，不渲染提示） */
  const hint = (action: string): string | undefined => {
    const cfg = shortcuts.find((s) => s.action === action)
    return cfg?.accelerator ? formatShortcut(cfg.accelerator) : undefined
  }

  /**
   * 执行命令：统一收口「跑完就关面板」。
   *
   * ⚠️ 走 `handleOpenChange` 而不是直接 `onOpenChange`：后者不复位页面栈，
   * 从搜索结果里点开一条会话之后栈顶还停在 `search-sessions`，下次打开面板
   * 直接进搜索页（看起来像「命令列表没了」）。
   */
  const run = (action: () => void): (() => void) => {
    return () => {
      handleOpenChange(false)
      action()
    }
  }

  const activeWorkspaceId = app.activeWorkspaceId

  /** 二级页面头部的「回上一级」按钮（主机 / 脚本 / 新建工作区 / 目录页四处同款） */
  const backButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="-ml-1 shrink-0"
      aria-label={t('返回')}
      onClick={pop}
    >
      <ArrowLeft className="size-4" />
    </Button>
  )

  /**
   * 底部键位提示：必须跟着层级走 —— 二级视图里 Esc 是「返回上一级」而不是「关闭面板」
   * （行为见 onEscapeKeyDown 的拦截），文案照抄根级会教错用户；二级视图里已经敲了词时
   * Esc 先清词，标签也跟着换成「清除」，否则用户按下去看到的反应和提示对不上。
   */
  const footerHints: { keys: string[]; label: string }[] =
    page.kind === 'root'
      ? [
          { keys: ['↑', '↓'], label: t('选择') },
          { keys: ['Enter'], label: t('执行') },
          { keys: ['Esc'], label: t('关闭') }
        ]
      : [
          { keys: ['↑', '↓'], label: t('选择') },
          // 目录页（本地 / 远端）里 ⏎ 是「进子目录」，别的地方是「打开这一项」
          {
            keys: ['Enter'],
            label: page.kind === 'dir' || page.kind === 'remote-dir' ? t('进入') : t('打开')
          },
          // 两个目录页都能 Backspace 回上一级目录（焦点不在路径输入框里时）
          ...(page.kind === 'dir' || page.kind === 'remote-dir'
            ? [{ keys: ['Backspace'], label: t('上一级') }]
            : []),
          { keys: ['Esc'], label: keyword.trim() ? t('清除') : t('返回') }
        ]

  /**
   * 各层级的标题 / 描述：Radix 的 Dialog 用这对字段做无障碍名，层级一变就得跟着换，
   * 否则读屏听到的还是「命令面板」。
   *
   * 写成 switch 而不是 `Record<Page['kind'], …>`：目录页的描述由**压栈那条命令**给
   * （选工作区目录说什么、以后别的用途说什么），一张静态表盖不住。
   */
  const pageMeta = ((): { title: string; description: string } => {
    switch (page.kind) {
      case 'new-workspace':
        return {
          title: t('新建工作区'),
          description: t('选择文件夹、从 Git 导入、连接远端服务器或新建容器型项目')
        }
      case 'hosts':
        return { title: t('主机'), description: t('选一台主机，在内容区域打开它的终端') }
      case 'scripts':
        return { title: t('脚本'), description: t('选一个脚本，挑一台主机运行它') }
      case 'search-sessions':
        return { title: t('搜索会话'), description: t('按标题与消息内容搜索全部会话') }
      case 'dir':
        return {
          title: t('选择目录'),
          description: page.description ?? t('在服务端目录里挑一个文件夹')
        }
      case 'remote-hosts':
        return {
          title: t('连接远端服务器'),
          description: t('选一台 SSH 主机，接下来在它的文件系统里选一个目录')
        }
      case 'remote-dir':
        return {
          title: t('选择远端目录'),
          description: `${page.hostName} · ${t('选中的目录会作为这个远端工作区的根，项目名默认取目录名。')}`
        }
      default:
        return { title: t('命令面板'), description: t('搜索并执行命令') }
    }
  })()

  /**
   * 桌面端才有的那条出口（判据仍是「宿主有没有本机目录框」）：目录页底栏右下角挂一枚
   * 「使用系统文件选择器」。web / 手机 / 扩展没有本机文件系统，不挂。
   */
  const canPickNative = typeof getAgentHostOrNull()?.pickLocalDirectory === 'function'

  /**
   * 切去系统目录框：先收面板（两个模态叠着会互相抢 Esc 与焦点，系统框还常压在最上层），
   * 拿到路径再当「选中」交出去；取消 = 什么都不发生（面板已经关了，栈也复位了）。
   */
  const pickNativeDir = async (onPicked: (path: string) => void): Promise<void> => {
    const fn = getAgentHostOrNull()?.pickLocalDirectory
    if (!fn) return
    handleOpenChange(false)
    const path = await fn().catch(() => null)
    if (path) onPicked(path)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={pageMeta.title}
      description={pageMeta.description}
      // 面板里不摆关闭按钮：它紧贴搜索框右上角，既抢视觉焦点又和「Esc 关闭」重复
      showCloseButton={false}
      // 高度**不写死**：面板由内容撑（命令少就矮、多了才长），上限交给列表的 max-h。
      // 宽度也不随层级变 —— 目录页与独立弹窗同宽，来回跳的时候不该看着像换了个面板
      className="sm:max-w-[480px]"
      commandProps={{
        // 「搜索会话」的命中来自服务端（含消息正文）；两个目录页的输入框里装的是路径，
        // 都不能再被 cmdk 拿标题 / value 筛一遍
        ...(page.kind === 'search-sessions' ||
        page.kind === 'dir' ||
        page.kind === 'remote-dir'
          ? { shouldFilter: false }
          : {}),
        onValueChange: setRootQuery
      }}
      onEscapeKeyDown={(event) => {
        // 根级：交给 Radix 关面板
        if (stack.length === 1) return
        /*
          有上一级就别关面板：这一层敲了词先清词，清完才退一层（`preventDefault` 挡住
          Radix 的「Esc = 关闭」）。目录页没有词可清，Esc 直接退回上一级页面 ——
          「新建工作区 → 选择文件夹…」按两下 Esc 才是关面板，一按就整块消失会让人以为选错了。
        */
        event.preventDefault()
        if (keyword.trim()) setKeyword('')
        else pop()
      }}
    >
      {page.kind === 'root' ? (
        <>
          {/* autoFocus 兜两条路径：面板打开（与 Radix 的初始聚焦同目标）、从二级视图返回根级 */}
          <CommandInput placeholder={t("输入命令名称…")} autoFocus />
          {/* 列表限高而不是面板限高：内容少时面板自然矮，超出 24rem（约 8 行）才自己滚；
              视口很矮（横屏手机 / 小窗）时按 85dvh 减去输入行与底栏封顶，别顶出屏幕 */}
          <CommandList className="min-h-0 max-h-[min(24rem,calc(85dvh_-_7rem))] flex-1">
            <CommandEmpty>{t("没有匹配的命令。")}</CommandEmpty>

            {/*
              工作区：只放一条「新建工作区」进二级，不把四条入口平铺在根级 —— 它们都是
              「加一个项目」的一部分，一次只会做一件，铺开只把根级清单顶长。

              为什么值得在这里开一个口子：那四条入口原先只长在「开始新对话」页的工作区下拉
              底部（以及定时任务表单里），**空会话之外根本没有**。命令面板是「哪儿都能叫出来」
              的入口，加项目这种低频但急需的操作放这儿才找得到。
            */}
            <CommandGroup heading={t('工作区')}>
              <CommandItem
                keywords={[
                  'workspace',
                  'project',
                  'new',
                  'add',
                  'import',
                  '工作区',
                  '项目',
                  '新建',
                  '添加',
                  '导入'
                ]}
                onSelect={() => push({ kind: 'new-workspace' })}
              >
                <FolderPlus />
                <span>{t('新建工作区')}</span>
                <ChevronRight className="ml-auto" />
              </CommandItem>
            </CommandGroup>

            {/* 主机：带二级 —— 选中不直接连，先列出主机（根级只放一个入口，免得主机多了刷屏）。
                主机清单在「主机」功能区里维护（活动栏最左那个服务器图标），没有配置过就整组不出现
                （省得点进去是空的）。

                「运行脚本」也收在这一组：脚本只跑在主机上（运行对话框里就是挑一台主机），
                和主机清单放一起比单开一组「脚本」更顺 —— 所以不再有「脚本」分组，也不再放
                「管理脚本」那一行（那件事在主机侧栏顶部的「脚本」按钮上）。 */}
            {app.sshHosts.length > 0 && (
              <CommandGroup heading={t("主机")}>
                <CommandItem
                  keywords={['ssh', 'host', '主机', '远程', 'terminal', '终端']}
                  onSelect={() => push({ kind: 'hosts' })}
                >
                  <Server />
                  <span>{t("主机")}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {app.sshHosts.length}
                  </span>
                  <ChevronRight />
                </CommandItem>
                {/* SSH 隧道：全局单例面板（隧道列表横跨多台主机，所以不按主机开二级）。
                    ⚠️ 监听端口开在**跑 server 的那台机器**上，不是本机浏览器这台。 */}
                <CommandItem
                  keywords={['tunnel', '隧道', '转发', 'forward', 'socks', '代理', 'port']}
                  onSelect={run(() => {
                    openTunnelTab()
                  })}
                >
                  <Network />
                  <span>{t("SSH 隧道")}</span>
                  <span className="ml-auto max-w-40 truncate text-xs text-muted-foreground">
                    本地 / 远程转发 · SOCKS5
                  </span>
                </CommandItem>
                {/* 运行脚本：带二级 —— 根级只放入口（脚本一多，全铺在命令列表里就没法用了）。
                    二级里**选中一个脚本 = 运行它**，不是打开编辑：编辑在脚本清单那一页的
                    卡片上（`scripts:list`），命令面板只负责「马上跑一下」。
                    跑在哪：当前视图就是一条终端时**就地写进去**（不弹窗、不重连，见
                    `features/scripts/run-script-command.ts`），否则弹「运行脚本」对话框挑主机。
                    一个脚本都没有时不出这一行：点进去是空列表，等于一个死入口 */}
                {app.scripts.length > 0 && (
                  <CommandItem
                    keywords={['script', 'scripts', '脚本', '运行', 'run', '执行', '命令']}
                    onSelect={() => push({ kind: 'scripts' })}
                  >
                    <FileCode2 />
                    <span>{t('运行脚本')}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {app.scripts.length}
                    </span>
                    <ChevronRight />
                  </CommandItem>
                )}
              </CommandGroup>
            )}

            {/*
              会话：**「搜索会话」恒可用** —— 它搜的是全部会话（标题 + 消息正文，跨项目），
              跟「当前有没有选中工作区」无关。原先整个组挂在 `activeWorkspaceId` 上，
              于是「新对话」不选项目之后这组整块消失，搜索入口看起来就像被删掉了。

              「当前项目的会话列表」仍然只对活动工作区有意义，留在门里；
              新建会话不在这里（标题栏 / 项目行都有常驻入口）。
              归档会话不列在根级：那是搜索二级视图的事（归档是收起来，不是消失）。
            */}
            <CommandGroup heading={t('会话')}>
              <CommandItem
                // value 里带上已经敲的词：根级输入「部署」时这一行也能命中
                // （cmdk 按 value 过滤，等于「输入什么都能看到它」），点进去直接带着词搜
                value={`搜索会话 ${rootQuery}`}
                keywords={['search', 'find', '搜索', '查找', '查找会话', '全部', '全局']}
                onSelect={() => {
                  // 先进页再灌词：push 会把词清空，顺序反了就到手是空的
                  push({ kind: 'search-sessions' })
                  setKeyword(rootQuery)
                }}
              >
                <Search />
                <span className="truncate">
                  {rootQuery.trim()
                    ? t('在所有会话中搜索「{query}」', { query: rootQuery.trim() })
                    : t('搜索会话')}
                </span>
                <ChevronRight className="ml-auto" />
              </CommandItem>
              {activeWorkspaceId && (
                <>
                  {/* 手机壳唯一的新建入口 —— 桌面 / web 不传回调，这一行不出现（见 prop 注释） */}
                  {onNewConversation && (
                    <CommandItem
                      keywords={['new', 'conversation', '会话', '新建', '新消息']}
                      onSelect={run(() => onNewConversation(activeWorkspaceId))}
                    >
                      <MessageSquarePlus />
                      <span>{t('新建会话')}</span>
                      <CommandShortcut>{hint('new-conversation')}</CommandShortcut>
                    </CommandItem>
                  )}
                  {app.conversations
                    .filter((c) => c.workspaceId === activeWorkspaceId && !c.archivedAt)
                    .map((conversation) => (
                      <CommandItem
                        key={conversation.id}
                        value={`会话 ${conversationTitle(conversation.title)}`}
                        keywords={['conversation', conversationTitle(conversation.title)]}
                        onSelect={run(() =>
                          onOpenConversation(conversation.id, conversation.workspaceId)
                        )}
                      >
                        <MessageSquare />
                        <span className="truncate">{conversationTitle(conversation.title)}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {conversation.messageCount}
                        </span>
                      </CommandItem>
                    ))}
                </>
              )}
            </CommandGroup>

            {/* 设置 / 主题：始终可用 */}
            <CommandGroup heading={t("设置")}>
              <CommandItem keywords={['settings', 'preference', '设置', '偏好']} onSelect={run(onOpenSettings)}>
                <Settings />
                <span>{t("打开设置")}</span>
                <CommandShortcut>{hint('open-settings')}</CommandShortcut>
              </CommandItem>
              <CommandItem
                keywords={['theme', '主题', 'dark', 'light', '亮', '暗', '切换']}
                onSelect={run(onToggleTheme)}
              >
                {theme === 'dark' ? <Sun /> : <Moon />}
                <span>{t('切换主题（当前{theme}）', { theme: t(theme === 'dark' ? '深色' : '浅色') })}</span>
                <CommandShortcut>{hint('toggle-theme')}</CommandShortcut>
              </CommandItem>
              {/*
                下面三条是全局面板入口（文件管理 / 系统监控 / 应用日志）。默认画；
                手机壳传 `globalPanels={false}` 整块关掉 —— 它没有日志面板（见 prop 注释）。
              */}
              {globalPanels && (
                <>
              {/* 应用日志：全局单例面板，挂在「设置」组里 —— 它跟主机无关（不连主机也看得到
                  全 App 的业务事件），放在主机组里会被「有没有配置主机」挡住。与隧道同一个落点
                  （会渲染内容标签的视图 + `ensureChatView`），键盘用户不点标题栏那颗按钮也能到。 */}
              {/* 文件管理：同样是全局单例面板。浏览的是服务端那台机器的整盘（绝对路径），
                  与工作区无关，所以和日志一样落在「设置」组 —— 不连主机也该能打开自己的机器。 */}
              <CommandItem
                keywords={['file', 'files', '文件', '文件管理', '浏览器', 'explorer', '文件夹']}
                onSelect={run(() => {
                  openFilesTab()
                })}
              >
                <FolderTree />
                <span>文件管理</span>
                <span className="ml-auto max-w-40 truncate text-xs text-muted-foreground">
                  本机整盘
                </span>
              </CommandItem>
              {/* 系统监控 + 任务管理器：同样是全局单例面板，和文件管理一样落在「设置」组 ——
                  它看的是服务端那台机器，跟项目 / 主机都无关，不连主机也该能打开。 */}
              <CommandItem
                keywords={['task', 'tasks', 'process', 'kill', 'monitor', '系统监控', '任务管理器', '进程', '结束进程', 'cpu', '内存']}
                onSelect={run(() => {
                  openSysmonTab()
                })}
              >
                <Gauge />
                <span>系统监控</span>
                <span className="ml-auto max-w-40 truncate text-xs text-muted-foreground">
                  任务管理器 · 可杀进程
                </span>
              </CommandItem>
              <CommandItem
                keywords={['log', 'logs', '日志', '记录', 'event', 'trace', '排错']}
                onSelect={run(() => {
                  openLogsTab()
                })}
              >
                <ScrollText />
                <span>应用日志</span>
                <span className="ml-auto max-w-40 truncate text-xs text-muted-foreground">
                  全 App 业务事件
                </span>
              </CommandItem>
                </>
              )}
            </CommandGroup>
          </CommandList>
        </>
      ) : page.kind === 'new-workspace' ? (
        <>
          <CommandInput
            leading={backButton}
            placeholder={t('筛选新建方式…')}
            value={keyword}
            onValueChange={setKeyword}
            autoFocus
          />
          {/*
            四条入口直接取自 `useWorkspaceAddActions`：标签 / 图标 / 顺序 / 容器门控都在那边，
            这里只负责「点下去」。cmdk 仍本地过滤，把副标题也拼进 `value`（敲 git / ssh / sftp /
            容器都能命中）。
          */}
          <CommandList className="min-h-0 max-h-[min(24rem,calc(85dvh_-_7rem))] flex-1">
            <CommandEmpty>{t('没有匹配的新建方式。')}</CommandEmpty>
            {/* 不写 group heading：面板头部已经写着「新建工作区」+ 说明，再来一行小标题就是重字 */}
            <CommandGroup>
              {workspaceAdd.actions.map((action) => (
                <CommandItem
                  key={action.value}
                  value={[action.label, action.description].filter(Boolean).join(' ')}
                  onSelect={() => {
                    /*
                      「选择文件夹…」与「连接远端服务器…」都就地压页，不弹独立弹窗：
                      选错层级、想换一张盘 / 换一台主机的时候按一下 Esc 就退回这里，
                      不用「关面板 → 重开 → 再点一次」。远端那条有两级：主机清单 → 远端目录。
                      剩下两条（Git 导入 / 容器型项目）仍然是「关面板 + 弹窗」：
                      它们要填表单（仓库地址 / 镜像 / 端口），塞进面板等于自己做一套表单壳。
                    */
                    if (action.value === ADD_DIR_ACTION) {
                      push({
                        kind: 'dir',
                        description: t(
                          '这里列的是服务端上的目录（Agent 就跑在那台机器上）。选中的目录会登记为项目。'
                        ),
                        onPick: (path) => workspaceAdd.addDirectory(path)
                      })
                      return
                    }
                    if (action.value === ADD_REMOTE_ACTION) {
                      push({ kind: 'remote-hosts' })
                      return
                    }
                    run(() => workspaceAdd.onAction(action.value))()
                  }}
                  // 两行式：行高交给内容撑（写 py-2 才不被默认的 py-1.5 挤成一条缝）
                  className="items-start py-2"
                >
                  {/* 图标跟着**标题那一行**走（items-start + mt-0.5）：默认 items-center 会把
                      它压到两行块的正中，看着像掉到副标题旁边 */}
                  <span className="mt-0.5 flex shrink-0 items-center">{action.icon}</span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{action.label}</span>
                    {action.description && (
                      <span className="truncate text-xs text-muted-foreground">
                        {action.description}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </>
      ) : page.kind === 'hosts' ? (
        <>
          <CommandInput
            leading={backButton}
            placeholder={t("搜索主机…")}
            value={keyword}
            onValueChange={setKeyword}
            autoFocus
          />
          {/* 过滤交给 cmdk 本地做（主机清单就在内存里，不用打接口） */}
          <CommandList className="min-h-0 max-h-[min(24rem,calc(85dvh_-_7rem))] flex-1">
            <CommandEmpty>{t("没有匹配的主机。")}</CommandEmpty>
            <CommandGroup heading={t("主机")}>
              {app.sshHosts.map((host) => {
                const isLocal = host.kind === 'local'
                /**
                 * 标题 / 副标题 / 关键词统一由 `hostPaletteFields` 给（纯函数，有单测）。
                 *
                 * ⚠️ 不要在这里就地拼 `['ssh', host.name, host.host, host.username]`：
                 * cmdk 会对 keywords 逐个 `.trim()`，数据里只要有一条缺 `username` 的记录
                 * （例如别的版本写进去的 `kind: 'vnc'`，服务端原样透传）就整个面板白屏，
                 * 「打开主机」从此进不去。
                 */
                const { label, subtitle, keywords } = hostPaletteFields(host)
                return (
                  <CommandItem
                    key={host.id}
                    // value 参与 cmdk 的本地过滤：把能搜的字段都拼进来
                    value={`${label} ${subtitle}`}
                    keywords={keywords}
                    onSelect={run(() => onOpenHost(host))}
                  >
                    {isLocal ? <SquareTerminal /> : <Cloud />}
                    <span className="truncate">{label}</span>
                    <span className="ml-auto max-w-40 truncate font-mono text-xs text-muted-foreground">
                      {subtitle}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </>
      ) : page.kind === 'scripts' ? (
        <>
          <CommandInput
            leading={backButton}
            placeholder={t("搜索脚本…")}
            value={keyword}
            onValueChange={setKeyword}
            autoFocus
          />
          {/* 过滤交给 cmdk 本地做（脚本清单就在内存里，不用打接口）；
              分段与排序在 `ScriptPaletteList`（与清单页同一口径，手机版共用同一份） */}
          <CommandList className="min-h-0 max-h-[min(24rem,calc(85dvh_-_7rem))] flex-1">
            <CommandEmpty>{t("没有匹配的脚本。")}</CommandEmpty>
            <ScriptPaletteList app={app} run={run} />
          </CommandList>
        </>
      ) : page.kind === 'remote-hosts' ? (
        <>
          <CommandInput
            leading={backButton}
            placeholder={t('搜索远端主机…')}
            value={keyword}
            onValueChange={setKeyword}
            autoFocus
          />
          {/* 主机清单在内存里（`app.sshHosts` 的 SSH 那部分），过滤交给 cmdk */}
          <CommandList className="min-h-0 max-h-[min(24rem,calc(85dvh_-_7rem))] flex-1">
            {workspaceAdd.remoteHosts.length === 0 ? (
              /*
                一台 SSH 主机都没配：这一页只能是死路，说清「先去哪加」比留一片白强。
                （`actions` 里那条入口恒定在，不能靠隐藏它来解决 —— 用户会以为功能没了。）
              */
              <p className="px-3 py-6 text-sm text-muted-foreground">
                {t('还没有 SSH 主机：先在「主机」里添加一台，再回来选它。')}
              </p>
            ) : (
              <>
                <CommandEmpty>{t('没有匹配的主机。')}</CommandEmpty>
                <CommandGroup heading={t('SSH 主机')}>
                  {workspaceAdd.remoteHosts.map((host) => {
                    // 与「主机」那一页同一套标题 / 副标题 / 关键词（含对缺字段记录的兜底）
                    const { label, subtitle, keywords } = hostPaletteFields(host)
                    return (
                      <CommandItem
                        key={host.id}
                        value={`${label} ${subtitle}`}
                        keywords={keywords}
                        onSelect={() =>
                          push({
                            kind: 'remote-dir',
                            hostName: label,
                            // 数据源在这里造一次、跟着页面走：它绑的是「这台主机」
                            source: workspaceAdd.remoteDirSource(host.id),
                            onPick: (path) => workspaceAdd.addRemoteWorkspace(host.id, path)
                          })
                        }
                      >
                        <Cloud />
                        <span className="truncate">{label}</span>
                        <span className="ml-auto max-w-40 truncate font-mono text-xs text-muted-foreground">
                          {subtitle}
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </>
      ) : page.kind === 'remote-dir' ? (
        /*
          远端目录页：与本地目录页同一块浏览器，只换数据源 —— 清单来自那台主机的 SFTP。
          `initialPath="/"` 是有意的：远端没有「用户主目录」这个接口，从根开始列最直白；
          列不动（没权限 / 服务器不支持）时错误留在列表区，Esc 退回主机清单换一台。
        */
        <DirectoryBrowser
          /*
            key 区分数据源：两块目录页在 JSX 里占同一个位置，将来若出现「本地 → 远端」的
            相邻跳转，没有 key 的话 React 会复用实例、把上一页的清单当成这一页的列表。
          */
          key={`remote:${page.hostName}`}
          source={page.source}
          leading={backButton}
          initialPath="/"
          onPick={(path) => {
            handleOpenChange(false)
            page.onPick(path)
          }}
        />
      ) : page.kind === 'dir' ? (
        /*
          目录页：面板就是外壳 —— 浏览器本体不画标题 / 底栏，返回键与底栏提示在这里给。
          清单自己封顶（`min(24rem, …)`），与其它二级页同高：目录多得多的机器上也不会把面板顶出屏幕。
        */
        <DirectoryBrowser
          key="local-dir"
          app={app}
          leading={backButton}
          onPick={(path) => {
            // 选完先关面板再干活（与 `run` 同一条路），别让面板跟着切换页面闪一下
            handleOpenChange(false)
            page.onPick(path)
          }}
        />
      ) : (
        <CommandPaletteSearch
          api={app.api}
          keyword={keyword}
          workspaces={app.workspaces}
          onKeywordChange={setKeyword}
          onBack={pop}
          onOpenHit={(hit) => run(() => onOpenConversation(hit.conversationId, hit.workspaceId))()}
        />
      )}

      {/*
        底部键位提示：贴面板底、所有层级都在（cmdk 只提供键盘行为，这行是把它写出来给人看）。
        左右两块 `justify-between` 分两端、各自 `items-center`；`flex-nowrap` 顶掉基础里的
        `flex-wrap` —— 窄到放不下时让**左边的键位组内部**折行，而不是把右边那枚出口挤到下一行。
      */}
      <CommandFooter className="flex-nowrap items-center justify-between gap-x-3">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {footerHints.map((item) => (
            <CommandFooterHint key={item.keys.join('+')} keys={item.keys} label={item.label} />
          ))}
        </span>
        {/*
          桌面端：本地目录页右下角那枚「使用系统文件选择器」（其余层级没有目录可挑，不画）。
          不套 `ml-auto`：外层 `justify-between` 已经把它推到最右边，`shrink-0` 保证它不被压窄。
          远端目录页不给：那目录不在这台机器上，系统框指不到。
        */}
        {page.kind === 'dir' && canPickNative ? (
          <SystemDirPickerLink
            className="shrink-0"
            onPick={() => void pickNativeDir(page.onPick)}
          />
        ) : null}
      </CommandFooter>
    </CommandDialog>
  )
}
