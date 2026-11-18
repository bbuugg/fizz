/**
 * 「加一个新工作区」的四个入口 —— 选择文件夹 / 从 Git 导入 / 连接远端服务器 /
 * 新建容器型项目，连同它们各自的弹窗，打包成一份。
 *
 * ## 为什么是 hook 而不是组件
 *
 * `WorkspacePicker` 是**受控**的（`value` / `onChange` 由调用方管），而这四个入口是
 * 「与当前选谁无关」的副作用。做成组件就得把 picker 一起吞进去，可调用方各有各的
 * value 语义（聊天里 = 下一条消息的归属；定时任务表单里 = 表单的局部状态），
 * 吞进去反而要再包一层。所以这里只产出三样东西，调用方自己拼：
 *
 * ```tsx
 * const { actions, onAction, dialogs } = useWorkspaceAddActions(app, (ws) => setWorkspaceId(ws.id))
 * <WorkspacePicker actions={actions} onAction={onAction} ... />
 * {dialogs}
 * ```
 *
 * `dialogs` 里是系统目录框（桌面端）/ 服务端目录浏览器（web）与三个新建弹窗 ——
 * Radix 都会 portal 到 body，挂在树的哪里都行。
 *
 * ⚠️ **加项目只剩这一处入口**（侧栏那颗「+」已删）：两个调用方都必须把 `actions`
 * 接上，否则用户在那个界面里就没有「新建项目」的路了。
 */
import { useState, type ReactNode } from 'react'
import { Cloud, Container, FolderInput, GitBranch } from 'lucide-react'
import { GitCloneDialog } from '@fizz/agent-kit/features/projects/GitCloneDialog'
import { NewContainerProjectDialog } from '@fizz/agent-kit/features/projects/NewContainerProjectDialog'
import { RemoteWorkspaceDialog } from '@fizz/agent-kit/features/chat/RemoteWorkspaceDialog'
import { useDirectoryPicker } from '@fizz/agent-kit/shared/hooks/use-directory-picker'
import { useStateValue } from '@fizz/agent-kit/shared/lib/state-ws'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { ContainerProjectsSnapshot } from '@fizz/contracts/types'
import type { AgentWorkspace } from '@fizz/contracts/agent-api'

export interface WorkspaceAddActions {
  /** 喂给 `WorkspacePicker` 的 `actions`（图标与侧栏那几颗同源） */
  actions: { value: string; label: string; icon: ReactNode }[]
  /** 喂给 `WorkspacePicker` 的 `onAction` */
  onAction: (value: string) => void
  /** 四个入口各自的弹窗（含目录选择器），挂进调用方的树里 */
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
   * 三个新建弹窗的开关；选目录那一路不需要状态（直接 `await pick()`）。
   * 侧栏那颗「+」已删，加项目只剩这里 —— 别在别处再挂一套弹窗，两处维护迟早会漂。
   */
  const [addMode, setAddMode] = useState<'git' | 'container' | 'remote' | null>(null)
  /** 容器型项目的唯一能力门控（服务端有 docker 才有这个选项） */
  const containerProjects = useStateValue<ContainerProjectsSnapshot>('containerProjects', {
    available: false,
    projects: []
  })

  /**
   * 选目录：桌面端弹**系统目录框**，web 才用内置的服务端目录浏览器。
   * 工作区登记的是「跑 Agent 那台机器」上的路径 —— 桌面端后端就在本进程里，是同一台机器。
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

  const actions: WorkspaceAddActions['actions'] = [
    { value: '__add_dir__', label: t('选择文件夹…'), icon: <FolderInput /> },
    { value: '__add_git__', label: t('从 Git 导入…'), icon: <GitBranch /> },
    // 远端工作区：目录在 SSH 主机上，Agent 经 SFTP / 远端 shell 操作它
    { value: '__add_remote__', label: t('连接远端服务器…'), icon: <Cloud /> },
    // 容器型项目：服务端有 docker 才出现（目录由服务端固定生成，用户不可选）
    ...(containerProjects.available
      ? [{ value: '__add_container__', label: t('新建容器型项目…'), icon: <Container /> }]
      : [])
  ]

  const onAction = (action: string): void => {
    if (action === '__add_dir__') {
      void pick().then((path) => {
        if (path) addDir(path)
      })
      return
    }
    if (action === '__add_container__') setAddMode('container')
    else if (action === '__add_remote__') setAddMode('remote')
    else setAddMode('git')
  }

  const dialogs = (
    <>
      {/* 桌面端是系统目录框（这里为 null），web 才是内置的服务端目录浏览器 */}
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
      <RemoteWorkspaceDialog
        app={app}
        open={addMode === 'remote'}
        onOpenChange={(open) => setAddMode(open ? 'remote' : null)}
        onCreated={(ws) => onAdded?.(ws)}
      />
    </>
  )

  return { actions, onAction, dialogs }
}
