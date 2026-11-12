"use client";

/**
 * 消息区滚动容器：基于 `use-stick-to-bottom`（v1.1.6）实现「贴住底部」。
 *
 * 库内部用 spring 动画平滑跟随内容增长（就是「消息向上流动」顺滑观感的来源）；
 * 仅当「已经贴底」时才会自动跟随，用户上滚即停止、滚回底部自动恢复。
 *
 * 这里只做四件事：
 * 1. 切换会话 / 消息装载完成（resetKey 变化）：`useLayoutEffect` 里**同步写 scrollTop**
 *    落底，压掉内容暴增时库默认的 resize spring 动画（只调 scrollToBottom 是不够的，
 *    会被同一帧的 ResizeObserver spring 抢跑，详见那段注释）。
 * 2. 用户手动开合折叠块（`holdScroll`）：转调库的 `stopScroll()` 退出跟随，
 *    刚展开的内容向下长出来、视图不动，点的那张卡不会被拽到底部。
 * 3. **用户离开底部后，任何内容尺寸变化都不能把跟随重新打开**（见下面 contentRef 的
 *    observer）：库在内容变矮且「离底 ≤ 阈值」时会无视用户已上滚、把 isAtBottom 设回
 *    true；一轮结束时的自动折叠正好触发它，随后操作行出现就会贴底。
 * 4. 对外提供 isAtBottom / scrollToBottom / holdScroll，给「回到底部」按钮与折叠块用。
 * 5. **用户自己往上滚时立刻退出跟随**（见 `attachScroll` 里的 wheel / touch 监听）——
 *    库自带的「上滚即停」在我们这套样式 + 流式场景下两条判定同时失效，只靠它会一直
 *    被拽回底部。
 * 6. **装载期一律瞬时贴底**（`settling`）：刷新 / 切会话 / 回放重建时内容不是一次到位的
 *    （骨架 → 历史 → 代码高亮 / 图片撑开 → 回放逐帧），第 1 条的同步落底只压住了第一帧，
 *    之后每一次长高都会被库的 spring 接管 —— 观感就是「刷新后从顶部一路平滑滚到底」。
 *    从 resetKey 变化（含挂载）起算一小段窗口，窗口内把 resize 强制成瞬时；窗口在内容
 *    高度稳定后（或到硬上限）结束，流式追更的平滑跟随不受影响。
 */
import { Button } from "@fizz/ui/button";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import {
  PullToRefreshIndicator,
  usePullToRefresh,
} from "@fizz/agent-kit/shared/ai-elements/pull-to-refresh";
import { ArrowDownIcon } from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import type { ComponentProps } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * 「算贴底」的距离阈值（像素）。与库内部的 `STICK_TO_BOTTOM_OFFSET_PX` 取同一个值 ——
 * 两处口径不一致会出现「库认为贴底、我们认为没贴」的错位。
 */
const AT_BOTTOM_THRESHOLD_PX = 70;

/**
 * 「真正贴底」的距离（像素）：只有到这里才恢复跟随。
 *
 * 不能用上面那个 70px —— 那是**自动贴底锁定**的容差（键盘开合时重新锁住跟随），
 * 用户手动往下滚时他还没到底、只是进了 70px 范围，一旦据此恢复跟随，
 * 下一帧任何内容尺寸变化都会**瞬时**把他吸到底部（用户实测的「还没到底就跳」）。
 */
const AT_BOTTOM_EPSILON_PX = 2;

/**
 * 装载期的「静默」判定：内容高度多久不再变化就算装载结束（毫秒）。
 *
 * 装载完成之后常跟着一波**二次长高**（代码高亮、图片按真实尺寸撑开、折叠块展开），
 * 间隔通常在 200ms 内；窗口取短了会漏掉后半段，又变成自己往下滚。
 */
const SETTLE_QUIET_MS = 280;

/**
 * 装载期硬上限（毫秒）。
 *
 * 流式输出时内容每帧都在长高，静默计时会被一直往后推 —— 没有上限的话「刷新时这轮正在
 * 生成」会整轮退化成逐帧瞬时贴底，丢掉「消息向上流动」的平滑观感。上限保证它最多
 * 只覆盖装载那一小段，随后一定交还给 spring。
 */
