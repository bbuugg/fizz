/**
 * 工作区服务：把「这一轮绑定的工作区根目录」交给插件。
 *
 * ## 为什么需要它
 *
 * 内置文件工具是**闭包**拿到工作区根的（`fileToolsPlugin(root, …)`，见
 * `@fizz/agent` 的 plugins.ts），插件却什么都没有 —— 于是插件写的工具**没法解析相对路径**。
 * 而模型的系统提示词里明确写着「所有路径一律使用相对工作区根目录的路径」，所以一个
 * 「把某个文件传上去」的插件工具，拿到的大概率就是 `notes/report.md` 这种相对路径。
 * 没有这个服务，插件只能要求绝对路径，跟全仓库的路径约定拧着来。
 *
 * ## 边界（刻意很小）
 *
 * 只回答两件事：工作区在哪（`path`）、怎么把模型给的路径变成绝对路径（`resolve`）。
 * **不做沙箱**：不拦着插件读写工作区外的文件 —— 插件本来就是**完全可信**的代码
 * （它能 `import node:fs` 干任何事），给一个「看起来能挡住」的 API 只会造成安全错觉。
 * 需要限制范围的插件请自己调 `contains` 判断。
 *
 * 提供时机：`runAgent` 建 turn context（挂载装配产物）时 set（未绑定目录的会话不提供 → 声明
 * `inject: ['workspace']` 的插件在那里会被**推迟挂载**，见 context.ts 的依赖注入说明）。
 */
import { isAbsolute, join, normalize, relative } from 'node:path'
import { Service } from '../service'
import type { Context } from '../context'

export interface WorkspaceInfo {
  /** 工作区根目录（绝对路径） */
  path: string
  /** 项目显示名（提示词段落之类的文案里用得到；没给就是空串） */
  name?: string
}

export class WorkspaceService extends Service {
  /** 工作区根目录（已归一化） */
  readonly path: string
  /** 项目显示名 */
  readonly label: string

  constructor(ctx: Context, info: WorkspaceInfo) {
    super(ctx)
    this.path = normalize(String(info?.path ?? ''))
    this.label = String(info?.name ?? '')
  }

  get name(): string {
    return 'workspace'
  }

  /**
   * 把模型给的路径解析成绝对路径：绝对路径原样归一化，相对路径拼到工作区根下。
   *
   * 不做「越界检查」——见文件头的边界说明。要判断的话用 `contains`。
   */
  resolve(input: string): string {
    const raw = String(input ?? '').trim()
    if (!raw) return this.path
    return normalize(isAbsolute(raw) ? raw : join(this.path, raw))
  }

  /** 这个路径（绝对或相对）是否落在工作区内 */
  contains(input: string): boolean {
    const target = this.resolve(input)
    const rel = relative(this.path, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
}
