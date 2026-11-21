/**
 * 「加一个新工作区」的四个入口 —— 选择文件夹 / 从 Git 导入 / 连接远端服务器 /
 * 新建容器型项目，连同它们各自的弹窗，打包成一份。
 *
 * ## 谁在用
 *
 * - **命令面板**的「新建工作区」页：读 `actions` 画四行（第二行用 `description` 说清目录
 *   落在哪）；「选文件夹」「连接远端服务器」两条在面板里就地压页，Git / 容器两条走宿主弹窗。
 * - **定时任务表单**：只接 Git / 容器两条（远端工作区首期不支持；选文件夹那条也让面板办，
 *   见 `TriggerEditDialog` 的 filter）。
 *
 * 对话输入框下方那颗工作区 pill **不再挂这套菜单**：四条动作在命令面板里全有，两处各摆
 * 一遍只会慢慢漂成「面板里有、下拉里没有」；它现在只留一条「新建工作区」直接开面板那一页
 * （`requestCommandPalette('new-workspace')`）。
 *
 * ## 为什么是 hook 而不是组件
 *
 * `WorkspacePicker` 是**受控**的（`value` / `onChange` 由调用方管），而这四个入口是
 * 「与当前选谁无关」的副作用。做成组件就得把 picker 一起吞进去，可调用方各有各的
 * value 语义（定时任务表单里 = 表单的局部状态），吞进去反而要再包一层。
 * 所以这里只产出数据与回调，调用方自己拼：
 *
 * ```tsx
 * const { actions, onAction, dialogs } = useWorkspaceAddActions(app, (ws) => setWorkspaceId(ws.id))
 * <WorkspacePicker actions={actions} onAction={onAction} ... />
 * {dialogs}
 * ```
 *
 * `dialogs` 里是服务端目录浏览器（桌面端底栏多一枚系统框）与三个新建弹窗 ——
 * Radix 都会 portal 到 body，挂在树的哪里都行。
 */
import { useState, type ReactNode } from 'react'
import { Cloud, Container, FolderInput, GitBranch } from 'lucide-react'
import { GitCloneDialog } from '@fizz/agent-kit/features/projects/GitCloneDialog'
import { NewContainerProjectDialog } from '@fizz/agent-kit/features/projects/NewContainerProjectDialog'
import {
  remoteDirSource,
  remoteHostsOf
} from '@fizz/agent-kit/features/chat/remote-dir-source'
import { useDirectoryPicker } from '@fizz/agent-kit/shared/hooks/use-directory-picker'
import type { DirPickerSource } from '@fizz/agent-kit/shared/components/ServerDirPicker'
import { useStateValue } from '@fizz/agent-kit/shared/lib/state-ws'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { ContainerProjectsSnapshot, HostConfig } from '@fizz/contracts/types'
import type { AgentWorkspace } from '@fizz/contracts/agent-api'

/**
 * 「选择文件夹…」这条入口的动作 id。
 *
 * 命令面**认识它**：在面板里点它不该弹独立弹窗，而是把目录页压进面板栈
 * （`CommandPalette` 的 `dir` 页），选完再走 `addDirectory`。放在这里导出，
 * 免得两边各写一份字符串、改一边就静默失联。
 */
export const ADD_DIR_ACTION = '__add_dir__'

/**
 * 「连接远端服务器…」的动作 id。
 *
 * 只有命令面板认识它：进去先是一页远端主机清单，选一台再压一页目录浏览器
 * （数据源换成这台主机的 SFTP），选完走 `addRemoteWorkspace`。
 * **没有独立弹窗了**（原先那个 `RemoteWorkspaceDialog` 已删）—— 面板里这四步
 * 逐级可退，表单式弹窗反而不适合它（路径靠点、不靠敲）。写死在面板里也能跑，
 * 但那等于「加项目」的动作名散落两处 —— 改一处就静默失联。
 */
export const ADD_REMOTE_ACTION = '__add_remote__'

