'use client'

/**
 * 「让用户选一个目录」—— 三端都走**内置命令面板式目录浏览器**（`ServerDirPicker`），
 * 桌面端在它的底栏右下角多给一枚「使用系统文件选择器」。
 *
 * ## 为什么不再按平台分叉
 *
 * 早先的判据是 `host.pickLocalDirectory` 在不在 —— 在（desktop）就直接弹系统目录框。
 * 系统框的好处是真的（认得上次打开的位置、收藏夹、侧栏能直接拖），但它是**另一套外观**：
 * 同一个「选择文件夹」，web 端是一块面板，桌面端变成 Windows / GTK / macOS 的对话框，
 * 截图、文档、教程都对不上；而多数时候用户只是要点几下钻进某层子目录，面板反而更快。
 *
 * 现在**面板是主路径**：桌面端想用系统框就从底栏切过去，不再替用户二选一。
 * web / mobile / extension 没有本机文件系统（`pickLocalDirectory` 不实现），那枚入口不出现 ——
 * 判据仍然是「这个方法在不在」，只是从「要不要显示界面」变成了「要不要显示系统框出口」。
 *
 * 这块浏览器还有**第二副外壳**：命令面板的 `dir` 页（`CommandPalette` 里的页面栈）。
 * 区别只有「Esc 是关弹窗还是退回上一级页面」和底栏提示，浏览本体是同一份
 * `DirectoryBrowser` —— 别为了某个新入口再抄一遍浏览器。
 *
 * ## 用法
 *
 * ```tsx
 * const { pick, node } = useDirectoryPicker(app, '选中的目录会登记为笔记目录。')
 * // node 放进自己的树里（Radix 会 portal 到 body，位置其实无所谓）
 * const dir = await pick()   // 取消 → null
 * ```
 *
 * ## 三条出口结算同一个 Promise
 *
 * `pick()` 在三种情况下 settle：面板里点「选择」（带路径）、切去系统框后选完（带路径）、
 * 直接关掉面板（`null`）。**切系统框那一次关闭不算取消** —— 靠 `nativeRef` 区分，
 * 否则 Promise 会先以 `null` 结掉，用户在系统框里选完也白选。
 *
 * ## 「新建文件夹」两边都有
 *
 * 面板里那枚走服务端的 `POST /api/fs/mkdir`（浏览器自己建不了）；系统框自带 ——
 * Windows 的 `IFileOpenDialog`（`FOS_PICKFOLDERS`）、GTK 的目录选择器、
 * macOS（`properties: ['createDirectory']`）都提供，所以这也不是取舍。
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { ServerDirPicker } from '@fizz/agent-kit/shared/components/ServerDirPicker'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export interface DirectoryPicker {
  /** 让用户选一个目录；用户取消（或关掉面板）返回 `null` */
  pick: () => Promise<string | null>
  /** 内置目录浏览器的节点（三端都渲染；桌面端底栏多一枚系统框入口） */
  node: ReactNode
}

export function useDirectoryPicker(app: AgentApp, description?: string): DirectoryPicker {
  const [open, setOpen] = useState(false)
  /** 面板里那一遍等在这里的回调 —— `pick()` 返回的 Promise 靠它 settle */
  const resolveRef = useRef<((path: string | null) => void) | null>(null)
  /** 这一次「面板收起」是切去系统框，不是取消（见文件头最后一段） */
  const nativeRef = useRef(false)

  /*
   * `getAgentHostOrNull()` 返回的是模块级单例（`setAgentHost` 只在启动时调一次），
   * 所以它**可以**进依赖；不像 `app` 那样每次渲染都是新对象。
   */
  const host = getAgentHostOrNull()
  const canPickNative = typeof host?.pickLocalDirectory === 'function'

  const pick = useCallback((): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve
      nativeRef.current = false
      setOpen(true)
    })
  }, [])

  const settle = useCallback((path: string | null): void => {
    const resolve = resolveRef.current
    resolveRef.current = null
    resolve?.(path)
  }, [])

  /**
   * 切到系统目录框：先收起面板 —— 两个模态叠着会互相抢 Esc 与焦点，系统框还常常压在
   * 窗口最上层，面板留在下面只会闪一下。拿到结果（取消 = `null`）再 settle。
   */
  const pickNative = useCallback(async (): Promise<void> => {
    const fn = host?.pickLocalDirectory
    if (!fn) return
    nativeRef.current = true
    setOpen(false)
    let path: string | null = null
    try {
      path = await fn()
    } catch {
      // 主进程抛错（比如对话框建不起来）：按「没选」处理，别把 Promise 挂死
      path = null
    } finally {
      nativeRef.current = false
      settle(path)
    }
  }, [host, settle])

  const node = (
    <ServerDirPicker
      app={app}
      open={open}
      description={description}
      // 桌面端才有：web / mobile 没有本机文件系统，画出来也是点不动的
      onPickNative={canPickNative ? () => void pickNative() : undefined}
      onOpenChange={(next) => {
        setOpen(next)
        // 关掉（点遮罩 / Esc / 关窗）一律算「没选」；切系统框那一次不算
        if (!next && !nativeRef.current) settle(null)
      }}
      onPick={(path) => settle(path)}
    />
  )

  return { pick, node }
}
