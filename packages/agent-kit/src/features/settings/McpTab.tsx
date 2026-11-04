/**
 * 设置弹窗 →「MCP」标签页：外部工具服务列表（编辑 / 删除 / 看它有哪些工具）+ 新增弹窗。
 * 配置存在服务端，Agent 跑在服务端时直接连这些 server。
 *
 * 三种传输方式：`stdio`（本地子进程，填命令 / 参数 / 环境变量）、`http`（Streamable HTTP，
 * 填地址 / 请求头）、`sse`（旧版 HTTP+SSE，服务端还在用时选它）。表单按方式换字段。
 *
 * ⚠️ 这里**没有启用 / 停用开关**：是否启用是**会话级**的选择 —— 每个会话在
 * `ChatPanel` 输入框上方的工具条里自己挑要用哪几个（McpSelect），选中的才注入工具集。
 * 本页只回答「配了什么」。
 *
 * 「看工具」入口只保留每个 server 自己的按钮（扳手图标）：连它一个、列出它提供的工具
 * （服务端列完就断开它），工具清单以 Dialog 呈现。
 *
 * 编辑复用新增那个表单弹窗：同一个 POST 路由，带 id 即更新、不带即新建
 * （服务端 `saveMcpServer` 约定，见 packages/workspace/src/domain.ts）。
 */
import { useState } from 'react'
import { Loader2, Pencil, Plus, Trash2, Wrench } from 'lucide-react'
import { Badge } from '@fizz/ui/badge'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Textarea } from '@fizz/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { formatCommandArgs, parseCommandArgs } from '@fizz/agent-kit/shared/lib/command-args'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import { Segmented } from '@fizz/agent-kit/shared/components/Segmented'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'
// 只引 `/types` 子路径：这三个是纯函数，`@fizz/mcp` 根入口会把 MCP SDK 拖进浏览器产物
import {
  isStdioMcpServer,
  mcpServerSummary,
  normalizeMcpTransport,
  type McpServerConfig,
  type McpToolInfo,
  type McpTransport
} from '@fizz/mcp/types'

/** 某个 server 的工具探测状态：还没问 / 正在问 / 结果 */
type ToolsState = { infos: McpToolInfo[]; errors: string[] } | 'loading'

/** 表单里那两坨多行键值对（环境变量 / 请求头）都用 `K=V` 一行一个的文本框编辑 */
function parseKvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