const SETTLE_MAX_MS = 1600;

type ConversationContextValue = {
  isAtBottom: boolean;
  scrollToBottom: () => void;
  /** 用户手动开合折叠块时调用：退出自动贴底，别把刚展开的内容拽到底部 */
  holdScroll: () => void;
};

const ConversationContext = createContext<ConversationContextValue | null>(null);

/** 取消息区的滚动状态与动作（必须在 <Conversation> 内使用） */
export function useConversation(): ConversationContextValue {
  const context = useConversationOptional();
  if (!context) {
    throw new Error("useConversation must be used within a <Conversation>");
  }
  return context;
}

/**
 * 同 `useConversation`，但在 `<Conversation>` 之外调用时**返回 null 而不是抛错**。
 * 给「既可能在消息流里、也可能单独渲染」的片段用（如 PartView 里的工具卡 / 思考条）。
 */
export function useConversationOptional(): ConversationContextValue | null {
  return useContext(ConversationContext);
}

export type ConversationProps = ComponentProps<"div"> & {
  /**
   * 变化时立刻（瞬时）落底。切换会话 / 消息装载完成时由调用方递增 ——
   * 用 useLayoutEffect 在本帧 paint 之前写 scrollTop，杜绝任何中间态。
   */
  resetKey?: string;
  /**
   * 内容**变高**（ResizeObserver 的 positive resize）时是否用平滑动画跟随。
   *
   * 只有**流式追加**需要它（就是「消息向上流动」那个顺滑观感）。其余让内容长高的
   * 情况一律不需要，最典型的是历史里的图片：`MarkdownImage` 先用骨架占位、`onLoad`
   * 后按真实尺寸撑开，于是装载完成后内容还会二次长高 —— 用 spring 跟随就是一段
   * 「没人操作却自己往下滚」的动画（用户明确反馈过）。这类场景瞬时到底即可。
   *
   * 注意它**只在装载期结束后**才真正生效（见下面的 `settling`）：装载窗口里即便
   * 正在流式输出也强制瞬时，否则刷新后内容分阶段长高会被 spring 一路带着滚下来。
   *
   * 默认 `false`（瞬时）。流式那一路由调用方传 `streaming` 打开。
   */
  smoothResize?: boolean;
  /**
   * 上拉刷新：给了就在消息区挂上「滚到底部继续上拉 → 松手重拉这条会话」，
   * 并在**底边**显示指示器（见 `pull-to-refresh.tsx`）。
   *
   * 不传 = 完全不挂监听（容器工作台这类没有「重拉这条会话」语义的宿主）。
   *
   * ⚠️ 为什么不复用原来那颗「重新加载」按钮：错误只是**一种**该重拉的时机 ——
   * 「一条消息都没有」很可能是**没加载成功**，那种状态下原来根本没有按钮可点。
   */
  onRefresh?: () => Promise<unknown> | unknown;
  /**
   * 是否允许触发上拉刷新（默认 `true`）。传给 `false` 时手势监听、指示器都不挂，
   * 但容器仍保留 `overscroll-y-contain` —— 会话进行中要禁止的是「重拉会话」这个动作，
   * 不能让页面退回浏览器自己的整页下拉刷新。
   */
  refreshEnabled?: boolean;
};

