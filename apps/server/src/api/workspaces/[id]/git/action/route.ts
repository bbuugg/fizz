/**
 * 源代码管理（git）：写操作（暂存/取消暂存/提交/检出/推送/初始化/回滚/删分支等）。
 * POST /api/workspaces/:id/git/action (body: GitActionInput)
 *
 * 四条约束（与原路由一致）：
 * 1. 只操作工作区指向的仓库
 * 2. 不做 force push、不做 reset --hard
 * 3. GIT_TERMINAL_PROMPT=0：需要凭据的推送立刻失败
 * 4. 破坏性动作（回滚、删分支）服务端只负责把 git 的原话带回，**不做二次确认** ——
 *    确认是界面的事（用户在面板上点的），服务端再问一遍只会让接口没法给脚本 / 外部调用用。
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  COMMIT_IDENTITY,
  commitAll,
  git,
  type GitActionInput,
  type GitRun
} from '@fizz/git'
import { workspaceRepoRoot } from '@/lib/workspace-repo'
import { domain } from '@/lib/server/state'
import { remoteUnsupported } from '@/lib/server/remote-guard'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

function invalidRelPath(p: string): string | null {
  if (!p) return '路径不能为空'
  if (p.startsWith('-')) return `非法路径：${p}`
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p)) return '只能操作仓库内的相对路径'
  if (p.split(/[\\/]/).includes('..')) return '路径不能越出仓库（含 ..）'
  return null
}

function outputOf(res: GitRun): string {
  return (res.stderr || res.stdout).trim()
}

/**
 * 把路径列表按命令行长度切成块：几千个文件时把所有路径塞进**一条** git 命令会撞上
 * 系统命令行长度上限（Windows ~32K 字符）。每块 ≤`maxCount` 个路径且 ≤`maxChars` 字符，
 * 两个都取保守值，给 git 自己的参数留余量。
 */