export interface WorkspaceAddActions {
  /**
   * 四条入口（命令面板「新建工作区」页照它画行）。
   * `label` 是一行式标题，`description` 是第二行的灰字 —— 光看标题不够：
   * 「选择文件夹」和「从 Git 导入」都得说清目录最终落在哪（本机 / 远端 / 容器）。
   * `WorkspacePicker` 只读 value / label / icon（它的行高只有一行）。
   */
  actions: { value: string; label: string; description?: string; icon: ReactNode }[]
  /** 喂给 `WorkspacePicker` 的 `onAction`（定时任务表单那条路） */
  onAction: (value: string) => void
  /**
   * 目录已经在**面板里**选好了：直接登记成工作区。
   *
   * 命令面板会把 `ADD_DIR_ACTION` 那一条换成一页目录浏览器（能退回上一级），
   * 选中的路径从这里回来 —— 与 `onAction(ADD_DIR_ACTION)` 走的是同一个 `addDir`，
   * 只是省掉了「关面板 → 弹窗 → 系统框/面板」那一跳。
   */
  addDirectory: (path: string) => void
  /**
   * 可承载远端工作区的主机（命令面板的远端主机页画它）。
   *
   * 与 `actions` 一样出自本 hook：`kind !== 'local'` 的过滤只有一处，面板别再自己 filter。
   * 空数组 = 一台 SSH 主机都没配，面板那一页给提示、让用户按 Esc 退回去。
   */
  remoteHosts: HostConfig[]
  /**
   * 一台主机的远端目录数据源（喂目录浏览器）。
   *
   * 远端目录在**另一台机器**上，只能经 SFTP 列 —— 数据源统一在 `remote-dir-source.ts`
   * 里，别在面板里再写一套 list/mkdir。
   */
  remoteDirSource: (hostId: string) => DirPickerSource
  /**
   * 远端目录选好了：直接登记成远端工作区（`path` 是远端 POSIX 绝对路径）。
   *
   * 命令面板「连接远端服务器 → 选主机 → 选目录」的最后一步，名字留空 = 服务端取目录名。
   * 与 `addDirectory` 对称。
   */
  addRemoteWorkspace: (hostId: string, path: string) => void
  /** 三个新建弹窗（含目录浏览器），挂进调用方的树里 */
  dialogs: ReactNode
}

/**
 * @param app 需要它做两件事：`addWorkspace`（选目录那一路）与给目录浏览器用
 * @param onAdded 新建 / 导入成功后的回调：调用方拿去「选中它」
 *   （聊天里是 `selectNewWorkspace`，定时任务表单里是 `setWorkspaceId`）
 */
