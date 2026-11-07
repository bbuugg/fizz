/**
 * 左侧栏：工作区 + 会话（与桌面端的 AgentPanel 同构，只是不做文件树 / 终端）。
 * 工作区就是 Agent 的边界，所以这里也是「权限可见范围」的入口。
 *
 * ## 版式
 *
 * **一个**分区（`SectionShell`），自上而下：
 *
 * 1. 顶部两颗**动作**（`SidebarActions`，固定不滚，底部留一段 `pb-2` 与内容组分隔）：
 *    「新对话」= 不指定项目直接开会话；「定时任务」= **开主区域的定时任务管理标签页**
 *    （`triggers:list`，CRUD 全在那页，见 `features/tasks/TriggersPanel`）；
 * 2. 两块**可折叠的内容组**（`SidebarGroup`）：任务（临时会话）→ 工作区（项目树）。
 *    「任务」按内容高度、最多占一半（`size="half"`，内容少时不留空白、条数多时组内滚），
 *    「工作区」展开时吃剩余高度（`size="fill"`），两块都是组内自己滚；外层仍留一个滚动
 *    容器，只作窗口过矮时的兜底。
 *
 * 动作区与内容组这两个组件在 `shared/components/SidebarGroups`，**主机侧栏用的是同一份**
 * （那边是「新建主机 / 新建分组 / 隧道」+「主机与终端 / 脚本」）—— 改版式改那一份，
 * 别在这里或 `HostsSidebar` 里各写一遍。
 *
 * 组标签的折叠箭头排在名字**后面**、hover / 键盘聚焦才浮现（见 `SectionHeader`）；
 * 项目行的展开箭头同理，PC 上平时隐身。
 *
 * 顺序是「正在用的东西优先」：任务（刚发生的）→ 工作区（常驻项目）。折叠只切内容、
 * 不动布局高度，状态只在内存里（见 `SectionHeader` 的 `onToggle`）。**不可拖拽、不分权重**
 * （见 `docs/lessons/ui.md` §92）。
 *
 * ## 「已归档」不在侧栏（也别再搬回来）
 *
 * 归档清单现在在 **设置 →「历史会话」**（`features/settings/HistoryTab`）。它搬过三次家：
 * 项目树下面常驻的一段滚动区 → 「工作区」标签行右侧一颗 `History` 图标 + 弹窗 → 侧栏顶部
 * 独立成一组 → 设置里的一页。最后一趟的理由是：归档是「清理 / 找回」的存量数据，
 * 而侧栏的宽度和高度是全局最贵的资源 —— 一个只在找回旧会话时才用的清单，不该每天占着
 * 半屏，也不该让人每次找项目都从上往下划过它。
 * 底下的 git 告警行走**外壳**的 `footer` 槽（滚动区**外面**，不跟着滚）。
 *
 * ## 添加项目不在侧栏（加号已删除）
 *
 * 「选择目录 / 从 Git 导入 / 新建容器型项目」三个入口都在**「开始新对话」页的工作区下拉**里
 * （`ChatPanel` 的 `WorkspaceSelect` → `WorkspacePicker` 的 `actions`），侧栏不再有那颗「+」。
 * 侧栏是「看现有项目」的地方，加项目要选目录 / 填仓库地址 / 起容器，那是新建会话页面的活。
 *
 * 整条侧栏的骨架（外壳 + 分区容器）**由宿主挑**（`shell`：不传时是
 * `shared/components/SidebarScaffold`，与「主机 / 接口请求 / 插件面」共用同一份）
 * —— 本文件只填内容。手机壳在 `apps/mobile` 的 `Sidebar.tsx` 里挑另一个外壳
 * （同一个 `SidebarScaffold`，顶上多一行品牌），这里**不判断**自己长在哪一端。
 *
 * ## 顶部那条「工作区」栏已经删掉（别再搬回来）
 *
 * 它当初只有一个用途：给「定时任务 / 刷新列表」两颗**面板级**按钮当底座。那两颗已经
 * 下移到「项目」分区标题栏右侧（操作贴着它所作用的清单，见 `features/hosts/HostsSidebar`），
 * 顶部栏就只剩「工作区」三个字 —— 一块**恒为空白**的 32px 带宽，还占着侧栏最贵的位置。
 * 同理删掉的还有它 `title` 里那句「还没有工作区…」提示：选工作区的入口在对话页输入框
 * 上方，跟这里没关系。
 *
 * ⚠️ 后来**主机 / 接口请求的顶栏也一并删了**（用户要求三条侧栏长得一样）：那两行写的是
 * 面板名（`主机` / `接口请求`），但用户点的是活动栏那颗图标，那行字只是把提示词又抄了一遍，
 * 还让三条侧栏的顶部差着一整条栏的高度。现在**三个侧栏的第一行都是分区标题** ——
 * 骨架里已经没有 `label` 这个东西了，见 `SidebarScaffold`。当前是哪个工作区也**没有丢**：
 * 看项目树里的高亮行，悬停任意项目行都能看到它的完整路径。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Archive,
  ArrowRightLeft,
  CalendarClock,
  Check,
  ChevronRight,
  CirclePlus,
  Cloud,
  Container,
  Download,
  Folder,
  GitBranch,
  Loader2,
  MoreHorizontal,
  MessageSquarePlus,
  Pencil,
  Play,
  Puzzle,
  RefreshCw,
  RotateCw,
  ShieldQuestion,
  SlidersHorizontal,
  Square,
  Trash2,
  AlertTriangle,
  Clock,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@fizz/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@fizz/ui/dropdown-menu";
import { Input } from "@fizz/ui/input";
import { Skeleton } from "@fizz/ui/skeleton";
import {
  OpenWorkspaceItems,
  canOpenWorkspaceDir,
} from "@fizz/agent-kit/features/projects/OpenWorkspaceItems";
import { ContainerSettingsDialog } from "@fizz/agent-kit/features/projects/ContainerSettingsDialog";
import { DeleteConversationDialog } from "@fizz/agent-kit/features/chat/DeleteConversationDialog";
import { ConvertAcpDialog } from "@fizz/agent-kit/features/chat/ConvertAcpDialog";
import { TypingBubble } from "@fizz/agent-kit/features/chat/TypingBubble";
import { ConversationRowIcon } from "@fizz/agent-kit/features/chat/ConversationRowIcon";
import { WorkspaceDeleteDialog } from "@fizz/agent-kit/features/projects/WorkspaceDeleteDialog";
import { GitInstallDialog } from "@fizz/agent-kit/features/projects/GitInstallDialog";
import { IconTip } from "@fizz/agent-kit/shared/components/IconTip";
import { useConfirm } from "@fizz/agent-kit/shared/components/ConfirmProvider";
import {
  SectionContent,
  SectionShell,
} from "@fizz/agent-kit/shared/components/StackedSections";
// 内容组（任务 / 工作区）与顶部动作区：与「主机」侧栏共用同一份，见
// `shared/components/SidebarGroups` —— 高度策略（封顶 / 吃剩余）也在那边，这里不再各写一遍。
import {
  SidebarAction,
  SidebarActions,
  SidebarGroup,
  SidebarRowsSkeleton,
} from "@fizz/agent-kit/shared/components/SidebarGroups";
import { AGENT_PROJECTS_SECTION } from "@fizz/agent-kit/shared/lib/section-ids";
// 侧栏骨架（外壳 + 顶部栏 + 分区容器）：与「主机 / 接口请求」共用同一份，
// 见 `shared/components/SidebarScaffold`。本侧栏**不传 `label`** —— 顶部那条
// 「工作区」栏已整条删除，于是它渲染出来就是「没有顶部栏」的那一支。
import { SidebarScaffold } from "@fizz/agent-kit/shared/components/SidebarScaffold";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { conversationTitle } from "@fizz/agent-kit/shared/lib/conversation-title";
import { ROW_ACTION_CLASS } from "@fizz/agent-kit/shared/components/RowAction";
import type { AgentWorkspace } from "@fizz/contracts/agent-api";
import type { GitStatus } from "@fizz/git";
import type {
  ContainerProjectState,
  ContainerProjectsSnapshot,
} from "@fizz/contracts/types";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useStateValue } from "@fizz/agent-kit/shared/lib/state-ws";
import {
  getActivity,
  useActivities,
  type ConversationWaiting,
} from "@fizz/agent-kit/shared/lib/conversation-activity";
// 名字被行尾浮层挤到截断时，hover 自动滑到行尾（见 lib/hover-reveal.ts 里那段说明）
import {
  resetTruncatedName,
  revealTruncatedName,
} from "@fizz/agent-kit/shared/lib/hover-reveal";
// 已去掉 next/image：SPA 下用原生 <img>
// 左下角「菜单」按钮已经搬到**底部状态栏**（AppShell 渲染，见 StatusBar）：
// 侧栏一收起就整条消失，而菜单是全局入口（设置 / 命令面板 / 主题），不该跟着没
// 「定时任务」这颗按钮的落点变过两次：Popover（`TriggersStatusMenu`）→ 下方可折叠分区
// （`TriggersSection`）→ **现在直接开主区域的 `triggers:list` 标签页**（`openTriggersTab`）。
// 侧栏 260px 宽只够看名字和开关，改不了 cron / prompt / 归属项目，新建还得绕到项目行的
// 「更多」里 —— 那些事都归 `features/tasks/TriggersPanel` 那一页做。
import { openTriggersTab } from "@fizz/agent-kit/shared/lib/tool-tabs";
// ⚠️ 这里**不再** import `SidebarTopBar` —— 顶部那条「工作区」栏已整条删除（理由见文件头）。
// 主机 / 接口请求 / 插件仍然用它（经由 `SidebarScaffold` 的 `label`），组件本身不动。
import type { NewInWorkspaceKind } from "@fizz/agent-kit/shared/lib/new-in-workspace";

/**
 * 项目行上的几种「新建」：各自弹一个对应功能的弹窗（会话不弹窗，直接落初始页）。
 * 类型定义在 `lib/new-in-workspace.ts`（应用层概念，外壳与 useAppContext 共用）。
 */
export type { NewInWorkspaceKind } from "@fizz/agent-kit/shared/lib/new-in-workspace";

/**
 * worktree 项目归属的父项目 id：
 * 优先用登记的 `parentWorkspaceId`（创建时写入，父项目改名 / 路径变化都不受影响）；
 * 老数据没这个字段（加字段前建的 worktree），按目录约定 `<父目录>/.worktree/<标识>`
 * 回退推断。都认不出返回 null（调用方把 worktree 退回顶层，别让它从列表里消失）。
 */
