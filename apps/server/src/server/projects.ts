/**
 * 项目(工作区)创建 / 目录浏览的服务层收口:HTTP 路由与 AI 工具共用同一套
 * 校验与落库顺序,避免「弹窗能做、助手不能做(或反过来)」的双实现漂移。
 *
 * worktree 的创建与项目删除也在这层(本文件下半部),三道闸 / 扫描逻辑只有一份。
 *
 * 错误统一抛 `ProjectServiceError(status, message)`,route 侧只做「catch → jsonError」;
 * 纯判定函数在 `./projects-pure`(scripts 可独立验证)。
 */
import { existsSync, promises as fs } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  AgentWorkspace,
  FsDirEntry,
  FsDirsResult,
  WorktreeInput
} from '@fizz/contracts/agent-api'
import { WORKTREE_IDENTIFIER_RE } from '@fizz/contracts/agent-api'
import { agentBrowserSessionId } from '@fizz/contracts'
import { browserSessions } from '@fizz/tools'
import { addWorktree, cloneRepo, ensureWorktreesIgnored, hasCommits, isCloneCanceled, refExists, removeWorktree, repoNameFromUrl, resolveRepoRoot, type GitLogLevel } from '@fizz/git'
import { resolveDataDir } from '@fizz/workspace'
import { domain } from './state'
import { stopSessionRunning } from './background-tasks'
import { projectDirOf } from './container-projects/root'
import { purgeProjectContainers } from './container-projects/purge'
import { describeError } from './lib/http'
import { invalidNameReason, WORKTREE_DIR, worktreeIdentifierOf } from './projects-pure'

/** 服务层唯一异常类型:route 侧 catch 后按 status 回 JSON 错误 */
export class ProjectServiceError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 500 | 502,
    message: string
  ) {
    super(message)
  }
}

/** route 侧的统一错误映射:项目服务的异常 → jsonError 参数 */
export function projectError(err: unknown): { status: ProjectServiceError['status']; message: string } {
  if (err instanceof ProjectServiceError) return { status: err.status, message: err.message }
  const { status, message } = describeError(err)
  return { status, message }
}

/** Windows / POSIX 都不允许出现在目录名里的字符 */
const ILLEGAL_DIR_CHARS = /[\\/:*?"<>|]/

// ---------- 目录浏览(fs/dirs 路由与 list_dirs 工具共用) ----------

const MAX_ENTRIES = 2000

async function listRoots(): Promise<FsDirEntry[]> {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }]
  const roots: FsDirEntry[] = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    const isDir = await fs.stat(root).then((s) => s.isDirectory()).catch(() => false)
    if (isDir) roots.push({ name: `${letter}:`, path: root })
  }
  return roots
}

/** 列出服务端某目录下的子目录(空 path = 从用户主目录起),给文件夹选择器用 */
export async function listDirs(path?: string): Promise<FsDirsResult> {
  const raw = (path ?? '').trim()
  const target = raw ? resolve(raw) : homedir()

  const statTarget = await fs.stat(target).catch(() => null)
  if (!statTarget?.isDirectory()) throw new ProjectServiceError(404, `目录不存在:${target}`)
  const dirents = await fs.readdir(target, { withFileTypes: true }).catch(() => null)
  if (!dirents) throw new ProjectServiceError(403, `没有权限读取:${target}`)

  const entries: FsDirEntry[] = []
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    entries.push({ name: d.name, path: join(target, d.name) })
    if (entries.length >= MAX_ENTRIES) break
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const up = dirname(target)
  return {
    path: target,
    parent: up === target ? null : up,
    roots: await listRoots(),
    entries
  }
}

/** 在服务端某个目录下新建文件夹,返回新目录的绝对路径(名称校验与 fs/dirs 同一套) */
export async function mkdirIn(parent: string, name: string): Promise<string> {
  const trimmed = (name ?? '').trim()
  const reason = invalidNameReason(trimmed)
  if (reason) throw new ProjectServiceError(400, reason)

  const parentPath = resolve((parent ?? '').trim() || homedir())
  const parentStat = await fs.stat(parentPath).catch(() => null)
  if (!parentStat?.isDirectory()) throw new ProjectServiceError(404, `目录不存在:${parentPath}`)

  const target = join(parentPath, trimmed)
  const exists = await fs.stat(target).then(() => true).catch(() => false)
  if (exists) throw new ProjectServiceError(409, `已存在同名目录:${target}`)

  try {
    await fs.mkdir(target)
  } catch (err) {
    const { status, message } = describeError(err)
    throw new ProjectServiceError(status, `创建失败:${message}`)
  }
  return target
}

