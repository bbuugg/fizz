// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@fizz/ui/select";
import { CHAT_ICON_PILL } from "@fizz/agent-kit/features/chat/composer";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/** ACP 权限答复档的中文名（pill 的 tooltip / aria 用） */
const ACP_PERMISSION_LABELS = {
  confirm: "确认（逐次询问）",
  allow: "完全放行（不再询问）",
} as const;

/**
 * 每档的第二行说明（富面板用，与内置权限 pill 同一套排版）。
 *
 * 为什么要它：两档名字只说「问不问」，不说「问了之后会怎样」——「完全放行」到底是
 * 替你答 allow_once 还是 allow_always，只有这行字讲得清（见下面的长注释）。
 */
const ACP_PERMISSION_HINTS = {
  confirm: "每次请求权限都弹确认卡，由你决定是否允许。",
  allow: "服务端直接替你答复「允许」，确认卡不再出现。",
} as const;

/**
 * ACP 会话的「权限答复」pill（复用内置权限 pill 的位置与外观；**两档**）。
 *
 * - **确认**（缺省）：agent 每次发 `session/request_permission` 都弹确认卡，由你挑；
 * - **完全放行**：服务端在应用层直接替用户答复「允许」（挑 agent 给的 allow_always →
 *   allow_once），确认卡根本不会出现。
 *
 * 按**会话**记住（存会话配置，换会话要重选）。一轮运行中切换也有效：服务端在每次
 * `session/request_permission` 到来时现取会话当前的模式，所以切到「完全放行」后
 * **本轮后续**的权限请求就不再弹卡（已经挂起等答复的那一张除外）。
 * ⚠️ ACP 没有运行时可设的「权限等级」：agent 自己配成 `deny` 时它根本不发请求，放宽无从谈起
 * —— `allow` 只是把它的 **ask** 变成放行。
 */
export function AcpPermissionPill({ app }: { app: AgentApp }) {
  const t = useT();
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  if (!conversation || conversation.backend !== "acp") return null;
  const mode: "confirm" | "allow" =
    conversation.acpPermissionMode === "allow" ? "allow" : "confirm";
  return (
    <Select
      value={mode}
      onValueChange={(v) => app.setAcpPermissionMode(v as "confirm" | "allow")}
    >
      <SelectTrigger
        className={CHAT_ICON_PILL}
        icon={false}
        aria-label={t("权限答复：{label}", { label: t(ACP_PERMISSION_LABELS[mode]) })}
      >
        {/* mx-auto 居中：SelectTrigger 自带 justify-between，单个子元素会被顶到左边 */}
        {/*
          图标上的 `!` 与内置权限 pill（composer.tsx 的 PermissionIcon）同一处理：
          压掉 `CHAT_ICON_PILL` 的 `hover:[&_svg]:text-primary`，让档位语义色
          （琥珀 = 完全放行）在 hover 时保持不变。
        */}
        <span className="mx-auto flex items-center">
          {mode === "allow" ? (
            <ShieldAlert className="size-3.5 text-amber-600! dark:text-amber-500!" />
          ) : (
            <ShieldCheck className="size-3.5 text-muted-foreground!" />
          )}
        </span>
      </SelectTrigger>
      {/* 与内置权限 pill 同一个**富面板**形状（header + 两行选项，见 packages/ui 的
          `SelectItem`）：两颗 pill 表达的是同一件事（放得多宽），长得不一样会让人以为是两套机制 */}
      <SelectContent
        position="popper"
        side="top"
        align="start"
        sideOffset={6}
        className="w-80"
        header={
          <div className="space-y-1">
            <div className="text-[15px] leading-5 font-semibold">{t("权限答复")}</div>
            <p className="text-[13px] leading-5 text-muted-foreground">
              {t("外部 Agent 每次请求权限时怎么答复；按会话记住，换会话要重选。")}
            </p>
          </div>
        }
      >
        <SelectItem
          value="confirm"
          description={t(ACP_PERMISSION_HINTS.confirm)}
          icon={<ShieldCheck className="size-3.5 text-muted-foreground" />}
        >
          {t(ACP_PERMISSION_LABELS.confirm)}
        </SelectItem>
        <SelectItem
          value="allow"
          description={t(ACP_PERMISSION_HINTS.allow)}
          icon={<ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-500" />}
        >
          {t(ACP_PERMISSION_LABELS.allow)}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
