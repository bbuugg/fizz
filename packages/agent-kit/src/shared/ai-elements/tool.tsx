"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@fizz/ui/collapsible";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { REVEAL_ON_HOVER_ARROW } from "@fizz/agent-kit/shared/lib/hover-reveal-arrow";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import type { ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  FilePenIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  FileXIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  Loader2Icon,
  SearchIcon,
  Square,
  SquareTerminalIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@fizz/ui/button";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useEffect, useState } from "react";
import { CodeBlock } from "@fizz/agent-kit/shared/ai-elements/code-block";
import { Tooltip, TooltipContent, TooltipTrigger } from "@fizz/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fizz/ui/dialog";
import { useIsMobile } from "@fizz/agent-kit/shared/hooks/useIsMobile";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("not-prose my-1 w-full rounded-md", className)}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolUIPart["state"];
  /**
   * 明细（命令 / 主入参 / 读写的文件）：单行截断着排在标题右侧，**卡片收起时也看得见**。
   *
   * 为什么值得占这一行的宽度：工具名本身（`read_file` / `bash`）几乎不携带信息，
   * 「读的是哪个文件、跑的是哪条命令」才是扫一眼对话流时真正要确认的东西。
   *
   * 宽度：**不给固定上限**，按内容宽铺开（有位置就完整显示），只有真的超出行宽才由
   * flex 收缩让位 —— 顺序是 运行态文案 → 明细 → 标题（`shrink` 权重 99 → 99 → 1，
   * 见 `STATUS_SHRINK`）。**压缩先压右侧**：明细先被压掉，标题只在明细压完还不够时才
   * 单行截断（`…`，不折行）；最右侧的状态图标 / 停止钮 / 箭头 `shrink-0`，不会被挤出去。
   *
   * ⚠️ 别给明细加 `max-w-[55%]` 这类百分比：外层那一行是 `inline-flex`（宽度由内容撑），
   * 百分比基数跟着内容变，会出现「整行右边还空着、明细已被砍半」；也别加 `min-w-*`，
   * 短明细会被撑宽，文本后面凭空多一段空白。
   *
   * 被截断的全文：桌面悬停名字（或明细）出 Tooltip，触屏点名字开全文弹窗；
   * 命令类工具的内容区还会再回声一份（见 PartView）。
   *
   * ⚠️ 别给标题 `shrink-0` 换「明细不被压缩」：那会让这一行的 min-content 等于整句意图，
   * 窄屏上把右侧的状态图标 / 停止钮顶出容器（用户报过）。标题保宽度靠的是「权重最低」，
   * 不是「不参与收缩」。
   */
  detail?: string;
  /**
   * 工具名右侧的**运行态**（子任务的「运行中 · 正在读文件 · 已调用 N 个工具」等）。
   *
   * 运行态要一眼可见，不该被挤到卡片内容区里当正文。
   */
  status?: ReactNode;
  /**
   * 停掉这次工具调用（工具在飞的时候给的回调）：传了就渲染一颗停止钮，排在**箭头左侧**
   * （状态图标之后、展开箭头的正前面）。
   *
   * ⚠️ 按钮**不能塞进 CollapsibleTrigger 里** —— 触发器本身就是开合热区，把按钮放进去，
   * 点「停止」会先被 composeEventHandlers 展开 / 收起一次（按钮还会被 Radix 的 trigger
   * 语义当成卡片的一部分）。所以头部的箭头单独成一个 Trigger，按钮夹在两个 Trigger 中间。
   */
  onStop?: () => void;
  /** 停止钮文案（缺省「停止」） */
  stopLabel?: string;
  /**
   * 这一条是不是**本轮直播里还在跑**（所属消息仍在流式）。
   *
   * 只有它为真时，运行态才画成转圈的 loading。历史里因异常中断残留的未结算 part
   * （用户停止 / 断线 / 进程被杀）也停在 `input-streaming` / `input-available`，
   * 给它们转圈等于在说「它还在跑」—— 所以那两档在非直播时退回静态图标。
   *
   * 缺省 true：自造头部的调用方（插件面板等）不必关心这个区别。
   */
  live?: boolean;
  className?: string;
};

