"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@fizz/ui/collapsible";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { REVEAL_ON_HOVER_ARROW } from "@fizz/agent-kit/shared/lib/hover-reveal-arrow";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { useStickToBottom } from "use-stick-to-bottom";
import { ShimmerLabel } from "@fizz/agent-kit/shared/ai-elements/shimmer-label";
import { reasoningPreview } from "@fizz/agent-kit/shared/lib/preview-text";
import { useStreamdownOptions } from "@fizz/agent-kit/shared/lib/streamdown";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { t } from "@fizz/i18n";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: undefined,
    });

    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const [startTime, setStartTime] = useState<number | null>(null);

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
        setStartTime(null);
      }
    }, [isStreaming, startTime, setDuration]);

    // Auto-open when streaming starts, auto-close when streaming ends (once only)
    useEffect(() => {
      if (defaultOpen && !isStreaming && isOpen && !hasAutoClosed) {
        // Add a small delay before closing to allow user to see the content
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, defaultOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen);
    };

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen, setIsOpen, duration }}
      >
        <Collapsible
          className={cn("not-prose my-1", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
  /**
   * 折叠 + 流式时，紧跟在「正在思考…」后面那一行**实时预览**（已切好最后一行）。
   * undefined = 不显示。调用方负责在不该显示时传 undefined，原因见 `reasoningPreview`。
   */
  previewText?: string;
  /**
   * 上面那一行的行号（`reasoningPreview` 返回的 `lineKey`）——「换行滚一格」的**唯一**判据。
   * undefined 时只横滚、不滚行（预览内容不是逐行推进的调用方可以不给）。
   */
  previewLineKey?: number;
};

/**
 * 思考正文 → 行内预览（**最后一行**的纯文本 + 行号）。
 *
 * 实现在 `shared/lib/preview-text.ts`：过程分组的抬头右侧也要同一行预览，
 * 而 `lib` 不能反向依赖 `ai-elements`（会成环）。这里保留同名导出，
 * PartView 等既有调用方的 import 路径不用动。
 */
export { reasoningPreview };

/**
 * 换行滚动的两半动画。**必须同长**（200ms），否则一进一出对不上，看着像两行在错位。
 *
 * `fill-mode-forwards` 是滚出去那一半的必要条件：`animate-out` 默认
 * `animation-fill-mode: none`，动画一结束就弹回原位（0），在窗口里重新露出来 ——
 * 表现就是「滚上去又跳回来」。
 *
 * `motion-reduce:hidden`：关掉动画时滚出去那行会一直停在原位盖住新行，索性整行不画
 * （只留「直接换行」的效果）。
 */
const ROLL_IN =
  "animate-in slide-in-from-bottom duration-200 ease-out";
const ROLL_OUT =
  "animate-out slide-out-to-top duration-200 ease-out fill-mode-forwards motion-reduce:hidden";

/**
 * 预览里的一行文本：超出宽度时**横向跟最新字**。
 *
 * 不是 truncate（那样永远只看得见开头，而最新内容在尾部），也不是
 * `scrollLeft = scrollWidth`（那是**每来一颗 token 硬跳一格**，看起来一格一格地抖 ——
 * 用户原话「很生硬」）。做法是让文字躺在 `w-max` 轨道上、窗口 `overflow-hidden`，
 * 把轨道 `translateX(-溢出量)`，溢出量变化由 CSS transition 追着走：token 密集时
 * 就是一段连续的平滑滚动，稀疏时也只是一次短促的滑动。
 *
 * ⚠️ 首帧落位**不能**带过渡：挂载时（新行 / 上一行）从 0 滑到尾部，看起来像整行被
 * 从开头抽走。所以第一次先关掉 transition 直接落位，下一帧再交还给 class。
 *
 * ⚠️ 位置靠 `ResizeObserver` 跟，不是靠 `[text]` 依赖：文字变长会改轨道宽度（观察轨道），
 * 面板被拖宽会改窗口宽度（观察窗口）—— 后者不跟的话，拖完面板预览会停在一个错的
 * 位移上，尾部被裁掉。
 */
const PreviewTrack = memo(function PreviewTrack({ text }: { text: string }) {
  const trackRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const win = track?.parentElement;
    if (!track || !win) return;

    const place = (instant: boolean) => {
      const overflow = Math.max(0, track.offsetWidth - win.clientWidth);
      const shift = `translateX(${-overflow}px)`;
      if (!instant) {
        track.style.transform = shift;
        return;
      }
      track.style.transition = "none";
      track.style.transform = shift;
      // 下一帧交还给 class 上的过渡，否则后面每一次位移也都是硬跳
      requestAnimationFrame(() => {
        track.style.transition = "";
      });
    };

    place(true);
    const observer = new ResizeObserver(() => place(false));
    observer.observe(win);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={trackRef}
      className="inline-block w-max transition-transform duration-150 ease-out motion-reduce:transition-none"
    >
      {text}
    </span>
  );
});

