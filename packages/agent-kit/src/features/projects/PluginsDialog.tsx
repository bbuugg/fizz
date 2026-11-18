/**
 * 项目级「插件」弹窗：从侧栏项目「更多」菜单进来的入口，**只管这个项目自己的插件**。
 *
 * 用户级（全局）插件由 设置 →「插件」页统一管 —— 它对所有项目生效，所以那种「在 A 项目
 * 关掉它」的操作既做不到（项目开关对它无效），也不该让人以为在这里关了就全局关了，
 * 所以这一面**不列**它（服务端也只回项目自己那一半，见 `apps/server/src/api/plugins/route.ts`）。
 *
 * 内容本体是与设置页共用的 `shared/components/PluginsPanel`，按本仓库分层约定放在
 * `shared/`（被 ≥2 个功能区引用）。
 *
 * 生效时机**按能力分**（面板里有说明）：工具 / 提示词 / 钩子挂在 turn context 上 →
 * 下一轮对话；上传源挂在长驻 context 上 → 回到输入框重开附件菜单即可选到。
 */
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@fizz/ui/dialog'
import { PluginsPanel } from '@fizz/agent-kit/shared/components/PluginsPanel'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function PluginsDialog({
  app,
  workspaceId,
  open,
  onClose
}: {
  app: AgentApp
  /** 弹窗针对哪个项目（null = 没在开） */
  workspaceId: string | null
  open: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      {/*
        高度**钉死**（不是 `max-h`）：面板内容会随「扫描中 → 有列表 / 没有插件 / 搜索过滤后
        只剩一两项」在几行与几十行之间变，`max-h` 下弹窗高度跟着内容一起跳。固定高度后，
        多出来的行由下面那个滚动区域吞掉（与 `shared/ai-elements/followup-card.tsx` 的多题
        卡片同一思路）。`min(36rem, 85dvh)`：桌面就是 36rem，小屏幕上不超过视口。

        `sm:max-w-2xl` 用标准类（不用任意值）：只是想把原来的 560px 放宽一点，
        没必要为它多引入一个任意值类名。
      */}
      <DialogContent className="flex h-[min(36rem,85dvh)] flex-col overflow-hidden sm:max-w-2xl">
        <DialogTitle>项目插件</DialogTitle>
        <DialogDescription>
          这里管的是这个项目自己的插件（{'{项目}'}/.fizz/plugins）。用户级（全局）插件
          对所有项目生效，请到 设置 →「插件」里开关。生效时机看能力：工具 / 提示词 / 钩子
          下一轮对话生效，上传源重开附件菜单即生效。
        </DialogDescription>

        {/* `data-dialog-scroll`：滚动条贴弹窗右沿 + 没条时右侧也留满 16px（见 styles.css）。
            原来挂 `no-scrollbar` 把条整个藏了（那时条在 p-4 内侧、像多一条轨道）。 */}
        <div data-dialog-scroll="" className="min-h-0 flex-1 overflow-y-auto pt-1">
          {workspaceId && (
            <PluginsPanel app={app} scope="workspace" workspaceId={workspaceId} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
