/**
 * 命令面板的「搜索会话」二级视图：同一块面板，功能切换成会话搜索。
 *
 * 与命令面板的会话搜索共用服务端接口 `searchConversations`（侧栏那条已移除）：
 * 标题 + 消息正文都搜，结果带回命中片段；归档会话照搜（归档是收起来，不是消失）。
 * 这里只负责这一层视图 —— 进出二级的模式切换与 Esc 行为由 CommandPalette 编排
 * （Esc 拦截必须挂在 Radix 的 onEscapeKeyDown 上，所以搜索词的状态提升到那里）。
 */
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useEffect, useState } from 'react'
import { ArrowLeft, Archive, Loader2, MessageSquare } from 'lucide-react'
import type { ConversationSearchHit } from '@fizz/contracts/agent-api'
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@fizz/ui/command'
import type { AgentApi } from '@fizz/agent-client/api'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 输入停顿多久才真的发请求（与侧栏搜索一致） */
const DEBOUNCE_MS = 250

export function CommandPaletteSearch({
  api,
  keyword,
  workspaces,
  onKeywordChange,
  onBack,
  onOpenHit
}: {
  /** 可能为 null（尚未连上服务端）；此时发不了请求，结果恒为空 */
  api: AgentApi | null
  /** 搜索词：真源在 CommandPalette（Esc「先清词再返回」要读它） */
  keyword: string
  /** 工作区清单：结果行右侧标注会话属于哪个项目 */
  workspaces: AgentApp['workspaces']
  onKeywordChange: (next: string) => void
  /** 返回根级命令列表（输入行左侧的返回按钮） */
  onBack: () => void
  /** 点一条结果：打开那个会话（调用方负责关面板） */
  onOpenHit: (hit: ConversationSearchHit) => void
}) {
  const t = useT()
  const [results, setResults] = useState<ConversationSearchHit[]>([])
  const [searching, setSearching] = useState(false)

  const trimmed = keyword.trim()

  // 输入即搜，防抖 250ms（cancelled 标记防过期响应回写）。
  // 清空关键词不在 effect 里同步清结果：渲染由 trimmed 分叉（空词显示提示行），
  // 旧 results 留着不可见，下次输入会被新一轮请求覆盖。
  useEffect(() => {
    if (!trimmed) return
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      void (async () => {
        try {
          const hits = await api?.searchConversations(trimmed)
          // 期间用户可能又改了关键词 / 退回了根级
          if (!cancelled) setResults(hits ?? [])
        } catch {
          if (!cancelled) setResults([])
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmed, api])

  return (
    <>
      <CommandInput
        leading={
          <button
            type="button"
            aria-label={t('返回命令列表')}
            onClick={onBack}
            className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
        }
        placeholder={t("搜索会话…")}
        value={keyword}
        onValueChange={onKeywordChange}
        autoFocus
        icon={
          searching ? (
            /* 搜索进行中：把输入框的搜索图标换成转圈，进度信号收敛在图标位置 */
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label={t('搜索中')} />
          ) : undefined
        }
      />
      <CommandList className="min-h-0 max-h-none flex-1">
        {/* cmdk 已关本地过滤（shouldFilter=false）：命中来自服务端（含消息正文），
            不能再被 cmdk 按标题筛一遍，否则「内容命中、标题不含关键词」的行会被吃掉。
            搜索期间结果区保留上一轮结果不动（防跳变），新结果到了才整体替换 ——
            进度信号由输入框图标位置的转圈承担。 */}
        {!trimmed ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('输入关键词，按标题与消息内容搜索全部会话')}
          </p>
        ) : results.length > 0 ? (
          <CommandGroup heading={t('会话')}>
            {results.map((hit) => {
              // 同一会话可能标题、消息各命中一条：key / value 都带上命中点保证唯一
              const key =
                hit.where === 'message'
                  ? `${hit.conversationId}-${hit.messageId}`
                  : `${hit.conversationId}-title`
              const workspaceName = workspaces.find((w) => w.id === hit.workspaceId)?.name
              return (
                <CommandItem
                  key={key}
                  value={`${hit.title || t('未命名会话')} ${key}`}
                  keywords={[hit.title, workspaceName].filter((s): s is string => !!s)}
                  onSelect={() => onOpenHit(hit)}
                >
                  {/* 归档会话仍然能被搜到 —— 给个标记，否则点开一个侧栏里看不见的会话会以为搜错了 */}
                  {hit.archived ? (
                    <Archive aria-label={t('已归档')} />
                  ) : (
                    <MessageSquare />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate">{hit.title || t('未命名会话')}</span>
                      {hit.archived && (
                        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{t('已归档')}</span>
                      )}
                      <span className="ml-auto max-w-32 shrink-0 truncate text-xs text-muted-foreground">
                        {workspaceName}
                      </span>
                    </div>
                    {hit.where === 'message' && (
                      <p className="truncate text-xs text-muted-foreground">
                        {hit.role === 'user' ? t('我：') : ''}
                        {hit.snippet}
                      </p>
                    )}
                  </div>
                </CommandItem>
              )
            })}
          </CommandGroup>
        ) : searching ? (
          /* 只有首轮搜索（还没有上一轮结果可保留）才在列表里显示进度；
             后续搜索列表保持不动，转圈在输入框图标位置 */
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t('搜索中…')}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('没有匹配「{keyword}」的会话', { keyword: trimmed })}
          </p>
        )}
      </CommandList>
    </>
  )
}