/**
 * 折叠 + 流式时触发行上那一行实时预览：**横向跟最新字、纵向跟最新行**。
 *
 * 纵向是「换行时整行往上滚一格」：同时挂两行 ——
 *   · 当前行在**流内**（`block`），撑出窗口宽度、并且带 `ROLL_IN` 从下方 100% 升上来；
 *   · 上一行**绝对定位**叠在同一个窗口里，带 `ROLL_OUT` 从 0 滚到 -100% 停住。
 * 两行都靠 `key` 换新：当前行 key = 行号，行号一变就重新挂载、动画从头播；
 * 上一行是换行那一刻从 state 里取到的「上一行的最终文本」。
 *
 * ⚠️ 判「换行」只能用 `lineKey`（见 `reasoningPreview`），不能比对文本前缀。
 * ⚠️ 窗口高度写死 `h-5`（= `text-sm` 的 20px 行高）：绝对定位的上一行需要窗口有确定
 * 高度才裁得干净。改触发行的字号时这里要跟着改，否则会露半行。
 */
export const ReasoningPreview = memo(function ReasoningPreview({
  text,
  lineKey,
}: {
  text: string;
  lineKey: number;
}) {
  /*
   * 「当前行」镜像成 state 而不是直接用 props：换行那一刻要拿到**上一行的最终文本**
   * 去渲染滚出去的那行，而 props 里只剩新行了。渲染期 setState 是 React 认可的
   * 「props 变了就调整 state」写法，会立刻再渲染一次、不会多一帧旧内容。
   */
  const [cur, setCur] = useState({ key: lineKey, text });
  const [prev, setPrev] = useState<{ key: number; text: string } | null>(null);

  /*
   * ⚠️ 空行不滚。`\n` 常常单独一个 token 先到，下一颗 token 才出字 —— 那一下如果照滚，
   * 窗口会先滚成一个空白（宽度也塌成 0），等字来了行号又没变、不会再滚第二次，
   * 结果就是「空白一下，然后文字凭空冒出来」，等于没动画。
   * 所以新行还没出字时**继续显示上一行**，等出字了再一起滚。
   */
  if (text) {
    if (cur.key !== lineKey) {
      setPrev(cur);
      setCur({ key: lineKey, text });
    } else if (cur.text !== text) {
      setCur({ key: lineKey, text });
    }
  }

  return (
    <span className="relative h-5 min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground">
      {prev ? (
        /* 纯视觉的滚出层：同一段字已经在当前行里，别让读屏念两遍 */
        <span
          /*
           * key 带 `prev-` 前缀：换行时「上一行」的 key 恰好等于刚退位那行的 key，
           * 不带前缀 React 会把那个 DOM 节点挪过来复用 —— `PreviewTrack` 里量好的
           * `translateX` 是按**旧窗口宽度**算的，而窗口宽度跟着新行变了，滚出去的
           * 那行尾部就对不上右边缘（会横着错开一截）。带前缀让它重新挂载、重新量。
           */
          key={`prev-${prev.key}`}
          aria-hidden
          className={cn("absolute inset-0 h-5 overflow-hidden", ROLL_OUT)}
        >
          <PreviewTrack text={prev.text} />
        </span>
      ) : null}
      <span key={`cur-${cur.key}`} className={cn("block h-5 overflow-hidden", ROLL_IN)}>
        <PreviewTrack text={cur.text} />
      </span>
    </span>
  );
});

/**
 * 思考条的默认触发文案（中英都走 `t()`；英文见 `packages/i18n/src/en.ts`）。
 *
 * ⚠️ 这里在渲染期调用 `t()`，所以**用它的组件必须订阅语言**（`ReasoningTrigger` 里调了
 * `useT()`）：本组件是 `memo` 的，props 不变时不会因为父级重渲染而跟着重渲染 —— 不自己
 * 订阅的话，切成英文后这行字会一直停在中文，直到下一条消息进来。
 */
