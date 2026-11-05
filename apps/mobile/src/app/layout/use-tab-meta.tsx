/**
 * 面板标签的展示信息（标签条 / 手机顶栏共用）。
 *
 * 原先它在 `PanelView.tsx` 里，与主区域的标签条绑在一起。手机版把标签条换成了一条
 * 移动顶栏（`MobileAppBar`）—— 顶栏上要显示**当前标签**的图标与名字，同一套解析不能
 * 抄第二份（主机 / 终端 / 插件 / 笔记的名字来源各不相同，抄一份必漂），所以抽到这里，
 * 两处都从这里 import。
 *
 * 按 key 的类型分别取源：
 * - 对话标签 → 会话列表里的标题（会话被重命名 / 首条消息自动定标题都跟着走）；
 * - 主机标签 → **优先**读主机清单（改名能实时反映），清单里没有了（主机被删）就退回
 *   打开时记在登记表里的快照 —— 标签不会突然变成一串 uuid；
 * - 本机终端 → 登记表里的快照（`终端 N` / 目录）。
 */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import {
  Cable,
  CalendarClock,
  FileCode2,
  FileText,
  FolderOpen,
  FolderTree,
  Gauge,
  Globe,
  MessageSquare,
  MessageSquarePlus,
  Network,
  NotebookPen,
  Puzzle,
  Server,
  SquareTerminal
} from 'lucide-react'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { usePluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import {
  getToolTab,
  getToolTabsVersion,
  subscribeToolTabs
} from '@fizz/agent-kit/shared/lib/tool-tabs'
import { NEW_API_REQUEST_ID, NEW_WS_REQUEST_ID } from '@fizz/agent-kit/features/api/api-client'
import {
  apiRequestIdOfTabKey,
  hostIdOfTabKey,
  isApiTabKey,
  isFilesTabKey,
  isHostTabKey,
  isLocalFileTabKey,
  isLocalTabKey,
  isNoteTabKey,
  isPluginTabKey,
  isScriptsTabKey,
  isSftpTabKey,
  isSysmonTabKey,
  isTriggersTabKey,
  isTunnelTabKey,
  NEW_TAB_KEY,
  sftpHostIdOfTabKey
} from '@fizz/agent-kit/shared/lib/panel-tabs'
import type { SshHostConfig } from '@fizz/contracts/types'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'
import { useT } from '@fizz/agent-kit/shared/lib/language'

/** 一个标签在标签条 / 移动顶栏上的展示信息 */
export interface TabMeta {
  /** 标签条上的短名 */
  label: string
  /** 悬停提示（更完整的描述） */
  title: string
  /** 类型图标：一列标签里混着「对话 / 主机 / 终端」三种东西，光看名字分不出来 */
  icon: ReactNode
}

export function useTabMeta(): (key: string) => TabMeta {
  // 订阅语言：标签名里的默认标题（`新会话` / `新对话`）要跟着语言变
  const t = useT()
  const { app } = useAppContext()
  /** 插件界面清单：标签条上要显示插件声明的图标与名字（数据来自服务端，不在前端算） */
  const pluginSurfaces = usePluginSurfaces(app, app.activeWorkspaceId ?? undefined)
  // 笔记标签的名字**会变**：重命名后 `retargetNoteTab` 就地改登记表（key 是不透明的
  // `note:<n>`，名字只在表里），而登记表自己不发通知。不订阅这个版本号，标签条会一直
  // 停在旧文件名上，直到下一次由别的原因触发的重渲染 —— 用户看到的是「重命名没生效」。
  useSyncExternalStore(subscribeToolTabs, getToolTabsVersion, getToolTabsVersion)
  return useCallback(
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
          label: host?.name ?? snapshot?.label ?? '主机',
          title: host
            ? `SSH · ${host.username}@${host.host}:${host.port}`
            : (snapshot?.title ?? '主机已从清单里删除'),
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
          label: host ? `${host.name} 文件` : (snapshot?.label ?? '文件'),
          title: host
            ? `SFTP · ${host.username}@${host.host}:${host.port}`
            : (snapshot?.title ?? '主机已从清单里删除'),
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
          label: tool?.label ?? '隧道',
          title: tool?.title ?? 'SSH 隧道',
          icon: <Network className="size-3.5 shrink-0" />
        }
      }
      if (isTriggersTabKey(key)) {
        // 定时任务面板也是全局单例（`triggers:list`），名字固定
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? '定时任务',
          title: tool?.title ?? '定时任务',
          icon: <CalendarClock className="size-3.5 shrink-0" />
        }
      }
      if (isScriptsTabKey(key)) {
        // 脚本管理面板同样是全局单例（`scripts:list`），名字固定。
        // 单个脚本的新建 / 编辑是模态框（`ScriptEditDialog`），不占标签。
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? '脚本',
          title: tool?.title ?? '脚本',
          icon: <FileCode2 className="size-3.5 shrink-0" />
        }
      }
      if (isFilesTabKey(key)) {
        // 文件管理也是全局单例（`files:list`），名字固定。手机端没有入口（见 PanelView 里
        // 那条分支的说明），这里备着是为了标签名不至于退化成空串。
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? '文件管理',
          title: tool?.title ?? '文件管理',
          icon: <FolderTree className="size-3.5 shrink-0" />
        }
      }
      if (isSysmonTabKey(key)) {
        // 系统监控 / 任务管理器也是全局单例（`sysmon:list`）。手机上的入口在抽屉左下角
        // （`layout/Sidebar.tsx`，与设置同一行）。
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? '系统监控',
          title: tool?.title ?? '系统监控',
          icon: <Gauge className="size-3.5 shrink-0" />
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
          label:
            request?.name.trim() ||
            request?.url.trim() ||
            (requestId === NEW_API_REQUEST_ID ? '新请求' : '接口请求'),
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
        // 默认标题（`新会话`）按当前语言显示；用户起过的名字原样
        label: conversationTitle(conversation?.title) || '对话',
        title: conversationTitle(conversation?.title) || key,
        icon: <MessageSquare className="size-3.5 shrink-0" />
      }
    },
    [app.conversations, app.sshHosts, app.apiRequests, app.scripts, pluginSurfaces]
  )
}
