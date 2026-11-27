import { Check, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@fizz/ui/button";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/**
 * 模型选择卡底部的 ACP 思考强度面板。只按 thought_level 能力显示，不能猜 agent 类型、
 * configId 或固定档位；沿用 agent 提供的名称与值。没有能力时隐藏，读取时就地显示状态。
 *
 * 交互是**一排可点的档位**（不是内置模型那颗滑块）：外部 Agent 的档位数量 / 名称都由
 * agent 自己给，没有「强度递增」的语义，拉一条滑块出来反而在暗示一个并不存在的刻度。
 */
export function acpThoughtLevelState(app: AgentApp) {
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  /** 新任务页：档位来自探测的 `draftAcp`，选择先记草稿、建会话时下发（同 `AcpModePill`） */
  const draftAcp = app.draftAcp;
  const draft =
    !conversation && app.chatTarget?.backend === "acp" &&
    draftAcp?.agentId === app.chatTarget.configId && draftAcp?.modelId === app.chatTarget.modelId
      ? draftAcp : null;
  const agentId =
    conversation?.backend === "acp" ? conversation.configId : draft?.agentId;
  const agent = agentId
    ? app.acpAgents.find((a) => a.id === agentId)
    : undefined;
  const thought =
    conversation?.acpThoughtLevel ?? draft?.thoughtLevel ?? undefined;
  const loading = !!draft?.loading || (!!conversation && app.acpConfigLoading);
  const error = draft?.error ?? (conversation ? app.acpConfigError : null);
  const visible = !!agent && (loading || !!error || !!thought?.options.length);
  return { conversation, draft, agent, thought, loading, error, visible };
}

export function AcpThoughtLevelSelect({ app }: { app: AgentApp }) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const { conversation, draft, agent, thought, loading, error, visible } = acpThoughtLevelState(app);
  if (!visible || !agent) return null;
  const chosen = draft?.thought ?? thought?.current;
  const currentValue = thought?.options.some((o) => o.value === chosen) ? chosen : thought?.current;
  const current = thought?.options.find((o) => o.value === currentValue);
  const disabled = switching || loading || !!error || app.streaming || (!conversation && app.creatingConversation);

  const select = async (value: string): Promise<void> => {
    if (disabled || switchingRef.current || !thought?.options.some((o) => o.value === value) || value === currentValue) return;
    if (!conversation) {
      app.setDraftAcpThought(value);
      return;
    }
    setSwitching(true);
    switchingRef.current = true;
    try {
      const res = await app.setAcpThoughtLevel(agent.id, conversation.id, value);
      if (!res.ok) toast.error(t("切换思考档失败：{error}", { error: res.error ?? t("未知错误") }));
    } catch (error) {
      toast.error(t("切换思考档失败：{error}", { error: error instanceof Error ? error.message : t("未知错误") }));
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  };

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2" aria-busy={loading || switching}>
      <legend className="flex w-full items-center justify-between gap-2 text-xs font-medium">
        <span className="flex shrink-0 items-center gap-1">
          {t("思考强度")}
          {switching && <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />}
        </span>
        <span className="truncate text-muted-foreground">{current?.name}</span>
      </legend>
      {loading ? (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
          {t("正在更新模型配置…")}
        </div>
      ) : error ? (
        <p role="alert" className="break-words text-xs text-destructive">{t("读取思考档失败：{error}", { error })}</p>
      ) : (
        <div className="flex flex-wrap gap-1" title={app.streaming ? t("生成期间不能切换思考强度") : undefined}>
          {thought?.options.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={option.value === currentValue ? "secondary" : "ghost"}
              size="sm"
              className="h-auto min-h-7 max-w-full gap-1 text-xs"
              disabled={disabled}
              aria-pressed={option.value === currentValue}
              title={option.description ?? option.name}
              onClick={() => { void select(option.value); }}
            >
              <span className="truncate">{option.name}</span>
              {option.value === currentValue && <Check aria-hidden className="size-3.5 shrink-0" />}
            </Button>
          ))}
        </div>
      )}
    </fieldset>
  );
}
