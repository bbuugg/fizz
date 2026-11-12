/**
 * 「打开工作区目录」的一组**下拉菜单项**：嵌进别的菜单里用（项目行的「更多操作」）。
 * 临时会话（`scratch`，没有项目行）的会话行也复用它，只是标题换成「打开会话目录」。
 *
 * 原来是对话标签顶栏的一颗**分裂按钮**（左半文件管理器 / 右半 IDE 下拉）。那颗按钮
 * 与「工作区文件 / 源代码管理 / 展开面板」挤在同一行，且它做的事是**项目级**的
 * （打开的是这个工作区目录，跟当前看哪个会话无关）—— 所以整体搬到左侧栏项目行的
 * 「更多操作」里，顶栏只留「这个会话的面板」那几颗。
 *
 * 能力全部来自宿主的 `openFileManagerAt` / `listIdes` / `openIde`（见 `host.ts`）：
 * **只有 desktop 宿主实现**，web 端注入的宿主没有这些方法，所以整组菜单项在 web 上
 * 干脆不渲染（不要给浏览器一个必然失败的入口）。
 *
 * IDE 列表**懒探测**：本组件只在父菜单**打开时**才挂载（Radix 的 Content 是打开才渲染），
 * 所以 `listIdes()` 只在用户真的展开菜单时走一次主进程扫 PATH —— 不在每个项目行挂载时
 * 白扫一遍。
 */
import { useEffect, useState } from 'react'
import { Code2, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@fizz/ui/dropdown-menu'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/** 已探测到的 IDE（空数组 = 没探测到 / 还没探测完，此时只留「文件管理器」一项） */
function useInstalledIdes(enabled: boolean): Array<{ id: string; name: string }> {
  const host = getAgentHostOrNull()
  const [ides, setIdes] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    if (!enabled || !host?.listIdes) return
    let alive = true
    void host
      .listIdes()
      .then((list) => {
        if (alive) setIdes(list)
      })
      // 探测失败只静默降级成「只有文件管理器」：这组入口不该因为扫不到 IDE 就消失
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [host, enabled])

  return ides
}

/**
 * 宿主能不能「打开目录」（只有 desktop 实现）。
 *
 * 给它单独一个导出，是为了让调用方能把**分隔线**一起判掉：本组件在 web 下返回 `null`，
 * 而分隔线是兄弟节点，只判组件不判能力就会在菜单顶上留一条孤零零的横线。
 */
export function canOpenWorkspaceDir(): boolean {
  return !!getAgentHostOrNull()?.openFileManagerAt
}

export function OpenWorkspaceItems({
  path,
  disabled,
  label
}: {
  path: string
  disabled?: boolean
  /**
   * 子菜单标题。缺省「打开工作区目录」是项目行（工作区）的措辞；
   * 临时会话那一行打开的是**这条会话自己的目录**，叫「打开会话目录」才读得通。
   */
  label?: string
}) {
  const t = useT()
  const host = getAgentHostOrNull()
  // web 端（宿主没实现文件管理器能力）不画这组入口
  const available = !!host?.openFileManagerAt
  const ides = useInstalledIdes(available)
  if (!available) return null

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>, okText: string): Promise<void> => {
    const r = await action()
    if (r.ok) toast.success(okText)
    else toast.error(r.error ?? t('打开失败'))
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <FolderOpen className="size-4" />
        {label ?? t('打开工作区目录')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-48">
        <DropdownMenuItem
          onSelect={() => void run(() => host.openFileManagerAt!(path), t('已打开：{path}', { path }))}
        >
          <FolderOpen className="size-3.5 shrink-0" />
          {t('用文件管理器打开')}
        </DropdownMenuItem>
        {ides.length > 0 && <DropdownMenuSeparator />}
        {ides.map((ide) => (
          <DropdownMenuItem
            key={ide.id}
            onSelect={() => {
              if (!host.openIde) return
              void run(() => host.openIde!(ide.id, path), t('已用 {name} 打开：{path}', { name: ide.name, path }))
            }}
          >
            <Code2 className="size-3.5 shrink-0" />
            {t('用 {name} 打开', { name: ide.name })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
