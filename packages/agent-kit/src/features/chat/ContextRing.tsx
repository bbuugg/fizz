// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Gauge, Loader2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@fizz/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@fizz/ui/popover";
import { IconTip } from "@fizz/agent-kit/shared/components/IconTip";
import { CHAT_ICON_PILL } from "@fizz/agent-kit/features/chat/composer";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import {
  compactionKeepRecentTokens,
  DEFAULT_CONTEXT_WINDOW,
  findModelEntry,
  resolveContextWindow,
} from "@fizz/contracts/types";
import { turnIsAcp } from "@fizz/agent-kit/features/chat/session-backend";

/**
 * 模型 / 后端选择：紧挨发送按钮。
 *
 * 一个下拉装下「这一轮用什么」，标签行尾各有设置齿轮（配置入口永远可达）：
 * - AI 模型：每个模型配置一项，展开是它带的那几个模型；齿轮打开 设置 → AI 模型；
 * - 外部 Agent（ACP）：每个 agent 一项，展开是**设置里挑过的那几个**模型
 *   （一个 agent 常有十几二十个模型，全列出来太吵，白名单见设置 → 外部 Agent）；
 *   齿轮打开 设置 → 外部 Agent。没有任何模型 / agent 时分组也显示（给配置入口）。
 *
 * 会话类型在创建时就锁定，**被锁的整组不显示**（不是置灰）：
 * - acp 会话：只显示绑定的那个 agent 的模型（AI 模型组、其它 agent 一概不出）；
 * - 内置会话：ACP 组不出；锁了配置的只显示那份配置；
 * - 没有会话（空态）：两组全量可选。
 * 换类型只能新建会话。
 */
/**
 * 上下文用量圆环：输入框操作行右侧的小环 + **点击**弹出的详情卡。
 *
 * 按会话类型分两条数据来源：
 * - **内置 agent（内置）**：分子取最近一条助手消息落盘的 `usage.contextTokens`
 *   —— 就是 pi 的 `calculateContextTokens`：**最后一次请求上游真实上报的 input + output**
 *   （不是本地按字符估的量）；分母取该会话选中模型的窗口（`resolveContextWindow`，
 *   与压缩触发同源）。详情卡里可**手动压缩**。
 * - **ACP**：分子 / 分母都取 agent 自己上报的 `contextUsage`（session/update 的 usage_update
 *   的 `used` / `size`）。这份数据 `session/load` 拿不到，**没推过就整个不渲染**（不画空环）；
 *   历史在 agent 侧、本地压不了 —— 压缩相关 UI 一律隐藏。
 *
 * 流式进行中显示的是上一完成轮的值，本轮结束后跳到新值；ACP 的 usage_update 是即时的，
 * 收到就会在轮中刷新。
 */