const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming) {
    return <ShimmerLabel>{t('正在思考…')}</ShimmerLabel>;
  }
  // ⚠️ 只有「正在流式」才该显示闪烁的「正在思考…」。原来 `duration === 0` 也走这个分支，
  // 于是思考不到 1 秒就结束时，收起后头部会一直闪着「Thinking...」（像还没想完）。
  if (duration === undefined || duration === 0) {
    return <p>{t('思考了几秒')}</p>;
  }
  return <p>{t('思考了 {seconds} 秒', { seconds: duration })}</p>;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    previewText,
    previewLineKey,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();
    // 订阅语言：memo 组件不订阅的话，切语言时这行字不会跟着变（见 defaultGetThinkingMessage）
    useT();

    /*
     * ⚠️ `flex w-fit` 而不是 `inline-flex`（别改回去）：
     * inline-flex 是**行内级**盒子，会落进块级父元素的行盒里，被父级 line-height
     * （这里是 15px 正文的 22.5px）撑到 24.5px —— 触发器本身只有 20px，
     * 多出来的 4.5px 全掉在**下方**，于是这条「思考了几秒」看着比工具条偏上、
     * 与下一条的间距也比上一条松（工具条是 display:flex 的 20px 盒子，没有行盒）。
     * `flex` 让它变成块级盒子、脱离行盒，`w-fit` 保住「触发区只占内容宽度」。
     */
    const content = children ?? (
      <>
        <BrainIcon className="size-4 shrink-0" />
        {/* 预览在时标题不许被压缩（min-w-0 留给预览那一格，它自己横向滚动） */}
        <span className={cn("truncate", previewText != null && "shrink-0")}>
          {getThinkingMessage(isStreaming, duration)}
        </span>
        {previewText != null ? (
          /*
           * 折叠 + 流式时的行内实时预览：横向跟最新字、纵向跟最新行（换行滚一格）。
           * 窗口的宽度由流内的当前行撑出（`min-w-0 flex-1` 与触发器的 `w-fit max-w-full`
           * 搭配：文字短时整行贴合内容、右侧箭头紧跟，长了就顶满并把旧字从左边推出）。
           * 实现与坑见 `ReasoningPreview`。
           */
          <ReasoningPreview
            text={previewText}
            lineKey={previewLineKey ?? -1}
          />
        ) : null}
        <ChevronRightIcon
          className={cn(
            REVEAL_ON_HOVER_ARROW,
            "size-4 shrink-0",
            isOpen ? "rotate-90" : "rotate-0"
          )}
        />
      </>
    );

    return (
      <CollapsibleTrigger
        className={cn(
          // `group/row`：箭头 hover 显示按「这一行」算（消息气泡自带裸 group，用裸 group-hover
          // 会变成整条消息一起亮，见 REVEAL_ON_HOVER_ARROW）
          "group/row flex w-fit max-w-full items-center gap-2 text-left text-muted-foreground text-sm transition-colors hover:text-foreground",
          className
        )}
        {...props}
      >
        {content}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    // 思考内容可能很长：限高 + 内部滚动；用 use-stick-to-bottom 让流式增长时自动贴底
    // （用户中途上滚即停止、滚回底部自动恢复，与消息区一致），避免整篇思考直接铺满屏。
    const { scrollRef, contentRef } = useStickToBottom({ initial: "instant" });
    // 代码高亮主题跟着当前配色主题走（与 MessageResponse 同一份）
    const streamdownOptions = useStreamdownOptions();

    return (
      <CollapsibleContent
        className={cn(
          "mt-4 text-sm",
          "data-closed:fade-out-0 data-closed:slide-out-to-top-2 data-closed:animate-out data-open:slide-in-from-top-2 text-muted-foreground outline-none data-open:animate-in",
          className
        )}
        {...props}
      >
        <div
          ref={scrollRef}
          className="max-h-[20rem] overflow-y-auto pr-2 no-scrollbar"
          /*
           * overflow-anchor: none —— 关掉 Chromium 滚动锚定：流式 token 增长 / markdown 重排时
           * 它会「帮忙」修正滚动位置，造成偶发跳顶。滚动位置由 use-stick-to-bottom 显式管理。
           */
          style={{ overflowAnchor: "none" }}
        >
          <div ref={contentRef}>
            {/* Streamdown 的 props 比 div 更严（dir 只收 auto/ltr/rtl），这里显式收窄再透传。
                `sd-md` 是 styles.css 里「代码块 / 表格收敛」那组覆盖的作用域锚点；
                行号 / 表格工具条 / 代码高亮等渲染选项与 MessageResponse 共用 lib/streamdown.ts */}
            <Streamdown
              className="sd-md"
              {...streamdownOptions}
              {...(props as ComponentProps<typeof Streamdown>)}
            >{children}</Streamdown>
          </div>
        </div>
      </CollapsibleContent>
    );
  }
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
