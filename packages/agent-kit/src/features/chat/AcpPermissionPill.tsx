// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@fizz/ui/select";
import { CHAT_ICON_PILL } from "@fizz/agent-kit/features/chat/composer";
import { IconTip } from "@fizz/agent-kit/shared/components/IconTip";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/** ACP 权限答复档的中文名（pill 的 tooltip / aria 用） */
const ACP_PERMISSION_LABELS = {
  confirm: "确认（逐次询问）",
  allow: "完全放行（逐次自动允许）",
} as const;

/**
 * 每档的第二行说明（富面板用，与内置权限 pill 同一套排版）。
 *
 * 为什么要它：两档名字只说「问不问」，不说「问了之后会怎样」——「完全放行」到底是
 * 完全放行是替你答 allow_once，不是让 Agent 记住授权（见下面的长注释）。
 */
const ACP_PERMISSION_HINTS = {
  confirm: "每次请求权限都弹确认卡，由你决定是否允许。",
  allow: "每次请求仅自动允许本次，不让 Agent 记住授权；不支持单次允许时仍会询问。",
} as const;

/**
 * ACP 会话的「权限答复」pill（复用内置权限 pill 的位置与外观；**两档**）。
 *
 * - **确认**（缺省）：agent 每次发 `session/request_permission` 都弹确认卡，由你挑；
 * - **完全放行**：服务端只选 Agent 提供的 allow_once；缺少时仍弹确认卡，不升级授权。
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
        {/*
          悬停只报档位名字。提示挂在触发器**内部**（不是把 SelectTrigger 包起来）：
          一是避免 Tooltip 的 `data-state` 盖掉 Select 的；二是 Select 关闭会把焦点还回
          触发器，包在外层的话提示会跟着那次回焦再弹一次（同 composer 的 PermissionPill）。
          `size-8` 与按钮等大：按钮本身 `p-0`，悬停整个可点区域都出提示。
        */}
        <IconTip label={t(ACP_PERMISSION_LABELS[mode])}>
          <span className="flex size-8 items-center justify-center">
            {/*
              图标上的 `!` 与内置权限 pill（composer.tsx 的 PermissionIcon）同一处理：
              压掉 `CHAT_ICON_PILL` 的 `hover:[&_svg]:text-primary`，让档位语义色
              （琥珀 = 完全放行）在 hover 时保持不变。
            */}
            {mode === "allow" ? (
              <ShieldAlert className="size-3.5 text-amber-600! dark:text-amber-500!" />
            ) : (
              <ShieldCheck className="size-3.5 text-muted-foreground!" />
            )}
          </span>
        </IconTip>
      </SelectTrigger>
      {/* 与内置权限 pill 同一个**富面板**形状（header + 两行选项，见 packages/ui 的
          `SelectItem`）：两颗 pill 表达的是同一件事（放得多宽），长得不一样会让人以为是两套机制 */}
      <SelectContent
        alignItemWithTrigger={false}
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