export const Conversation = ({
  className,
  resetKey,
  smoothResize = false,
  onRefresh,
  refreshEnabled = true,
  children,
  style,
  ...props
}: ConversationProps) => {
  /**
   * 「装载期」标志：true 时内容怎么长高都瞬时贴底（见文件头第 6 条）。
   *
   * 初值 true —— 挂载本身就是一次装载，不能赌第一帧的 ResizeObserver 还没跑。
   * `resetKey` 每次变化都会把窗口重新拉开（切换会话 / 装载完成 / 回放重建 / 自己发消息），
   * 随后在「内容高度稳定」或到硬上限时结束。
   */
  const [settling, setSettling] = useState(true);

  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } =
    useStickToBottom({
      // 首屏 / 初次挂载直接落底（不要从顶部动画下来）
      initial: "instant",
      /*
       * 内容变高时的跟随方式。`undefined` 会让库回到自己的默认值（spring 平滑动画，
       * 见库内 mergeAnimations），"instant" 则瞬时贴底 —— 图片加载这类「没人操作却
       * 长高」的场景必须瞬时，否则就是一段自己往下滚的动画（见 smoothResize 注释）。
       *
       * `settling` 期间一律瞬时：库是在每次 RO 回调里现读这个 options，
       * 所以它跟着 React 重渲染生效即可，不需要额外通知库。
       */
      resize: smoothResize && !settling ? undefined : "instant",
    });

  /**
   * 上拉刷新（见 `pull-to-refresh.tsx`）：只有传了 `onRefresh`、且 `refreshEnabled`
   * 才挂监听与指示器。
   *
   * 解构而不是拿整个对象：`attachPull` 是 `useCallback` 的稳定引用（只随 `enabled` 变），
   * 而对象本身每次渲染都是新的 —— 把对象放进 `attachScroll` 的依赖会让 ref 回调每帧
   * 重建、监听被反复摘挂。
   */
  const pullEnabled = !!onRefresh && refreshEnabled;
  const {
    attach: attachPull,
    phase: pullPhase,
    distance: pullDistance,
  } = usePullToRefresh({
    enabled: pullEnabled,
    onRefresh: onRefresh ?? (() => undefined),
  });
  /** 上拉监听的卸载函数（与 `attachScroll` 同生命周期，节点换了要摘掉） */
  const pullCleanupRef = useRef<(() => void) | null>(null);

  /**
   * 用户主动离开底部后置 true：**只有**滚回底部或 resetKey 才复位。
   *
   * 不能只依赖库的 `isAtBottom`：流式期间内容每帧长高会写非 0 的
   * `resizeDifference`，库的 scroll 判定被整段跳过；键盘 / 触屏 / 拖拽滚动条
   * 这些不经过 wheel 的上滚因此在库里不算数，下一帧长高就被贴回底部。
   */
  const userPausedRef = useRef(false);

  /** 用户手动开合折叠块：退出跟随，让内容向下长、视图留在原地（见文件头注释）。 */
  const holdScroll = useCallback(() => {
    userPausedRef.current = true;
    stopScroll();
  }, [stopScroll]);

  /**
   * 盯**滚动容器自身高度**的观察器（不是内容高度）。
   *
   * 手机键盘收起 / 输入框高度变化会让滚动容器的高度跟着变，浏览器把 `scrollTop`
   * 夹到新的最大值会触发一次**看起来像上滚**的 scroll 事件，库据此把 `isAtBottom`
   * 置 false；之后流式内容再长高就不再跟随，用户必须手动滑到底部才恢复（实测反馈）。
   * 容器高度一变、而当前仍离底 ≤ 阈值时，直接同步落底并
   * `scrollToBottom({ animation: 'instant' })` 把库的状态机复位 —— 这与「用户真的
   * 翻到历史里」不同，那种情况离底 > 阈值，不动。
   *
   * 内容折叠 / 操作行出现这类**内容**高度变化不走这里，见下面 contentRef 的 observer。
   */
  const containerObserverRef = useRef<ResizeObserver | null>(null);
  /** 用户上滚监听的卸载函数（与 widthObserver 同生命周期，节点换了要摘掉） */
  const userScrollCleanupRef = useRef<(() => void) | null>(null);
  const attachScroll = useCallback(
    (el: HTMLDivElement | null) => {
      // 先把节点交给库（它要挂 scroll / wheel 监听、并从 ref 读 scrollTop）
      scrollRef(el);
      containerObserverRef.current?.disconnect();
      containerObserverRef.current = null;
      userScrollCleanupRef.current?.();
      userScrollCleanupRef.current = null;
      pullCleanupRef.current?.();
      pullCleanupRef.current = null;
      if (!el) return;
      // 下拉刷新：没传 `onRefresh` 时 `attachPull` 直接返回（不挂任何监听）
      pullCleanupRef.current = attachPull(el) ?? null;
      /**
       * 用户主动上滚 → 立刻退出跟随。
       *
       * 为什么库自带的「上滚即停」在这里不管用（两条判定同时失效）：
       *
       * 1. **wheel 那条**：库从事件 target 往上找第一个 `getComputedStyle(el).overflow`
       *    ∈ `{scroll, auto}` 的祖先，然后才认「这一滚是不是发生在滚动容器上」。而我们的
       *    容器是 `overflow-y-auto overflow-x-hidden`（见下面类名注释：必须禁掉横向滚动），
       *    计算值会序列化成 `"hidden auto"` —— 永远匹配不上，它一路走到没有父元素就
       *    `return`，**上滚完全不记账**。
       * 2. **scroll 那条**：库在回调里先判 `state.resizeDifference`，非 0 就 return
       *    （它没法区分「新内容到了」和「内容重排变高」）。流式输出时内容每帧都在长高，
       *    ResizeObserver 每帧都写一个非 0 的 difference，于是用户的 scroll 事件被整段丢掉。
       *
       * 两条一起失效 = 用户一边往上翻、AI 一边输出，`isAtBottom` 一直是 true，下一帧
       * 内容长高就被 `scrollToBottom` 拉回底部（用户实测：终端助手面板里根本翻不上去）。
       * 所以这里自己判「用户想往上」，直接 `stopScroll()` 把库的 isAtBottom 置 false ——
       * 它后续那些 resize 贴底在 rAF 里一查 `!isAtBottom` 就 bail。
       */
      /**
       * 手动滚到**真正贴底**后恢复跟随。
       *
       * 不能只把 `userPausedRef` 置 false：`stopScroll()` 同时把库的
       * `escapedFromLock` / `isAtBottom` 置成了退出状态；流式期间 resizeDifference
       * 非 0，库自己的 scroll 判定被跳过，不在这里复位的话「滚回底部」也不会再跟随。
       * 此时已经在底部，instant 只是把库的状态机复位，不会产生可见跳变。
       */
      const resumeFollowAtBottom = (): void => {
        if (!userPausedRef.current) return;
        userPausedRef.current = false;
        scrollToBottom({ animation: "instant" });
      };
      const onWheel = (e: WheelEvent): void => {
        if (e.deltaY < 0) {
          userPausedRef.current = true;
          stopScroll();
          return;
        }
        // 只有**真正到了底部**才恢复跟随；还在 70px 阈值里时不能 instant 吸底。
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_EPSILON_PX) {
          resumeFollowAtBottom();
        }
      };
      /** 触摸（手机 / 触屏本）：手指往下移 = 内容往上翻 = 用户在往回看 */
      let touchY: number | null = null;
      const onTouchStart = (e: TouchEvent): void => {
        touchY = e.touches[0]?.clientY ?? null;
      };
      const onTouchMove = (e: TouchEvent): void => {
        const y = e.touches[0]?.clientY ?? null;
        // 2px 死区：手指按住时的轻微抖动不该算「上滚」
        if (y !== null && touchY !== null && y - touchY > 2) {
          userPausedRef.current = true;
          stopScroll();
        }
        touchY = y;
      };
      /**
       * 兜底：键盘 / PageUp / 拖拽滚动条等不经过 wheel 的上滚。
       *
       * 只在「内容没有变矮」时把 scrollTop 变小算作用户上滚 —— 折叠块收起 / 删除消息
       * 会让浏览器夹小 scrollTop，那不是用户意图。回到最底部才重新打开跟随。
       */
      let lastTop = el.scrollTop;
      let lastHeight = el.scrollHeight;
      const onScroll = (): void => {
        const top = el.scrollTop;
        const height = el.scrollHeight;
        if (top < lastTop - 2 && height >= lastHeight) {
          userPausedRef.current = true;
          stopScroll();
        }
        /*
         * 用户自己往下滚时：
         * - 只有**真正到底**才恢复跟随；
         * - 还没到底（哪怕已在库的 70px 容差里）就继续压住库 —— 库的 handleScroll
         *   会把「near bottom」当成「at bottom」并解开锁定，不压的话下一帧内容一
         *   变尺寸就瞬时贴底。这里同步再 stopScroll() 一次，盖住它。
         */
        if (el.scrollHeight - top - el.clientHeight <= AT_BOTTOM_EPSILON_PX) {
          resumeFollowAtBottom();
        } else if (userPausedRef.current) {
          stopScroll();
        }
        lastTop = top;
        lastHeight = height;
      };
      el.addEventListener("wheel", onWheel, { passive: true });
      el.addEventListener("touchstart", onTouchStart, { passive: true });
      el.addEventListener("touchmove", onTouchMove, { passive: true });
      el.addEventListener("scroll", onScroll, { passive: true });
      userScrollCleanupRef.current = () => {
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("touchstart", onTouchStart);
        el.removeEventListener("touchmove", onTouchMove);
        el.removeEventListener("scroll", onScroll);
      };
      /** 上一帧的容器高度；`null` = 首次回调（只记录，不当成一次变化） */
      let prevHeight: number | null = null;
      const ro = new ResizeObserver(([entry]) => {
        const height = entry.contentRect.height;
        const first = prevHeight === null;
        const prev = prevHeight;
        const heightChanged = !first && prev !== height;
        prevHeight = height;
        // 首帧只记录：挂载时不该被当成「刚刚变过尺寸」
        if (!heightChanged) return;
        /*
         * **从「没有布局盒」恢复出来**（`display:none` → 有尺寸）：面板标签切回来时就是
         * 这一下（后台标签只是 `hidden`，不卸载）。
         *
         * 浏览器会把 `scrollTop` 原样还回来，可**隐藏期间内容可能已经长高**（后台跑完的
         * 那一轮）—— 于是「刚才贴底」的那条会停在旧偏移上、最新消息在折叠线以下。所以
         * 分两种：
         * - 用户没有主动上滚（`userPausedRef` false，一直在跟随）→ 瞬时回到底部；
         * - 用户翻在上面读 → **一点都别动**，留在浏览器还回来的那个位置。
         *
         * ⚠️ 这一支必须**排在下面那段 relock 之前**并 return：relock 的判据是「离底 ≤ 阈值」，
         * 而这里离底必然很大（内容长高了），落进去会被当成「用户翻到历史里」而完全不管。
         */
        if (prev === 0 && height > 0) {
          if (!userPausedRef.current) {
            el.scrollTop = el.scrollHeight;
            scrollToBottom({ animation: "instant" });
          }
          return;
        }
        // 直接量 DOM 而不是读 React state：这个判断必须与本次布局同步，
        // 走 state 会晚一帧（而这一帧正是库要贴底的那一帧）。
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        /*
         * 容器尺寸变化后仍然贴底 → 重新锁上跟随。
         *
         * 典型触发是手机键盘开合：`scrollTop` 被浏览器夹到新上限时会产生一次
         * 「scrollTop 变小」的 scroll 事件，库把它当用户上滚、把 isAtBottom 置 false；
         * 不重新锁的话，这一轮流式输出就永远不跟了（用户得手动滑到底）。
         * 只在「离底 ≤ 阈值」时做 —— 用户真的翻到历史里时不动他的视图。
         */
        if (!userPausedRef.current && distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX) {
          const relock = (): void => {
            // 再量一次：rAF 里用户可能已经上滚了，别把他拽回来
            if (el.scrollHeight - el.scrollTop - el.clientHeight > AT_BOTTOM_THRESHOLD_PX) return;
            el.scrollTop = el.scrollHeight;
            scrollToBottom({ animation: "instant" });
          };
          relock();
          // 尺寸变化后浏览器还可能补发一次 scroll（`scrollTop` 被夹到新上限），
          // 库会把它当成用户上滚。下一帧再锁一次，盖住这条迟到的 scroll。
          requestAnimationFrame(relock);
        }
      });
      ro.observe(el);
      containerObserverRef.current = ro;
    },
    [scrollRef, stopScroll, scrollToBottom, attachPull]
  );

  // 组件卸载时摘掉观察器、用户上滚监听与下拉监听（节点被换掉时由 attachScroll 自己清）
  useEffect(
    () => () => {
      containerObserverRef.current?.disconnect();
      userScrollCleanupRef.current?.();
      pullCleanupRef.current?.();
    },
    []
  );

  /**
   * **内容**尺寸变化时，用户已主动离开底部就重新压住库的跟随状态。
   *
   * 库自己的 ResizeObserver 在内容变矮时只要「离底 ≤ 阈值」就会把 isAtBottom 设回 true，
   * 完全不看 escapedFromLock —— 一轮结束时思考 / 工具卡自动折叠正好会让内容大幅变矮，
   * 用户明明在上面读，库却在这里把自己重新锁回底部；紧接着操作行 / 成果 chip 出现，
   * 内容回涨，库就贴底了（用户报的「会话结束后自己跳到底部」）。
   *
   * 外面那个容器 observer 盯的是**滚动容器**的尺寸，内容折叠时它根本不会触发，所以
   * 必须在 contentRef 上单独盯一次。顺序上库先注册、这里后注册，这里同步调 stopScroll()
   * 会把库刚置上的 isAtBottom 再压回 false，库随后的 rAF 贴底就会 bail。
   */
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (userPausedRef.current) stopScroll();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [contentRef, stopScroll]);

  /**
   * 装载期窗口：`resetKey` 每次变化（含挂载）重新拉开，内容高度静默
   * `SETTLE_QUIET_MS` 之后结束，最长不超过 `SETTLE_MAX_MS`（见文件头第 6 条）。
   *
   * 必须是 layout effect：`setSettling(true)` 要在本帧 paint 之前生效，让紧随其后的
   * ResizeObserver 回调读到的 `resize` 已经是 "instant" —— 换成普通 effect 会晚一帧，
   * 而那一帧正是装载内容长高、库要发起 spring 的那一帧。
   *
   * 顺序上也刻意排在下面「同步落底」那条之前：窗口先拉开，落底再执行，两者同一批
   * layout effect 里完成，中间不留可被 RO 插队的空隙。
   */
  useLayoutEffect(() => {
    const content = contentRef.current;
    setSettling(true);
    if (!content) {
      // 内容节点还没挂上（不该发生）：别把窗口卡死在装载期，交还给流式跟随
      setSettling(false);
      return;
    }

    let lastHeight = -1;
    let quietTimer: number | undefined;
    let maxTimer: number | undefined;
    let done = false;
    let ro: ResizeObserver | undefined;

    const stop = (): void => {
      if (done) return;
      done = true;
      if (maxTimer !== undefined) window.clearTimeout(maxTimer);
      if (quietTimer !== undefined) window.clearTimeout(quietTimer);
      ro?.disconnect();
      setSettling(false);
    };

    /** 每长高一次就重新计时 —— 装载是分批的，只有「静默」才算装完 */
    const arm = (): void => {
      if (done) return;
      if (quietTimer !== undefined) window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(stop, SETTLE_QUIET_MS);
    };

    ro = new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;
      if (height === lastHeight) return;
      lastHeight = height;
      arm();
    });
    ro.observe(content);
    arm();
    maxTimer = window.setTimeout(stop, SETTLE_MAX_MS);

    return () => {
      done = true;
      ro?.disconnect();
      if (maxTimer !== undefined) window.clearTimeout(maxTimer);
      if (quietTimer !== undefined) window.clearTimeout(quietTimer);
    };
  }, [resetKey, contentRef]);

  // 切换会话 / 消息装载完成：本帧 paint 之前瞬时落底（不要平滑动画）
  useLayoutEffect(() => {
    /*
     * ⚠️ 必须**同步**把 scrollTop 写到底，不能只调 scrollToBottom({ animation: "instant" })。
     *
     * 库的 scrollToBottom 内部每一步都 `await` 一个 rAF，而同一帧里 ResizeObserver 的回调
     * 先于 rAF 执行：历史消息一次性装载完成时内容高度暴增，RO 会先用 resize 动画（默认
     * spring）发起平滑滚动并占住 `state.animation`；随后 instant 那次请求因为 behavior
     * 不匹配被直接跳过（见库源码 `state.animation || (state.animation = …)` 与
     * `if (state.animation?.behavior === behavior)`），于是观感就是「切进会话后从顶部
     * 平滑滚到底部」。同步赋值则发生在 RO 之前，等 RO 回调跑时 scrollTop 已到底
     * （`scrollTop < target` 为假），spring 根本起不来。
     *
     * 落底本身直接写 DOM（同步、本帧生效）；随后的 scrollToBottom 负责把库的状态机复位
     * —— 它会清掉在途动画（`wait !== true` 时），并同步把 isAtBottom 置回 true。
     * 顺序不能反：先 scrollToBottom 的话，它内部要等一个 rAF 才真正动 scrollTop，
     * 又会被 RO 的 spring 抢先。
     */
    userPausedRef.current = false;
    const scrollEl = scrollRef.current;
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    scrollToBottom({ animation: "instant" });
  }, [resetKey, scrollRef, scrollToBottom]);

  const resumeAndScrollToBottom = useCallback(() => {
    userPausedRef.current = false;
    scrollToBottom();
  }, [scrollToBottom]);

  /**
   * context 值**按依赖记稳**，不要每次渲染现场造字面量。
   *
   * 流式期间 `Conversation` 每帧都在重渲染（`ChatPanel` 拿到新的 `app` 就重渲）。
   * 现场造对象会让所有 `useConversation()` 消费者（正文里每个工具卡 / 思考条 /
   * 折叠组 / 提问卡…）跟着每帧重渲 —— context 的传播**不受 `memo` 拦截**，
   * `MessageParts` 的 memo 在这里等于白加，历史消息子树（含 Shiki 高亮产物）每帧
   * 全量重渲一遍。这正是「会话跑着时整个软件都卡」的一大半。
   */
  const ctxValue = useMemo(
    () => ({ isAtBottom, scrollToBottom: resumeAndScrollToBottom, holdScroll }),
    [isAtBottom, resumeAndScrollToBottom, holdScroll]
  );

  return (
    <ConversationContext.Provider value={ctxValue}>
      <div
        ref={attachScroll}
        /*
         * `data-message-scroll` = 消息区的滚动容器锚点。
         *
         * 划选浮层（`features/chat/quotes.tsx` 的 `MessageQuoteLayer`）是 body 上的
         * `fixed` 浮层，要判断「浮层会不会飘出消息区、压到标签条上」就得知道这个容器的
         * rect。用属性显式标出来，而不是让那边按 `overflow-y-auto` 往上找祖先 ——
         * 正文里的代码块也是 `overflow-auto`，会被误判成滚动容器。
         */
        data-message-scroll=""
        className={cn(
          /*
           * `overflow-x-hidden`：消息区**只纵向滚**。只写 `overflow-y-auto` 时另一轴按
           * 规范会被算成 `auto` —— 任何一条略宽的内容（加载骨架的固定宽度、图片、
           * 没包滚动层的宽元素）都会让整块消息区能左右拖。手机壳的侧栏手势靠
           * 「起点不在横向滚动容器里」来避让代码块 / 宽表格（见 `use-sidebar-swipe.ts`），
           * 消息区自己被认成横向滚动容器时，右滑开抽屉就整个失效。
           * 代码块 / 表格自带 `overflow-x-auto`，不受这一条影响。
           */
          /*
           * 消息区**要画滚动条**：长会话里得看得见「我在哪儿 / 还有多长」。
           * 样式见 `styles.css` 那条 base 层 `::-webkit-scrollbar`（10px、圆角、半透明滑块），
           * 只在「有鼠标 + ≥768px」时生效 —— 触屏 / 手机宽度下 `display: none`，
           * 占位式滚动条会白吃 10px 横向空间，那种屏幕上不该画。
           *
           * ⚠️ 占位式滚动条的经典毛病：条从「没有」到「出现」，内容盒宽度少 10px ——
           * 整列内容横向缩一下、和下方输入框错开，短会话又弹回去（用户早先报的
           * 「滚动条前后宽度变化」）。解法不是把条藏掉（那是上一版的做法，代价是
           * 长会话里完全没有位置感），而是**让槽位始终存在**：`scrollbar-gutter`。
           *
           * ⚠️ 用 `stable both-edges` 而不是只写 `stable`：只留右侧槽位时内容盒中心会比
           * 面板中心左偏半个槽位（5px），消息列与下方输入框就差了这 5px；两侧各留一个槽，
           * 内容盒中心重新与面板中心重合，上下对齐。代价是可用宽度少 20px —— 宽屏无感，
           * 而触屏 / 窄屏的滚动条宽度是 0（`display: none`），槽位宽度也就是 0，不白吃像素。
           *
           * 滚动位置由 `use-stick-to-bottom` 显式管理（见下面 `overflowAnchor`）。
           */
          "relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden",
          /*
           * `overscroll-y-contain`：只在挂了下拉刷新时加。滚到头继续拉不再向页面链式传递
           * —— 少了它，手机上拉一下会触发**浏览器自己的整页下拉刷新**（整页重载），
           * 比原来点按钮糟得多。不挂上拉刷新的宿主保持原状（滚动链没被改变）。
           */
          onRefresh && "overscroll-y-contain",
          className
        )}
        /*
         * overflow-anchor: none —— 关掉 Chromium 的滚动锚定。流式内容增长 / markdown 重排时
         * 它会「帮忙」修正滚动位置，造成偶发跳顶。滚动位置由 use-stick-to-bottom 显式管理。
         *
         * ⚠️ `scrollbar-gutter` **不在这里写**：它必须和「什么时候画滚动条」那条 media
         * 查询放在一起（`styles.css` 里 `[data-message-scroll]` 的那一条），否则触屏 /
         * 窄视口下会白留一段槽位。上面 `data-message-scroll` 属性就是给那条规则用的。
         */
        style={{ overflowAnchor: "none", ...style }}
        {...props}
      >
        <div ref={contentRef}>{children}</div>
        {/*
         * 指示器放在**内容之后**：`sticky bottom-0` 要贴在滚动区底边，就必须是流里的
         * 最后一个节点（放前面会变成贴在顶边 —— 那是下拉刷新的形状）。
         */}
        {pullEnabled ? (
          <PullToRefreshIndicator phase={pullPhase} distance={pullDistance} />
        ) : null}
      </div>
    </ConversationContext.Provider>
  );
};

export type ConversationContentProps = ComponentProps<"div">;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <div className={cn("flex flex-col gap-8", className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useConversation();

  return (
    !isAtBottom && (
      // sticky（而不是 absolute）：按钮在滚动容器**里面**，用 sticky 才能一直贴在可视区底部
      <div className="pointer-events-none sticky bottom-4 z-10 -mt-12 flex justify-center">
        <Button
          // outline 变体在暗色下是 `dark:bg-input/30`、悬停 `dark:hover:bg-input/50`，而 `--input`
          // 本身就是 15% 透明的白，浮在消息上看不清；这里换成不透明的 popover / accent 背景，
          // 保留边框与阴影。
          // 背景本来就是不透明的（bg-background / dark:bg-popover），别再叠 backdrop-blur：
          // 磨砂对纯色底毫无视觉贡献，却让这颗按钮在**上滚浏览时**每帧多做一次背景采样。
          className={cn(
            "pointer-events-auto rounded-full bg-background text-foreground shadow-lg hover:bg-accent dark:bg-popover dark:hover:bg-accent",
            className
          )}
          onClick={scrollToBottom}
          size="icon"
          type="button"
          variant="outline"
          {...props}
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      </div>
    )
  );
};
