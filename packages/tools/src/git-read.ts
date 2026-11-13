/**
 * `git_read`：给 agent 的**只读 git 视图**。
 *
 * 为什么单独做一个窄工具，而不是让 agent 用 `bash` 跑 git：
 * - `bash` 既能读也能写；「只读 agent 带 bash」是个假承诺
 *   （`rm` / `git checkout .` / `git reset --hard` 都能毁东西）；
 * - 白名单式的窄接口把危险面压到「四条只读命令」，且天然免疫 `-i` / `-p` 这类
 *   会挂死的交互参数；
 * - 输出统一走 `clipToBudget`，一条 `git diff` 不会把上下文炸掉。
 *
 * ⚠️ 这里**刻意不给** checkout / add / commit / reset / push / stash：写仓库的活
 * 留给父 agent 的 bash（那里有审批链路）。真要做写操作窄工具时，
 * 也要照审批的规矩来，不能因为「git 命令而已」就绕过 requestConfirm。
 */
import { relative } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { git, repoRoot } from '@fizz/git'
import { resolveInside } from '@fizz/contracts/workspace'
import { clipToBudget, MAX_TOOL_RESULT_CHARS } from './output-log'
import { tr } from '@fizz/i18n'

/**
 * git ref（提交 / 分支 / tag）的允许形状。
 *
 * 第一条「不能以 `-` 开头」是防 flag 注入：ref 会原样进 `git diff <ref>`，
 * 放开的话 `--upload-pack=curl …` 这种就能变成一个参数塞进去。
 * 允许 `^` / `~` / `/`（`HEAD~2`、`origin/main`、`v1.0^2`）。空格直接拒 —— 命令
 * 走参数数组、不存在 shell 拼接，但空格里塞别的东西对只读视图没有正当用途。
 */
const REF_RE = /^[A-Za-z0-9._/^~{}()[\]@,-]+$/

/** log 的最大条数：agent 真的很少需要更多，且每条的 relate 都要占上下文 */
const MAX_LOG_ENTRIES = 50

