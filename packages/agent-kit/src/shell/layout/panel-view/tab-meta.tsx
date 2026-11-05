"use client";

import { useCallback, useSyncExternalStore } from 'react';
import {
  Cable,
  Cloud,
  Gauge,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  MessageCircleQuestion,
  MessageSquare,
  MessageSquarePlus,
  Network,
  NotebookPen,
  CalendarClock,
  FolderTree,
  Puzzle,
  ScrollText,
  Settings,
  ShieldQuestion,
  SquareTerminal,
} from 'lucide-react'
import { t } from '@fizz/i18n'
import { useLanguage } from '@fizz/agent-kit/shared/lib/language'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { usePluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import { TypingBubble } from '@fizz/agent-kit/features/chat/TypingBubble'
import { getActivity, useActivities } from '@fizz/agent-kit/shared/lib/conversation-activity'
import {
  getTabDecoration,
  getTabDecorationsVersion,
  subscribeTabDecorations,
} from '@fizz/agent-kit/shared/lib/tab-decorations'
import {
  getTerminalStatus,
  getTerminalStatusVersion,
  subscribeTerminalStatus,
} from '@fizz/agent-kit/shared/lib/terminal/terminal-registry'
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
  /**
   * 会话运行态：标签图标要跟着「在跑 / 等你点头」变（与侧栏 `AgentSidebar` 同一份数据源，
   * 服务端广播的，与当前打开哪条会话无关）。
   */
  useActivities()
  /**
   * 终端存活：登记表（`terminal-registry`）是**拉取式**的（`isAlive()` 不会触发重渲染），
   * 靠这条版本号订阅才能在进程退出那一刻把绿点换成红点。
   */
  useSyncExternalStore(subscribeTerminalStatus, getTerminalStatusVersion, getTerminalStatusVersion)
  /** 外部装饰（插件 / 标签内容方写进来的图标与状态点，见 `tab-decorations.ts`） */
  useSyncExternalStore(
    subscribeTabDecorations,
    getTabDecorationsVersion,
    getTabDecorationsVersion
  )
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
          icon: <Cloud className="size-3.5 shrink-0" />
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
        //
        // ⚠️ 全局单例的 label / title 是**静态文案**（登记表里存的只是中文原文），
        // 不是主机名那种数据快照 —— 必须在这里 `t()` 现翻，不能直接用 `tool?.label`：
        // 登记表在打开那一刻写死，切语言不会重建它（设置标签就是这么一直是中文的）。
        const tool = getToolTab(key)
        return {
          label: t(tool?.label ?? '隧道'),
          title: t(tool?.title ?? 'SSH 隧道'),
          icon: <Network className="size-3.5 shrink-0" />
        }
      }
      if (isLogsTabKey(key)) {
        // 应用日志面板同样是全局单例（`logs:list`），内部用 Tab 切命名空间
        const tool = getToolTab(key)
        return {
          label: t(tool?.label ?? '日志'),
          title: t(tool?.title ?? '应用日志'),
          icon: <ScrollText className="size-3.5 shrink-0" />
        }
      }
      if (isFilesTabKey(key)) {
        // 文件管理器：全局单例（`files:list`），浏览的是服务端那台机器的整盘
        const tool = getToolTab(key)
        return {
          label: t(tool?.label ?? '文件管理'),
          title: t(tool?.title ?? '文件管理'),
          icon: <FolderTree className="size-3.5 shrink-0" />
        }
      }
      if (isSysmonTabKey(key)) {
        // 系统监控 + 任务管理器：全局单例（`sysmon:list`），看的是服务端那台机器
        const tool = getToolTab(key)
        return {
          label: t(tool?.label ?? '系统监控'),
          title: t(tool?.title ?? '系统监控'),
          icon: <Gauge className="size-3.5 shrink-0" />
        }
      }
      if (isTriggersTabKey(key)) {
        // 定时任务面板也是全局单例（`triggers:list`），名字固定
        const tool = getToolTab(key)
        return {
          label: t(tool?.label ?? '定时任务'),
          title: t(tool?.title ?? '定时任务'),
          icon: <CalendarClock className="size-3.5 shrink-0" />
        }
      }
      if (isScriptsTabKey(key)) {
        // 脚本管理面板同样是全局单例（`scripts:list`），名字固定。
        // 单个脚本的新建 / 编辑是模态框（`ScriptEditDialog`），不占标签。
        const tool = getToolTab(key)
        return {
          label: t(tool?.label ?? '脚本'),
          title: t(tool?.title ?? '脚本'),
          icon: <FileCode2 className="size-3.5 shrink-0" />
        }
      }
      if (isSettingsTabKey(key)) {
        // 设置面板也是全局单例（`settings:list`）。名字固定 —— 它内部有分组菜单，
        // 标签名再跟着当前分组变只会让人以为开了好几条设置
        const tool = getToolTab(key)
        return {
          label: t(tool?.label ?? '设置'),
          title: t(tool?.title ?? '设置'),
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
   * 覆盖层：在 `baseMeta` 之上叠三样东西（后者压前者）。
   *
   * 1. **别名**（`label`）—— 用户就地改的名字只存在登记表的 `alias` 里（见 `renameToolTab`），
   *    放在这里盖一层，就不用给那十几个分支各加一次 `alias ??`；
   * 2. **内建运行态**（`icon` / `status`）—— 会话的「在跑 / 等你确认 / 等你回答」与终端的
   *    「活着 / 已退出」。优先级与侧栏 `ConversationRowIcon` 一致：等人 > 在跑 > 类型图标；
   * 3. **外部装饰**（`tab-decorations.ts`）—— 标签内容方 / 插件写进来的东西，优先级最高。
   *
   * ⚠️ 只盖 `label`，不动 `title`：悬停提示要继续说清「这是哪台主机 / 哪个请求」。
   */
  return useCallback(
    (key: string): TabMeta => {
      const meta = baseMeta(key)
      const alias = getToolTab(key)?.alias

      let icon = meta.icon
      let status = meta.status

      /*
       * 会话运行态。`getActivity` 对非会话 key 恒返回冻结的空态（表里只会有会话 id），
       * 所以不必先判断这是不是对话标签。
       */
      const activity = getActivity(key)
      if (activity.waiting) {
        // 区分两种「等你」：权限申请用盾牌、AI 提问用问号气泡（与侧栏同一套符号）
        const Icon = activity.waiting.kind === 'confirm' ? ShieldQuestion : MessageCircleQuestion
        icon = (
          <Icon
            className="size-3.5 shrink-0 text-amber-500"
            aria-label={t(activity.waiting.kind === 'confirm' ? '等待确认' : '等待回答')}
          />
        )
      } else if (activity.running) {
        /*
         * 打字气泡而不是转圈（与侧栏同一条理由：一屏十几个转圈太晃）。
         * 尺寸用 `!` 压过组件自带的 `size-4`：标签条图标槽是 14px，`className` 是**拼在**
         * 基础类后面的，同权重下谁生效取决于产物里两条规则的先后 —— 只有 `!` 是确定的。
         */
        icon = <TypingBubble className="size-3.5!" />
      }

      /**
       * 终端：连接中黄点、就绪绿点、已退出红点（登记表只在主区域标签上写，侧栏终端不参与）。
       *
       * 「建好进程」≠「连上了」：SSH 握手 / 认证、web 端 WS 建连 + spawn 都要时间，这期间
       * 挂绿点会让人以为已经能敲命令（用户报过）。阶段由 `TerminalPanel` 推，这里只做映射。
       */
      const terminal = getTerminalStatus(key)
      if (terminal) {
        status =
          terminal.phase === 'exited'
            ? { tone: 'error', label: t('终端已退出') }
            : terminal.phase === 'connecting'
              ? { tone: 'waiting', label: t('终端连接中') }
              : { tone: 'ok', label: t('终端运行中') }
      }

      // 外部装饰压在最上面（不传就保留上面算出来的）
      const decoration = getTabDecoration(key)
      if (decoration?.icon !== undefined) icon = decoration.icon
      if (decoration?.status) status = decoration.status

      return { ...meta, label: alias ?? meta.label, icon, status }
    },
    // 语言已由 `baseMeta` 的依赖带进来（`t()` 读的是模块级的当前语言）
    [baseMeta]
  )
}

// ---------------------------------------------------------------------------
// 分隔条
// ---------------------------------------------------------------------------
