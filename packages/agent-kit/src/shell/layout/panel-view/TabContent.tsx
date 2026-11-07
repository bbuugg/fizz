"use client";

import { type ReactNode } from 'react'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { ConversationTab } from '@fizz/agent-kit/features/chat/ConversationTab'
import { TerminalPanel } from '@fizz/agent-kit/features/terminal/TerminalPanel'
import { TerminalTabView } from '@fizz/agent-kit/features/terminal/TerminalTabView'
import { ApiPage } from '@fizz/agent-kit/features/api/ApiPage'
import { WsPage } from '@fizz/agent-kit/features/api/WsPage'
import { ScriptsPanel } from '@fizz/agent-kit/features/scripts/ScriptsPanel'
import { SftpPanel } from '@fizz/agent-kit/features/sftp/SftpPanel'
import { FileManagerPanel } from '@fizz/agent-kit/features/file-manager/FileManagerPanel'
import { SysmonPanel } from '@fizz/agent-kit/features/system-tasks/SysmonPanel'
import { TunnelPanel } from '@fizz/agent-kit/features/tunnels/TunnelPanel'
import { LogsPanel } from '@fizz/agent-kit/features/logs/LogsPanel'
import { TriggersPanel } from '@fizz/agent-kit/features/tasks/TriggersPanel'
import { LocalFileTabContent } from '@fizz/agent-kit/features/local-file/LocalFileTabContent'
import { NoteTabContent } from '@fizz/agent-kit/features/notes/NoteTabContent'
import { PluginTabContent } from '@fizz/agent-kit/features/plugins/PluginTabContent'
import { SettingsTabContent } from '@fizz/agent-kit/features/settings/SettingsTabContent'
import { NEW_API_REQUEST_ID, NEW_WS_REQUEST_ID } from '@fizz/agent-kit/features/api/api-client'
import {
  apiRequestIdOfTabKey,
  isApiTabKey,
  isConversationTabKey,
  isFilesTabKey,
  isLocalFileTabKey,
  isLogsTabKey,
  isNoteTabKey,
  isPluginTabKey,
  isScriptsTabKey,
  isSettingsTabKey,
  isSftpTabKey,
  isSysmonTabKey,
  isTriggersTabKey,
  isTunnelTabKey,
  NEW_TAB_KEY,
  sftpHostIdOfTabKey,
} from '@fizz/agent-kit/shared/lib/panel-tabs'
import { getToolTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import type { SshHostConfig } from '@fizz/contracts/types'

/**
 * SFTP 文件管理标签的内容：按 key 里的 hostId 去主机清单里取配置。
 *
 * 取不到（主机被删）时给一句明确的话，而不是渲染一个空壳页面 —— 与终端标签
 * 「数据已失效」同一套处理。主机配置只读（`SshHostConfig` 里没有明文凭据），
 * 真正的连接凭据在服务端解密，这一路只用到 `username@host:port` 与 id。
 */
export function SftpTabContent({ hostId }: { hostId: string }): ReactNode {
  const { app } = useAppContext()
  const host = app.sshHosts.find(
    (h): h is SshHostConfig => h.kind !== 'local' && h.id === hostId
  )
  if (!host) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        这台主机已不存在，关闭标签后重新打开即可。
      </div>
    )
  }
  return <SftpPanel host={host} />
}

/**
 * 接口请求标签的内容：按 `protocol` 分发到 HTTP 编辑页（`ApiPage`）或 WebSocket 调试页
 * （`WsPage`）。草稿（哨兵 `NEW_WS_REQUEST_ID`）还没落盘、不在清单里，直接判定走 WS 页；
 * 已保存条目读它的 `protocol`（undefined = http，兼容历史数据）。
 */
export function ApiTabContent({ requestId }: { requestId: string }): ReactNode {
  const { app } = useAppContext()
  const request = app.apiRequests.find((r) => r.id === requestId) ?? null
  if (requestId === NEW_WS_REQUEST_ID || request?.protocol === 'ws') {
    return <WsPage requestId={requestId} />
  }
  return <ApiPage requestId={requestId} />
}