/**
 * 工具行的**运行态图标**：只一颗图标，**不带文案、不带底色**。
 *
 * - 去掉文案：这一行已经挤了工具名 + 明细（命令 / 路径），再挂一段 "Running" / "Completed"
 *   会把明细先挤断，而图标本身已经把状态说清楚了。
 * - 去掉底色：以前套在 `<Badge variant="secondary">` 里，那块灰底在暗色主题下比工具名还重，
 *   而状态是**次要信息**，不该抢戏。
 *
 * 图标自身的语义色保留（绿=完成 / 红=出错 / 黄=等审批），那是唯一还在传递状态的东西。
 *
 * ⚠️ 这张表只放**结算 / 审批**两类的静态图标；「还在跑」那两档由 `statusIcon` 换成转圈的
 * loading，见那里的说明。
 */
const STATUS_ICONS: Record<ToolUIPart["state"], ReactNode> = {
  "input-streaming": <CircleIcon className="size-4 shrink-0" />,
  "input-available": <ClockIcon className="size-4 shrink-0" />,
  "approval-requested": <ClockIcon className="size-4 shrink-0 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 shrink-0 text-blue-600" />,
  "output-available": <CheckCircleIcon className="size-4 shrink-0 text-green-600" />,
  "output-error": <XCircleIcon className="size-4 shrink-0 text-red-600" />,
  "output-denied": <XCircleIcon className="size-4 shrink-0 text-orange-600" />,
};

/** 「还在跑」的两档：入参正在生成（模型还在写这个调用）、已收到完整入参（工具在执行） */
const RUNNING_STATES = new Set<ToolUIPart["state"]>(["input-streaming", "input-available"]);

/**
 * 头部**运行态文案**的收缩权重。
 *
 * 这一行是「图标 + 标题 + 明细 + 状态文案 + 状态图标 + 停止钮 + 箭头」，几样东西在争宽度，
 * 让位顺序按信息价值排（权重越大越先被压掉）：
 *
 * 1. 运行态文案（`shrink-[99]`）—— 状态图标（转圈 / 绿勾 / 黄叹号）已经把结论说清楚了，
 *    文案只是补充，空间一紧就先压没；
 * 2. 明细（命令 / 路径，同样 `shrink-[99]`）—— 随后被压，按 basis 比例只砍超出部分，
 *    原文还有 Tooltip / 弹窗 / 内容区三处回声；
 * 3. 标题（意图 / 工具名）—— 最后才让位：`shrink`（权重 1）保住宽度，真的放不下才单行
 *    `truncate`（见 `ToolHeadLabel`），**不折行**；
 * 4. 状态图标 / 停止钮 / 箭头 —— `shrink-0`，不参与压缩、也不换行，永远留在行尾。
 */
const STATUS_SHRINK = "shrink-[99]";

/**
 * 状态图标：**在跑的转圈**，其余按 `STATUS_ICONS`。
 *
 * 转圈是「还没结束」最直白的信号 —— 原来 `input-available` 是一颗 `animate-pulse` 的时钟，
 * 脉冲幅度太小，扫一眼看不出和静止图标的区别（长命令、`sleep 30` 这种几秒不动的尤其明显）。
 *
 * `live` 是必需的门：非直播（历史里残留的未结算 part）时**不能转** —— 那一轮早就没了，
 * 转圈会让人以为它还在跑。那时退回静态的圆圈 / 时钟。
 */
const statusIcon = (state: ToolUIPart["state"], live: boolean) =>
  live && RUNNING_STATES.has(state) ? (
    <Loader2Icon className="size-4 shrink-0 animate-spin" />
  ) : (
    STATUS_ICONS[state]
  );

