/**
 * 终端设置：「偏好」页（终端分组的第一个条目）。
 *
 * 这里都是纯客户端偏好（落 localStorage，见 `lib/terminal-prefs.ts` 与
 * `lib/terminal-shell.ts`），不走服务端；改动实时生效 —— 消费方（终端面板 /
 * 工具条）通过 useSyncExternalStore 订阅同一个 key，开关一拨立即按新偏好行事，
 * 不用重开终端。
 */
import { useEffect, useState } from 'react'
import { ClipboardPaste, Copy, History, ScrollText, Sparkles, SquareTerminal } from 'lucide-react'
import type { ShellDetectResult } from '@fizz/shells'
import { Switch } from '@fizz/ui/switch'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import {
  setTerminalCommandHistoryEnabled,
  setTerminalCommandPrediction,
  setTerminalCopyOnSelect,
  setTerminalPasteOnRightClick,
  setTerminalScrollback,
  TERMINAL_SCROLLBACK_OPTIONS,
  useTerminalCommandHistoryEnabled,
  useTerminalCommandPrediction,
  useTerminalCopyOnSelect,
  useTerminalPasteOnRightClick,
  useTerminalScrollback,
  type TerminalScrollback
} from '@fizz/agent-kit/shared/lib/terminal-prefs'
import { setTerminalShell, useTerminalShell } from '@fizz/agent-kit/shared/lib/terminal-shell'
import { Segmented } from '@fizz/agent-kit/shared/components/Segmented'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/** 「跟随系统默认」在 ToggleGroup 里的取值（ToggleGroup 只收字符串，null 用哨兵代替） */
const PLATFORM_DEFAULT = '__platform-default__'

export function TerminalTab({ app }: { app: AgentApp }) {
  const tr = useT()
  const copyOnSelect = useTerminalCopyOnSelect()
  const pasteOnRightClick = useTerminalPasteOnRightClick()
  const commandPrediction = useTerminalCommandPrediction()
  const commandHistoryEnabled = useTerminalCommandHistoryEnabled()
  const scrollback = useTerminalScrollback()

  /** 默认终端（设置里配，工具条「终端」主按钮用它） */
  const defaultShell = useTerminalShell()
  /** 宿主探测到的可选 shell（null = 还没拉到 / 不支持选择） */
  const [shells, setShells] = useState<ShellDetectResult | null>(null)

  // 拉一次可选 shell。listTerminalShells 是 store 的 action（引用稳定），effect
  // 实际只在挂载时跑一次；万一将来引用变动，cancelled 标志防竞态、setShells 幂等，也无害
  const { listTerminalShells } = app
  useEffect(() => {
    let cancelled = false
    void listTerminalShells()
      .then((result) => {
        if (!cancelled) setShells(result)
      })
      .catch(() => {
        if (!cancelled) setShells(null)
      })
    return () => {
      cancelled = true
    }
  }, [listTerminalShells])

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Copy className="size-3.5" />
          {tr('选中即复制')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('选中终端文字后自动复制。')}
        </p>
        <div className="flex items-center gap-3">
          <Switch
            id="terminal-copy-on-select"
            checked={copyOnSelect}
            onCheckedChange={setTerminalCopyOnSelect}
          />
          <label htmlFor="terminal-copy-on-select" className="text-xs text-muted-foreground">
            {copyOnSelect ? tr('已开启') : tr('已关闭')}
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <ClipboardPaste className="size-3.5" />
          {tr('右键粘贴')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('右键把剪贴板内容粘贴到命令行；选中文字时仍弹原菜单。默认开启。')}
        </p>
        <div className="flex items-center gap-3">
          <Switch
            id="terminal-paste-on-right-click"
            checked={pasteOnRightClick}
            onCheckedChange={setTerminalPasteOnRightClick}
          />
          <label htmlFor="terminal-paste-on-right-click" className="text-xs text-muted-foreground">
            {pasteOnRightClick ? tr('已开启') : tr('已关闭')}
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-3.5" />
          {tr('命令预测')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('根据历史与常见命令给出补全建议；→ 接受，Ctrl+↑/↓ 换选。')}
        </p>
        <div className="flex items-center gap-3">
          <Switch
            id="terminal-command-prediction"
            checked={commandPrediction}
            onCheckedChange={setTerminalCommandPrediction}
          />
          <label htmlFor="terminal-command-prediction" className="text-xs text-muted-foreground">
            {commandPrediction ? tr('已开启') : tr('已关闭')}
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <History className="size-3.5" />
          {tr('记录命令历史')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('记录已执行的命令，供预测和「命令历史」使用；关闭后不再新增记录。')}
        </p>
        <div className="flex items-center gap-3">
          <Switch
            id="terminal-command-history"
            checked={commandHistoryEnabled}
            onCheckedChange={setTerminalCommandHistoryEnabled}
          />
          <label htmlFor="terminal-command-history" className="text-xs text-muted-foreground">
            {commandHistoryEnabled ? tr('已开启') : tr('已关闭')}
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <ScrollText className="size-3.5" />
          {tr('滚动缓冲')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('一个终端标签能往上翻多少行，超出后最早的行会被丢掉。每个标签各占一份内存，行数调很大又同时开很多标签要留意。')}
        </p>
        <Segmented
          ariaLabel={tr('滚动缓冲')}
          value={String(scrollback)}
          // 选项只来自 TERMINAL_SCROLLBACK_OPTIONS，回填的值一定合法（prefs 里还有一道校验）
          onChange={(v) => setTerminalScrollback(Number(v) as TerminalScrollback)}
          options={TERMINAL_SCROLLBACK_OPTIONS.map((n) => ({
            value: String(n),
            label: tr('{n} 行', { n })
          }))}
        />
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <SquareTerminal className="size-3.5" />
          {tr('默认终端')}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {tr('工具条「终端」按钮默认使用的 shell；只影响新开的终端。在会话顶栏「选择终端」里选过的 shell 会自动记到这里。')}
        </p>
        {shells === null ? (
          <p className="text-xs text-muted-foreground">{tr('正在检测可用终端…')}</p>
        ) : (
          <Segmented
            ariaLabel={tr('默认终端')}
            value={defaultShell ?? PLATFORM_DEFAULT}
            onChange={(id) => setTerminalShell(id === PLATFORM_DEFAULT ? null : id)}
            options={[
              {
                value: PLATFORM_DEFAULT,
                label: tr('跟随系统默认'),
                title: tr('使用宿主平台的默认终端')
              },
              ...shells.shells.map((shell) => ({
                value: shell.id,
                label: shell.name,
                title: tr('默认使用 {name}', { name: shell.name })
              }))
            ]}
          />
        )}
        {shells !== null && shells.shells.length === 0 && (
          <p className="text-xs text-muted-foreground">{tr('宿主没提供可选的终端，只能用平台默认。')}</p>
        )}
      </section>
    </div>
  )
}