// ---------- 默认项目根 ----------

/**
 * 默认项目根:`FIZZ_PROJECTS_ROOT` 优先,缺省 `<数据目录>/projects`。
 *
 * 刻意**不做** mkdir:判定与展示都只要路径;真正要往里建目录时由
 * `createProject('new')` 兜底创建,避免一个 getter 带着磁盘副作用。
 */
export function getDefaultProjectsRoot(): string {
  return process.env.FIZZ_PROJECTS_ROOT?.trim() || join(resolveDataDir(), 'projects')
}

/** `path` 是否落在默认项目根之内(根内创建免审批的判定依据) */
export function isInsideProjectsRoot(path: string, root?: string): boolean {
  const base = root ?? getDefaultProjectsRoot()
  const norm = (p: string): string => {
    const r = resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  const p = norm(path)
  const normalized = norm(base)
  if (p === normalized) return true
  if (!p.startsWith(normalized)) return false
  const ch = p[normalized.length]
  return ch === '\\' || ch === '/'
}

// ---------- 项目创建(三种模式收口) ----------

export type CreateProjectInput =
  | { mode: 'existing'; path: string; name?: string }
  | { mode: 'new'; parentPath: string; name: string }
  | {
      mode: 'git'
      gitUrl: string
      parentPath: string
      name?: string
      /**
       * 取消信号：abort 时杀掉 git 进程树、删掉克隆了一半的目录，并以
       * 「克隆已取消」收场（不是故障）。只有 HTTP 路由会传；AI 工具那条没有取消通道。
       */
      signal?: AbortSignal
      /**
       * git 的逐行输出（进度 / 报错原文）。后台任务的日志就是靠它接住的；
       * AI 工具那条不传（没人看它跑的过程）。
       */
      onLog?: (line: string, level?: GitLogLevel) => void
    }

/** 校验过的克隆落点（`prepareGitClone` 的产物） */
export interface PreparedClone {
  url: string
  parentDir: string
  /** 目标目录名（Windows / POSIX 都不允许的字符已拦过） */
  dirName: string
  /** 完整目标路径 `parentDir/dirName` */
  destDir: string
  /** 用户显式给的目录名（同时也是项目展示名）；没给则 undefined */
  name?: string
}

/**
 * 克隆入参的校验 + 落点推导。
 *
 * **单独导出**是因为 HTTP 路由要在**建后台任务之前**先跑一遍：一眼就错的输入
 * （路径不是绝对路径、目标目录已存在、目录名非法）不该在状态栏的任务列表里留一条
 * 「失败的克隆」—— 那是表单错误，当场回 400 / 409 更直接。
 */
export function prepareGitClone(input: {
  gitUrl?: string
  parentPath?: string
  name?: string
}): PreparedClone {
  const url = input.gitUrl?.trim()
  const parentDir = input.parentPath?.trim()
  const name = input.name?.trim()
  if (!url || !parentDir) throw new ProjectServiceError(400, '缺少 git 地址或父目录')
  if (!isAbsolute(parentDir)) throw new ProjectServiceError(400, '克隆目标必须是绝对路径')

  // 目录名:用户没给就从 URL 推导(repoNameFromUrl 推不出会返回空串 → 拒绝)
  const dirName = name || repoNameFromUrl(url)
  if (!dirName) throw new ProjectServiceError(400, '无法从地址推导目录名,请手动填写')
  if (ILLEGAL_DIR_CHARS.test(dirName) || dirName === '.' || dirName === '..') {
    throw new ProjectServiceError(400, `目录名不合法:${dirName}`)
  }

  const destDir = resolve(parentDir, dirName)
  if (existsSync(destDir)) throw new ProjectServiceError(409, `目标目录已存在:${destDir}`)

  return { url, parentDir, dirName, destDir, ...(name ? { name } : {}) }
}

/**
 * 三种模式统一入口:登记既有目录 / 新建目录 / 从 Git 克隆。
 * 校验顺序与错误文案与原路由逐字对齐,前端与助手看到的行为一致。
 */
export async function createProject(input: CreateProjectInput): Promise<AgentWorkspace> {
  if (input.mode === 'existing') {
    const path = input.path?.trim()
    if (!path) throw new ProjectServiceError(400, '缺少项目路径')
    if (!isAbsolute(path)) throw new ProjectServiceError(400, '项目路径必须是绝对路径')
    // addWorkspace 自带「绝对路径 + 目录真实存在」校验与去重,直接交给它
    return domain.addWorkspace({
      path,
      ...(input.name?.trim() ? { name: input.name.trim() } : {})
    })
  }

  if (input.mode === 'new') {
    const parent = input.parentPath?.trim()
    const name = input.name?.trim()
    if (!parent || !name) throw new ProjectServiceError(400, '缺少父目录或名称')
    if (!isAbsolute(parent)) throw new ProjectServiceError(400, '父目录必须是绝对路径')
    // 默认根是刚配的环境变量 / 首次使用时还不存在:这里是唯一一个替它兜底创建的地方
    if (resolve(parent) === resolve(getDefaultProjectsRoot())) {
      await fs.mkdir(parent, { recursive: true }).catch(() => undefined)
    }
    const target = await mkdirIn(parent, name)
    return domain.addWorkspace({ path: target })
  }

  // mode === 'git'
  const prep = prepareGitClone(input)

  let result
  try {
    // cloneRepo 内部先过 assertSafeRepoUrl(拒 `-` 开头与换行),失败走下面的 catch
    result = await cloneRepo({
      url: prep.url,
      destDir: prep.destDir,
      ...(input.signal ? { signal: input.signal } : {}),
      // git 的进度 / 报错原文一路转成任务日志(后台任务面板里能展开看)
      ...(input.onLog ? { onLog: input.onLog } : {})
    })
  } catch (err) {
    // 用户取消不是故障:git 已被杀、半份目录已清,回一句「已取消」就够(别再甩 exit code)
    if (isCloneCanceled(err)) throw new ProjectServiceError(400, '克隆已取消')
    throw new ProjectServiceError(400, err instanceof Error ? err.message : String(err))
  }
  if (result.code !== 0) {
    /*
     * stderr 的**最后一行**未必是最有用的一行：git 的报错常常是多行，
     * `fatal: repository '…' does not exist` 后面还跟着
     * `Please make sure you have the correct access rights / and the repository exists.`，
     * 掐最后一行会得到一句没有主语的碎片。所以优先取最后的 `fatal:` / `error:` 行。
     * （完整输出已经逐行进任务日志了，这里只是给一句快递错误。）
     */
    const lines = result.stderr
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const fatal = [...lines].reverse().find((line) => /^(fatal|error)\s*:/i.test(line))
    const detail = fatal ?? lines[lines.length - 1] ?? `退出码 ${result.code}`
    throw new ProjectServiceError(502, `克隆失败:${detail}`)
  }

  return domain.addWorkspace({
    path: prep.destDir,
    ...(prep.name ? { name: prep.name } : {})
  })
}

// ---------- 项目删除(三道闸唯一化) ----------

export type RemoveProjectInput = { deleteWorktree?: boolean }

/**
 * 删除项目:**逐字搬自原 DELETE /api/workspaces/[id]** 的主体(三道闸语义不变)——
 * 1. 勾了删磁盘时,每个 worktree 项目过 dropWorktree 三道闸;
 * 2. 容器型项目先把容器停掉再删掉(见 `container-projects/purge.ts`),最后才摘记录。
 */
export async function removeProject(id: string, input?: RemoveProjectInput): Promise<AgentWorkspace[]> {
  const workspace = domain.getWorkspace(id)
  if (!workspace) throw new ProjectServiceError(404, '工作区不存在')

  const options = input ?? {}
  const subtree = domain.workspaceSubtree(id)

  // 1. 磁盘目录(只有勾了才动):子树里每个 worktree 项目各删一次
  if (options.deleteWorktree) {
    for (const ws of subtree) {
      if (!ws.isWorktree) continue
      const failure = await dropWorktree(ws)
      if (failure) throw new ProjectServiceError(failure.status, failure.message)
    }
    // 容器型项目的目录由系统分配(slug),用户平时看不到它——勾了删磁盘就是**真删**它。
    // 目录就在我们的固定根下、路径形状由 projectDirOf 自算,不存在越界删除的可能。
    for (const ws of subtree) {
      const slug = ws.container?.slug
      if (!slug) continue
      await fs.rm(projectDirOf(slug), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // 2. 容器型项目:先把容器停掉再删掉,最后才摘记录。
  //    记录摘了之后容器就再也管不着了(界面上看不见它,快照是按工作区遍历的),
  //    留着它只会变孤儿、还占着宿主端口映射。收尸逻辑在 `container-projects/purge.ts`
  //    (按名字 + label 双路径找容器,失败写应用日志,不挡这次删除 —— 记录不摘的话
  //    用户会卡在一个「删不掉的项目」上,docker 没启动时尤其常见;孤儿由启动清扫兜住)。
  for (const ws of subtree) {
    if (!ws.container?.slug) continue
    await purgeProjectContainers(ws.container.slug)
  }

  // 删项目会**级联**删掉它下面的会话。会话没了，它名下那些后台命令就再没有能显示它的
  // 容器了（面板按会话过滤），所以先发停止信号。与会话删除同一条口径：只发信号、
  // 不等收场，杀不掉的进程由任务体自己收尾。
  const doomedWorkspaces = new Set(subtree.map((ws) => ws.id))
  const doomedConversations = domain
    .listConversations()
    .filter((conversation) => doomedWorkspaces.has(conversation.workspaceId))
  for (const conversation of doomedConversations) stopSessionRunning(conversation.id)
  domain.deleteWorkspace(id)
  /*
   * 这些会话的浏览器 profile 一并删掉（口径同 `api/conversations/[id]/route.ts` 的 DELETE）。
   *
   * 删项目是**唯一能一次带走很多会话**的入口，漏在这里就一次攒下一整棵子树的孤儿
   * profile —— 每个都还带着 Cookie / 登录态。`purge` 自己吞异常，这里再 `allSettled`
   * 一层：单个 profile 删不掉（Windows 文件占用）不该让项目删除失败。
   *
   * 并行是安全的：每个会话一份独立目录，互不重叠。
   */
  await Promise.allSettled(
    doomedConversations.map((conversation) =>
      browserSessions.purge(agentBrowserSessionId(conversation.id), '会话已删除')
    )
  )
  return domain.listWorkspaces()
}

/** worktree 项目的目录容器(相对源项目目录):形状判定在 projects-pure 的 worktreeIdentifierOf */

/**
 * 删掉一个 worktree 项目的磁盘目录。返回非 null 表示拒绝执行,值就是要回给用户的话。
 *
 * 三道闸门缺一不可 —— 这一旦被当成任意 `rm -rf` 入口就完了:
 *  1. 目标必须是 worktree 项目,且父项目还在(父没了就无从判断该在哪个仓库里 remove);
 *  2. 路径必须严格等于 `<父项目>/.worktree/<标识>`(老数据 `parentWorkspaceId` 缺失时
 *     按目录约定回退推断,与侧栏 `worktreeParentId` 同一套推断);
 *  3. 目录必须在磁盘上确实存在,否则告诉用户「已经没了」而不是假装成功。
 */
async function dropWorktree(
  workspace: AgentWorkspace
): Promise<{ status: 400 | 404 | 500; message: string } | null> {
  if (!workspace.isWorktree) {
    return { status: 400, message: '只有 worktree 项目才能删除磁盘目录' }
  }

  const parent = workspace.parentWorkspaceId
    ? domain.getWorkspace(workspace.parentWorkspaceId)
    : inferParent(workspace.path)
  if (!parent) {
    return { status: 400, message: '找不到这个 worktree 的源项目,无法安全删除目录' }
  }

  const identifier = worktreeIdentifierOf(workspace.path, parent.path)
  const expected = join(resolve(parent.path), WORKTREE_DIR, identifier ?? '')
  if (!identifier || resolve(workspace.path) !== expected) {
    return {
      status: 400,
      message: `只允许删除 ${join(resolve(parent.path), WORKTREE_DIR, '<标识>')} 下的目录`
    }
  }

  const exists = await stat(workspace.path).then(() => true).catch(() => false)
  if (!exists) return { status: 404, message: `目录已不存在:${workspace.path}` }

  try {
    // 父项目目录本身就是仓库根时用它;解析失败(比如 git 不可用)退回父目录,
    // removeWorktree 的兜底分支照样能把目录删掉
    const repoPath = await resolveRepoRoot(parent.path).catch(() => parent.path)
    await removeWorktree({ repoPath, worktreePath: workspace.path })
  } catch (err) {
    const { message } = describeError(err)
    return { status: 500, message: `删除 worktree 目录失败:${message}` }
  }

  // removeWorktree 不抛错(失败会退化成手动删目录),所以只能回头看一眼目录还在不在
  const stillThere = await stat(workspace.path).then(() => true).catch(() => false)
  if (stillThere) {
    return { status: 500, message: `删除 worktree 目录失败:${workspace.path} 仍然存在` }
  }
  return null
}

/** worktree 项目在列表里少了 `parentWorkspaceId` 时的回退:按 `<父目录>/.worktree/<标识>` 约定推断 */
function inferParent(worktreePath: string) {
  const parentPath = resolve(worktreePath, '..', '..')
  return domain.listWorkspaces().find((ws) => resolve(ws.path) === parentPath)
}

// ---------- worktree 创建(与 worktree 路由同一套校验) ----------

/**
 * 在某个项目下新建 git worktree(建目录 + 建分支)并登记成新项目。
 * **逐字搬自原 POST /api/workspaces/[id]/worktree** 的主体,路由与 AI 工具共用。
 */
export async function createWorktree(workspaceId: string, input: WorktreeInput): Promise<AgentWorkspace> {
  const workspace = domain.getWorkspace(workspaceId)
  if (!workspace) throw new ProjectServiceError(404, '工作区不存在')

  const identifier = input.identifier?.trim() ?? ''
  if (!WORKTREE_IDENTIFIER_RE.test(identifier)) {
    throw new ProjectServiceError(400, 'worktree 标识只能包含字母、数字、-、_、.,且要以字母或数字开头')
  }

  try {
    const repoPath = await resolveRepoRoot(workspace.path).catch(() => null)
    if (!repoPath) {
      throw new ProjectServiceError(400, `${workspace.name} 不是一个 git 仓库(worktree 需要 git 托管)`)
    }
    if (!(await hasCommits(repoPath))) {
      throw new ProjectServiceError(400, `${workspace.name} 的仓库还没有任何提交,建不了 worktree。先在项目里提交一次再试。`)
    }

    const worktreePath = join(workspace.path, WORKTREE_DIR, identifier)
    if (await stat(worktreePath).then(() => true).catch(() => false)) {
      throw new ProjectServiceError(400, `目标目录已存在:${worktreePath}`)
    }

    const baseBranch = input.baseBranch?.trim() ?? ''
    if (baseBranch && !(await refExists(repoPath, baseBranch))) {
      throw new ProjectServiceError(400, `基线分支不存在:${baseBranch}`)
    }

    const branch = `worktree/${identifier}`
    if (await refExists(repoPath, branch)) {
      throw new ProjectServiceError(400, `分支 ${branch} 已存在,换一个 worktree 标识再试`)
    }

    // 先忽略 `.worktree/`:它是源仓库里的新目录,不忽略会在源项目的 git 面板里冒出来
    await ensureWorktreesIgnored(repoPath, `${WORKTREE_DIR}/`)
    await fs.mkdir(resolve(worktreePath, '..'), { recursive: true })
    await addWorktree({ repoPath, worktreePath, branch, baseRef: baseBranch })

    // 登记成新项目;名字默认取标识(用户可选填项目名)
    return await domain.addWorkspace({
      path: worktreePath,
      name: input.name?.trim() || identifier,
      isWorktree: true,
      parentWorkspaceId: workspace.id
    })
  } catch (err) {
    if (err instanceof ProjectServiceError) throw err
    const { status, message } = describeError(err)
    throw new ProjectServiceError(status, message)
  }
}