/**
 * 终端标签的内容：登记表元数据 → 一条终端。
 *
 * ⚠️ **主区域的终端标签恒是「宿主本机」终端，不做任何容器判定。**
 * 以前这里会拿 `tool.workspaceId` 去 `containerProjects` 快照里查，命中容器型项目就把
 * `containerWorkspaceId` 交给 `TerminalPanel`（服务端换成 `docker exec`）—— 于是「主机与
 * 终端」里配的那条**本机终端**，只要当前项目是容器型，就变成了容器内 shell（用户报过）。
 * 「主机与终端」是**独立功能**，它开出来的东西与任何会话 / 项目都无关；容器终端只存在于
 * **会话自己的侧栏面板**里，那条路由 `openTerminalTabOf` 显式带 `containerWorkspaceId`
 * （见 `features/chat/ConversationTab.tsx`），不靠这里推断。
 */
export function TerminalTabContent({ tabKey, active }: { tabKey: string; active: boolean }): ReactNode {
  const tool = getToolTab(tabKey)
  if (!tool) {
    /*
     * 登记表里没有它 —— 理论上不该发生（条目与标签同生共死：`openXxxTab` 先写表再开标签，
     * 标签关掉后由 `PanelView` 的 effect 回收）。真出现了就明说，别渲染一片空白让人以为
     * 是终端挂了。
     */
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        这个标签的数据已失效，关闭后重新打开即可。
      </div>
    )
  }
  return (
    <TerminalTabView tabKey={tabKey}>
      <TerminalPanel
        // 终端的工作目录：本机终端是本地路径；主机终端（`sshHostId`）是远端 POSIX 目录
        cwd={tool.cwd}
        // 不是正被看着的那个就别抢输入焦点（收起 / 切走的标签仍常挂载）
        visible={active}
        shellId={tool.shellId ?? null}
        // 命令历史 / 预测的作用域：SSH 主机终端一份（全局）、宿主本机终端一份（全局，
        // 不挂项目，见 `localHistory`）。**这里不传 workspaceId** —— 主区域的终端与项目无关。
        localHistory={tool.kind === 'local'}
        sshHostId={tool.sshHostId}
        // 本机终端的额外启动参数 / 启动后自动命令（主机终端不适用，TerminalPanel 里只在
        // 非 ssh 分支使用）
        args={tool.kind === 'local' ? tool.args : undefined}
        autoCommand={tool.kind === 'local' ? tool.autoCommand : undefined}
        // 运行脚本时终端就绪后写入一次（SSH 与本机终端都适用，见 TerminalPanel.scriptInput）
        scriptInput={tool.scriptInput}
        // 主区域的工具标签带 tabKey → 终端按它登记关闭守卫（进程还活着时关标签要确认），
        // 也按它登记到终端登记表（供内嵌 AI 助手操作这个终端）。
        tabKey={tabKey}
      />
    </TerminalTabView>
  )
}

/**
 * 按标签 key 的类型分发内容：对话标签 → `ConversationTab`；工具标签 → 一条终端。
 *
 * ⚠️ 这个分发点**只有一处**（`PanelContentLayer` 里按标签平铺时调它）。标签内容绝不能在
 * 递归的布局骨架上、或在组里再渲染一份 —— 标签换组时那会换掉它的父节点，React 卸载重挂，
 * 终端 xterm 重建、PTY 被 kill、未保存内容全丢（见 `docs/lessons/ui.md` §59）。
 */