export function useWorkspaceAddActions(
  app: AgentApp,
  onAdded?: (workspace: AgentWorkspace) => void
): WorkspaceAddActions {
  const t = useT()
  /**
   * 两个新建弹窗的开关（Git 导入 / 容器型项目）；选目录那一路直接 `await pick()`，不需要状态。
   * 远端工作区**没有弹窗**了 —— 命令面板的 `remote-hosts` → `remote-dir` 两页就是它，
   * 别再把表单式弹窗加回来（路径靠点选，敲路径反而是退路）。
   */
  const [addMode, setAddMode] = useState<'git' | 'container' | null>(null)
  /** 容器型项目的唯一能力门控（服务端有 docker 才有这个选项） */
  const containerProjects = useStateValue<ContainerProjectsSnapshot>('containerProjects', {
    available: false,
    projects: []
  })

  /**
   * 选目录：三端都用内置的服务端目录浏览器，桌面端底栏多一枚「使用系统文件选择器」。
   * 工作区登记的是「跑 Agent 那台机器」上的路径 —— 桌面端后端就在本进程里，是同一台机器。
   *
   * 这条弹窗服务于**表单 / 下拉**（工作区下拉、定时任务表单）；命令面板里是另一副外壳
   * （`CommandPalette` 的 `dir` 页），共用同一块浏览本体。
   */
  const { pick, node } = useDirectoryPicker(
    app,
    t('这里列的是服务端上的目录（Agent 就跑在那台机器上）。选中的目录会登记为项目。')
  )

  const addDir = (path: string): void => {
    void app.addWorkspace({ path }).then((ws) => {
      if (ws) onAdded?.(ws)
    })
  }

  /** 远端目录：路径在 SSH 主机上，`remote.hostId` 告诉服务端去那台机器上探 */
  const addRemoteWorkspace = (hostId: string, path: string): void => {
    void app.addWorkspace({ path, remote: { hostId } }).then((ws) => {
      if (ws) onAdded?.(ws)
    })
  }

  /** 可选的远端主机与「按主机取数据源」：两处都从 `remote-dir-source.ts` 来，面板不自己拼 */
  const remoteHosts = remoteHostsOf(app.sshHosts)
  const dirSourceFor = (hostId: string): DirPickerSource => remoteDirSource(app, hostId)

  const actions: WorkspaceAddActions['actions'] = [
    {
      value: ADD_DIR_ACTION,
      label: t('选择文件夹…'),
      description: t('在磁盘上选一个文件夹'),
      icon: <FolderInput />
    },
    {
      value: '__add_git__',
      label: t('从 Git 导入…'),
      description: t('从远端仓库克隆一份'),
      icon: <GitBranch />
    },
    // 远端工作区：目录在 SSH 主机上，Agent 经 SFTP / 远端 shell 操作它
    {
      value: ADD_REMOTE_ACTION,
      label: t('连接远端服务器…'),
      description: t('目录在 SSH 主机上，Agent 经 SFTP 读写'),
      icon: <Cloud />
    },
    // 容器型项目：服务端有 docker 才出现（目录由服务端固定生成，用户不可选）
    ...(containerProjects.available
      ? [
          {
            value: '__add_container__',
            label: t('新建容器型项目…'),
            description: t('目录由服务端建在容器里'),
            icon: <Container />
          }
        ]
      : [])
  ]

  const onAction = (action: string): void => {
    if (action === ADD_DIR_ACTION) {
      void pick().then((path) => {
        if (path) addDir(path)
      })
      return
    }
    /*
      「连接远端服务器」只有命令面板那条路（压主机页 → 远端目录页）。这里显式忽略：
      万一哪个调用方把完整 `actions` 原样喂给下拉，点它什么都不该发生 ——
      落到下面的 `else` 会莫名弹出一个「从 Git 导入」。
    */
    if (action === ADD_REMOTE_ACTION) return
    if (action === '__add_container__') setAddMode('container')
    else setAddMode('git')
  }

  const dialogs = (
    <>
      {/*
        表单那条路用的独立弹窗。命令面板里都不走它：
        「选文件夹」（`ADD_DIR_ACTION`）压 `dir` 页、选完 `addDirectory`；
        「连接远端服务器」（`ADD_REMOTE_ACTION`）压主机页 → `remote-dir` 页，**没有弹窗**；
        Git / 容器要填表单，面板里也是「关面板 + 这里弹」。
        但别因为面板有页就把前两个删了 —— 定时任务表单还从这里进。
      */}
      {node}
      <GitCloneDialog
        app={app}
        open={addMode === 'git'}
        onOpenChange={(open) => setAddMode(open ? 'git' : null)}
        onCloned={(ws) => onAdded?.(ws)}
      />
      <NewContainerProjectDialog
        app={app}
        open={addMode === 'container'}
        onOpenChange={(open) => setAddMode(open ? 'container' : null)}
        onCreated={(ws) => onAdded?.(ws)}
      />
    </>
  )

  return {
    actions,
    onAction,
    addDirectory: addDir,
    remoteHosts,
    remoteDirSource: dirSourceFor,
    addRemoteWorkspace,
    dialogs
  }
}