export function buildGitReadTool(root: string): ToolSet {
  return {
    git_read: tool({
      description: tr(
        '只读地看这个 git 仓库：当前改动（git status / git diff）、最近的提交历史（git log）、某个提交的内容（git show）。' +
          '适合「改了什么」「最近谁动过这里」「这个提交干了什么」这类问题。' +
          '只能看，不能改仓库（要提交 / 回滚 / 切分支请用 bash，那边有审批）。',
        'Read-only view of this git repository: current changes (git status / git diff), recent history (git log), and a specific commit (git show). ' +
          'Suitable for questions like “what changed”, “who touched this recently”, or “what did this commit do”. ' +
          'Read-only: use bash for commit / rollback / branch switching (that path has approval).'
      ),
      inputSchema: z.object({
        action: z
          .enum(['status', 'diff', 'log', 'show'])
          .describe(tr('status=当前改动清单；diff=改动内容；log=提交历史；show=某个提交的内容', 'status=current changes; diff=change contents; log=commit history; show=contents of a commit')),
        ref: z
          .string()
          .optional()
          .describe(tr('提交 / 分支 / tag，如 HEAD、HEAD~1、main、abc1234。diff 表示与谁比，show 表示看哪个提交', 'Commit / branch / tag, e.g. HEAD, HEAD~1, main, abc1234. For diff it is the comparison base; for show the commit to display')),
        path: z.string().optional().describe(tr('只看某个文件 / 目录（相对工作区根）', 'Limit to a file / directory (relative to the workspace root)')),
        stat: z.boolean().optional().describe(tr('diff/show 只要「改了哪些文件 + 增删行数」，不要完整内容', 'For diff/show return only changed files and added/deleted line counts, not full contents')),
        limit: z.number().optional().describe(tr(`log 的条数，默认 20，最大 ${MAX_LOG_ENTRIES}`, `Number of log entries; default 20, max ${MAX_LOG_ENTRIES}`))
      }),
      execute: async ({ action, ref, path, stat = false, limit = 20 }) => {
        // 1. 边界：先确认工作区在不在 git 仓库里，不在就直说，别让后面的报错难懂
        const repo = await repoRoot(root).catch(() => null)
        if (!repo) {
          return '当前目录不是一个 git 仓库（也读不到 .git）。如果是未初始化的项目，请让用户先 git init。'
        }

        // 2. ref 校验（防 flag 注入）
        if (ref !== undefined) {
          if (ref !== '' && (ref.startsWith('-') || /\s/.test(ref) || !REF_RE.test(ref))) {
            return `ref 不合法：${ref}\n（允许提交 / 分支 / tag，如 HEAD、HEAD~1、main、abc1234；不能以 - 开头、不能带空格）`
          }
        }

        // 3. path 校验：越界直接拒，与其它文件工具同一道闸
        let gitPath: string | undefined
        if (path) {
          const abs = resolveInside(root, path)
          // 工作区可能是仓库的子目录：把绝对路径换算成相对 repo root 的形式
          gitPath = relative(repo, abs).replace(/\\/g, '/') || '.'
          if (gitPath.startsWith('..')) {
            return `path 超出了 git 仓库范围：${path}（工作区在此仓库的子目录之外）`
          }
        }

        // 4. 组参数：`--` 之后的都当路径，不会被误认成 ref
        const pathspec = gitPath && gitPath !== '.' ? ['--', gitPath] : []
        const args = buildArgs(action, ref, stat, Math.min(Math.max(1, limit), MAX_LOG_ENTRIES), pathspec)
        if (args === null) return `${action} 需要 ref 参数（哪个提交？）`

        try {
          const run = await git(root, args)
          // git() 是**不抛异常**的（git-panel.ts：失败也把 stderr 原样带回、ok=false）
          if (!run.ok) {
            return `git ${action} 失败：${run.stderr.trim() || '（git 没有给出原因）'}` +
              `\n（${ref ? `ref=${ref} ` : ''}${path ? `path=${path}` : ''}）`
          }
          const body = run.stdout.trim()
          // status / log 在「干净仓库 / 空历史」下合法地没输出，给一句人话而不是空串
          return clipToBudget(body || explainEmpty(action), MAX_TOOL_RESULT_CHARS)
        } catch (err) {
          // 只剩 spawn 本身的失败（没装 git / PATH 问题）：git() 已经兜过一层，这里防意外
          const msg = err instanceof Error ? err.message : String(err)
          return `git ${action} 失败：${msg}`
        }
      }
    })
  }
}

/** 按动作组 git 参数（不含 pathspec） */
function buildArgs(
  action: 'status' | 'diff' | 'log' | 'show',
  ref: string | undefined,
  stat: boolean,
  limit: number,
  pathspec: string[]
): string[] | null {
  switch (action) {
    case 'status':
      // --porcelain=v2：机器可读，且不会在「刚 init、没有任何提交」的 unborn 分支上
      // 把 `## No commits yet on master` 解析出分支名 "No"（porcelain v1 的坑）
      // --branch：顺带给出当前分支 / 上游 / ahead-behind
      return ['status', '--porcelain=v2', '--branch', ...pathspec]
    case 'diff':
      return [
        'diff',
        '--no-color',
        ...(stat ? ['--stat'] : []),
        ...(ref ? [ref] : []),
        // 未暂存改动是默认视图；给了 ref 就是「这个 ref 与工作区的差异」
        ...pathspec
      ]
    case 'log':
      return [
        'log',
        `-${limit}`,
        '--no-color',
        '--format=%h %ad %an %s',
        '--date=short',
        ...(ref ? [ref] : []),
        ...pathspec
      ]
    case 'show':
      if (!ref) return null
      return ['show', '--no-color', '--format=commit %H%nAuthor: %an%nDate: %ad%n%n    %s', '--date=short', ref, ...pathspec]
  }
}

/** 「合法但没内容」的解释：否则模型看到空串会以为工具坏了，然后反复重试 */
function explainEmpty(action: 'status' | 'diff' | 'log' | 'show'): string {
  switch (action) {
    case 'status':
      return '（工作区是干净的：没有未提交的改动）'
    case 'diff':
      return '（没有差异：指定范围内工作区与 HEAD 一致）'
    case 'log':
      return '（这个范围没有提交记录）'
    case 'show':
      return '（这个提交没有可显示的内容 —— 可能是个空提交）'
  }
}
