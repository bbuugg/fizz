/**
 * 设置 →「技能」标签页：**技能发现位置**（内置 + 额外目录）+ 服务端磁盘上扫到的技能
 * + 启用/停用 + **重新扫描**。技能内容在服务端（目录 + SKILL.md），这里只切配置。
 *
 * 技能是磁盘上的「目录 + SKILL.md」，用户可能在不关应用的情况下新装一个 —— 列表不会
 * 自己变，所以给一个「刷新」按钮（走 `app.reloadSkills()`，只重扫技能，不整表刷新）。
 *
 * 「额外发现目录」存在服务端的 `skillSettings.extraDirs`（**绝对路径**，指的是跑 Agent 那台
 * 机器上的目录），每次 GET 都重扫；加目录走 `useDirectoryPicker` —— 桌面端直接弹**系统
 * 目录框**（后端就跑在本进程里，两者指的是同一台机器），web 才退到让服务端列目录。
 *
 * 列表上方的搜索框**纯前端过滤**（名字 / 描述 / 来源 / 路径），不打服务端 —— 技能清单
 * 一次就全在手里，装了十几个以后靠它找比上下翻快。
 */
import { useState } from 'react'
import { Check, Folder, FolderPlus, RotateCw, Search, X } from 'lucide-react'
import { Badge } from '@fizz/ui/badge'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { useDirectoryPicker } from '@fizz/agent-kit/shared/hooks/use-directory-picker'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 来源标签：内置那份随产品分发，其余来源直接用枚举名（与既有展示一致） */
const SOURCE_LABEL: Record<string, string> = { builtin: '内置' }

export function SkillsTab({ app }: { app: AgentApp }) {
  const tr = useT()
  /** 重新扫描中（防重复点击；扫描是同步打服务端，很快） */
  const [refreshing, setRefreshing] = useState(false)
  /** 技能列表的搜索词（纯前端过滤，不打服务端） */
  const [keyword, setKeyword] = useState('')

  /**
   * 选一个额外发现目录。桌面端弹系统目录框、web 用内置的服务端目录浏览器
   * （见 `useDirectoryPicker`）—— 技能目录是**服务端**上的路径，两条路都指向同一台机器。
   */
  const { pick, node: dirPicker } = useDirectoryPicker(
    app,
    '这里列的是服务端上的目录（技能就在那台机器上）。选中的目录会加进「额外发现目录」。'
  )

  const refresh = (): void => {
    setRefreshing(true)
    void app.reloadSkills().finally(() => setRefreshing(false))
  }

  const extraDirs = app.skills?.settings.extraDirs ?? []
  const roots = app.skills?.roots ?? []
  const skills = app.skills?.skills ?? []
  const kw = keyword.trim().toLowerCase()
  // 名字 / 描述 / 路径都能命中：装多了以后用户多半记得的是描述或那个目录名
  const shown = kw
    ? skills.filter((s) =>
        [s.name, s.description, s.source, s.file].some((v) => v.toLowerCase().includes(kw))
      )
    : skills

  /** 加一个额外发现目录（已存在的不重复加；写入是全量清单） */
  const addDir = (raw: string): void => {
    const dir = raw.trim()
    if (!dir || extraDirs.includes(dir)) return
    void app.setSkillDirs([...extraDirs, dir])
  }

  /** 打开选目录入口，选完就加（取消 → `null`，什么都不做） */
  const pickDir = (): void => {
    void pick().then((dir) => {
      if (dir) addDir(dir)
    })
  }

  /** 移除一个额外发现目录（内置位置不在 extraDirs 里，删不掉） */
  const removeDir = (dir: string): void => {
    void app.setSkillDirs(extraDirs.filter((x) => x !== dir))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-4 text-muted-foreground">
          技能是包含 SKILL.md 的目录
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          disabled={refreshing}
          title={tr('重新扫描磁盘上的技能目录（新装的技能点这里）')}
          onClick={refresh}
        >
          <RotateCw className={cn('size-3', refreshing && 'animate-spin')} />
          {refreshing ? tr('扫描中…') : tr('刷新')}
        </Button>
      </div>

      {/* 技能发现位置：内置位置只读展示（含是否存在、扫到几个），custom 是可增删的额外目录 */}
      <div className="rounded-md border border-border/60">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-medium">{tr('技能发现位置')}</div>
            <div className="text-[0.6875rem] leading-4 text-muted-foreground">
              {tr('这些目录下的')} {'<名字>'}/SKILL.md {tr('会被扫到')}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            title={tr('添加一个额外的技能发现目录（服务端上的绝对路径）')}
            onClick={pickDir}
          >
            <FolderPlus className="size-3" />
            添加目录
          </Button>
        </div>
        <div className="divide-y divide-border/60">
          {roots.map((root) => (
            <div
              key={`${root.source}:${root.dir}`}
              className="flex items-center gap-2 px-3 py-1.5"
            >
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[0.625rem]">
                {tr(SOURCE_LABEL[root.source] ?? root.source)}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]" title={root.dir}>
                {root.dir}
              </span>
              <span
                className={cn(
                  'shrink-0 text-[0.625rem]',
                  root.exists ? 'text-muted-foreground' : 'text-muted-foreground'
                )}
              >
                {root.exists ? tr('{count} 个', { count: root.count }) : tr('目录不存在')}
              </span>
              {root.source === 'custom' && (
                <button
                  type="button"
                  aria-label={tr('移除发现目录 {dir}', { dir: root.dir })}
                  title={tr('移除这个额外目录')}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  onClick={() => removeDir(root.dir)}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {skills.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              variant="muted"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={tr('搜索技能（名字 / 描述 / 路径）…')}
              aria-label={tr('搜索技能')}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {kw ? `${shown.length}/${skills.length}` : tr('{count} 个', { count: skills.length })}
          </span>
        </div>
      )}

      {shown.map((skill) => {
        const enabled = !(app.skills?.settings.disabled ?? []).includes(skill.id)
        return (
          <div
            key={skill.id}
            className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2"
          >
            <button
              type="button"
              aria-label={enabled ? tr('停用技能 {name}', { name: skill.name }) : tr('启用技能 {name}', { name: skill.name })}
              aria-pressed={enabled}
              onClick={() => void app.toggleSkill(skill.id, !enabled)}
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
                enabled
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-transparent'
              )}
            >
              <Check className="size-3" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm">{skill.name}</span>
                <Badge variant="outline" className="h-5 px-1.5 text-[0.625rem]">
                  {tr(SOURCE_LABEL[skill.source] ?? skill.source)}
                </Badge>
              </div>
              <div className="line-clamp-2 text-xs leading-4 text-muted-foreground">
                {skill.description}
              </div>
              <div className="truncate text-[0.625rem] text-muted-foreground" title={skill.file}>
                {skill.file}
              </div>
            </div>
          </div>
        )
      })}
      {skills.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {tr('没扫到技能。在任一位置放入')} {'<目录>'}/SKILL.md {tr('后点「刷新」。')}
        </p>
      )}
      {skills.length > 0 && shown.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {tr('没有匹配「{keyword}」的技能。', { keyword: keyword.trim() })}
        </p>
      )}

      {/* 桌面端是系统目录框（这里为 null），web 才是内置的服务端目录浏览器 */}
      {dirPicker}
    </div>
  )
}