function formatKvLines(kv?: Record<string, string>): string {
  return Object.entries(kv ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

export function McpTab({ app }: { app: AgentApp }) {
  const tr = useT()
  const [adding, setAdding] = useState(false)
  /** 正在编辑的配置 id；null = 新增模式 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [mcpName, setMcpName] = useState('')
  /** 当前选的传输方式（决定表单显示命令组还是地址组）；存量配置没有这一项 = stdio */
  const [mcpTransport, setMcpTransport] = useState<McpTransport>('stdio')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpEnv, setMcpEnv] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpHeaders, setMcpHeaders] = useState('')
  /** 正在展示工具清单的 server id（Dialog，同时只开一个） */
  const [toolsServerId, setToolsServerId] = useState<string | null>(null)
  /** server id → 它自己的工具（按需拉，拉过就留着） */
  const [tools, setTools] = useState<Record<string, ToolsState>>({})
  /** 待确认删除的 MCP server（二次确认弹窗；null = 关着） */
  const [deleteTarget, setDeleteTarget] = useState<McpServerConfig | null>(null)

  /** 连一个 server 列它的工具（服务端连上、列完、断开） */
  const loadTools = async (id: string): Promise<void> => {
    setTools((prev) => ({ ...prev, [id]: 'loading' }))
    try {
      const res = await app.probeMcpServerTools(id)
      setTools((prev) => ({ ...prev, [id]: res }))
    } catch (err) {
      // 连不上是 200 + errors（服务端如实回），走到这里说明请求本身没成（404 / 网络）
      setTools((prev) => ({
        ...prev,
        [id]: { infos: [], errors: [err instanceof Error ? err.message : String(err)] }
      }))
    }
  }

  /** 点 server 的「工具」：打开 Dialog 并拉它的工具清单 */
  const openTools = (id: string): void => {
    setToolsServerId(id)
    void loadTools(id)
  }

  /** 清空表单草稿（只有保存成功、或重新打开表单时才动它） */
  const resetMcpDraft = (): void => {
    setMcpName('')
    setMcpTransport('stdio')
    setMcpCommand('')
    setMcpArgs('')
    setMcpEnv('')
    setMcpUrl('')
    setMcpHeaders('')
  }

  /** 打开表单弹窗：给了 `server` 就是编辑（预填它当前的配置），不给就是新增（空表单） */
  const openMcpForm = (server?: McpServerConfig): void => {
    setEditingId(server?.id ?? null)
    setMcpName(server?.name ?? '')
    setMcpTransport(normalizeMcpTransport(server?.transport))
    setMcpCommand(server?.command ?? '')
    setMcpArgs(formatCommandArgs(server?.args ?? []))
    setMcpEnv(formatKvLines(server?.env))
    setMcpUrl(server?.url ?? '')
    setMcpHeaders(formatKvLines(server?.headers))
    setAdding(true)
  }

  /** 关表单：只收起，不清草稿（误点遮罩 / Esc 不该把刚填的一串参数弄丢） */
  const closeMcpForm = (): void => {
    setAdding(false)
    setEditingId(null)
  }

  /**
   * 保存表单：带 id 走更新、不带 id 走新建（同一个 POST 路由）。
   *
   * 这里**不传任何启用状态** —— MCP 的启停已上移到**会话级**（在会话里选哪些 MCP 可用），
   * 配置本身只有「配了什么」这一层含义。
   */
  const saveMcpServer = async (): Promise<void> => {
    const stdio = mcpTransport === 'stdio'
    const env = parseKvLines(mcpEnv)
    const headers = parseKvLines(mcpHeaders)
    // 两条校验各管各的：stdio 缺命令 / http·sse 缺地址，其余字段一概不发过去
    if (stdio ? !mcpCommand.trim() : !mcpUrl.trim()) return
    const editing = editingId ? app.mcpServers.find((s) => s.id === editingId) : undefined
    const ok = await app.saveMcpServer({
      ...(editing ? { id: editing.id } : {}),
      // 名称留空就拿「命令 / 地址」顶上，总得有个能认出来的标题
      name: mcpName.trim() || (stdio ? mcpCommand.trim() : mcpUrl.trim()),
      transport: mcpTransport,
      ...(stdio
        ? {
            command: mcpCommand.trim(),
            args: parseCommandArgs(mcpArgs),
            ...(Object.keys(env).length ? { env } : {})
          }
        : {
            url: mcpUrl.trim(),
            ...(Object.keys(headers).length ? { headers } : {})
          })
    })
    if (ok) {
      closeMcpForm()
      resetMcpDraft()
      // 目标改了（命令 / 地址），之前探到的工具清单就作废了：丢掉缓存，下次点「工具」重新拉
      if (editing) {
        setTools((prev) => {
          const next = { ...prev }
          delete next[editing.id]
          return next
        })
      }
    }
  }

  const toolsServer = app.mcpServers.find((s) => s.id === toolsServerId) ?? null
  const toolsProbe = toolsServerId ? tools[toolsServerId] : undefined

  return (
    <div className="space-y-3">
      <p className="text-xs leading-4 text-muted-foreground">
        {tr('MCP 给 Agent 外接工具，支持 stdio / http / sse；每个会话在输入框上方工具条选择启用项。')}
      </p>

      {app.mcpServers.map((server) => (
        <div key={server.id} className="rounded-md border border-border/60">
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{server.name}</div>
              <div className="flex items-center gap-1.5">
                {!isStdioMcpServer(server) && (
                  <Badge variant="outline" className="h-4 shrink-0 px-1 text-[0.625rem]">
                    {server.transport}
                  </Badge>
                )}
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {mcpServerSummary(server)}
                </div>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 shrink-0 p-0 text-muted-foreground"
              aria-label={tr('看 {name} 提供了哪些工具', { name: server.name })}
              title={tr('看 {name} 提供了哪些工具', { name: server.name })}
              onClick={() => openTools(server.id)}
            >
              <Wrench className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 shrink-0 p-0 text-muted-foreground"
              aria-label={tr('编辑 MCP server {name}', { name: server.name })}
              title={tr('编辑 MCP server {name}', { name: server.name })}
              onClick={() => openMcpForm(server)}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
              aria-label={tr('删除 MCP server {name}', { name: server.name })}
              title={tr('删除 MCP server {name}', { name: server.name })}
              onClick={() => setDeleteTarget(server)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}

      {app.mcpServers.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {tr('还没有 MCP server。加一个之后，Agent 就能用它的工具。')}
        </p>
      )}

      <Button size="sm" variant="outline" className="w-full" onClick={() => openMcpForm()}>
        <Plus className="size-3.5" /> {tr('添加 MCP server')}
      </Button>

      {/* 关掉只收起、不清空：误点遮罩 / Esc 不该把刚填的一串参数弄丢（只有保存成功才清） */}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!open) closeMcpForm()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? tr('编辑 MCP server') : tr('添加 MCP server')}</DialogTitle>
            <DialogDescription>
              {/* 标签页上只有 stdio / http / sse 三个短名，完整含义放这儿说 */}
              {mcpTransport === 'stdio'
                ? tr('stdio（本地子进程）：命令在服务端执行，填服务端上跑得起来的 stdio 服务（npx / uvx / 绝对路径都行）。')
                : mcpTransport === 'http'
                  ? tr('http（Streamable HTTP）：由服务端发起 HTTP 请求，填远端 MCP 的地址，需要鉴权就把请求头也带上。')
                  : tr('sse（旧版 HTTP + SSE）：同上，只是走旧版 SSE 端点，地址与请求头填法一样。')}
              {editingId ? tr('改完保存即生效，启停状态保持原样。') : ''}
            </DialogDescription>
          </DialogHeader>

          {/* min-w-0 别删：DialogContent 是 grid，grid 子项默认 `min-width: auto`，
              而 Textarea 带 `field-sizing-content`（按内容定尺寸）—— 往「请求头 / 环境变量」里
              敲一个长无空格的 key，它的 min-content 就把这一列顶得比弹窗还宽，输入框直接溢出去 */}
          <form
            className="min-w-0 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void saveMcpServer()
            }}
          >
            {/*
              三种传输方式用分段控件 —— 有哪几种、当前是哪种都是一眼的事，比下拉少一次点击。
              标签只放短名（弹窗才 24rem 宽，带全称会挤成一团），完整含义见上面的说明文案。
              切方式不清草稿：用户多半是在几种写法间来回试，填一半的东西不该被抹掉。

              这里**只做取值选择，没有面板**：`http` / `sse` 共用同一组字段（地址 + 请求头），
              字段仍由 `mcpTransport` 条件渲染（见下面那段）。按面板拆就得把同一份 JSX 抄两遍，
              改一处忘一处；而且面板是惰性挂载的，切走再切回来输入框会重挂一次 —— 值在 state
              里不丢，但光标位置和滚动位置会掉。
            */}
            <Segmented
              ariaLabel={tr('传输方式')}
              fullWidth
              value={mcpTransport}
              onChange={(value) => setMcpTransport(value as McpTransport)}
              options={[
                { value: 'stdio', label: 'stdio' },
                { value: 'http', label: 'http' },
                { value: 'sse', label: 'sse' }
              ]}
            />

            <Input
              placeholder={tr('名称，如 filesystem')}
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
            />

            {mcpTransport === 'stdio' ? (
              <>
                <Input
                  placeholder={tr('启动命令，如 npx')}
                  value={mcpCommand}
                  onChange={(e) => setMcpCommand(e.target.value)}
                />
                <Input
                  placeholder={tr('启动参数（空格分隔，可留空）')}
                  value={mcpArgs}
                  onChange={(e) => setMcpArgs(e.target.value)}
                />
                <Textarea
                  rows={3}
                  placeholder={tr('环境变量（K=V 每行一个，可留空）') + '\nAPI_KEY=...'}
                  value={mcpEnv}
                  onChange={(e) => setMcpEnv(e.target.value)}
                />
              </>
            ) : (
              <>
                <Input
                  placeholder={tr('服务地址，如 https://example.com/mcp')}
                  value={mcpUrl}
                  onChange={(e) => setMcpUrl(e.target.value)}
                />
                <Textarea
                  rows={3}
                  placeholder={tr('请求头（K=V 每行一个，可留空）') + '\nAuthorization=Bearer ...'}
                  value={mcpHeaders}
                  onChange={(e) => setMcpHeaders(e.target.value)}
                />
              </>
            )}

            <DialogFooter className="pt-1">
              <Button type="button" size="sm" variant="ghost" onClick={closeMcpForm}>
                {tr('取消')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={mcpTransport === 'stdio' ? !mcpCommand.trim() : !mcpUrl.trim()}
              >
                {editingId ? tr('保存') : tr('添加')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 单个 server 的工具清单：Dialog 呈现 */}
      <Dialog
        open={toolsServerId !== null}
        onOpenChange={(open) => {
          if (!open) setToolsServerId(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr('{name} 的工具', { name: toolsServer?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {tr('连上该 server，列出它提供的工具（列完服务端就断开它）。')}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {toolsProbe === 'loading' && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {tr('正在连它、列工具…')}
              </div>
            )}

            {toolsProbe && toolsProbe !== 'loading' && (
              <>
                {/* 报错可能是多行（主消息 + 子进程 stderr 尾巴），保留换行才看得懂 */}
                {toolsProbe.errors.map((err, i) => (
                  <div
                    key={i}
                    className="whitespace-pre-wrap break-words text-xs text-amber-600 dark:text-amber-500"
                  >
                    ⚠ {err}
                  </div>
                ))}
                {toolsProbe.infos.length === 0 && toolsProbe.errors.length === 0 && (
                  <div className="text-xs text-muted-foreground">{tr('它没有提供任何工具。')}</div>
                )}
                {toolsProbe.infos.map((tool) => (
                  <div key={tool.name} className="text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{tool.name}</span>
                    {tool.description ? ` — ${tool.description.slice(0, 80)}` : ''}
                  </div>
                ))}
              </>
            )}
          </div>

          <DialogFooter className="pt-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => toolsServerId && void loadTools(toolsServerId)}
            >
              {tr('重新读取')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除 MCP server：二次确认（写清删的是哪一条 + 连带影响） */}
      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        title={tr('删除 MCP server？')}
        description={
          deleteTarget
            ? tr('「{name}」（{summary}）会从列表里移除，它的工具从下一轮对话起不再注入。删掉就得重新添加。', { name: deleteTarget.name, summary: mcpServerSummary(deleteTarget) })
            : ''
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (target) void app.deleteMcpServer(target.id)
        }}
      />
    </div>
  )
}