function chunkPaths(paths: string[], maxCount = 200, maxChars = 8000): string[][] {
  const chunks: string[][] = []
  let cur: string[] = []
  let chars = 0
  for (const p of paths) {
    if (cur.length >= maxCount || (cur.length > 0 && chars + p.length + 1 > maxChars)) {
      chunks.push(cur)
      cur = []
      chars = 0
    }
    cur.push(p)
    chars += p.length + 1
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

async function isTracked(root: string, path: string): Promise<boolean> {
  const res = await git(root, ['ls-files', '--error-unmatch', '--', path])
  return res.ok
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const workspace = domain.getWorkspace(id)
  if (!workspace) return jsonError(404, '工作区不存在')
  const denied = remoteUnsupported(workspace, 'Git 面板')
  if (denied) return denied

  const body = await parseJsonBody<GitActionInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  // 初始化是唯一「还不是仓库也要能跑」的动作
  if (body.action === 'init' || body.action === 'init-commit') {
    if (!workspace.path) return jsonError(400, '这个工作区没有目录，无法初始化 git 仓库')
    // 用 workspaceRepoRoot 而不是 repoRoot：临时工作区落在别人仓库的子目录里时，
    // 「已经是仓库了」这个判断会让它永远 init 不了（见 lib/workspace-repo.ts）
    if (body.action === 'init-commit' && (await workspaceRepoRoot(workspace))) {
      return jsonError(400, '这个工作区已经是 git 仓库了')
    }
    const res = await git(workspace.path, ['init'])
    if (!res.ok) return jsonError(500, res.stderr || 'git init 失败')
    if (body.action === 'init') return Response.json({ output: outputOf(res) })

    const commitMessage = (body.message ?? '').trim() || '初始化仓库'
    let committed: Awaited<ReturnType<typeof commitAll>>
    try {
      committed = await commitAll({
        worktreePath: workspace.path,
        message: commitMessage
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return jsonError(
        500,
        `仓库已初始化，但首次提交失败：${detail}（你可以先修掉这个原因，再重试创建任务）`
      )
    }
    if (!committed) {
      const empty = await git(workspace.path, [
        '-c', `user.name=${COMMIT_IDENTITY['user.name']}`,
        '-c', `user.email=${COMMIT_IDENTITY['user.email']}`,
        'commit', '--allow-empty', '-m', commitMessage
      ])
      if (!empty.ok) {
        return jsonError(500, `仓库已初始化，但首次提交失败：${empty.stderr || 'git commit 失败'}`)
      }
    }
    const output = [
      outputOf(res).trim(),
      committed
        ? `已提交 ${committed.changedFiles} 个文件（${committed.commit.slice(0, 8)}）`
        : '目录里没有可提交的内容，已创建一个空提交作为起点'
    ].filter(Boolean).join('\n')
    return Response.json({ output })
  }

  const root = await workspaceRepoRoot(workspace)
  if (!root) return jsonError(400, '这个工作区不是 git 仓库（也可能这台机器上没装 git）')

  switch (body.action) {
    case 'stage': {
      const paths = body.paths ?? []
      if (!paths.length) return jsonError(400, '没有要暂存的文件')
      const bad = paths.map(invalidRelPath).find(Boolean)
      if (bad) return jsonError(400, bad)
      const res = await git(root, ['add', '--', ...paths])
      if (!res.ok) return jsonError(500, res.stderr || 'git add 失败')
      return Response.json({ output: '' })
    }

    case 'unstage': {
      const paths = body.paths ?? []
      if (!paths.length) return jsonError(400, '没有要取消暂存的文件')
      const bad = paths.map(invalidRelPath).find(Boolean)
      if (bad) return jsonError(400, bad)
      let res = await git(root, ['restore', '--staged', '--', ...paths])
      if (!res.ok) res = await git(root, ['reset', 'HEAD', '--', ...paths])
      if (!res.ok) res = await git(root, ['rm', '--cached', '-r', '--', ...paths])
      if (!res.ok) return jsonError(500, res.stderr || '取消暂存失败')
      return Response.json({ output: '' })
    }

    case 'commit': {
      const message = (body.message ?? '').trim()
      if (!message) return jsonError(400, '提交信息不能为空')
      const res = await git(root, ['commit', '-m', message])
      if (!res.ok) return jsonError(500, res.stderr || 'git commit 失败')
      return Response.json({ output: res.stdout.trim() })
    }

    case 'checkout': {
      const ref = (body.ref ?? '').trim()
      if (!ref || ref.startsWith('-')) return jsonError(400, '缺少要检出的分支 / 提交')
      if (ref.startsWith('(')) return jsonError(400, `${ref} 不是一个可检出的分支`)
      const exists = (full: string) => git(root, ['show-ref', '--verify', '--quiet', full])

      // 1) 本地分支：直接切（最常见的路径）
      if ((await exists(`refs/heads/${ref}`)).ok) {
        const res = await git(root, ['checkout', ref])
        if (!res.ok) return jsonError(500, res.stderr || 'git checkout 失败')
        return Response.json({ output: outputOf(res) })
      }

      /*
       * 2) 远端跟踪分支（面板列表给的是 `origin/main` 这种短名）。
       *
       * ⚠️ 这里**不能** `checkout --detach`：那是「看一眼某个提交」的语义，而用户点一条
       * 分支是想**在这条分支上干活**。分离头指针下后续提交会变成游离提交（一换分支就
       * 只能靠 reflog 捞回来），面板上的推送 / 拉取也全被 `status.detached` 禁掉 ——
       * 用户点了「切换分支」却发现自己不在任何分支上，就是这里造成的。
       *
       * 按 git 自己的 DWIM 走：落一个同名本地分支并跟踪该远端分支
       * （`git checkout --track origin/main` 等价于 `-b main --track origin/main`）。
       */
      const remoteRef = `refs/remotes/${ref}`
      if ((await exists(remoteRef)).ok) {
        const remotes = (await git(root, ['remote'])).stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
        // 远端名本身可能带 `/`（少见但合法），所以取**最长**匹配的那个前缀，
        // 不能像界面那样按第一个 `/` 硬拆
        const owner = remotes
          .filter((r) => ref.startsWith(`${r}/`))
          .sort((a, b) => b.length - a.length)[0]
        const local = owner ? ref.slice(owner.length + 1) : ref.slice(ref.indexOf('/') + 1)
        if (!local) return jsonError(400, `${ref} 不是一个可检出的分支`)

        // 本地已有同名分支（`origin/main` → `main`）：切过去就行，不重复建
        const target = (await exists(`refs/heads/${local}`)).ok ? local : null
        const res = target
          ? await git(root, ['checkout', target])
          : await git(root, ['checkout', '-b', local, '--track', remoteRef])
        if (!res.ok) return jsonError(500, res.stderr || 'git checkout 失败')
        return Response.json({ output: outputOf(res) })
      }

      // 3) 其余（提交 hash / tag）：检出具体提交本来就该是分离头指针
      const res = await git(root, ['checkout', '--detach', ref])
      if (!res.ok) return jsonError(500, res.stderr || 'git checkout 失败')
      return Response.json({ output: outputOf(res) })
    }

    case 'create-branch': {
      const name = (body.name ?? '').trim()
      if (!name) return jsonError(400, '分支名不能为空')
      if (name.startsWith('-') || /\s/.test(name)) return jsonError(400, `分支名不合法：${name}`)
      const from = (body.from ?? '').trim()
      if (from.startsWith('-')) return jsonError(400, `起点不合法：${from}`)
      const exists = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
      if (exists.ok) return jsonError(400, `分支 ${name} 已经存在`)
      const res = await git(root, from ? ['checkout', '-b', name, from] : ['checkout', '-b', name])
      if (!res.ok) return jsonError(400, res.stderr || '新建分支失败')
      return Response.json({ output: outputOf(res) })
    }

    case 'delete-branch': {
      const name = (body.name ?? '').trim()
      if (!name) return jsonError(400, '分支名不能为空')
      // 与 create-branch 同一套校验：分支名不允许以 - 开头（会被 git 当选项）、也不允许空格
      if (name.startsWith('-') || /\s/.test(name)) return jsonError(400, `分支名不合法：${name}`)
      const exists = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
      if (!exists.ok) return jsonError(400, `本地分支 ${name} 不存在`)
      // 当前分支 git 一定不让删（main worktree 或别的 worktree 占着），自己先判一句人话 ——
      // git 的原话是 "cannot delete branch 'x' used by worktree at ..."，看不出是被谁占
      const current = await git(root, ['branch', '--show-current'])
      if (current.stdout.trim() === name) {
        return jsonError(400, '不能删除当前所在的分支：先切到别的分支再删')
      }
      const res = await git(root, body.force
        ? ['branch', '--delete', '--force', name]
        : ['branch', '--delete', name])
      if (!res.ok) {
        // git 2.5x 的文案是 "error: the branch 'x' is not fully merged."（早期版本大写 T），
        // 后一行是 "If you are sure you want to delete it, run 'git branch -D x'"。
        // 翻成面板上的操作 —— 光把原话丢给前端，用户不知道还有个勾选项能继续
        if (/not fully merged/i.test(res.stderr)) {
          return jsonError(400, `分支 ${name} 还没合并到任何其它分支：勾上「强制删除」才会删（未合并的提交删完只剩 reflog 能找回）`)
        }
        return jsonError(400, res.stderr || `删除分支 ${name} 失败`)
      }
      // 成功时 git 的 stdout 是 "Deleted branch x (was 411ea6d)."，把 hash 带回去：
      // 强制删掉的未合并分支只有 reflog 能找回，得告诉用户按哪个 commit 找
      const sha = /was ([0-9a-f]{7,})/.exec(res.stdout)?.[1]
      return Response.json({
        output: `已删除本地分支 ${name}${sha ? `（${sha.slice(0, 8)}，需要时可用 reflog 找回）` : ''}`
      })
    }

    case 'delete-remote-branch': {
      const remote = (body.remote ?? '').trim()
      const branch = (body.branch ?? '').trim()
      if (!remote) return jsonError(400, '远端名不能为空')
      if (remote.startsWith('-') || /\s/.test(remote)) return jsonError(400, `远端名不合法：${remote}`)
      if (!branch) return jsonError(400, '分支名不能为空')
      if (branch.startsWith('-') || /\s/.test(branch)) return jsonError(400, `分支名不合法：${branch}`)
      const remotes = (await git(root, ['remote'])).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean)
      if (!remotes.includes(remote)) {
        return jsonError(400, `远端 ${remote} 不存在（已配置：${remotes.join('、') || '无'}）`)
      }
      // 先问远端一次：这个分支还在不在。
      // `git push --delete` 在「远端已经没有这个分支」时报 "remote ref does not exist" 并返回非 0 ——
      // 典型场景是分支在 GitHub 界面 / 别的客户端已删，本地的 refs/remotes/<remote>/<branch> 还是陈的，
      // 用户看到列表就点删除，于是撞上一条看起来像失败、其实目标早已不存在的报错。
      // 探测用 ls-remote（只读、不改任何 ref），拿不到远端状态时（离线 / 鉴权失败）才退回 push 的原话。
      const probe = await git(root, ['ls-remote', '--heads', remote, branch])
      if (!probe.ok) {
        return jsonError(502, probe.stderr || `连不上远端 ${remote}，无法确认分支是否存在`)
      }
      const existsRemotely = probe.stdout.trim().length > 0
      if (!existsRemotely) {
        // 远端已无此分支：把本地那条陈旧的远端跟踪 ref 顺手抹掉，让列表立刻一致
        await git(root, ['update-ref', '-d', `refs/remotes/${remote}/${branch}`])
        return Response.json({ output: `远端 ${remote} 上已经没有 ${branch} 了（顺手清掉了本地残留的远端跟踪分支）` })
      }
      // 这就是一次 force push（远端 ref 被推空），但它是用户显式要求的删除，不是顺手带上的
      const res = await git(root, ['push', remote, '--delete', branch])
      if (!res.ok) {
        // 竞态：探测之后、push 之前分支被别人删了。同一个目标已经达成，按成功回。
        if (/remote ref does not exist/i.test(res.stderr)) {
          await git(root, ['update-ref', '-d', `refs/remotes/${remote}/${branch}`])
          return Response.json({ output: `远端 ${remote} 上的 ${branch} 已不存在，视为已删除` })
        }
        return jsonError(500, res.stderr || res.stdout || '删除远端分支失败')
      }
      return Response.json({ output: `已删除远端分支 ${remote}/${branch}` })
    }

    case 'rollback': {
      const path = (body.path ?? '').trim()
      const bad = invalidRelPath(path)
      if (bad) return jsonError(400, bad)
      const mode = body.mode === 'all' ? 'all' : 'worktree'

      if (mode === 'worktree') {
        if (!(await isTracked(root, path))) {
          const abs = join(root, path)
          const stat = await fs.stat(abs).catch(() => null)
          if (!stat) return jsonError(404, '文件不存在')
          if (!stat.isFile()) return jsonError(400, '只能回退普通文件')
          await fs.rm(abs)
          return Response.json({ output: `已删除未跟踪文件 ${path}` })
        }
        const res = await git(root, ['restore', '--worktree', '--', path])
        if (!res.ok) return jsonError(400, res.stderr || `回退 ${path} 失败`)
        return Response.json({ output: `已丢弃 ${path} 未暂存的改动` })
      }

      const res = await git(root, ['restore', '--staged', '--worktree', '--', path])
      if (res.ok) return Response.json({ output: `已把 ${path} 回退到上次提交` })
      const unstage = await git(root, ['rm', '--cached', '-r', '--', path])
      if (!unstage.ok) return jsonError(400, res.stderr || `回退 ${path} 失败`)
      return Response.json({
        output: `仓库还没有提交，已取消暂存（文件内容保留）：${path}`
      })
    }

    case 'rollback-all': {
      const paths = body.paths ?? []
      if (!paths.length) return jsonError(400, '没有要回滚的文件')
      const bad = paths.map(invalidRelPath).find(Boolean)
      if (bad) return jsonError(400, bad)
      // 与单文件回滚同一套语义：worktree = 只丢工作区那份（已暂存的留着），all = 连索引一起回到 HEAD
      const mode = body.mode === 'worktree' ? 'worktree' : 'all'

      // 几千个文件时把所有路径塞进一条命令会撞上系统命令长度上限（Windows ~32K 字符），
      // ls-files / restore / rm --cached 一律分块跑
      const chunks = chunkPaths(paths)
      const tracked: string[] = []
      const untracked: string[] = []
      for (const chunk of chunks) {
        const listed = (await git(root, ['ls-files', '-z', '--', ...chunk])).stdout
          .split('\0').filter(Boolean)
        const trackedSet = new Set(listed)
        for (const p of chunk) (trackedSet.has(p) ? tracked : untracked).push(p)
      }

      const parts: string[] = []
      let restored = 0
      let unstaged = 0
      for (const chunk of chunkPaths(tracked)) {
        const res = await git(root, [
          'restore',
          ...(mode === 'all' ? ['--staged'] : []),
          '--worktree', '--', ...chunk
        ])
        if (res.ok) {
          restored += chunk.length
          continue
        }
        if (mode !== 'all') return jsonError(400, res.stderr || '回滚失败')
        // unborn HEAD（仓库还没有提交）：回落成只取消暂存、内容保留
        const unstage = await git(root, ['rm', '--cached', '-r', '--', ...chunk])
        if (!unstage.ok) return jsonError(400, res.stderr || '回滚失败')
        unstaged += chunk.length
      }
      if (restored) {
        parts.push(
          mode === 'all'
            ? `已回滚 ${restored} 个已跟踪文件`
            : `已丢弃 ${restored} 个文件未暂存的改动`
        )
      }
      if (unstaged) parts.push(`仓库还没有提交：已取消暂存 ${unstaged} 个文件（内容保留）`)

      let removed = 0
      for (const path of untracked) {
        const abs = join(root, path)
        const stat = await fs.stat(abs).catch(() => null)
        if (!stat?.isFile()) continue
        await fs.rm(abs)
        removed++
      }
      if (removed) parts.push(`删除了 ${removed} 个未跟踪文件`)

      return Response.json({ output: parts.join('，') || '没有可回滚的内容' })
    }

    case 'rollback-dir': {
      const path = (body.path ?? '').trim()
      const bad = invalidRelPath(path)
      if (bad) return jsonError(400, bad)
      const mode = body.mode === 'worktree' ? 'worktree' : 'all'
      const stat = await fs.stat(join(root, path)).catch(() => null)
      if (!stat?.isDirectory()) return jsonError(404, '目录不存在')

      // 目录本身作为 pathspec 交给 git（递归整棵子树），**不枚举文件**：
      // 几千个文件时把每个路径塞进命令行会撞上系统命令长度上限（Windows ~32K 字符）
      const parts: string[] = []

      // 未跟踪的文件 / 目录先清（git clean -fd，不碰 ignored）。必须赶在 unborn 回落的
      // 「取消暂存」之前：取消暂存后那些文件会变成未跟踪，再 clean 就把内容误删了。
      // 数量用 ls-files --others 现算（clean 的输出措辞跟 locale 走，数它不可靠）
      const others = await git(root, ['ls-files', '--others', '-z', '--', path])
      const untrackedCount = others.ok ? others.stdout.split('\0').filter(Boolean).length : 0
      const clean = await git(root, ['clean', '-fd', '--', path])
      if (!clean.ok) return jsonError(400, clean.stderr || `清理 ${path} 里的未跟踪文件失败`)
      if (untrackedCount) parts.push(`删除了 ${untrackedCount} 个未跟踪文件`)

      // 已跟踪文件：目录下没有被 git 跟踪的文件就跳过 restore（pathspec 匹配不到会报错）
      const tracked = await git(root, ['ls-files', '-z', '--', path])
      if (tracked.ok && tracked.stdout) {
        if (mode === 'worktree') {
          const res = await git(root, ['restore', '--worktree', '--', path])
          if (!res.ok) return jsonError(400, res.stderr || `回滚 ${path} 失败`)
          parts.push(`已丢弃 ${path} 里未暂存的改动`)
        } else {
          const res = await git(root, ['restore', '--staged', '--worktree', '--', path])
          if (res.ok) {
            parts.push(`已把 ${path} 里的改动回退到上次提交`)
          } else {
            // unborn HEAD（仓库还没有提交）：回落成只取消暂存、内容保留（内容此时在磁盘上）
            const unstage = await git(root, ['rm', '--cached', '-r', '--', path])
            if (!unstage.ok) return jsonError(400, res.stderr || `回滚 ${path} 失败`)
            parts.push(`仓库还没有提交：已取消暂存 ${path} 里的文件（内容保留）`)
          }
        }
      }

      return Response.json({ output: parts.join('，') || `${path} 里没有可回滚的内容` })
    }

    case 'set-remote': {
      const name = (body.name ?? '').trim()
      const url = (body.url ?? '').trim()
      if (!name) return jsonError(400, '远端名不能为空')
      if (name.startsWith('-') || /\s/.test(name)) return jsonError(400, `远端名不合法：${name}`)
      if (!url) return jsonError(400, '远端地址不能为空')
      if (url.startsWith('-')) return jsonError(400, `远端地址不合法：${url}`)
      const names = (await git(root, ['remote'])).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean)
      const res = names.includes(name)
        ? await git(root, ['remote', 'set-url', name, url])
        : await git(root, ['remote', 'add', name, url])
      if (!res.ok) return jsonError(400, res.stderr || '设置远端失败')
      return Response.json({
        output: names.includes(name) ? `已更新远端 ${name}` : `已添加远端 ${name}`
      })
    }

    case 'remove-remote': {
      const name = (body.name ?? '').trim()
      if (!name) return jsonError(400, '远端名不能为空')
      if (name.startsWith('-') || /\s/.test(name)) return jsonError(400, `远端名不合法：${name}`)
      const names = (await git(root, ['remote'])).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean)
      if (!names.includes(name)) return jsonError(404, `没有这个远端：${name}`)
      const res = await git(root, ['remote', 'remove', name])
      if (!res.ok) return jsonError(400, res.stderr || '删除远端失败')
      return Response.json({ output: `已删除远端 ${name}` })
    }

    case 'push': {
      const current = await git(root, ['branch', '--show-current'])
      const branch = current.stdout.trim()
      if (!branch) return jsonError(400, '处于分离头指针：先切回一个分支再推送')
      const remotes = (await git(root, ['remote'])).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean)
      // 界面上「推送到…」挑的远端；没挑就按上游那条老路走
      const chosen = (body.remote ?? '').trim()
      if (chosen && !remotes.includes(chosen)) return jsonError(400, `没有这个远端：${chosen}`)
      const upstream = await git(root, [
        'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'
      ])
      const hasUpstream = upstream.ok && upstream.stdout.trim().length > 0
      /**
       * 目标远端：显式指定 > 上游 > `origin` > **现有的第一个远端**。
       *
       * ⚠️ 以前这里第三档写死 `origin`：远端叫 `upstream` / `github` 的仓库（`git clone -o`、
       * 或手动 `remote add` 加的）明明配了远端，推送却回「这个仓库还没有 origin 远端」，
       * 把人指去再配一个 —— 面板状态里有远端、所以前台不会走「管理远端」，看起来就是
       * 「明明有远端却让我设置远端」。远端一个都没有时才是真该去配。
       */
      if (!hasUpstream && !chosen && remotes.length === 0) {
        return jsonError(
          400,
          '这个仓库还没有配置任何远端：在面板右上角「更多」→「管理远端」里加一个就行（终端里 git remote add origin <url> 也可以）'
        )
      }
      const target = chosen || (hasUpstream ? '' : remotes.includes('origin') ? 'origin' : remotes[0])
      const args = hasUpstream
        ? chosen
          ? ['push', chosen, branch]
          : ['push']
        : ['push', '--set-upstream', target, branch]
      const res = await git(root, args)
      if (!res.ok) return jsonError(500, res.stderr || 'git push 失败')
      return Response.json({ output: outputOf(res) })
    }

    case 'pull': {
      const current = await git(root, ['branch', '--show-current'])
      const branch = current.stdout.trim()
      if (!branch) return jsonError(400, '处于分离头指针：先切回一个分支再拉取')
      const upstream = await git(root, [
        'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'
      ])
      if (!upstream.ok || !upstream.stdout.trim()) {
        return jsonError(
          400,
          `当前分支「${branch}」还没有设置上游（upstream）：先推送一次（面板上的「推送」按钮）设好上游，或在终端里跑 git push --set-upstream origin ${branch}`
        )
      }
      const res = await git(root, ['pull'])
      if (!res.ok) {
        const detail = res.stderr || res.stdout || 'git pull 失败'
        // 冲突时 git pull 的退出码是 1，stderr 里会有冲突文件列表；这里把原话带给前端
        return jsonError(500, detail)
      }
      return Response.json({ output: outputOf(res) })
    }

    case 'stash-push': {
      const message = (body.message ?? '').trim()
      const args = ['stash', 'push']
      if (body.includeUntracked) args.push('--include-untracked')
      if (message) {
        // `-m` 的值以 `-` 开头会被 git 当成选项
        if (message.startsWith('-')) return jsonError(400, '贮藏说明不能以 - 开头')
        args.push('-m', message)
      }
      const res = await git(root, args)
      if (!res.ok) return jsonError(400, res.stderr || '贮藏失败')
      return Response.json({ output: outputOf(res) || '已贮藏当前改动' })
    }

    case 'stash-pop':
    case 'stash-apply':
    case 'stash-drop': {
      const ref = (body.ref ?? '').trim()
      // ref 是拼进命令行的，只认 `stash@{n}` 这一种形状，别让它变成任意参数
      if (ref && !/^stash@\{\d+\}$/.test(ref)) return jsonError(400, `贮藏引用不合法：${ref}`)
      const sub = body.action === 'stash-pop' ? 'pop' : body.action === 'stash-apply' ? 'apply' : 'drop'
      const res = await git(root, ['stash', sub, ...(ref ? [ref] : [])])
      // ⚠️ 报错用 `outputOf`（stderr 优先、退回 stdout）而不是只看 stderr：
      // `stash pop` 撞上冲突时退出码是 1，而「哪个文件冲突、stash 还留着」这些全在 stdout 上
      if (!res.ok) return jsonError(400, outputOf(res) || `git stash ${sub} 失败`)
      return Response.json({ output: outputOf(res) })
    }

    default:
      return jsonError(400, '不支持的操作')
  }
}
