// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { ChatComposer } from "@fizz/agent-kit/features/chat/chat-surface";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { useMainComposerProps } from "@fizz/agent-kit/features/chat/use-main-composer-props";

/** 初始页：中央输入框 + 下方常驻的工作区选择行（不指定项目也能直接聊） */
export function NewTaskView({ app }: { app: AgentApp }) {
  const t = useT()
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 sm:px-6 pb-20">
      <div className="w-full max-w-2xl">
        <div className="mb-5 flex flex-col items-center gap-1 text-center space-y-4">
          <div className="text-lg font-semibold">{t('开始新对话')}</div>
        </div>
        {/* 草稿在「确认开跑」后才清：建 ACP 会话要先起外部进程，失败时输入框必须还在 */}
        <ChatComposer
          {...useMainComposerProps(app, {
            onSubmit: (text, onStarted) => app.send(text, undefined, onStarted)
          })}
        />
      </div>
    </div>
  );
}
