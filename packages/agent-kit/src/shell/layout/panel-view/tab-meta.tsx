"use client";

import { useCallback, useSyncExternalStore } from 'react';
import {
  Cable,
  Gauge,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  MessageSquare,
  MessageSquarePlus,
  Network,
  NotebookPen,
  CalendarClock,
  FolderTree,
  Puzzle,
  ScrollText,
  Server,
  Settings,
  SquareTerminal,
} from 'lucide-react'
import { t } from '@fizz/i18n'
import { useLanguage } from '@fizz/agent-kit/shared/lib/language'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { usePluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import { NEW_API_REQUEST_ID, NEW_WS_REQUEST_ID } from '@fizz/agent-kit/features/api/api-client'
import {
  apiRequestIdOfTabKey,
  hostIdOfTabKey,
  isApiTabKey,
  isFilesTabKey,
  isHostTabKey,
  isLocalTabKey,
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
import {
  getToolTab,
  getToolTabsVersion,
  subscribeToolTabs,
} from '@fizz/agent-kit/shared/lib/tool-tabs'
import type { SshHostConfig } from '@fizz/contracts/types'
import { getPanelState } from '@fizz/agent-kit/shared/lib/panel-store'
import type { TabMeta } from './types'

/** 标签条高度（与 `SidePanel` 的标签条一致，两处看起来才是同一套控件） */
export const STRIP_H = 'h-9'

/** 某标签在某组内的下标（找不到给 0）—— 把「插到目标前 / 后」翻译成下标用 */
export function tabIndexIn(groupId: string, tabKey: string): number {
  const g = getPanelState().groups[groupId]
  const i = g ? g.tabIds.indexOf(tabKey) : -1
  return i < 0 ? 0 : i
}

/**
 * 标签的展示信息。
 *
 * 按 key 的类型分别取源：
 * - 对话标签 → 会话列表里的标题（会话被重命名 / 首条消息自动定标题都跟着走）；
 * - 主机标签 → **优先**读主机清单（改名能实时反映），清单里没有了（主机被删）就退回
 *   打开时记在登记表里的快照 —— 标签不会突然变成一串 uuid；
 * - 本机终端 → 登记表里的快照（`终端 N` / 目录）。
 */
export function useTabMeta(): (key: string) => TabMeta {
  const language = useLanguage()
  const { app } = useAppContext()
  /** 插件界面清单：标签条上要显示插件声明的图标与名字（数据来自服务端，不在前端算） */
  const pluginSurfaces = usePluginSurfaces(app, app.activeWorkspaceId ?? undefined)
  // 笔记标签的名字**会变**：重命名后 `retargetNoteTab` 就地改登记表（key 是不透明的
  // `note:<n>`，名字只在表里），而登记表自己不发通知。不订阅这个版本号，标签条会一直
  // 停在旧文件名上，直到下一次由别的原因触发的重渲染 —— 用户看到的是「重命名没生效」。
  useSyncExternalStore(subscribeToolTabs, getToolTabsVersion, getToolTabsVersion)
  const baseMeta = useCallback(
    (key: string): TabMeta => {
      if (key === NEW_TAB_KEY) {
        return {
          label: t('新对话'),
          title: t('新对话（初始页）'),
          icon: <MessageSquarePlus className="size-3.5 shrink-0" />
        }
      }
      if (isHostTabKey(key)) {
        const hostId = hostIdOfTabKey(key)
        // 主机标签只由 SSH 主机开出来（本机终端走 `local:` 标签），按 kind 收窄
        const host = app.sshHosts.find(
          (h): h is SshHostConfig => h.kind !== 'local' && h.id === hostId
        )
        const snapshot = getToolTab(key)
        return {
          label: host?.name ?? snapshot?.label ?? t('主机'),
          title: host
            ? `SSH · ${host.username}@${host.host}:${host.port}`
            : (snapshot?.title ?? t('主机已从清单里删除')),
          icon: <Server className="size-3.5 shrink-0" />
        }
      }
      if (isSftpTabKey(key)) {
        // SFTP 标签：标签名与主机名同步（改名后已开的标签也跟着变），图标与主机区分开
        const hostId = sftpHostIdOfTabKey(key)
        const host = app.sshHosts.find(
          (h): h is SshHostConfig => h.kind !== 'local' && h.id === hostId
        )
        const snapshot = getToolTab(key)
        return {
          label: host ? `${host.name} ${t('文件')}` : (snapshot?.label ?? t('文件')),
          title: host
            ? `SFTP · ${host.username}@${host.host}:${host.port}`
            : (snapshot?.title ?? t('主机已从清单里删除')),
          icon: <FolderOpen className="size-3.5 shrink-0" />
        }
      }
      if (isLocalTabKey(key)) {
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? '终端',
          title: tool?.title ?? '本机终端',
          icon: <SquareTerminal className="size-3.5 shrink-0" />
        }
      }
      if (isTunnelTabKey(key)) {
        // 隧道面板是全局单例，标签名固定；悬停提示带上「绑在服务端那台机器上」的提醒
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('隧道'),
          title: tool?.title ?? t('SSH 隧道'),
          icon: <Network className="size-3.5 shrink-0" />
        }
      }
      if (isLogsTabKey(key)) {
        // 应用日志面板同样是全局单例（`logs:list`），内部用 Tab 切命名空间
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('日志'),
          title: tool?.title ?? t('应用日志'),
          icon: <ScrollText className="size-3.5 shrink-0" />
        }
      }
      if (isFilesTabKey(key)) {
        // 文件管理器：全局单例（`files:list`），浏览的是服务端那台机器的整盘
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('文件管理'),
          title: tool?.title ?? t('文件管理'),
          icon: <FolderTree className="size-3.5 shrink-0" />
        }
      }
      if (isSysmonTabKey(key)) {
        // 系统监控 + 任务管理器：全局单例（`sysmon:list`），看的是服务端那台机器
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('系统监控'),
          title: tool?.title ?? t('系统监控'),
          icon: <Gauge className="size-3.5 shrink-0" />
        }
      }
      if (isTriggersTabKey(key)) {
        // 定时任务面板也是全局单例（`triggers:list`），名字固定
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('定时任务'),
          title: tool?.title ?? t('定时任务'),
          icon: <CalendarClock className="size-3.5 shrink-0" />
        }
      }
      if (isScriptsTabKey(key)) {
        // 脚本管理面板同样是全局单例（`scripts:list`），名字固定。
        // 单个脚本的新建 / 编辑是模态框（`ScriptEditDialog`），不占标签。
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('脚本'),
          title: tool?.title ?? t('脚本'),
          icon: <FileCode2 className="size-3.5 shrink-0" />
        }
      }
      if (isSettingsTabKey(key)) {
        // 设置面板也是全局单例（`settings:list`）。名字固定 —— 它内部有分组菜单，
        // 标签名再跟着当前分组变只会让人以为开了好几条设置
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('设置'),
          title: tool?.title ?? t('设置'),
          icon: <Settings className="size-3.5 shrink-0" />
        }
      }
      if (isNoteTabKey(key)) {
        // 笔记标签：名字与归属都在登记表里（key 是不透明的 `note:<n>`），重命名后就地改
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? '笔记',
          title: tool?.notePath ?? tool?.title ?? '笔记',
          icon: <NotebookPen className="size-3.5 shrink-0" />
        }
      }
      if (isLocalFileTabKey(key)) {
        // 本地文件标签：归属（绝对路径）同样只在登记表里，key 是不透明的 `file:<n>`
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? 'Markdown',
          // 悬停给完整绝对路径 —— 一堆 README.md 时只看文件名分不清是哪一个
          title: tool?.externalPath ?? tool?.title ?? 'Markdown',
          icon: <FileText className="size-3.5 shrink-0" />
        }
      }
      if (isApiTabKey(key)) {
        const requestId = apiRequestIdOfTabKey(key)
        // WebSocket 草稿（哨兵）与已保存的 `protocol === 'ws'` 条目走另一套图标 / 提示
        if (requestId === NEW_WS_REQUEST_ID) {
          return {
            label: '新建连接',
            title: '新建 WebSocket 连接（未保存）',
            icon: <Cable className="size-3.5 shrink-0" />
          }
        }
        const request = app.apiRequests.find((r) => r.id === requestId)
        if (request?.protocol === 'ws') {
          return {
            label: request.name.trim() || request.url.trim() || 'WebSocket',
            title: `WS ${request.url || '（未填写地址）'}`,
            icon: <Cable className="size-3.5 shrink-0" />
          }
        }
        return {
          label: request?.name.trim() || request?.url.trim() || (requestId === NEW_API_REQUEST_ID ? '新请求' : '接口请求'),
          title: request
            ? `${request.method || 'GET'} ${request.url || '（未填写地址）'}`
            : '新建接口请求（未保存）',
          icon: <Globe className="size-3.5 shrink-0" />
        }
      }
      if (isPluginTabKey(key)) {
        const tool = getToolTab(key)
        // 图标优先用插件声明的那个（data URI 只能塞进 <img>，绝不拼进 DOM）
        const surface = pluginSurfaces.find(
          (s) => s.pluginId === tool?.pluginId && s.id === tool?.surfaceId
        )
        return {
          label: tool?.label || '插件',
          title: tool?.title || '插件界面',
          icon: surface?.icon ? (
            <img
              src={surface.icon}
              alt=""
              aria-hidden
              className="size-3.5 shrink-0 object-contain"
            />
          ) : (
            <Puzzle className="size-3.5 shrink-0" />
          )
        }
      }
      const conversation = app.conversations.find((c) => c.id === key)
      return {
        // 默认标题（`新会话`）按当前语言显示，用户起过的名字原样
        label: conversationTitle(conversation?.title) || t('对话'),
        title: conversationTitle(conversation?.title) || key,
        icon: <MessageSquare className="size-3.5 shrink-0" />
      }
    },
    [app.conversations, app.sshHosts, app.apiRequests, app.scripts, pluginSurfaces, language]
  )

  /**
   * 别名盖在**数据源算出来的名字**之上。
   *
   * 上面那份 `baseMeta` 全部按「数据源现在叫什么」算（主机清单 / 接口清单 / 脚本名 /
   * 会话标题），而用户就地改的名字只存在登记表的 `alias` 里（见 `renameToolTab`）——
   * 放在这里盖一层，就不用给那十几个分支各加一次 `alias ??`。
   *
   * ⚠️ 只盖 `label`，不动 `title`：悬停提示要继续说清「这是哪台主机 / 哪个请求」。
   */
  return useCallback(
    (key: string): TabMeta => {
      const meta = baseMeta(key)
      const alias = getToolTab(key)?.alias
      return alias ? { ...meta, label: alias } : meta
    },
    [baseMeta]
  )
}

// ---------------------------------------------------------------------------
// 分隔条
// ---------------------------------------------------------------------------
