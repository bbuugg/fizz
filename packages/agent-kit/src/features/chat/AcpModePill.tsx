import { AlertCircle, Loader2, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@fizz/ui/dropdown-menu";
import { CHAT_ICON_PILL } from "@fizz/agent-kit/features/chat/composer";
import { IconTip } from "@fizz/agent-kit/shared/components/IconTip";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/** 只读当前会话 / 当前 Agent+模型的草稿能力，不根据品牌或旧 type 推断语义。 */
function acpModeState(app: AgentApp) {
  const conversation = app.conversations.find((c) => c.id === app.activeConversationId);
  const draft = !conversation && app.chatTarget?.backend === "acp" && app.draftAcp &&
    app.draftAcp.agentId === app.chatTarget.configId && app.draftAcp.modelId === app.chatTarget.modelId
      ? app.draftAcp : null;
  const agentId = conversation?.backend === "acp" ? conversation.configId : draft?.agentId;
  const agent = app.acpAgents.find((a) => a.id === agentId);
  const modes = conversation?.acpModes ?? draft?.modes;
  const chosen = draft?.mode ?? modes?.current;
  const currentId = modes?.available.some((mode) => mode.id === chosen) ? chosen : modes?.current;
  const loading = !!draft?.loading || (!!conversation && !!app.acpConfigLoading);
  const error = draft?.error ?? (conversation ? app.acpConfigError : null);
  return { conversation, draft, agent, modes, currentId, loading, error };
}

/** 模式使用中性名称，原样展示 ACP 提供的选项；与权限答复、思考档互不替代。 */
export function AcpModePill({ app }: { app: AgentApp }) {
  const state = acpModeState(app);
  if (!state.agent) return null;
  // 换会话 / 模型 / 通道 / 候选项就丢弃旧菜单和保存状态，不能复用旧闭包。
  const key = JSON.stringify([state.conversation?.id, state.agent.id,
    state.conversation?.modelId ?? state.draft?.modelId, state.modes?.configId,
    state.modes?.available.map((mode) => mode.id)]);
  return <AcpModeControl key={key} app={app} state={state} />;
}

function AcpModeControl({ app, state }: { app: AgentApp; state: ReturnType<typeof acpModeState> }) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const { conversation, agent, modes, currentId, loading, error } = state;
  if (!agent) return null;

  if (loading || error) {
    const message = loading ? t("正在读取这个外部 Agent 的模式…") : t("读取模式失败：{error}", { error: error ?? t("未知错误") });
    return <IconTip label={message}>
      <span className="inline-flex" role={loading ? "status" : "alert"}>
        <button type="button" disabled className={CHAT_ICON_PILL} aria-label={message} aria-busy={loading}>
          {loading ? <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            : <AlertCircle aria-hidden className="size-3.5 shrink-0 text-destructive" />}
        </button>
      </span>
    </IconTip>;
  }
  if (!modes?.available.length) return null;
  const currentMode = modes.available.find((mode) => mode.id === currentId);
  const label = currentMode ? t("模式：{name}", { name: currentMode.name ?? currentMode.id }) : t("模式");
  const disabled = switching || modes.available.length === 1 || (!conversation && app.creatingConversation);

  const select = async (modeId: string): Promise<void> => {
    if (disabled || switchingRef.current || !alive.current || modeId === currentId ||
        !modes.available.some((mode) => mode.id === modeId)) return;
    if (!conversation) {
      app.setDraftAcpMode(modeId);
      return;
    }
    switchingRef.current = true;
    setSwitching(true);
    try {
      const res = await app.setAcpAgentMode(agent.id, conversation.id, modeId);
      if (!res.ok && alive.current) toast.error(t("切换模式失败：{error}", { error: res.error ?? t("未知错误") }));
    } catch (error) {
      if (alive.current) toast.error(t("切换模式失败：{error}", { error: error instanceof Error ? error.message : t("未知错误") }));
    } finally {
      switchingRef.current = false;
      if (alive.current) setSwitching(false);
    }
  };

  return (
    <DropdownMenu>
      <IconTip label={currentMode?.description ? `${label}：${currentMode.description}` : label}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={CHAT_ICON_PILL} disabled={disabled} aria-label={label} aria-busy={switching}>
            {switching ? <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              : <SlidersHorizontal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
          </button>
        </DropdownMenuTrigger>
      </IconTip>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="min-w-56">
        <DropdownMenuRadioGroup aria-label={t("模式")} value={currentId ?? undefined}
          onValueChange={(modeId) => void select(modeId)}>
          {modes.available.map((mode) => (
            <DropdownMenuRadioItem key={mode.id} value={mode.id}
              disabled={disabled} title={mode.description ?? mode.name ?? mode.id}>
              <span className="truncate">{mode.name ?? mode.id}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