function worktreeParentId(
  worktree: AgentWorkspace,
  all: AgentWorkspace[],
): string | null {
  if (
    worktree.parentWorkspaceId &&
    all.some((w) => w.id === worktree.parentWorkspaceId)
  ) {
    return worktree.parentWorkspaceId;
  }
  const parent = all.find(
    (w) =>
      !w.isWorktree &&
      (worktree.path.startsWith(`${w.path}/.worktree/`) ||
        worktree.path.startsWith(`${w.path}\\.worktree\\`)),
  );
  return parent?.id ?? null;
}

/*
 * 两块内容组的高度策略（任务恒封顶、工作区吃剩余高度，以及「上面的组不能改吃剩余高度」
 * 的原因）已经收进 `shared/components/SidebarGroups` —— 那两条类名和主机侧栏是同一份，
 * 别再在这里写回来。
 */

/**
 * 列表加载骨架屏（刷新后的加载窗口）：形状对齐「项目组标题 + 两个项目行 + 各两条会话」。
 * 刻意不渲染真实空态文案（「还没有工作区 / 还没有项目」）—— 那是**加载完成后**才成立的
 * 结论，列表请求没落地前摆出来就是一次闪屏（先空态、后内容）。
 */
function SidebarListSkeleton() {
  return (
    <div
      className="flex flex-col gap-2 px-1 pt-3"
      aria-busy="true"
      aria-hidden="true"
    >
      <Skeleton className="h-3 w-12" />
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-8 w-full rounded-md" />
          <div className="flex flex-col gap-1 pl-3">
            <Skeleton className="h-6 w-[85%] rounded-md" />
            <Skeleton className="h-6 w-[68%] rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 容器运行态 → 侧栏项目名后面那颗小圆点的颜色与人话。
 *
 * 只画在**容器型项目**上：普通项目没有「容器在不在跑」这回事，给个灰点只会让人以为
 * 项目坏了。颜色沿用项目里已有的语义（`emerald-500` = 运行中、`destructive` = 出错）：
 * `running` 绿 / `starting` 黄（呼吸）/ `stopping` 琥珀（呼吸，和启动中同色但文案不同）/
 * `error` 红 / `stopped` 灰。
 */
const CONTAINER_STATE_TONE: Record<
  ContainerProjectState["state"],
  { dot: string; text: string; short: string }
> = {
  running: { dot: "bg-emerald-500", text: "容器运行中", short: "运行中" },
  starting: {
    dot: "bg-amber-500 animate-pulse",
    text: "容器启动中…",
    short: "启动中",
  },
  stopping: {
    dot: "bg-amber-500 animate-pulse",
    text: "容器正在停止…",
    short: "停止中",
  },
  error: { dot: "bg-destructive", text: "容器启动失败", short: "启动失败" },
  stopped: {
    dot: "bg-muted-foreground/35",
    text: "容器已停止",
    short: "已停止",
  },
};

/**
 * 外壳拿到的 props：`children` 是分区内容、`footer` 是常驻底行（git 告警），
 * 其余三个是宿主的形态参数 —— 原样转给 `SidebarScaffold` 就行。
 */
export interface AgentSidebarShellProps {
  /** 分区内容（`SectionShell`）：放进外壳的滚动区 */
  children: ReactNode;
  /** 常驻底行（git 告警）；没有告警时是 `false` */
  footer?: ReactNode;
  /** 侧栏宽度（px），见 `AgentSidebar` 的 props */
  width: number;
  /** 手机抽屉开关，见 `AgentSidebar` 的 props */
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}

/**
 * 默认外壳（桌面 / web）：与「主机 / 接口请求 / 插件面」同一条 `SidebarScaffold`，
 * **不带品牌行** —— 那两端的品牌在窗口顶栏，侧栏再画一遍就是重复。
 */
const DefaultShell = ({
  width,
  mobileOpen,
  onMobileOpenChange,
  footer,
  children,
}: AgentSidebarShellProps) => (
  <SidebarScaffold
    width={width}
    mobileOpen={mobileOpen}
    onMobileOpenChange={onMobileOpenChange}
    footer={footer}
  >
    {children}
  </SidebarScaffold>
);

export function AgentSidebar({
  app,
  onOpenChatView,
  onOpenConversation,
  onDeleteConversation,
  onNewInWorkspace,
  /** 项目「更多」菜单里的「导入会话」：由 AgentApp 弹出导入弹窗（状态集中在外壳） */
  onImportInWorkspace,
  /** 项目「更多」菜单里的「插件」：打开该项目级的插件弹窗（看 / 启停这个项目的插件） */
  onManagePlugins,
  width,
  mobileOpen,
  onMobileOpenChange,
  onNavigate,
  shell,
}: {
  app: AgentApp;
  /**
   * 打开某个**具体对象**：选中 + 把面板标签落到位 —— 两件事一起做（实现在 `AgentProvider`）。
   *
   * 侧栏刻意只传 id、不自己调 `app.openConversation`：标签激活属于「用户手势」，
   * 各写一半就会不同步（点了侧栏但面板还停在别的标签上）。
   */
  onOpenConversation: (conversationId: string, workspaceId?: string) => void;
  /**
   * 删除会话（会话行 × 确认后）：Provider 包装过 —— 删的是**当前会话**时会把 URL 一并
   * 退回空态（初始页），否则「URL → 状态」effect 会把已删除的 id 当深链再打开一次，
   * 页面停在一个不存在的会话上还报「无会话」。侧栏只管调用，不自己拼导航。
   */
  onDeleteConversation: (conversationId: string) => Promise<boolean>;
  /**
   * 项目行行尾的两个「新建」（会话 / 协作）与「更多」菜单里的几项。
   *
   * - `conversation`：**不弹窗** —— 落到该项目的「创建新任务」页，会话等第一句发送时才建
   * - `collab`：直接建会话（默认班子，不弹窗）
   * - `worktree*`：由 `AgentApp` 弹出对应的新建弹窗
   *   （定时任务不在项目行上了：它不再依附项目，入口只有顶部那颗按钮 → 主区域面板）
   *
   * 弹窗挂在顶层而不是侧栏内部：状态集中一处好收。
   */
  onNewInWorkspace: (kind: NewInWorkspaceKind, workspaceId: string) => void;
  /** 项目「更多」菜单里的「导入会话」：打开导入弹窗（选 ACP agent → 拉取会话） */
  onImportInWorkspace: (workspaceId: string) => void;
  /** 项目「更多」菜单里的「插件」：打开该项目级的插件弹窗（按项目看 / 启停） */
  onManagePlugins: (workspaceId: string) => void;
  /**
   * 切到**空态**的对话视图（初始页）。调用方是「新对话」按钮与项目行（点一下 = 落到那个
   * 项目的初始页）—— 落点都是**不带任何会话 id** 的空态（调用方刚 openConversation(null)，
   * 带旧 id 会被「URL → 状态」effect 当深链重新打开，把上一个项目的会话拉回来）。
   * 实现见 AppShell。
   */
  onOpenChatView: () => void;
  /** 侧栏宽度（px）：由宿主 AgentApp 持有并持久化。**右缘拖拽条也在 AgentApp**（在折叠外壳外面） */
  width: number;
  /** 手机端抽屉开关（只有抽屉外壳读它）：由 AgentApp 持有（顶栏汉堡按钮切换） */
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  /**
   * 用户**选中**了什么之后调一下（会话行 / 顶部的「新对话」）。
   * 手机壳用它顺手收起抽屉（`onMobileOpenChange(false)`）；桌面 / web 不传。
   *
   * 侧栏**不自己判断**自己是不是手机形态（早先这里读 `useIsMobile`）：
   * 「选完就收」是外壳的行为，不是内容的行为。
   */
  onNavigate?: () => void;
  /**
   * 外壳：抽屉 / 占位、宽度、顶部品牌行这些**窗口形态**的东西由宿主组织。
   * 本组件只交内容（分区 + git 告警）与弹窗，套在外壳的滚动区里。
   * 不传 = `DefaultShell`（`SidebarScaffold`；品牌在窗口顶栏，侧栏里不再画）。
   * 手机在 `apps/mobile` 的 `Sidebar.tsx` 里挑自己的外壳（多一行品牌区）。
   */
  shell?: ComponentType<AgentSidebarShellProps>;
}) {
  /** 外壳：宿主挑；不传就是桌面 / web 的默认骨架（见 prop 注释） */
  const Shell = shell ?? DefaultShell;
  const t = useT();
  /** 主题色（菜单里选强调色）。就地取用：纯视觉偏好、不进 AppShell 的 prop 链 */
  /** 正在重命名的会话 id（null = 未在编辑） */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  /** 待确认删除的会话（弹窗）：内置只删本地；acp 会话多一个「同时删 agent 侧」复选框 */
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<
    AgentApp["conversations"][number] | null
  >(null);
  /** 要「转为内置 Agent 会话」的会话：非空 = 确认弹窗开着（见会话行「更多」那一项） */
  const [convertTarget, setConvertTarget] = useState<
    AgentApp["conversations"][number] | null
  >(null);
  /** 展开了**项目子树**的项目 id 列表（子树里是该项目的会话列表） */
  const [expanded, setExpanded] = useState<string[]>([]);
  /**
   * 待确认移除的工作区（null = 没有弹窗）。
   *
   * ⚠️ 这里不能像会话删除那样「点两次就地确认」：删工作区在服务端是**级联删除**
   * （`domain.deleteWorkspace` 会连它下面的全部会话一起清掉），误点代价比删一个会话大得多，
   * 必须用弹窗把「连带删什么、什么不会动」讲清楚。
   */
  const [pendingRemove, setPendingRemove] = useState<AgentWorkspace | null>(
    null,
  );
  /** 正在启动容器的项目 id（menu 项显示「启动中…」并禁用，防连点） */
  const [startingContainer, setStartingContainer] = useState<string | null>(
    null,
  );
  /** 正在重启容器的项目 id（menu 项显示「重启中…」并禁用，防连点） */
  const [rebuildingContainer, setRebuildingContainer] = useState<string | null>(
    null,
  );
  /** 正在停止容器的项目 id（menu 项显示「停止中…」并禁用，防连点） */
  const [stoppingContainer, setStoppingContainer] = useState<string | null>(
    null,
  );
  /** 「容器设置」弹窗要改的那个项目（null = 关着） */
  const [settingsWorkspace, setSettingsWorkspace] =
    useState<AgentWorkspace | null>(null);
  /** 命令式确认（重启容器会中断会话，见 `restartContainer`） */
  const confirm = useConfirm();
  /**
   * 会话运行态（服务端事件驱动）整张表。
   *
   * 在组件顶层订阅**一次**，每行渲染时再按 id 取 —— `renderConversationRow` 是普通
   * 渲染函数不是组件，里面不能调 hook（Hook 规则）。
   */
  const activities = useActivities();

  /**
   * 切换工作区 / 打开某个会话时把它所在的项目展开：从别处切过来、
   * 或在一个**收起的**项目里新建了会话，都要能立刻看到它。
   *
   * 依赖只放「选中态」的两个 id（工作区 + 会话）：新建会话时目标工作区往往
   * 就是当前这个（工作区 id 没变，光靠它触发不了），靠「选中会话 id 变了」补上这一路。
   * effect 只在依赖变化时运行，普通重渲染 / WS 推送都不会把手动收起的项目又撑开。
   */
  useEffect(() => {
    const id = app.activeConversationId ? app.activeWorkspaceId : null;
    if (!id) return;
    // 选中 worktree 时，除了它自己，父项目链路也要一并展开，否则那一行藏在收起的父项目里
    setExpanded((prev) => {
      const next = [...prev];
      let cur: string | undefined = id;
      while (cur && !next.includes(cur)) {
        next.push(cur);
        const ws = app.workspaces.find((w) => w.id === cur);
        cur = ws?.isWorktree
          ? (worktreeParentId(ws, app.workspaces) ?? undefined)
          : undefined;
      }
      return next.length === prev.length ? prev : next;
    });
  }, [app.activeWorkspaceId, app.activeConversationId]);

  /**
   * 「定位到当前会话」：选中态变化（新建会话 / 从别处切过来）时把会话行滚进可视区。
   *
   * 行可能这一拍还没渲染出来 —— 所在项目正被上面的 effect 撑开，`expanded` 的更新要
   * 下一次提交才落地 —— 所以记一个「待滚动」id：节点出现的那次渲染再滚，滚完即清。
   * 「行本来就在可视区」时是 no-op（点行切换不会瞎跳）。
   *
   * ⚠️ 这里**不能换成 `node.scrollIntoView(...)`**（含 `block: 'nearest'`）：它会滚动
   * **所有可滚动祖先、两个轴都滚**。侧栏折叠时，外壳那条 36px 窄条
   * （`overflow-hidden` 只是不画滚动条，它本身仍是滚动容器）里塞的是 260px 宽的侧栏本体
   * —— 一次定位就把窄条横向滚出 24px，`scrollLeft` 一带，同为窄条子节点的「展开」按钮
   * 也跟着左移 24px（「刷新后侧栏刚出来就向左一跳」就是这么来的）。
   * 所以自己按最近边算纵向偏移，只动**纵向** `scrollTop`。
   *
   * 内容组各自「组内滚」（封顶 / 吃剩余高度，见 `SidebarGroups` 的高度策略）之后，
   * 行可能同时被两层容器夹住（组内 + 外层列表），
   * 所以从行往上逐层补差：**内层先滚，外层再按内层滚完的新位置补**，一次到位。
   */
  const listRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<string | null>(null);
  /**
   * 上一次看到的选中会话 id。
   *
   * ⚠️ 不能拿 `pendingScrollRef` 自己当「上次选中」比较：滚完它会被清成 null，
   * 而这段代码每次渲染都跑 —— 下一次任意重渲染都会把同一个会话重新标成「待滚动」。
   * 展开别的工作区恰好会触发下面那个 effect（依赖 `expanded`），于是滚动条被拽回
   * 当前会话（用户报过）。只在**选中 id 真变了**时才重新排队。
   */
  const lastActiveConversationRef = useRef<string | null>(null);
  if (lastActiveConversationRef.current !== app.activeConversationId) {
    lastActiveConversationRef.current = app.activeConversationId;
    pendingScrollRef.current = app.activeConversationId;
  }
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id) return;
    const scroller = listRef.current;
    const node = scroller?.querySelector<HTMLElement>(
      `[data-conversation-id="${CSS.escape(id)}"]`,
    );
    if (!scroller || !node) return;
    pendingScrollRef.current = null;
    // `block: 'nearest'` 的等价物：行在可视区内就不动，越出哪条边就补哪条的差额。
    // 逐层向上（组内滚动容器 → 外层列表），到 `scroller` 为止就停 —— 再往上就是
    // 侧栏外壳那条窄条，横向一跳就是上面说的老 bug。
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1) {
        const box = el.getBoundingClientRect();
        const row = node.getBoundingClientRect();
        if (row.top < box.top) el.scrollTop += row.top - box.top;
        else if (row.bottom > box.bottom)
          el.scrollTop += row.bottom - box.bottom;
      }
      if (el === scroller) break;
    }
  }, [app.activeConversationId, expanded, app.conversations]);

  /**
   * 按工作区归类**未归档**会话，组内按最近更新排序（最近在用的在最上面）。
   *
   * 归档的会话不进这里（它们在 设置 →「历史会话」，见 `features/settings/HistoryTab`）：
   * 项目树只留「还在用的」，否则归堆一长串旧会话把当前项目埋掉。
   */
  const byWorkspace = useMemo(() => {
    const map = new Map<string, typeof app.conversations>();
    for (const c of app.conversations) {
      if (c.archivedAt) continue;
      const list = map.get(c.workspaceId) ?? [];
      list.push(c);
      map.set(c.workspaceId, list);
    }
    for (const list of map.values())
      list.sort((a, b) => b.updatedAt - a.updatedAt);
    return map;
  }, [app.conversations]);

  /**
   * 临时工作区：用户「不选项目」发消息时服务端自动建的目录（`conversations/<会话 id>`）。
   *
   * 它们不进项目树（见上面 `projects` 的过滤），会话统一归到末尾那组「临时会话」——
   * 一条会话一个 uuid 目录，混进项目树会让人以为那是个真项目。
   */
  const scratchIds = useMemo(
    () => new Set(app.workspaces.filter((w) => w.scratch).map((w) => w.id)),
    [app.workspaces],
  );
  /** 临时会话（未归档）：按最近更新排序，与项目树里的组同一套顺序 */
  const scratchConversations = useMemo(() => {
    const list: AgentApp["conversations"] = [];
    for (const id of scratchIds) list.push(...(byWorkspace.get(id) ?? []));
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [scratchIds, byWorkspace]);
  /**
   * 有「跑完还没被点开」的会话的工作区（`AgentConversation.unseen`，只有定时任务会写）。
   *
   * 用途是**项目名上那颗红点**：一条任务跑出来的会话藏在某个项目下面，
   * 项目收起来的时候光看会话行是发现不了的。已归档的不算 —— 它已经收进设置页了，
   * 再为它点亮一个「项目里有新东西」的红点纯属误导。
   */
  const unseenWorkspaceIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of app.conversations) {
      if (c.unseen && !c.archivedAt) set.add(c.workspaceId);
    }
    return set;
  }, [app.conversations]);
  /** 「任务」组里有没有没看过的（那一组没有项目行，红点只能挂在组标签上） */
  const tasksHaveUnseen = scratchConversations.some((c) => c.unseen);
  /**
   * 两块内容组的折叠态（任务 / 工作区），默认都展开。
   *
   * **只存内存、不落盘**：折叠态一旦持久化，改默认值或挪走内容之后老数据会把东西
   * 永久藏起来，而入口可能已经不在（`StackedSections` 文件头记着这个教训）。
   * 刷新即回默认展开，是这里刻意接受的代价。
   */
  const [tasksOpen, setTasksOpen] = useState(true);
  const [workspacesOpen, setWorkspacesOpen] = useState(true);

  /** 待确认归档的会话 id：第一次点 = 进入确认态，再点 = 真归档，鼠标移开该行 = 反悔 */
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null);

  /** 容器型项目的能力开关 + 各项目运行态（随 state ws 的 `containerProjects` 域下发） */
  const containerProjects = useStateValue<ContainerProjectsSnapshot>(
    "containerProjects",
    {
      available: false,
      projects: [],
    },
  );

  /** git 不可用教程弹窗（侧栏「项目」分组标题旁的告警图标点开） */
  const [gitDialogOpen, setGitDialogOpen] = useState(false);
  /**
   * 服务端 git 可用性（随全局状态快照下发；默认 available 让连接建立前的空档不误报）。
   * 探测的是服务端机器，git 操作 / 建 worktree 都发生在那边。
   */
  const git = useStateValue<GitStatus>("git", { available: true });

  /**
   * 项目分组：**顶层只放普通项目**（非 worktree、有真实目录），worktree 按父项目 id 分桶
   * 挂到各自父项目的子树里（`worktreesByParent`）—— 这样侧栏是「项目 → worktree → 会话」
   * 三级，而不是把 worktree 也平铺成一排看不出从属的项目。
   *
   * 只列绑定了真实目录的工作区：防御历史数据 —— 「仅对话」模式移除前，服务端会自动补建
   * 一个 `path: ''` 的内置工作区，老库里那一行还在，列出来是个点进去什么都干不了的空壳。
   *
   * 父项目不在了（被移除）的 worktree 退回顶层，别让它从列表里消失。
   */
  const { projects, worktreesByParent } = useMemo(() => {
    const byParent = new Map<string, AgentWorkspace[]>();
    const top: AgentWorkspace[] = [];
    for (const w of app.workspaces) {
      if (!w.path) continue;
      // 临时工作区（「不选项目」发消息时自动建的 `conversations/<会话 id>`）不进项目树：
      // 一条会话一个 uuid 目录，摆成项目行会立刻把列表淹掉；它的会话归到末尾「临时会话」组
      if (w.scratch) continue;
      if (!w.isWorktree) {
        top.push(w);
        continue;
      }
      const parentId = worktreeParentId(w, app.workspaces);
      // 父项目存在就挂进去（worktree 也可以再套 worktree，渲染是递归的）；
      // 找不到父项目则退回顶层
      if (parentId && app.workspaces.some((x) => x.id === parentId)) {
        const list = byParent.get(parentId) ?? [];
        list.push(w);
        byParent.set(parentId, list);
      } else {
        top.push(w);
      }
    }
    for (const list of byParent.values())
      list.sort((a, b) => a.name.localeCompare(b.name));
    return { projects: top, worktreesByParent: byParent };
  }, [app.workspaces]);

  /** 一个「id 列表」型展开态的开关 —— 项目树里四份展开态共用这同一段逻辑 */
  const toggler =
    (set: Dispatch<SetStateAction<string[]>>) =>
    (id: string): void =>
      set((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );

  /** 项目子树：展开后露出这个项目下的会话列表 */
  const toggleExpand = toggler(setExpanded);

  /**
   * 行尾小按钮：平时隐形，hover 所在行才浮现；手机没有 hover，常显。
   *
   * 底色（`hover:bg-foreground/10`）现在来自 `shared/components/RowAction` 的共用底板 ——
   * 以前每处各写一份字面量，标签那颗就是这么漂成 `hover:bg-destructive/10` 的（暗色下
   * 几乎看不见）。这里只额外补「显形」那部分，**不能**把它们写进共用底板：标签那边的
   * 显形由外层浮层负责，按钮自己必须是常显的。
   */
  const rowAction = cn(
    ROW_ACTION_CLASS,
    "opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100",
  );

  /**
   * 会话行行尾那颗**浮层**（按钮组的容器）：绝对定位在行右缘，hover 整行才浮现。
   *
   * 抽成常量是因为这几个类名（渐隐底 / 让位宽度 / 触摸端常显）与标题的 `pe-*` 是一对，
   * 散在 JSX 里改一处必忘另一处。
   */
  const rowActionOverlay = cn(
    "pointer-events-none absolute right-0 top-0 flex h-full items-center gap-0.5 pl-4 pr-1.5",
    "bg-gradient-to-l from-sidebar from-70% to-transparent",
    "opacity-0 transition-opacity",
    // 触摸设备没有 hover 态，按钮常显；此时标题的 `max-md:pe-20` 也一直生效
    "group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto max-md:opacity-100",
  );

  /**
   * 项目子树的缩进容器：缩进 + 左侧一条竖线（shadcn `SidebarMenuSub` 的形态）。
   *
   * 三级（项目 → worktree → 会话）靠 DOM 嵌套累积，竖线跟着一层层往里画 ——
   * 原来只有 `pl-3`，层级多了就只剩「文字往右挪」，看不出谁挂在谁下面。
   * 竖线用 `--border`（在侧栏内已被 `[data-fizz-sidebar]` 重指到 `--sidebar-border`）。
   */
  const subList = "ml-3.5 flex flex-col gap-0.5 border-l border-border pl-2.5";

  /**
   * 一条会话行（「项目」组、「已归档」组的会话列表共用）。
   *
   * 归档与否只影响两处：行首图标（归档的用 Archive 而不是会话图标）与行尾的
   * 归档 / 取回按钮；两边的交互完全一样（都能点开、都能改名、都能删）。
   */
  const renderConversationRow = (
    conversation: AgentApp["conversations"][number],
    workspaceId: string,
  ): ReactNode => {
    const activeConversation = conversation.id === app.activeConversationId;
    const renaming = renamingId === conversation.id;
    /**
     * 运行态由**服务端事件**驱动（`lib/conversation-activity.ts`），所以别的会话在跑、
     * 别的会话在等确认，这里照样看得到 —— 不再只反映「本标签页发起的轮次」。
     */
    const activity = getActivity(conversation.id);
    // 「在等用户」优先于「在跑」：这时正卡住不动，转圈会让人以为还在干活
    const waiting = activity.waiting;
    const running =
      !waiting &&
      (activity.running || !!app.runningConversations[conversation.id]);
    /** 外部 ACP agent 驱动的会话：行尾「更多」里的重启 / 重新加载只给它 */
    const isAcp = conversation.backend === "acp";
    /**
     * 临时会话（`scratch` 工作区）的目录：`<数据目录>/conversations/<会话 id>`。
     *
     * 项目树里的那条「打开工作区目录」挂在**项目行**上，而临时工作区刻意不摆成项目行
     * （见上面 `projects` 的过滤）—— 于是这些会话的目录在侧栏就没有落点。补在会话行
     * 自己的「更多」里，与会话一一对应，一条会话一个目录。
     */
    const scratchPath = scratchIds.has(workspaceId)
      ? app.workspaces.find((w) => w.id === workspaceId)?.path
      : undefined;
    /** 归档确认态（第一次点变成勾，再点才真归档；鼠标移开该行 = 反悔） */
    const confirmingArchive = pendingArchiveId === conversation.id;
    const statusText = waiting
      ? waiting.kind === "confirm"
        ? t("等待确认：{label}", { label: waiting.label })
        : t("等待回答：{label}", { label: waiting.label })
      : running
        ? t("正在运行…")
        : conversationTitle(conversation.title);
    return (
      <div
        key={conversation.id}
        data-conversation-id={conversation.id}
        onClick={() => {
          onOpenConversation(conversation.id, workspaceId);
          setPendingArchiveId(null);
          onNavigate?.();
        }}
        onMouseEnter={(e) => {
          // hover 时让位 padding 会把标题挤成省略号 —— 顺手滑到行尾，把后半截露出来
          revealTruncatedName(e.currentTarget);
        }}
        onMouseLeave={(e) => {
          resetTruncatedName(e.currentTarget);
          // 点了归档但鼠标移开 = 反悔，退回普通状态（与删除的二次确认同一套交互）
          if (pendingArchiveId === conversation.id) setPendingArchiveId(null);
        }}
        className={cn(
          // 缩进交给下面那个「图标槽」占位（不再写 pl-*），标题才能和工作区名称同列。
          // `relative` 是行尾浮层（归档 / 重命名 / 删除）的定位基准，见下面那段注释
          // `px-2` 对齐 shadcn `SidebarMenuButton` 的水平内边距（项目行 / 分组标签同值）
          "group relative flex cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-2 py-1.5 text-sm transition-colors",
          // 选中 / hover 走**主题色深浅度**（soft 底、subtle 更强），不再是中性灰 ——
          // 深浅度令牌见 styles.css 的 --primary-*，随用户选的主题色自动变。
          activeConversation
            ? "bg-primary-subtle text-foreground"
            : "text-foreground hover:bg-primary-soft",
        )}
        title={statusText}
      >
        {/* 行首图标槽（类型 + 运行态）与桌面会话浮窗**共用一份**，见 `ConversationRowIcon`：
            会话分普通对话 / 多智能体协作 / 外部 ACP 三种，在跑 / 等确认 / 等回答时临时盖掉类型图标。
            两边各写一套映射一定会漂（浮窗原来就恒画对话气泡）。 */}
        <ConversationRowIcon
          backend={conversation.backend}
          kind={conversation.kind}
          waiting={waiting}
          running={running}
        />
        {/*
          定时任务跑出来的会话：**还没被点开过**就点一颗红点。
          只有这一种会话会有它（见 `AgentConversation.unseen`）—— 它是自己到点冒出来的，
          没有这个标记就只能自己一条条翻。点开即清（`openConversation`）。
        */}
        {conversation.unseen && (
          <span
            aria-label={t("未查看")}
            title={t("定时任务起的会话，还没点开过")}
            className="size-1.5 shrink-0 rounded-full bg-destructive"
          />
        )}
        {renaming ? (
          <Input
            autoFocus
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void app.renameConversation(conversation.id, renameTitle);
                setRenamingId(null);
              } else if (e.key === "Escape") {
                setRenamingId(null);
              }
            }}
            onBlur={() => setRenamingId(null)}
            className="h-6 min-w-0 flex-1 rounded px-1.5 py-0 text-sm"
          />
        ) : (
          // 平时**不留**内边距（标题吃满整行宽度），只在浮层要压上来时才让出 `pe-20`。
          // `data-name-text`：被挤成省略号时由 lib/hover-reveal.ts 滑到行尾（见行上的 onMouseEnter）
          <span
            data-name-text
            className="min-w-0 flex-1 truncate transition-[padding] group-hover:pe-20 max-md:pe-20"
          >
            {conversationTitle(conversation.title)}
          </span>
        )}
        {/*
          行尾动作：**绝对定位**在行尾、hover 整行才浮现。

          这些按钮此前留在 flex 流里，即使 `opacity-0`（只是不可见）**照样各占一格**，
          侧栏本来就窄，三个图标位 + 间隙把会话名截得只剩几个字 —— 悬停才出现的按钮却
          全程在吃宽度。改成浮层后：宽度只在需要时借，标题平时能吃满整行；hover 时靠标题
          的 `pe-*` 让位（浮层自带从 sidebar 底色渐隐过去，文字不会硬贴在按钮下面）。
          重命名进行中不渲染浮层：输入框需要那整行宽度，也避免「改名改到一半被删掉」。

          ⚠️ 归档的会话**不出现在项目树里**（见文件头），它们只在 设置 →「历史会话」
          里，那行的动作是「取消归档 / 彻底删除」（`features/settings/HistoryTab`）。
        */}
        {renaming ? null : (
          <div className={rowActionOverlay}>
            {/* 归档走「点两次就地确认」：第一次点变成确认图标（勾），再点才真归档，
                鼠标移开该行即反悔（见行上的 onMouseLeave）。取消归档可逆，所以那一侧
                在设置页里保持一键直达，不套这套确认。 */}
            <button
              type="button"
              aria-label={confirmingArchive ? t("确认归档") : t("归档会话")}
              onClick={(e) => {
                e.stopPropagation();
                setRenamingId(null);
                if (confirmingArchive) {
                  setPendingArchiveId(null);
                  void app.archiveConversation(conversation.id, true);
                } else {
                  setPendingArchiveId(conversation.id);
                }
              }}
              className={cn(
                rowAction,
                confirmingArchive &&
                  "bg-amber-500/10 text-amber-500 hover:bg-amber-500/20",
              )}
            >
              {confirmingArchive ? (
                <Check className="size-3.5" />
              ) : (
                <Archive className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              aria-label={t("重命名会话")}
              onClick={(e) => {
                e.stopPropagation();
                setRenamingId(conversation.id);
                setRenameTitle(conversation.title);
              }}
              className={rowAction}
            >
              <Pencil className="size-3.5" />
            </button>
            {/*
              行尾「更多」：删除 +（仅 acp）重启 / 重新加载会话都收进下拉，与项目行的「更多」同一套。
              删除走弹窗（不再是「点两次就地确认」）：acp 会话要多一个「同时删除 agent 侧会话」
              的复选框，就地按钮塞不下这些信息，所以它本来也该有个「收起来」的地方。
              后两项**只有 acp 会话有**（内置 内置会话没有 agent 进程这个概念）：
              重启 = 杀 agent 进程、保留 sessionId，下一轮 session/load 接回原上下文（是重连不是新建）；
              重新加载 = 当场再 load 一次、拿 agent 侧回放把消息列表整体重建（视图与 agent 侧对齐）。
            */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("更多操作")}
                  onClick={(e) => e.stopPropagation()}
                  className={rowAction}
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={4}
                className="min-w-40"
              >
                {/*
                  临时会话的「打开会话目录」：它的工作区不摆成项目行，项目树里那条
                  「打开工作区目录」在这里没有落点，所以挂到会话行自己的「更多」里。
                  `canOpenWorkspaceDir()` 与组件本身判的是同一个能力（web 宿主没有），
                  连分隔线一起判 —— 只判组件会在 web 的菜单顶上留一条孤线。
                */}
                {scratchPath && canOpenWorkspaceDir() && (
                  <>
                    <OpenWorkspaceItems
                      path={scratchPath}
                      label={t("打开会话目录")}
                    />
                    <DropdownMenuSeparator />
                  </>
                )}
                {isAcp && (
                  <DropdownMenuItem
                    // 在跑 / 在等答复时不给重启：那等于把这一轮掐了 —— 想掐用输入框那颗「停止」，
                    // 打着「重启」的旗号干这事只会让人误判（重启本该是无损的）。
                    // ⚠️ 等答复时 `running` 是 false（两者互斥，见上面的 `waiting`），必须一起判。
                    disabled={running || !!waiting}
                    onSelect={() => {
                      const agentId = conversation.configId;
                      if (!agentId) return;
                      void app
                        .restartAcpSession(agentId, conversation.id)
                        .then((ok) => {
                          if (ok)
                            toast.success(t("已重启会话，下一条消息会重新连接"));
                        });
                    }}
                  >
                    <RefreshCw className="size-4" />
                    {t("重启会话")}
                  </DropdownMenuItem>
                )}
                {isAcp && (
                  <DropdownMenuItem
                    // 与「重启会话」同一个禁用判据：正在跑 / 正等答复时，agent 侧那份转录还是
                    // 半截的（这一轮没落回 session），重载回来会缺一段 —— 反而把好视图弄坏。
                    // ⚠️ 等答复时 `running` 是 false（两者互斥，见上面的 `waiting`），必须一起判。
                    disabled={running || !!waiting}
                    onSelect={() => {
                      void app.reloadAcpSession(conversation.id).then((ok) => {
                        if (ok) toast.success(t("已重新加载会话"));
                      });
                    }}
                  >
                    <RotateCw className="size-4" />
                    {t("重新加载会话")}
                  </DropdownMenuItem>
                )}
                {isAcp && (
                  <DropdownMenuItem
                    // 与「重启会话」同一个禁用判据：正在跑 / 正等答复时，agent 侧那份转录是
                    // 半截的（这一轮还没落回 session），转出来的历史会缺一段。
                    disabled={running || !!waiting}
                    // 转换是形态变更、且要先确认（顺带选新会话落在哪个工作区），所以开弹窗而不是直接转
                    onSelect={() => setConvertTarget(conversation)}
                  >
                    <ArrowRightLeft className="size-4" />
                    {t("转换为内置 Agent 会话")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    setRenamingId(null);
                    setPendingDeleteConversation(conversation);
                  }}
                >
                  <Trash2 className="size-4" />
                  {t("删除会话")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    );
  };

  /**
   * 一个项目（含它下面的 worktree 子项目）里**有没有会话在跑 / 在等**。
   *
   * 会话行的转圈是逐行看的；项目这一层要汇总，否则子项目一折叠，子树里的会话行整个看不见，
   * 只剩项目行的图标能透出「下面还有东西在跑 / 还卡在等确认」。
   *
   * 口径与会话行（`renderConversationRow`）完全一致，且沿用它的优先级：
   * 卡在等确认 / 等回答的会话**不算**「在干活」（转圈会让人以为还在跑），
   * 所以先挑一个待办态，没有待办再看有没有在跑的。子项目算进父项目，因为它们渲染在父项目
   * 的子树里。
   */
  const workspaceActivity = (
    workspaceId: string,
  ): { running: boolean; waiting: ConversationWaiting | null } => {
    // 展开成「自己 + 全部后代 worktree」的工作区 id（BFS + seen：worktree 还能再套 worktree，
    // seen 兜住万一出现环的情况，不让它转不出来）
    const ids = [workspaceId];
    const seen = new Set(ids);
    for (let i = 0; i < ids.length; i++) {
      for (const child of worktreesByParent.get(ids[i]) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        ids.push(child.id);
      }
    }
    let running = false;
    let waiting: ConversationWaiting | null = null;
    for (const id of ids) {
      for (const conversation of byWorkspace.get(id) ?? []) {
        const activity = getActivity(conversation.id);
        if (activity.waiting) {
          if (!waiting) waiting = activity.waiting;
          continue;
        }
        // 与会话行同一个兜底：本标签页发起的轮次（`runningConversations`）也算在跑
        if (activity.running || app.runningConversations[conversation.id])
          running = true;
      }
    }
    return { running, waiting };
  };

  /**
   * 启动某个容器型项目的容器（服务端 `startContainerProject`：确保镜像 → 起容器 → 等容器内
   * agent 就绪，可能几分钟）。
   *
   * **手动启动入口之一**（另一个是主区域的启动卡片）。打开项目不再自动启动 —— 用户要求
   * 「切到会话别自己起」。失败原因落在快照的 `error` 里（接口不抛错），这里统一提示。
   */
  const startContainer = async (workspace: AgentWorkspace): Promise<void> => {
    const api = app.api;
    if (!api) {
      toast.error(t("还没有连接到服务端"));
      return;
    }
    setStartingContainer(workspace.id);
    try {
      const { snapshot } = await api.startContainerProject(workspace.id);
      const failure = snapshot.projects.find(
        (p) => p.workspaceId === workspace.id,
      )?.error;
      if (failure) toast.error(t("容器没起来：{error}", { error: failure }));
      else toast.success(t("「{name}」的容器已启动", { name: workspace.name }));
    } catch (err) {
      toast.error(
        t("启动容器失败：{error}", { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setStartingContainer(null);
    }
  };

  /**
   * 重启某个容器型项目的容器（服务端 `rebuildContainerProject`：停 → 删 → 起）。
   *
   * 为什么放在项目「更多」里：这是**项目级**动作（与当前看哪个会话无关），容器被弄脏 /
   * 镜像重建后要它生效时，用户第一反应就是在项目上找。以前只有 设置 →「容器」里那张
   * 「N 个项目在用这个镜像」的表能点到 —— 得先知道它属于哪个镜像，基本找不到。
   *
   * 会中断正在跑的会话，所以先确认；`/workspace` 挂载里的项目文件不受影响。
   * 失败原因有两种来源：接口本身报错（id 不对等）与「容器没起来」（落在快照的 `error` 里
   * —— `rebuildContainerProject` 与 `start` 同约定，不抛错），两种都要告诉用户。
   */
  const restartContainer = async (workspace: AgentWorkspace): Promise<void> => {
    const api = app.api;
    if (!api) {
      toast.error(t("还没有连接到服务端"));
      return;
    }
    const ok = await confirm({
      title: t("重启「{name}」的容器？", { name: workspace.name }),
      description:
        t("会在服务端停掉并重新创建这个容器，正在跑的会话会中断（/workspace 里的项目文件不受影响）。重建要等几十秒到几分钟，取决于镜像是否已经就绪。"),
      confirmLabel: t("重启容器"),
      destructive: true,
    });
    if (!ok) return;
    setRebuildingContainer(workspace.id);
    try {
      const { snapshot } = await api.rebuildContainerProject(workspace.id);
      const failure = snapshot.projects.find(
        (p) => p.workspaceId === workspace.id,
      )?.error;
      if (failure) toast.error(t("容器没起来：{error}", { error: failure }));
      else toast.success(t("「{name}」的容器已重启", { name: workspace.name }));
    } catch (err) {
      toast.error(
        t("重启容器失败：{error}", { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setRebuildingContainer(null);
    }
  };

  /**
   * 停掉某个容器型项目的容器（服务端 `stopContainerProject`：`docker stop`，**不删** ——
   * 端口映射与 `/workspace` 挂载都留着，下次启动走 `docker start` 冷启动）。
   *
   * 这是容器**唯一**的停止入口：服务端没有闲置自动停，起停都由用户决定。
   * 停完这个项目会退回启动态卡片，**不会**再被自动拉起 —— 想继续用要自己点「启动容器」。
   *
   * 会中断正在跑的会话，所以先确认；`/workspace` 里的项目文件不受影响。
   */
  const stopContainer = async (workspace: AgentWorkspace): Promise<void> => {
    const api = app.api;
    if (!api) {
      toast.error(t("还没有连接到服务端"));
      return;
    }
    const ok = await confirm({
      title: t("停止「{name}」的容器？", { name: workspace.name }),
      description:
        t("会停掉这个容器，正在跑的会话会中断（/workspace 里的项目文件不受影响）。停着的时候不占内存，下次打开这个项目会自动重新启动。"),
      confirmLabel: t("停止容器"),
      destructive: true,
    });
    if (!ok) return;
    setStoppingContainer(workspace.id);
    try {
      await api.stopContainerProject(workspace.id);
      toast.success(t("「{name}」的容器已停止", { name: workspace.name }));
    } catch (err) {
      toast.error(
        t("停止容器失败：{error}", { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setStoppingContainer(null);
    }
  };

  /** 一个项目（工作区）行 + 它展开的**项目子树**（会话列表） */
  const renderWorkspaceRow = (workspace: AgentWorkspace): ReactNode => {
    const isActive = workspace.id === app.activeWorkspaceId;
    const isExpanded = expanded.includes(workspace.id);
    const renaming = renamingId === workspace.id;
    const list = byWorkspace.get(workspace.id) ?? [];
    /** 这个项目下挂的 worktree 子项目（递归成下一级） */
    const childWorktrees = worktreesByParent.get(workspace.id) ?? [];
    const itemCount = list.length;
    /** 子树里有会话在跑 / 在等 → 项目行的图标跟着转（与会话行同款），tooltip 也带上说明 */
    const wsActivity = workspaceActivity(workspace.id);
    const wsStatus = wsActivity.waiting
      ? t(wsActivity.waiting.kind === "confirm" ? "等待确认：{label}" : "等待回答：{label}", { label: wsActivity.waiting.label })
      : wsActivity.running
        ? t("有会话正在运行…")
        : null;
    /**
     * 这个工作区的目录不在了（服务端巡检置位，见 `AgentWorkspace.dirMissing`）。
     * 只影响**往这个目录里放东西**的动作（新建会话 / 定时任务）：
     * 打开它已有的会话不拦（历史还能看）。
     */
    const wsMissing = !!workspace.dirMissing;
    /**
     * 远端工作区：`path` 是远端 POSIX 目录，所在主机的名字从 SSH 清单现查
     * （主机被删时 `undefined`，界面显示「主机已删除」而不是冻结旧快照）。
     */
    const remoteHostName = workspace.remote
      ? app.sshHosts.find((host) => host.id === workspace.remote?.hostId)?.name
      : undefined;
    const locationLabel = workspace.remote
      ? `${remoteHostName ?? t("主机已删除")} · ${workspace.path}`
      : workspace.path;
    const missingHint = workspace.remote
      ? t("远端目录不可用：{path}（目录不存在，或主机当前不可达）", { path: workspace.path })
      : t("工作区目录不存在：{path}（可能已被删除或移动）", { path: workspace.path });
    /** 这个项目容器的状态（非容器型项目 / 快照还没到 = `undefined`）：只有 `running` 能「停止」 */
    const containerState = workspace.container
      ? containerProjects.projects.find((p) => p.workspaceId === workspace.id)
          ?.state
      : undefined;
    return (
      <div key={workspace.id}>
        {/*
          点整行 = **落到这个项目的「开始新会话」页**：切工作区 + 空态对话 + 写 /chat 的 URL
          （与行尾「新建会话」按钮同款落点）。展开 / 折叠只走名称旁的箭头按钮 ——
          选工作区 / 切视图不再绑在展开动作上，反过来也一样。
        */}
        <div
          onClick={() => {
            // 正在重命名时不跳转：点输入框不该把页面切走
            if (renaming) return;
            app.selectWorkspace(workspace.id, false);
            app.openConversation(null);
            onOpenChatView();
          }}
          // `relative` 是行尾浮层（新建会话 / 更多）的定位基准，见下面那段注释
          className={cn(
            "group relative flex cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-2 py-1.5 text-sm text-foreground transition-colors",
            // 当前项目铺一层主题色淡底；hover 用稍强的那一档（与会话行同一套深浅度令牌）
            isActive
              ? "bg-primary-soft hover:bg-primary-subtle"
              : "hover:bg-primary-soft",
          )}
          // 与会话行同一套：hover 让位把项目名挤成省略号时，滑到行尾把后半截露出来
          onMouseEnter={(e) => revealTruncatedName(e.currentTarget)}
          onMouseLeave={(e) => resetTruncatedName(e.currentTarget)}
          title={
            wsMissing
              ? t("{path} — 目录不可用（可能已被删除或移动）", { path: locationLabel })
              : wsStatus
                ? `${locationLabel} — ${wsStatus}`
                : locationLabel
          }
        >
          {/* 行首图标：本项目（含 worktree 子项目）里有会话在跑就换成转圈、卡在等确认 / 等回答时
              换成盾牌问号 —— 都与会话行同一套；都停下来才回到类型图标（worktree 子项目用分支图标，
              普通项目用目录图标）。 */}
          {wsActivity.waiting ? (
            <ShieldQuestion
              className="size-4 shrink-0 text-amber-500"
              aria-label={
                wsActivity.waiting.kind === "confirm" ? t("等待确认") : t("等待回答")
              }
            />
          ) : wsActivity.running ? (
            // 与会话行同一套打字气泡（项目级聚合态也是「有人在跑」）
            <TypingBubble />
          ) : wsMissing ? (
            // 目录不在了：**保留图标形状**（还看得出是不是 worktree / 远端），把颜色换成 error。
            // 排在「等确认 / 运行中」之后 —— 那两个是瞬时活动态，比「目录没了」更该抢眼。
            workspace.remote ? (
              <Cloud className="size-4 shrink-0 text-destructive" aria-label={t("远端目录不可用")} />
            ) : workspace.isWorktree ? (
              <GitBranch className="size-4 shrink-0 text-destructive" aria-label={t("工作区目录不存在")} />
            ) : (
              <Folder className="size-4 shrink-0 text-destructive" aria-label={t("工作区目录不存在")} />
            )
          ) : workspace.remote ? (
            <Cloud
              className={cn("size-4 shrink-0", isActive ? "text-primary" : "text-muted-foreground")}
            />
          ) : workspace.isWorktree ? (
            <GitBranch
              className={cn(
                "size-4 shrink-0",
                isActive ? "text-primary" : "text-muted-foreground",
              )}
            />
          ) : (
            <Folder
              className={cn(
                "size-4 shrink-0",
                isActive ? "text-primary" : "text-muted-foreground",
              )}
            />
          )}

          {/*
            名称与展开箭头包在同一个 flex 容器里，让「箭头跟着名称长度走」这条规则仍然成立，
            同时把行尾让位（`group-hover:pe-14`）作用在**箭头之后** —— 否则箭头会被浮在
            行尾的按钮压住。
            - 以前两者是这一行的同级 flex 子项；
            - 而且 `truncate` 对内联元素**不生效**，长名字会直接溢出、压在箭头上，
              看起来像「展开/折叠图标不见了」。
            名称**不要**给 `flex-1`：它按自身宽度占位，箭头才会随名字长度往右走，
            最长只能顶到右侧那排按钮之前（再长就截断成省略号，不溢出）。
          */}
          <div className="flex min-w-0 items-center gap-1.5 transition-[padding] group-hover:pe-14 max-md:pe-14">
            {renaming ? (
              <Input
                autoFocus
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void app.renameWorkspace(workspace.id, renameTitle);
                    setRenamingId(null);
                  } else if (e.key === "Escape") {
                    setRenamingId(null);
                  }
                }}
                onBlur={() => setRenamingId(null)}
                className="h-6 min-w-0 flex-1 rounded px-1.5 py-0 text-sm"
              />
            ) : (
              // `data-name-text`：被 `group-hover:pe-14` 挤成省略号时由 lib/hover-reveal.ts
              // 滑到行尾（见行上的 onMouseEnter）
              <span data-name-text className="min-w-0 truncate">
                {workspace.name}
              </span>
            )}
            {/*
              项目里有一条定时任务起的会话还没点开 → 名字后面点一颗红点。
              项目常常是**收起来**的（会话行根本不渲染），不挂在名字上就等于这轮白冒出来。
              只表达「有未查看」，不带数字（见 `AgentConversation.unseen`）。
            */}
            {unseenWorkspaceIds.has(workspace.id) && (
              <span
                aria-label={t("有未查看的任务会话")}
                title={t("这个项目里有定时任务起的会话还没点开")}
                className="size-1.5 shrink-0 rounded-full bg-destructive"
              />
            )}
            {/* 容器型项目的容器状态点：绿=运行中 / 黄=启动中 / 黄=停止中 / 红=出错 / 灰=已停止。
                非容器项目、没有 docker（快照 `available === false`）或快照还没到时
                `containerState` 是 `undefined`，这里什么都不画 —— 一个「未知」的灰点
                和「已停止」分不开，反而误导。 */}
            {containerState && (
              <IconTip label={t(CONTAINER_STATE_TONE[containerState].text)}>
                <span
                  aria-label={t(CONTAINER_STATE_TONE[containerState].text)}
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    CONTAINER_STATE_TONE[containerState].dot,
                  )}
                />
              </IconTip>
            )}
            {/*
              展开 / 收起箭头：跟着项目名走，但**在 PC 上平时隐身**，hover 整行（或键盘聚焦到
              这颗按钮）才浮现 —— 与会话行、行尾那两个按钮同一套「要用才出现」的规矩，
              项目清单本来就窄，一排常显的箭头会跟文件夹图标抢注意力。
              触摸端没有 hover 态，用 `max-md:opacity-100` 常显（那时它就是唯一能展开的手势入口）。
              `focus-visible` 单独给：键盘 Tab 上来时必须看得见焦点落在哪儿。
            */}
            <button
              type="button"
              aria-label={isExpanded ? t("收起项目") : t("展开项目")}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(workspace.id);
              }}
              className={cn(
                "shrink-0 rounded transition-opacity hover:bg-foreground/10",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100",
              )}
            >
              {/* 单一箭头 + 旋转过渡：比切换两张图标顺滑 */}
              <ChevronRight
                className={cn(
                  "size-4 transition-transform duration-200",
                  isExpanded && "rotate-90",
                )}
              />
            </button>
          </div>
          {/*
            行尾两个按钮（新建会话 / 更多）**绝对定位**在行右侧、hover 整行才浮现 ——
            与会话行同一套做法。留在 flex 流里的话，即便 `opacity-0` 也照样占一格，
            侧栏本来就窄，悬停才出现的按钮却全程在吃项目名的宽度。
            平时项目名吃满整行；hover 时上面的 `group-hover:pe-14` 让出按钮那一段，
            浮层自带的渐隐底色保证文字不会硬贴在按钮下面。重命名中不渲染：输入框要那整行宽度。
          */}
          {renaming ? null : (
            <div
              className={cn(
                "pointer-events-none absolute right-0 top-0 flex h-full items-center gap-0.5 pl-3 pr-1.5",
                "bg-gradient-to-l from-sidebar from-70% to-transparent",
                "opacity-0 transition-opacity",
                // 触摸设备没有 hover 态，按钮常显；此时项目名的 `max-md:pe-14` 也一直生效
                "group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto max-md:opacity-100",
              )}
            >
              {/*
                「新建会话」从下拉里提出来常驻行尾：它是这个项目最高频的一个动作，
                每次都要展开「更多」才能碰到，不值当。点开即落到中央输入框的开始新会话页，
                没有弹窗（所以这里不需要像删除那样二次确认）。
              */}
              <IconTip label={wsMissing ? missingHint : t("新建会话")}>
                <button
                  type="button"
                  aria-label={t("新建会话")}
                  // 用 aria-disabled 而不是 disabled：真 disabled 的按钮不派发指针事件，
                  // 悬停提示和「为什么点不动」就都看不到了 —— 点一下给一句人话更有用
                  aria-disabled={wsMissing}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (wsMissing) {
                      toast.error(missingHint);
                      return;
                    }
                    // 只落到这个项目的「创建新任务」页：不弹 dialog、也不建会话。
                    // 会话类型（内置 agent / ACP）在页面的模型下拉里选，第一句发送时才建会话。
                    app.selectWorkspace(workspace.id, false);
                    app.openConversation(null);
                    onOpenChatView();
                  }}
                  className={cn(
                    rowAction,
                    wsMissing && "cursor-not-allowed text-muted-foreground/50",
                  )}
                >
                  <MessageSquarePlus className="size-3.5" />
                </button>
              </IconTip>
              {/* 「更多」：打开工作区目录、新建定时任务 / worktree、
                  重命名、导入会话、插件、移除工作区都收进下拉里。 */}
              <DropdownMenu>
                <IconTip label={t("更多操作")}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("更多操作")}
                      onClick={(e) => e.stopPropagation()}
                      className={rowAction}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </IconTip>
                <DropdownMenuContent
                  align="end"
                  sideOffset={4}
                  className="min-w-40"
                >
                  {/*
                    ⚠️ 下面这组「作用在这个项目的目录上」的动作（打开目录 / 定时任务 /
                    worktree），在 `wsMissing` 时一并禁用 —— 目录都没了，打不开也建不出来。
                    **重命名 / 导入会话 / 插件 / 移除工作区几项不禁**：那些是纯数据，
                    移除是唯一的出路（用户得能把这条失效记录拿掉）。
                  */}
                  {/* 「打开工作区目录」：从对话标签顶栏搬来的（原来那颗分裂按钮）。
                      它是**项目级**动作（开的是这个工作区目录，与当前看哪个会话无关），
                      摆在项目行的「更多操作」里才找得到；web 宿主没这个能力时整项不渲染。 */}
                  {/* 远端工作区：打开本机目录 / 文件管理器没有意义（目录在另一台机器上） */}
                  {!workspace.remote && (
                    <OpenWorkspaceItems path={workspace.path} disabled={wsMissing} />
                  )}
                  {/*
                    容器型项目的「预览」**不在这里**：它已经搬进会话右侧的 SidePanel
                    （对话标签顶栏那颗按钮，见 `ConversationTab` 的 `containerPreview`）——
                    预览是「一边和 agent 说话、一边看页面」的动作，与对话强绑定，
                    不该从项目行的菜单里另开一个主区域标签。
                  */}
                  {/*
                    多智能体协作**点一下直接建会话**（默认班子，见 `defaultCollabSettings()`），
                    不再弹窗选模型 / 配班子 —— 建好后在协作画布上改成员 / 角色 / 工具。
                    普通会话（内置 / ACP）走「创建新任务」页，类型在页面的模型下拉里选。
                  */}
                  {/* 远端工作区首期不支持协作会话（编排在本机跑，文件却在远端） */}
                  {!workspace.remote && (
                    <DropdownMenuItem
                      disabled={wsMissing}
                      onSelect={() => onNewInWorkspace("collab", workspace.id)}
                    >
                      <Users className="size-4" />
                      {t("多智能体协作")}
                    </DropdownMenuItem>
                  )}
                  {/*
                    ⚠️ 这里**不再有「定时任务」**：新建定时任务统一走主区域的
                    `triggers:list` 面板（侧栏顶部那颗同名按钮 → 面板里的「新建定时任务」，
                    项目在那个表单里选）。入口按项目分散过一次就很难找回来 ——
                    到底在哪个项目里建的、和另一条什么关系，只能挨个点开看。
                    ⚠️ 也**不再有「新建流程」**：流程功能整个删除，流程画布的能力
                    （连智能体、接线、删节点 / 删线）并进了多智能体协作画布。
                  */}
                  {/*
                    worktree 收进「工作区」二级菜单：新建（建目录 + 建分支）与加载（登记 `.worktree/`
                    下既有的目录）是同一件事的两种来源，摆在一层里才看得出是一对。
                  */}
                  {/* worktree 是 git 目录概念，远端工作区首期不支持 */}
                  {!workspace.remote && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <GitBranch className="size-4" />
                        {t("工作区")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuItem
                          disabled={wsMissing}
                          onSelect={() =>
                            onNewInWorkspace("worktree", workspace.id)
                          }
                        >
                          <GitBranch className="size-4" />
                          {t("新建工作区")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={wsMissing}
                          onSelect={() =>
                            onNewInWorkspace("worktree-load", workspace.id)
                          }
                        >
                          <Folder className="size-4" />
                          {t("管理工作区")}
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  {/*
                    容器型项目专属：**容器状态**二级菜单 —— 启动 / 停止 / 重启 / 设置。
                    这几项都是「项目级」动作（与当前看哪个会话无关），收在一组里才看得出是
                    一件事的四种操作；一级项右侧直接写当前状态，不展开也知道容器在不在跑。
                    没有 docker 时整项不渲染。
                  */}
                  {workspace.container && containerProjects.available && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger disabled={wsMissing}>
                        <Container className="size-4" />
                        {t("容器状态")}
                        {containerState && (
                          <span className="mr-1 flex flex-1 items-center justify-end gap-1.5 text-xs text-muted-foreground">
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                CONTAINER_STATE_TONE[containerState].dot,
                              )}
                            />
                            {t(CONTAINER_STATE_TONE[containerState].short)}
                          </span>
                        )}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-40">
                        <DropdownMenuItem
                          disabled={
                            wsMissing ||
                            startingContainer === workspace.id ||
                            // 停止中不给启动：服务端那条路要等 `docker stop` 落地，
                            // 点下去只会转很久，看着像又卡住了
                            containerState === "stopping" ||
                            containerState === "running" ||
                            containerState === "starting"
                          }
                          onSelect={() => void startContainer(workspace)}
                        >
                          {startingContainer === workspace.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Play className="size-4" />
                          )}
                          {startingContainer === workspace.id
                            ? t("启动中…")
                            : t("启动容器")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={
                            wsMissing ||
                            stoppingContainer === workspace.id ||
                            // `stopping` 也算「不在跑」：本地忙态在请求返回后就清了，但优雅退出
                            // 窗口里快照仍报 `stopping`（服务端按 slug 合并，点第二次也只是复用
                            // 同一个 promise，不会真发两条 `docker stop`）
                            containerState !== "running"
                          }
                          onSelect={() => void stopContainer(workspace)}
                        >
                          {stoppingContainer === workspace.id ||
                          containerState === "stopping" ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Square className="size-4" />
                          )}
                          {stoppingContainer === workspace.id ||
                          containerState === "stopping"
                            ? t("停止中…")
                            : t("停止容器")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={
                            wsMissing ||
                            rebuildingContainer === workspace.id ||
                            // 重启 = 停 + 删 + 起：正在停的时候点它只会把「停」再等一遍
                            containerState === "stopping"
                          }
                          onSelect={() => void restartContainer(workspace)}
                        >
                          {rebuildingContainer === workspace.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <RotateCw className="size-4" />
                          )}
                          {rebuildingContainer === workspace.id
                            ? t("重启中…")
                            : t("重启容器")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={wsMissing}
                          onSelect={() => setSettingsWorkspace(workspace)}
                        >
                          <SlidersHorizontal className="size-4" />
                          {t("容器设置…")}
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      setRenameTitle(workspace.name);
                      setRenamingId(workspace.id);
                    }}
                  >
                    <Pencil className="size-4" />
                    {t("重命名")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onImportInWorkspace(workspace.id)}
                  >
                    <Download className="size-4" />
                    {t("导入会话")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onManagePlugins(workspace.id)}
                  >
                    <Puzzle className="size-4" />
                    {t("插件")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setPendingRemove(workspace)}
                  >
                    <Trash2 className="size-4" />
                    {t("移除工作区")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/*
          项目子树：这个项目的会话**排在一条列表**里，行首图标标明是什么会话类型。

          刻意不分子分组、不给三个箭头：一个项目下的东西本来就该一眼看全。
          顺序固定为会话（按时间倒序）。

          最后再递归渲染这个项目下的 **worktree 子项目**（每个自己又是一整行 + 子树），
          于是侧栏天然形成「项目 → worktree → 会话」三级；缩进靠 DOM 嵌套的 pl-3 累积。
        */}
        {isExpanded && (
          <div className={cn("mb-1 mt-0.5", subList)}>
            {list.map((conversation) =>
              renderConversationRow(conversation, workspace.id),
            )}
            {childWorktrees.map((child) => renderWorkspaceRow(child))}
            {itemCount === 0 && childWorktrees.length === 0 && (
              <div className="px-2 py-1 text-xs leading-5 text-muted-foreground">
                {t("空空如也。")}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/*
        外壳（手机覆盖抽屉 / 桌面占位 + 宽度 + 遮罩 + 分区容器）由宿主挑（`shell`）：
        不传时是 `DefaultShell`（`SidebarScaffold`，与「主机 / 接口请求 / 插件面」共用
        同一份，免得手机抽屉那串类名各抄一遍）；手机在 `apps/mobile` 的 `Sidebar.tsx`
        里拼自己的外壳 —— 它的抽屉连窗口顶栏一起盖住，顶上要补一行品牌。

        ⚠️ 这里原先是一条 `SidebarTopBar`（左边「工作区」三个字），**整条删掉了**
        —— 它最后的用途只是给「定时任务 / 刷新列表」当底座，那两颗已经下移到「项目」分区
        标题栏右侧，于是剩下的是 32px 恒为空白的一条。别再搬回来，理由见文件头。

        顶部也不再补 `pt-2`（原先挂在 `StackedSections` 上）：那是把「头顶没有东西」伪装成
        「头顶有一条看不见的栏」，纯占地方 —— 骨架里就不补。
      */}
      {/*
        **一个**分区装两块内容组：任务 / 项目树（外加顶部两颗动作）。
        归档清单已经搬进 设置 →「历史会话」（见文件头）。
        git 告警走外壳的 `footer` 槽：它**只反映服务端状态**、不属于任何一个列表，
        所以不进分区、也不进那个滚动容器。
      */}
      <Shell
        width={width}
        mobileOpen={mobileOpen}
        onMobileOpenChange={onMobileOpenChange}
        footer={
          /*
            git 不可用告警：它是侧栏底部**唯一**残留的行，所以整行只在告警出现时才渲染
            （`!git.available` 为假时这里传下去的是 `false`，渲染成空）。
            原先这里的「服务器性能监控」卡片与「菜单」按钮都已搬走 —— 监控改成了**底部状态栏**
            右侧的徽标（见 SystemMonitorBadge），菜单也进了那条状态栏（见 StatusBar）；
            两者都整宽常驻、不随功能区切换消失，比挤在「AI Agent」侧栏底部更合适。
            探测的是服务端机器（git 操作 / 建 worktree 都在那边）。
          */
          !git.available && (
            <div className="flex shrink-0 items-center justify-end px-2 py-1.5">
              <IconTip label={t("服务端未检测到 git：点开查看安装教程")}>
                <button
                  type="button"
                  aria-label={t("服务端未检测到 git")}
                  onClick={() => setGitDialogOpen(true)}
                  className="shrink-0 rounded p-1 text-destructive transition-colors hover:bg-destructive/10"
                >
                  <AlertTriangle className="size-4" />
                </button>
              </IconTip>
            </div>
          )
        }
      >
        {/*
          **一个分区**（`SectionShell`）装两块动作（顶部）+ 两块内容组：任务 → 工作区。
          它们原先各是一个 `SectionShell`（按 `grow` 权重分高度、边界可拖、各滚各的），
          现在合成一个：不传 `resizableAbove`（不可拖高度、不分权重），
          高度只由「任务组按内容、最多一半 + 最后一块 `flex-1` + 外层兜底滚动」决定。

          ⚠️ 外层仍然必须是 `SectionShell`，**不能换成裸 `div.flex-1`**：它提供的
          `flex: 1 1 0` 内联样式里还带着 `minHeight` 兜底，那是这条链上唯一的高度下限。
          裸 `flex-1 min-h-0` 一旦遇到高度链算不准（`StackedSections` 的 `flex-1`
          没拿到确定高度），会直接塌成 0 —— 表现就是「标题还在、里面的东西全没了」。
        */}
        <SectionShell spec={AGENT_PROJECTS_SECTION} minHeight={200}>
          {/*
            顶部两个动作入口（`SidebarActions`，贴在清单最上方、与下面两块内容组分开）：

            - 「新对话」= 打开**不指定项目**的「创建新任务」页（**不建会话**，等第一句话发送时
              才建 —— 早期版本一点就落一条空会话，用户明确要求改掉）。它原先藏在「临时会话」
              组标签的 hover 加号里（要先把鼠标移上去才看得见），现在提到顶层 ——
              这是侧栏里最高频的「从零开始」；
            - 「定时任务」= 打开主区域那张定时任务管理页，数量挂在它右边（**0 条不显示数字**）。
              入口常显，不能等有任务了才出现 —— 它也是「新建第一条」的入口。

            形态（h-8、圆角、hover 底色、行首图标、与组标签的区分、`pb-2` 的间隔）都在
            `SidebarGroups` 的 `SidebarAction` 里，**主机侧栏用的是同一份**。
          */}
          <SidebarActions>
            <SidebarAction
              icon={CirclePlus}
              label={t("新对话")}
              onClick={() => {
                app.selectWorkspace(null, false);
                // 只进「创建新任务」页，**不建会话** —— 会话等用户发出第一句时才建
                // （`runRound` 里的 `newConversation`）。以前这里直接建，点一下就多一条空会话。
                app.openConversation(null);
                onOpenChatView();
                onNavigate?.();
              }}
            />
            {/*
              定时任务：**开主区域的「定时任务」标签页**（全局单例 `triggers:list`），
              不再是侧栏里一个可折叠的清单。

              原先是「折叠一块 260px 宽的看板」：每行只塞得下名字 + 开关 + 两颗小图标，
              cron / prompt / MCP 全看不见，新建还得绕到「项目行 → 更多」里。现在 CRUD
              全在那一页做，这里只留一个「打开」的入口 —— 数字只在有条目时给
              （0 条时括号里的数字是噪音，与各分组标签同一口径）。

              ⚠️ 别把它改回折叠清单、也别在这里加「新建」：新建要填需求 / 权限 / 模型，
              那是面板的事。
            */}
            <SidebarAction
              icon={CalendarClock}
              label={t("定时任务")}
              title={t("打开定时任务管理（增删改、跨项目）")}
              onClick={() => openTriggersTab()}
            />
          </SidebarActions>

          <SectionContent>
            {/*
              **外层兜底滚动容器**：上面那两颗动作按钮固定，从这里往下滚。
              它同时是两块内容组的**纵向 flex 容器**：任务组按内容、最多占一半
              （`size="half"`，也是 `max-height: 50%` 的那个 100% 基准），只有工作区
              展开时吃剩余高度（`size="fill"`），
              于是空间够的时候外层根本滚不动、也不会有「下面空着、里面却已经滚」；
              只有窗口极矮（两块的最小高度都放不下）时这层才兜底滚一次
              （`docs/lessons/ui.md` §92 坑二讲的就是这个双层关系：内层必须有高度上限，
              否则两层都"能滚"就成了滚到一半卡住）。

              横向 padding 由各块自己带（`px-2`）—— 组标签自带 `px-2`（见
              `SectionHeader`），内容块再各自带，**别在容器上再叠一层**
              （叠了就是 16px，和标签行错开 8px，见 §92）。

              顺序 = 「正在用的东西优先」：任务（刚发生的）→ 工作区（常驻项目）。
              两块都可折叠，折叠态只在本组件内存里（刷新即回默认展开，不落盘 ——
              落盘的折叠态会把内容永久藏起来）。
            */}
            <div
              ref={listRef}
              className="flex min-h-0 flex-1 flex-col overflow-auto no-scrollbar px-2"
            >
              {/*
                任务（临时会话）：用户没选项目时发的消息，服务端为每条会话建了一个临时工作区
                （`<数据目录>/conversations/<会话 id>`）—— 有真实目录，只是不摆成项目行。
                排在项目们上面：它们是「刚发生的」，而且没有项目行可以挂。

                标签就叫「任务」（不再叫「临时任务」）：它与顶部那颗「新对话」是一对 ——
                不在任何项目里开的对话落到这里，名字短一点才和下面的「工作区」同档。

                空着也渲染（一句空态；数量为 0 时**不显示括号数字**，见 `SectionHeader`）：
                否则点完「新对话」看不出东西落在哪儿。
              */}
              <SidebarGroup
                title={t("任务")}
                count={scratchConversations.length}
                // 组收起时也得看得见「有一轮跑出来的还没看」
                dot={tasksHaveUnseen}
                alignIndent
                open={tasksOpen}
                onToggle={() => setTasksOpen((v) => !v)}
                // 按内容高度、最多占**一半**（高度策略见 `SidebarGroups`）：固定 160px 在
                // 宽屏上只够看几行，而内容少时又不该留一块空白 —— 一半封顶，超出在组内滚。
                // **不要**在工作区收起时改吃剩余高度：标签行还在它下面，`flex-1` 会把
                // 「工作区」推到侧栏底部。
                size="half"
                className="px-2 pb-1"
                // 加载中不传空态：清单没落地时任务数就是 0，摆「还没有任务」是一次闪屏
                // （与下面「工作区」组同一条理由，骨架在 children 里）
                empty={
                  app.conversationsLoaded || app.error
                    ? t("还没有任务。")
                    : undefined
                }
              >
                {!app.conversationsLoaded && !app.error ? (
                  <SidebarRowsSkeleton rows={2} />
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {scratchConversations.map((conversation) =>
                      renderConversationRow(
                        conversation,
                        conversation.workspaceId,
                      ),
                    )}
                  </div>
                )}
              </SidebarGroup>

              {/*
                工作区（项目树）。展开一个项目会露出它的**项目子树**：会话排成
                一条列表（靠行首图标区分类型），worktree 子项目递归成下一级。

                ⚠️ 标签行右侧**没有任何图标**（加号 / 刷新都删了）：
                - 「添加项目」搬到了「开始新对话」页的工作区下拉（`ChatPanel` 的
                  `WorkspaceSelect`）—— 加项目要选目录 / 填仓库地址 / 起容器，那是新建
                  会话页面的活；侧栏只管**看现有项目**，两处都摆一份迟早会漂。
                - 「刷新列表」本来就没有：清单靠状态 WS 推送，而「重新拉一遍」的正路是
                  起始页（那页的模型下拉会重新加载配置与外部 Agent 清单），并且它就在用户
                  手边。侧栏再摆一颗同功能的图标，只是让几颗图标挤在 260px 宽的标签行里
                  （用户反馈「看不懂右边这三颗」）。
              */}
              <SidebarGroup
                title={t("工作区")}
                count={projects.length}
                alignIndent
                open={workspacesOpen}
                onToggle={() => setWorkspacesOpen((v) => !v)}
                // 最后一块：吃剩余高度、超出才在组内滚（见 `SidebarGroups` 的高度策略）
                size="fill"
                className="px-2 pb-2"
                // 加载中不传空态：列表请求还没落地，摆「还没有项目」就是一次闪屏
                empty={
                  app.conversationsLoaded || app.error ? t("还没有项目。") : undefined
                }
              >
                {/* 刷新后的加载窗口：列表请求还没落地 —— 上骨架屏，别闪「还没有项目」。
                    加载失败（app.error）时回退真实空态，错误信息另有横幅展示 */}
                {!app.conversationsLoaded && !app.error ? (
                  <SidebarListSkeleton />
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {projects.map((workspace) =>
                      renderWorkspaceRow(workspace),
                    )}
                  </div>
                )}
              </SidebarGroup>

              {/*
                ⚠️「定时任务」**不在侧栏的清单里了**：顶部那颗同名按钮改成直接开主区域的
                `triggers:list` 标签页（CRUD 全在那一页，见 `features/tasks/TriggersPanel`）。
                侧栏这块 260px 宽的地方只够看名字和开关，改不了 cron / prompt / MCP，
                新建还得绕到项目行的「更多」里 —— 那两件事都搬走了。

                ⚠️「已归档」也不在这里：归档清单在 设置 →「历史会话」
                （`features/settings/HistoryTab`）—— 它是存量数据，不该每天占着侧栏。
              */}
            </div>
          </SectionContent>
        </SectionShell>
      </Shell>
      {/* 容器设置（内存 / CPU 上限）：改完可选「仅保存」（下次启动生效）或「保存并重启」 */}
      <ContainerSettingsDialog
        app={app}
        workspace={settingsWorkspace}
        onOpenChange={(open) => {
          if (!open) setSettingsWorkspace(null);
        }}
      />

      {/* 移除工作区的二次确认（与设置 →「工作区」里的移除共用同一个弹窗） */}
      <WorkspaceDeleteDialog
        workspace={pendingRemove}
        onCancel={() => setPendingRemove(null)}
        onConfirm={(workspace, options) => {
          setPendingRemove(null);
          void app.deleteWorkspace(workspace.id, options);
        }}
      />

      {/* git 不可用教程：侧栏「项目」分组标题旁的红色告警图标点开 */}
      <GitInstallDialog
        open={gitDialogOpen}
        onOpenChange={setGitDialogOpen}
        status={git.available ? null : git}
      />

      {/* 删除会话确认弹窗：内置只删本地；acp 会话多一个「同时删除 agent 侧会话」复选框 */}
      <DeleteConversationDialog
        app={app}
        conversation={pendingDeleteConversation}
        onCancel={() => setPendingDeleteConversation(null)}
        onConfirm={async (conversation) => {
          // 删除比较慢：等接口真的成功再关弹窗（期间按钮转圈）；
          // 失败就留在弹窗里，别让用户以为删掉了
          const ok = await onDeleteConversation(conversation.id);
          if (ok) setPendingDeleteConversation(null);
          return ok;
        }}
      />

      {/* 「转为内置 Agent 会话」确认弹窗：与「从此签出」同一个壳（选工作区 / 建 worktree） */}
      <ConvertAcpDialog
        app={app}
        conversationId={convertTarget?.id ?? ""}
        open={convertTarget !== null}
        onOpenChange={(o) => {
          if (!o) setConvertTarget(null);
        }}
      />

    </>
  );
}