export function PanelTabContent({ tabKey, active }: { tabKey: string; active: boolean }): ReactNode {
  if (isConversationTabKey(tabKey)) {
    return (
      <ConversationTab
        conversationId={tabKey === NEW_TAB_KEY ? null : tabKey}
        // 守卫表按**标签 key** 索引（关闭 / 刷新都问它），而「新对话」占位标签的 key 是
        // `__new__`、会话 id 为空 —— 只传 conversationId 的话，草稿标签就登记不上守卫。
        hostTabKey={tabKey}
        /*
         * 「这个标签正被看着」（本组当前显示的那一个）。标签内容一律常挂载，后台标签只是
         * `hidden` 藏在原地 —— 会话自己的侧栏面板靠它判断「真露在外面」，否则后台标签的
         * 面板会照挂 window 键盘监听（推送快捷键一按，几个会话的面板一起响）。
         */
        active={active}
      />
    )
  }

  // 接口请求标签：草稿是哨兵 requestId，按 protocol 分发到 HTTP 页 / WebSocket 页。
  // 非活动标签由内容层 `hidden` 藏而不卸 —— 编辑到一半的方法 / 地址 / 响应都留在内存里。
  if (isApiTabKey(tabKey)) {
    return <ApiTabContent requestId={apiRequestIdOfTabKey(tabKey) ?? NEW_API_REQUEST_ID} />
  }

  // SFTP 文件管理标签：一台主机 = 一条（key 里带 hostId）。主机配置在
  // `useAppContext` 的清单里现取 —— 主机被删则渲染一句「数据已失效」，不炸。
  if (isSftpTabKey(tabKey)) {
    return <SftpTabContent hostId={sftpHostIdOfTabKey(tabKey) ?? ''} />
  }

  // 隧道标签：全局单例面板（`tunnel:list`）。它自己从 store 读 `sshTunnels` / `tunnelRuntimes`
  // 并订阅 WS 推送，不需要在这里传数据；「从主机右键进来」的预选主机在登记表里（`getToolTab`）。
  if (isTunnelTabKey(tabKey)) {
    return <TunnelPanel tabKey={tabKey} />
  }

  // 应用日志标签：全局单例面板（`logs:list`）。它自己拉全量 + 订阅 SSE（见 features/logs
  // 的 logs-store），这里同样不需要传数据；命名空间 Tab 列表也来自服务端应答。
  if (isLogsTabKey(tabKey)) {
    return <LogsPanel />
  }

  // 文件管理标签：全局单例（`files:list`）。所有状态（当前目录 / 选中 / 剪贴板）都在
  // 面板自己的 hook 里，宿主不需要传任何东西 —— 与日志 / 隧道同一形状。
  if (isFilesTabKey(tabKey)) {
    return <FileManagerPanel />
  }

  // 系统监控标签：全局单例（`sysmon:list`）。指标卡自己去读 `/api/system`（常驻采样器
  // 的快照，含每核 / 磁盘 / 历史曲线），进程表读 `/api/system/tasks`（按需现采）——
  // 两条通路都在面板内部，宿主不需要传任何东西。
  if (isSysmonTabKey(tabKey)) {
    return <SysmonPanel />
  }

  // 定时任务标签：全局单例管理面板（`triggers:list`）。数据走 `useAppContext().triggers`
  // （与侧栏那块看板同一份），这里不需要传任何东西。
  if (isTriggersTabKey(tabKey)) {
    return <TriggersPanel />
  }

  // 脚本管理面板：全局单例（`scripts:list`）。清单走 `useAppContext().app.scripts`
  // （与脚本编辑页 / 侧栏同一份），这里不需要传任何东西。
  if (isScriptsTabKey(tabKey)) {
    return <ScriptsPanel />
  }

  // 设置面板：全局单例（`settings:list`）。它与对话共享同一个 AppProvider（这是把独立
  // 设置窗口并回主区域的全部意义），分组请求记在登记表里，见 `openSettingsTab`。
  if (isSettingsTabKey(tabKey)) {
    return <SettingsTabContent />
  }

  // 插件界面标签：内容由**服务端**的 render() 产出（插件不写 React，见 PluginSurfaceBody）。
  // 归属（哪个插件 / 哪个面）在 `tool-tabs` 的登记表里，key 只是不透明的 `plugin:<n>`。
  if (isPluginTabKey(tabKey)) {
    return <PluginTabContent tabKey={tabKey} />
  }

  // 笔记标签：归属（哪个根 + 哪篇）在 `tool-tabs` 的登记表里，key 只是不透明的 `note:<n>`。
  // `active` 必须传下去 —— 所有标签都常挂载，`Ctrl/Cmd+S` 只有**正被看着的那篇**该响应。
  if (isNoteTabKey(tabKey)) {
    return <NoteTabContent tabKey={tabKey} active={active} />
  }

  // 本地文件标签：用本应用打开的一篇**本机** Markdown（绝对路径，读写走主进程 fs）。
  // 与上面的笔记标签是两条独立通路，见 `features/local-file/LocalFileTabContent.tsx` 的对照表。
  if (isLocalFileTabKey(tabKey)) {
    return <LocalFileTabContent tabKey={tabKey} active={active} />
  }

  // 剩下的就是终端标签（`host:<id>` / `local:<n>`）：元数据在登记表里，而「这个工作区
  // 是不是容器型项目」要读 state ws 的快照 —— 读快照得挂 hook，故内容拆到独立组件里。
  return <TerminalTabContent tabKey={tabKey} active={active} />
}

// ---------------------------------------------------------------------------
// 内容层：全部标签在 PanelView 根部渲染，再按各组车身矩形摆过去
// ---------------------------------------------------------------------------