/**
 * 状态文案（**中文为源**，英文见 `packages/i18n/src/en.ts` 的「工具卡的状态 tooltip」一节）。
 *
 * 只出现在图标的 tooltip 里，不再铺在工具行上 —— 那一行要留给工具名与明细。
 */
const STATUS_LABELS: Record<ToolUIPart["state"], string> = {
  "input-streaming": "正在生成参数",
  "input-available": "执行中",
  "approval-requested": "等待审批",
  "approval-responded": "已审批",
  "output-available": "已完成",
  "output-error": "出错",
  "output-denied": "已拒绝",
};

/**
 * 明细的全文弹窗（触屏 / 窄窗口共用）。
 *
 * 触屏上 Radix Tooltip 永远打不开（没有 hover），所以明细本身在头部行里就能点，
 * 点开是能选中、能复制的全文弹窗；命令仍然紧跟在工具名后面，不再被挪到下一行。
 */
function DetailDialog({
  title,
  detail,
  open,
  onOpenChange,
}: {
  title?: string;
  detail: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tr = useT();
  const [copied, setCopied] = useState(false);
  // 触屏没有 hover：复制入口默认藏起来，点一下内容区才浮出来（与消息操作行同一做法）
  const [copyVisible, setCopyVisible] = useState(false);

  // 关掉弹窗时复位，下一次打开仍是干净状态（复制的勾也不该留到下次）
  useEffect(() => {
    if (!open) {
      setCopyVisible(false);
      setCopied(false);
    }
  }, [open]);

  const copy = (): void => {
    // 剪贴板可能不可用（非安全上下文 / 无权限）：弹窗里的文字仍可手动选中复制，不额外报错
    void navigator.clipboard.writeText(detail).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? tr("完整内容")}</DialogTitle>
          <DialogDescription>
            {tr("这次调用的完整内容（列表里被截断了），可选中复制；点击内容会显示复制按钮。")}
          </DialogDescription>
        </DialogHeader>
        <div
          className="relative max-h-[60vh] overflow-hidden rounded-md bg-muted/50"
          onClick={() => setCopyVisible(true)}
        >
          <pre
            // 全局默认禁选（styles.css 的白名单制）：这块是要拿去复制 / 贴给别人的，显式放开
            data-selectable
            className="max-h-[60vh] overflow-auto px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap break-all"
          >
            {detail}
          </pre>
          {copyVisible && (
            <button
              type="button"
              title={copied ? tr("已复制") : tr("复制")}
              aria-label={copied ? tr("已复制") : tr("复制")}
              onClick={(event) => {
                event.stopPropagation();
                copy();
              }}
              // 与消息操作行里的复制钮同一形态：无边框 / 无底色，只有图标
              className="absolute right-1.5 bottom-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              {copied ? (
                <CheckIcon className="size-4 text-emerald-500" />
              ) : (
                <CopyIcon className="size-4" />
              )}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 触发行里的「标题 + 明细」两段文本（图标与状态图标之外的所有文字）。
 *
 * 两段**都是单行截断**，但让位顺序相反：先压明细，标题最后才出省略号。
 *
 * - 标题是「这一步在干什么」，是扫对话流时唯一必须读懂的那句 —— 所以给它的收缩权重
 *   最低（默认 `shrink`，即 1）：有位置就完整显示，真的放不下才 `truncate` 出 `…`
 *   （全文在 Tooltip / 触屏弹窗里）。
 * - 明细（命令 / 路径）是补充信息：`shrink-[99]`，一挤就先被压掉。它有三处回声
 *   （Tooltip / 全文弹窗 / 内容区），截断不丢信息。
 *
 * ⚠️ 标题**不要改回 `break-words` 折行**：折行会让这一行高度随内容变，而右侧那组
 * 图标（状态 / 停止 / 箭头）是按首行 `h-5` 对齐的 —— 一行变两行就错位；长 prompt
 * 折成三四行还会把整条对话流撑散（用户报过「工具名换行了」）。行高恒定 = 扫读节奏恒定。
 *
 * ⚠️ 也**不要**给标题 `shrink-0` 换「明细不被压缩」：那会让这一行的 min-content 等于
 * 整句意图，窄屏上把右侧图标顶出容器（用户报过）。标题保宽度靠的是「权重最低」，
 * 不是「不参与收缩」。
 *
 * 明细前面那截 `max-w-*` **不要加**：外层那一行是 `inline-flex`（宽度由内容撑到
 * shrink-to-fit，好让状态图标紧跟文字），百分比基数跟着内容变 —— 于是整行右边还空着一大片，
 * 明细已经被砍到一半（用户原话：「明明有位置可以正常显示」）。同理别加 `min-w-*`：短明细
 * （`$ ls`、`.`）会被撑得比文本还宽，文本后面凭空多一段空白，状态图标被推远。
 *
 * 抽成组件是因为触屏与桌面两条分支渲染的是同一对文本，只是外层交互不同
 * （点开弹窗 / 悬停 Tooltip）。
 */
function ToolHeadLabel({ titleText, detail }: { titleText: string; detail?: string }) {
  return (
    <>
      <span className="min-w-0 truncate text-sm">{titleText}</span>
      {detail ? (
        <span className="min-w-0 shrink-[99] truncate font-mono text-xs">{detail}</span>
      ) : null}
    </>
  );
}

/**
 * 工具卡头部图标：**命令类给终端、文件类给文件**，认不出的才退回扳手。
 *
 * 判据用 `type`（调用点一律传 `tool-<工具名>`）而不是标题：标题常常是模型写的 `intent`
 * （「修一下登录流程」），认工具只能靠名字；而 `type` 每个调用点本来就在传，不用再加一条 prop。
 *
 * 工具名与 `shared/lib/parts.ts` 的 `TOOL_LABELS` 是同一套；这里只列**需要换图标**的那些，
 * 认不出的一律扳手 —— 新工具漏配图标最多是沿用旧观感，不会变成空白。
 *
 * 为什么命令类要分开：一条命令的结果区是一整块终端面板（`LiveOutputBlock`），
 * 与「读文件 / 写文件」那种文件卡片是两种东西。都挂扳手时，扫对话流只能靠读字分辨
 * 这一步是改代码还是跑命令。
 *
 * 文件类是一套 `File*` 家族：读 / 写 / 改 / 删 一字之差靠字形分（同一份文件从读、改到删
 * 在流里是连着的三张卡，形状一致才看得出是同一件事的推进）。搜内容用放大镜、找文件用
 * 「文件 + 放大镜」、列目录用文件夹 —— 这三步常挨在一起，各给一颗才不至于一路扳手。
 *
 * 终端助手那四个（`run_in_terminal` / `read_terminal_output` / `send_keys` /
 * `list_terminal_sessions`）用方形终端：它们敲在**用户眼前那条**终端里，与
 * `execute_command`（服务端起一个子进程）失败面完全不同 —— 理由与 `TOOL_LABELS` 里
 * 那段说明一致，卡片上不该混成同一个图标。
 */
const TOOL_HEAD_ICONS: Record<string, LucideIcon> = {
  // 对齐 dsh 后的名字；旧名保留给历史会话（同一颗图标）
  bash: TerminalIcon,
  read: FileTextIcon,
  write: FilePlusIcon,
  edit: FilePenIcon,
  glob: FileSearchIcon,
  grep: SearchIcon,
  str_replace_editor: FilePenIcon,
  execute_command: TerminalIcon,
  run_in_terminal: SquareTerminalIcon,
  read_terminal_output: SquareTerminalIcon,
  send_keys: SquareTerminalIcon,
  list_terminal_sessions: SquareTerminalIcon,
  // 文件类：名字取自 TOOL_LABELS，别按直觉另起（`read` / `Write` 之类是 ACP agent 自己的名）
  read_file: FileTextIcon,
  write_file: FilePlusIcon,
  edit_file: FilePenIcon,
  delete_file: FileXIcon,
  search_files: SearchIcon,
  find_files: FileSearchIcon,
  list_files: FolderOpenIcon,
  list_dirs: FolderTreeIcon,
};

/**
 * 工具名 → 头部图标；认不出的一律扳手。
 *
 * 导出给过程分组的抬头用（`TurnStepGroup` 的 `kind + toolName`）：那里与这里必须是**同一颗**，
 * 否则展开前后（组抬头 / 组内的卡）同一步会换图标。
 */
export function toolHeadIcon(toolName: string): LucideIcon {
  return TOOL_HEAD_ICONS[toolName] ?? WrenchIcon;
}

/** `tool-<工具名>` → 头部图标；不是工具类型（`dynamic-tool` 之类）也退到扳手 */
function toolTypeIcon(type: string): LucideIcon {
  return toolHeadIcon(type.startsWith("tool-") ? type.slice("tool-".length) : type);
}

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  detail,
  status,
  onStop,
  stopLabel,
  live = true,
  ...props
}: ToolHeaderProps) => {
  const tr = useT();
  /**
   * 触屏：明细仍紧跟工具名，但改成可点（点开全文弹窗，见 `DetailDialog`）；
   * 桌面端留在触发行里、悬停出 Tooltip。
   */
  const touch = useIsMobile();
  const [detailOpen, setDetailOpen] = useState(false);
  // 触发区只占内容宽度（`flex-col` + `max-w-full`），不铺满整行 —— 右侧那组按钮紧跟在它
  // 后面，不会被推到容器最右端。展开 = 箭头朝下，收起 = 朝右。
  //
  // 颜色 / 字重与 ReasoningTrigger（「思考了几秒」行）同一口径：整行 text-muted-foreground、
  // 常规字重，hover 整体提亮 —— 图标和标题都不带自己的颜色类，靠继承跟随 hover 变化。
  //
  // 标题 + **明细**同排：「这一步干什么」（意图 / 工具名）后面紧跟「对谁干的」（命令 / 文件）。
  // 两段都单行截断、**不设宽度上限**（行是 shrink-to-fit，百分比会误伤，见 `ToolHeadLabel`）：
  // 先压明细、标题最后才省略，让位顺序与理由见 `STATUS_SHRINK`。
  // 明细全文在 Tooltip（桌面）/ 全文弹窗（触屏）里；命令类工具的内容区还会再回声一份
  // （见 PartView 的 `renderBuiltinDirect` / `renderAcpDirect`）。
  // 头部外壳：触发行 + 可选的停止钮（平级，见 ToolHeaderProps.onStop 的说明）。
  /*
   * ⚠️ **触发器始终可点**（含 `input-available` 正在跑那一档）：实时输出、流式入参都在
   * 内容区里，运行中不给展开入口 = 用户只能看一行标题干等。以前这里按 `settled` 做
   * aria-disabled / 吞掉点击，理由是「展开一片没有输出的空壳」—— 现在内容区有真东西，
   * 而且展开与否是用户自己的选择（默认仍是收起，见 `PartView` 的 `ToolCallCard`）。
   *
   * ⚠️ 也**不要**改成原生 `disabled`：按钮一旦 disabled，浏览器会吞掉它内部所有子元素的
   * click —— 触屏上「点标题看完整命令」会连带失效。
   */
  const titleText = title ?? type.split("-").slice(1).join("-");
  /** 头部那颗图标：命令类工具是终端，其余是扳手（见 `TOOL_HEAD_ICONS`） */
  const HeadIcon = toolTypeIcon(type);
  /**
   * 标题能不能点开全文弹窗。
   *
   * 触屏没有 hover，长标题只能靠弹窗看全文；但**只有真的会渲染弹窗时**（`detail` 存在，
   * 见函数末尾那个 `!touch || !detail` 的短路）才把它变成可点区域 —— 否则点了一下没反应，
   * 比不能点更糟。
   */
  const titleOpenable = touch && !!detail;
  const openDetail = (): void => setDetailOpen(true);

  /*
   * 内容触发器：图标 + 标题 + 明细 + 状态，**不含箭头**（箭头移到了 `head` 里，排在
   * 停止钮右侧 —— 见下面 `head` 的说明）。
   */
  const trigger = (
    <CollapsibleTrigger
      className={cn(
        "flex min-w-0 max-w-full flex-col items-start gap-1 rounded-md text-left text-muted-foreground transition-colors hover:text-foreground",
        className
      )}
      {...props}
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-2">
        <HeadIcon className="size-4 shrink-0" />
        {/*
         * 标题**不截断**（宽度不够就折行），明细**单行截断** —— 两段的待遇与理由见
         * `ToolHeadLabel`。核心是：「这一步干什么」是扫对话流时唯一必须读懂的那句，
         * 宁可这一行高一点，也不出省略号。
         *
         * ⚠️ 也**不要**给标题 `shrink-0` 换「一定不被压缩」：那会让这一行的 min-content
         * 等于整句意图，手机窄屏下整行比容器还宽、右侧状态图标 / 停止钮被顶到外面（用户报过）。
         * 标题要的是「不被省略」，靠折行做到，不靠「不被压缩」。
         */}
        {titleOpenable ? (
          // 触屏：没有 hover，点名字（或明细）开全文弹窗 —— 弹窗里标题与明细都在。
          // 阻止冒泡，否则会同时触发卡片展开 / 收起。
          <span
            role="button"
            tabIndex={0}
            title={titleText}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openDetail();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              openDetail();
            }}
            className="flex min-w-0 max-w-full cursor-pointer items-center gap-2 transition-colors hover:text-foreground"
          >
            <ToolHeadLabel titleText={titleText} detail={detail} />
          </span>
        ) : (
          <Tooltip delayDuration={100}>
            <TooltipTrigger asChild>
              {/* 名字与明细一起做触发区：被截断的往往是明细，悬停它同样该出全文 */}
              <span className="flex min-w-0 max-w-full items-center gap-2">
                <ToolHeadLabel titleText={titleText} detail={detail} />
              </span>
            </TooltipTrigger>
            {/* 明细与标题同一个 Tooltip：悬停就能同时看到「这一步干什么 + 具体命令 / 路径」 */}
            <TooltipContent className="max-w-[28rem]">
              <div className="break-words">{titleText}</div>
              {detail ? (
                <div className="mt-1 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap break-all opacity-80">
                  {detail}
                </div>
              ) : null}
            </TooltipContent>
          </Tooltip>
        )}
        {status ? (
          <span className={cn("min-w-0 truncate", STATUS_SHRINK)}>{status}</span>
        ) : null}
        {/*
         * 状态：只有一颗图标，文案挪进 tooltip。
         * 图标本身已经把状态说清楚了（转圈 = 还在跑 / 绿勾 / 红叉 / 黄钟），文字挂在旁边只会
         * 跟标题抢宽度。想要确切说法的人悬停一下就有。
         */}
        <Tooltip delayDuration={100}>
          <TooltipTrigger asChild>
            {/* 图标现在是状态唯一的载体：`role="img"` + aria-label 让读屏也能听到状态 */}
            <span
              role="img"
              aria-label={tr(STATUS_LABELS[state])}
              className="inline-flex shrink-0 items-center"
            >
              {statusIcon(state, live)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tr(STATUS_LABELS[state])}</TooltipContent>
        </Tooltip>
      </span>
    </CollapsibleTrigger>
  );
  /*
   * 头部一行三段：内容触发器 → 停止钮（可选）→ 箭头触发器。
   *
   * 为什么把箭头从触发器里拆出来：停止钮要排在**箭头左侧**，而真正的按钮塞不进
   * CollapsibleTrigger（它本身就是 `<button>`，套一层既是非法 HTML，点停止还会先被
   * 触发器当成开合热区吞掉一次）。于是箭头单独成一个 Trigger —— Radix 允许一个
   * Collapsible 挂多个 Trigger，点内容、点箭头都开合。
   *
   * `group/row` 挂在整行上：箭头「悬停这一行才浮现」要按这一行算 —— 消息气泡自带一个
   * 裸 group，用裸 `group-hover:` 会变成「鼠标停在消息任意处、所有箭头一起亮」
   * （见 REVEAL_ON_HOVER_ARROW）。`min-w-0` 留给触发器：长标题 / 长明细自己折行、
   * 截断，不把右侧那组顶出容器（手机窄屏踩过）。
   *
   * 右侧那组 `h-5`：与首行（`text-sm` 的 20px 行高）等高居中 —— 标题折成多行时，
   * 停止钮和箭头仍贴着第一行，不会漂到整块中间去。停止钮自己 `h-6` 会溢出这 20px
   * 上下各 2px，但那只影响绘制、不撑高布局（`overflow` 默认可见）。
   */
  const head = (
    <div className="group/row flex min-w-0 max-w-full items-start gap-2">
      {trigger}
      <div className="flex h-5 shrink-0 items-center gap-2">
        {onStop ? (
          <Tooltip delayDuration={100}>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={stopLabel ?? tr("停止")}
                className="shrink-0"
                onClick={onStop}
              >
                <Square className="size-3 text-destructive" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{stopLabel ?? tr("停止")}</TooltipContent>
          </Tooltip>
        ) : null}
        {/* 箭头（第二个 Trigger）：平时隐形、悬停整行才浮出来（规则见 REVEAL_ON_HOVER_ARROW），
            触屏常显；**不按状态隐藏** —— 运行中也要能展开，看实时输出 / 半截入参。
            旋转靠它自己的 `data-state`，所以裸 `group` 挂在它身上。纯图标按钮没有文字，
            靠 aria-label 报「展开 / 收起」（具体的开合状态由 Radix 的 aria-expanded 给出）。 */}
        <CollapsibleTrigger
          aria-label={tr("展开 / 收起")}
          className="group flex shrink-0 items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRightIcon
            className={cn(
              REVEAL_ON_HOVER_ARROW,
              // 键盘 Tab 到这个 Trigger 上时箭头必须现身（`REVEAL_ON_HOVER_ARROW` 里的
              // `group-focus-visible/row` 要求整行 `group/row` 自身被聚焦，而它是 div、
              // 不可聚焦 —— 这里用 Trigger 自己的 `group` 补一条）。
              "size-4 shrink-0 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90"
            )}
          />
        </CollapsibleTrigger>
      </div>
    </div>
  );
  // 桌面端只渲染这一行（没有额外的外壳 DOM）；触屏多一个全文弹窗
  if (!touch || !detail) return head;
  return (
    <>
      {head}
      <DetailDialog
        title={title}
        detail={detail}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
};

/**
 * 这段文本**真的是 JSON** 吗（决定代码块用哪套语法高亮）。
 *
 * ⚠️ 以前对所有字符串一律 `language="json"`：终端输出、构建日志这类纯文本被 JSON 语法
 * 逐字切开 —— 每个数字都变成独立的 token span（`/dev/vda1` → `/dev/vda` + `1`、
 * `x86_64` → `x` + `86` + `_` + `64`），满屏都是跳出来的数字，单词也断了。
 * 只有首字符是 `{` / `[` 且能 parse 的才算 JSON，其余按纯文本渲染。
 */
const looksLikeJson = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    // 纯文本不进 Shiki（`language` 的类型里只有真语言，没有 plain text）：
    // 直接铺等宽 pre —— 不高亮、不切词，也省掉一次异步高亮。
    // 是 JSON 的才交给 CodeBlock（见 looksLikeJson 的说明）。
    Output = looksLikeJson(output) ? (
      <CodeBlock code={output} language="json" />
    ) : (
      <pre className="m-0 overflow-auto whitespace-pre p-4 font-mono text-sm">
        {output}
      </pre>
    );
  }

  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div className="py-2 px-3">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