export function ContextRing({ app }: { app: AgentApp }) {
  const t = useT();
  const isAcp = turnIsAcp(app);
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  const checkpoint = conversation?.contextSummary ?? null;

  /**
   * 内置 agent 的分母 = **这个会话选中的模型自己配的窗口**（pi 的 `model.contextWindow`）；
   * 模型没单独配就用**兜底窗口**（服务端 `FIZZ_CONTEXT_BUDGET` > 200k，见
   * `GET /api/chat/context`）—— 与 `runAgent` 判断「何时压缩」用的是同一个数，
   * 所以圆环上的 80% 永远等于「下一轮会压缩」那条线。
   *
   * 别改成「没配窗口就整个不画」：那会连带把圆环里的手动压缩入口一起藏掉，而服务端
   * 那侧本来就按兜底值在压 —— 界面不显示只会让人找不到按钮，不会让压缩不发生。
   *
   * `windowFromModel` 只用来在卡片上说明这个分母的来源（模型自己声明 / 兜底值）。
   * ACP 不用它：窗口由 agent 在上报里给。
   */
  const config = app.models.find((m) => m.id === app.chatTarget?.configId);
  const modelId = app.chatTarget?.modelId;
  const configuredWindow = findModelEntry(config?.models, modelId)?.contextWindow;
  const windowFromModel =
    typeof configuredWindow === "number" &&
    Number.isFinite(configuredWindow) &&
    configuredWindow > 0;
  const localContextWindow = resolveContextWindow(
    config?.models,
    modelId,
    app.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
  );
  /**
   * 兜底窗口是**服务端**解析的（环境变量只在那边），挂载时拉一次缓存；`null` 期间先按
   * `DEFAULT_CONTEXT_WINDOW` 画，拉到之后自然重算（`loadDefaultContextWindow` 自己会去重）。
   * 模型配了窗口就不必拉 —— 那一份永远用不上。
   */
  useEffect(() => {
    // ACP 用不到兜底窗口（分母来自 agent 上报的 size），别为它白拉一次
    if (!isAcp && !windowFromModel) void app.loadDefaultContextWindow();
  }, [isAcp, windowFromModel, app.loadDefaultContextWindow]);

  /** 内置 agent：上一轮的完整用量 —— 从后往前找第一条带 usage 的助手消息（同时要它的 createdAt） */
  const lastUsageMessage = useMemo(() => {
    for (let i = app.messages.length - 1; i >= 0; i--) {
      const m = app.messages[i];
      if (m.role === "assistant" && m.usage) return m;
    }
    return null;
  }, [app.messages]);
  const lastUsage = lastUsageMessage?.usage ?? null;

  /**
   * 带 `contextUsage` 的助手消息（从后往前找最后一条）。
   *
   * 两条来源共用这一个 memo：ACP 是 agent 上报，内置 agent（内置）是每个工具步骤
   * 边界由服务端估推（见流事件 `context-usage`）—— 两者的落点都是消息上的
   * `contextUsage`，所以这里不需要按 isAcp 分叉。
   */
  const contextUsageMessage = useMemo(() => {
    for (let i = app.messages.length - 1; i >= 0; i--) {
      const m = app.messages[i];
      if (m.role === "assistant" && m.contextUsage) return m;
    }
    return null;
  }, [app.messages]);
  /**
   * 上下文占用的「实时那份」（**仅内置 agent**）：
   * 本轮每个工具步骤边界由服务端估算推来（见流事件 `context-usage`），落点是消息上的
   * `contextUsage`。它比 finish 的发得早，所以用于「一轮之内圆环也跟着走」。
   *
   * ⚠️ 只有当这份比 `lastUsageMessage`（带 `usage` 的助手消息）**严格更新**时才认：
   * 一轮跑完后，finish 的 `usage` 和最后一步的 `contextUsage` 落在**同一条**消息上
   * （同一个 `createdAt`），这份是「最后一步开始前」的估算，比 finish 的权威值略小，
   * 那时必须让 finish 赢 —— 所以判据是 `>` 而不是 `>=`（`>=` 会让估算把权威值盖回去，
   * 圆环跑完后永远差最后一段输出）。会话重开后 `contextUsage` 不再回放，自然退到 finish。
   */
  const liveContextUsage =
    contextUsageMessage &&
    (!lastUsageMessage ||
      contextUsageMessage.createdAt > lastUsageMessage.createdAt)
      ? contextUsageMessage.contextUsage
      : null;
  /**
   * ACP 的分子 / 分母：
   * - 先看**消息上**那份 —— 本轮 agent 推来时 handleFrame 即时写入，最新；
   * - 再退到**会话配置**里那份 —— 服务端持久化过，刷新后即使 `session/load` 回放
   *   不带 `usage_update`，圆环也能画回来。
   *
   * 两份都没有就整个不显示（不画一个永远空的环）；上面两个 useMemo 必须先执行
   * （hooks 顺序），所以这个早退放在它们之后。
   */
  const acpUsage = liveContextUsage ?? conversation?.acpContextUsage ?? null;
  /*
   * ACP：两份都没有、或 agent 报了个非法的 size（0 / NaN）就整个不显示。
   * `size` 是分母，为 0 时 `used / size` 会变成 Infinity —— 圆环被顶满、直接判红，
   * 看着像「上下文爆了」，实际只是没数据（上游 `toAcpStreamEvent` 已经滤过一次，
   * 但持久化的那份是历史数据，可能来自旧版本）。
   *
   * 内置 agent 没有这个分支：分母永远有（模型窗口 || 兜底窗口），最多是 `used` 还没来。
   */
  if (
    isAcp &&
    !(acpUsage && Number.isFinite(acpUsage.size) && acpUsage.size > 0)
  )
    return null;
  /**
   * 分子只认 `contextTokens`（pi 的 `calculateContextTokens` = 最后一次请求的 input + output）。
   * **不要用 `inputTokens`**：那是上游上报的**整轮累计**，多步工具循环下会虚高好几倍
   * （见 `TurnUsage.contextTokens` 的说明）—— 早先拿它当「上下文占用」，圆环就一直是超标的。
   *
   * 手动压缩之后、下一轮跑完之前：手上还是**压缩前**那一轮的值，直接画会显示成
   * 「压了等于没压」。这段时间用检查点里算好的 afterTokens 顶一下（同一口径：
   * base + 压缩后消息），等下一轮跑完自然换成实测值。
   */
  const compressedUsed =
    checkpoint &&
    (!lastUsageMessage || checkpoint.createdAt > lastUsageMessage.createdAt)
      ? checkpoint.stats.afterTokens
      : null;
  /**
   * 分子优先级（内置 agent）：
   * 1. **本轮实时估算**（`liveContextUsage`，每个工具步骤边界推来）—— 让圆环在一轮之内
   *    也跟着走；这是 pi 的兜底估算分支，finish 时会被上游真实 usage 覆盖。
   * 2. 上一轮 finish 落盘的 `usage.contextTokens`（历史 / 刚打开会话时用）。
   * 手动压缩后、下一轮还没产出实时值（也没跑完）时，用检查点的 afterTokens 顶一下
   * —— 判据仍是「检查点比手上这份估算更新」，压缩后 `liveContextUsage` 会被清掉
   * （新一轮还没推），所以这里先看检查点再看实时值。
   */
  const used = isAcp
    ? (acpUsage?.used ?? null)
    : (compressedUsed ??
      liveContextUsage?.used ??
      lastUsage?.contextTokens ??
      null);
  /** ACP 的窗口取 agent 上报的 size（本地模型配置对 ACP 不适用） */
  const contextWindow = isAcp && acpUsage ? acpUsage.size : localContextWindow;
  /** 顶上来的那个值是**压缩后**的估算，卡片里要标明，别让人以为又多占了（仅内置 agent） */
  const usedIsCheckpoint = !isAcp && compressedUsed !== null;

  // pi 的 footer 是 `(tokens / contextWindow) * 100` 保留一位小数；**不截断**（会真的显示 105.3%）
  const percent = used !== null ? (used / contextWindow) * 100 : null;
  // 弧长只能画 0..1，截断只发生在这里；数字与颜色仍按真实比值（与 pi 的 footer 一致）
  const ratio = percent !== null ? Math.min(1, percent / 100) : null;
  const percentText = percent !== null ? percent.toFixed(1) : null;
  // 颜色档照抄 pi 的 footer：`> 90` 红、`> 70` 琥珀，其余默认（无数据淡灰）
  const tone =
    percent === null
      ? "stroke-muted-foreground/30"
      : percent > 90
        ? "stroke-destructive"
        : percent > 70
          ? "stroke-amber-500 dark:stroke-amber-400"
          : "stroke-muted-foreground";

  const compressing = app.contextCompressing;
  /**
   * 手动压缩能不能**真的压出东西** —— 判据与服务端的切点同一条线：
   * **保留区之外还有原文**，切得出要摘要的那一段，才点得动。
   *
   * ⚠️ 这里曾经拿 `compactionTriggerTokens`（窗口 − 预留，默认窗口下 ≈92%）当闸，
   * 那是**自动**压缩的触发线；手动压缩走 `compactHistory({ force: true })`，
   * 服务端**根本不看它**。结果就是「上下文不到 92% 时按钮永远灰着」—— 明明还有
   * 几十万 token 的历史可以摘要，按钮却像坏了一样（用户报的就是这个）。
   *
   * 现在的算法（两边同源，公式在 `compactionKeepRecentTokens`）：
   * - 保留区 `keep` = min(20000, max(1024, 0.8 × (窗口 − 预留 − base)))；
   * - 没检查点：消息占用的部分（`used − base`）超过 `keep` 就压得动；
   * - 有检查点：只有**检查点之后新增**的量（`used − afterTokens`）超过 `keep`
   *   才切得动 —— 刚压完时这个值≈0，按钮自然灰着（那时也确实没东西可压）。
   *
   * `used` 还没拿到（上游不报 usage / 刚开新会话）时**放行**：判不了就别拦，
   * 让服务端回答（它会在没东西可压时回一句人话）。
   */
  const baseTokens = contextUsageMessage?.contextUsage?.base ?? 0;
  const keepTokens = compactionKeepRecentTokens(contextWindow, baseTokens);
  const compressibleTokens =
    used === null
      ? null
      : checkpoint
        ? used - checkpoint.stats.afterTokens
        : used - baseTokens;
  const canCompact =
    !isAcp && (compressibleTokens === null || compressibleTokens >= keepTokens);
  /** 置灰的原因：直接写在 title 上，省得用户猜 */
  const compactBlockedReason = isAcp
    ? t("外部 Agent 自己管理上下文，本地无法压缩")
    : !canCompact
      ? t("检查点之后还没有超出保留区的历史，压缩不会减少占用")
      : undefined;

  const compress = async (): Promise<void> => {
    const res = await app.compressContextNow();
    // 成功后的摘要块 / 横幅由 store 的 SSE 事件驱动；失败这里直接报
    if (!res.ok) toast.error(t("手动压缩失败：{error}", { error: res.reason ?? t("未知错误") }));
  };

  /** 圆环几何：r=7 在 18×18 视窗里留给 2.5 描边刚好；弧线从 12 点方向起 */
  const R = 7;
  const CIRC = 2 * Math.PI * R;

  /**
   * 悬停提示：**只放占用本身**（`已用 / 窗口 · 百分比`）—— 详情与手动压缩仍在点击后的
   * 卡片里，提示贴着输入行，写多了会盖住正文。数字用 `tabular-nums`，鼠标扫过时不抖。
   *
   * 以前这里挂的是原生 `title`（只有「点击看详情」一句话，没有数字），鼠标停下要等系统
   * 的延迟才出来、样式也跟全站气泡不一套；换成 `IconTip` 后与一排图标钮一致。
   * `used` 还没拿到（上游不报 / 刚开新会话）时把分子写成 `—`，分母照给 —— 比整句
   * 「暂无数据」更能说明「差的是分子」。
   */
  const usageTip = (
    <span className="tabular-nums">
      {used !== null ? used.toLocaleString() : "—"}
      {" / "}
      {contextWindow.toLocaleString()}
      {percentText !== null ? ` · ${percentText}%` : ""}
    </span>
  );

  return (
    <Popover>
      {/*
        提示挂在**外层 span** 上，不套 PopoverTrigger：触发器自带 `data-state`，
        `TooltipTrigger asChild` 注进去的状态会把它盖掉（见 IconTip 文件头的说明）。
        span 与按钮等大（inline-flex 包着 32px 的钮），悬停区域不变。
      */}
      <IconTip label={usageTip}>
        <span className="inline-flex">
          <PopoverTrigger asChild>
            <button
              type="button"
              /*
                ⚠️ **悬停不改圆环颜色**（用户要求）：这颗的「图标」是手绘 SVG，圆环用
                `stroke-*` 上色、本来就不吃 `CHAT_ICON_PILL` 里那条 `hover:[&_svg]:text-primary`；
                曾经另补过一条 `hover:[&_circle]:stroke-primary` 让整排 pill 的 hover 手感一致，
                但圆环的颜色本身是**用量告警语义**（灰 / 琥珀 / 红），hover 一变就会被误读成
                「占用变了」—— 去掉它。hover 只出上面那条占用提示，详情仍然点击才弹。
              */
              className={CHAT_ICON_PILL}
              aria-label={t("上下文用量")}
            >
              {compressing ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <svg viewBox="0 0 18 18" className="size-4 shrink-0" aria-hidden>
                  <circle
                    cx="9"
                    cy="9"
                    r={R}
                    fill="none"
                    strokeWidth="2.5"
                    className="stroke-muted-foreground/25"
                  />
                  {ratio !== null && ratio > 0 && (
                    <circle
                      cx="9"
                      cy="9"
                      r={R}
                      fill="none"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray={`${(ratio * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`}
                      transform="rotate(-90 9 9)"
                      className={tone}
                    />
                  )}
                </svg>
              )}
            </button>
          </PopoverTrigger>
        </span>
      </IconTip>
      {/*
        与「模型 / 权限」那几个下拉保持一套外观：圆角、实边框、离视口边缘留白。
        ⚠️ `PopoverContent` 默认只有 `ring-foreground/5`，在 `contrast` 主题下
        （`--popover` 与 `--background` 同色、边框才是纯黑 / 纯白）等于没有边；
        而且圆环在输入行偏右，`align="end"` 在窄屏上会把 256px 的卡片顶到视口左缘，
        没有 `collisionPadding` 就紧贴屏幕边。两处都照 DropdownMenuContent 来。
      */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className="w-64 rounded-xl border border-border"
      >
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Gauge className="size-3.5" />
            {t("上下文用量")}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums">
              {used !== null ? used.toLocaleString() : "—"}
            </span>
            <span className="text-muted-foreground">
              / {contextWindow.toLocaleString()} tokens
              {percentText !== null && ` · ${percentText}%`}
            </span>
          </div>
          {/* 手动压缩之后、下一轮跑完之前，手上没有任何上游实测值 —— 这个数是压缩后的
              **估算**。不标出来就会被当成实测值读（「怎么压完还是 40k」）。 */}
          {usedIsCheckpoint && (
            <div className="text-muted-foreground">{t("（压缩后估算，下一轮起按上游实测值）")}</div>
          )}
          {/* 压缩相关的是内置 agent 专属：ACP 的上下文在 agent 侧，本地既看不见
                        压缩历史也没有可点的按钮（`compressContextNow` 只走内置那条路） */}
          {!isAcp && (
            <>
              <div className="border-t pt-2" />
              {app.contextNotice ? (
                <p className="text-muted-foreground">
                  {t("最近一次压缩：{before} → {after} token，摘要了 {summarized} 条消息、保留 {kept} 条。", {
                    before: app.contextNotice.beforeTokens.toLocaleString(),
                    after: app.contextNotice.afterTokens.toLocaleString(),
                    summarized: app.contextNotice.summarizedTurns ?? 0,
                    kept: app.contextNotice.keptTurns ?? 0,
                  })}
                </p>
              ) : checkpoint ? null : (
                <p className="text-muted-foreground">
                  {t("最近没有发生过上下文压缩。")}
                </p>
              )}
              {checkpoint && (
                <p className="text-muted-foreground">
                  {t("已开启摘要压缩（{time}）：之前的对话以摘要参与上下文，原始消息未动。", {
                    time: new Date(checkpoint.createdAt).toLocaleString(),
                  })}
                </p>
              )}

              {app.activeConversationId && (
                <div className="flex items-center gap-2 pt-1">
                  {/* 会话进行中禁止压缩：这一轮还在跑时禁用。
                                        服务端不额外拦（回合中途落检查点只影响下一轮，无害），
                                        这里禁用是交互层的要求：用户在等回复，按钮点了也没有意义。 */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    disabled={compressing || app.streaming || !canCompact}
                    title={
                      app.streaming
                        ? t("这一轮还在进行中，请等它结束后再压缩")
                        : compactBlockedReason
                    }
                    onClick={() => void compress()}
                  >
                    {compressing ? (
                      <>
                        <Loader2 className="size-3 animate-spin" />
                        {t("压缩中…")}
                      </>
                    ) : (
                      t("压缩上下文")
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
