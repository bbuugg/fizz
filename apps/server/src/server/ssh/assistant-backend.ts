/**
 * SSH 助手后端：复用远端文件能力，默认目录与访问范围分开。
 * 工作区后端限制在项目根；终端助手按 SSH 账号访问整台远端主机，仍然绝不触碰本机盘。
 * shell 全部登记后台任务，前台等待与显式后台执行共用日志、取消和清理路径。
 */
import { posix } from 'node:path'
import { maskRepoUrl } from '@fizz/git'
import type { WorkspaceBackend, WorkspaceExecOptions, WorkspaceExecResult } from '@fizz/contracts/workspace'
import { startBackgroundTask } from '../background-tasks'
import { createRemoteBackend } from './workspace-backend'
import { remoteExecService } from './exec'

export function createAssistantBackend(hostId: string, cwd: string): WorkspaceBackend {
  const remote = createRemoteBackend(hostId, '/')
  const home = createRemoteBackend(hostId, cwd)
  const resolve = (path: string): string => {
    if (/[\0\r\n]/.test(path)) throw new Error('远端路径包含非法字符')
    return posix.resolve(cwd, path || '.')
  }
  return {
    ...remote,
    root: cwd,
    resolve,
    rel: (path) => path,
    ignoreChecker: home.ignoreChecker,
    search: async (opts) => {
      const ignore = opts.ignore
      const files = await remote.search({
        ...opts,
        subPath: resolve(opts.subPath),
        ignore: (path, isDir) => ignore(posix.relative(cwd, `/${path}`), isDir)
      })
      return files.map((file) => ({ ...file, file: posix.resolve('/', file.file) }))
    },
    find: async (opts) => {
      // glob 含目录时相对默认目录匹配；默认目录外则以显式搜索目录为根。
      const start = resolve(opts.subPath)
      const relative = posix.relative(cwd, start)
      const outside = relative === '..' || relative.startsWith('../')
      const base = outside
        ? (await remote.stat(start))?.type === 'dir' ? start : posix.dirname(start)
        : cwd
      const files = await createRemoteBackend(hostId, base).find({
        ...opts,
        subPath: start,
        ignore: (path, isDir) => opts.ignore(posix.relative(cwd, posix.resolve(base, path)), isDir)
      })
      return files.map((file) => posix.resolve(base, file))
    },
    exec: (command, opts = {}) => remoteExecService.exec(hostId, command, {
      ...opts,
      cwd: resolve(opts.cwd ?? ''),
      waitForCleanup: true
    })
  }
}

export function startAssistantCommand(input: {
  backend: WorkspaceBackend
  sessionId: string
  hostLabel: string
  command: string
  options: WorkspaceExecOptions
}) {
  const { backend, sessionId, hostLabel, command, options } = input
  return startBackgroundTask({
    sessionId,
    kind: 'ssh-assistant-command',
    title: maskRepoUrl(command),
    detail: `${hostLabel} · ${options.cwd ?? backend.root}`,
    run: async (signal, log) => {
      log(`SSH ${hostLabel} · ${options.cwd ?? backend.root}`)
      log(`$ ${maskRepoUrl(command)}`)
      const pending = { stdout: '', stderr: '' }
      const write = (stream: 'stdout' | 'stderr', chunk: string): void => {
        options.onOutput?.(stream, chunk)
        const lines = (pending[stream] + chunk).split(/\r\n|[\r\n]/)
        pending[stream] = lines.pop() ?? ''
        for (const line of lines) log(maskRepoUrl(line))
        // 无换行的输出也不能无限积攒。
        if (pending[stream].length > 2000) {
          log(maskRepoUrl(pending[stream]))
          pending[stream] = ''
        }
      }
      const result = await backend.exec(command, { ...options, signal, onOutput: write })
      for (const stream of ['stdout', 'stderr'] as const) {
        if (pending[stream]) log(maskRepoUrl(pending[stream]))
      }
      log(`结束：${result.reason} · exit ${result.exitCode ?? 'unknown'}`,
        result.reason === 'exit' && result.exitCode === 0 ? 'info' : 'error')
      // 结果同时留给前台工具；登记表需要失败状态，不能把非零退出码记成成功。
      if (result.reason !== 'exit' || result.exitCode !== 0) {
        const error = new Error(result.error ?? `命令结束：${result.reason} · exit ${result.exitCode ?? 'unknown'}`)
        Object.assign(error, { commandResult: result })
        throw error
      }
      return { value: result }
    }
  })
}

/** 前台等待同一条任务；停止一轮是显式取消，断开 SSE / 收起面板不影响它。 */
export async function waitAssistantCommand(input: Parameters<typeof startAssistantCommand>[0]): Promise<WorkspaceExecResult> {
  if (input.options.signal?.aborted) {
    return { stdout: '', stderr: '', exitCode: null, reason: 'aborted', truncated: false }
  }
  const handle = startAssistantCommand(input)
  const cancel = (): void => { void handle.cancel() }
  input.options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    const result = await handle.wait()
    if (result.detached) {
      return {
        stdout: `命令已转到后台，任务 id：${handle.id}。请在后台任务面板查看日志与状态。`,
        stderr: '', exitCode: null, reason: 'exit', truncated: false
      }
    }
    if (result.value) return result.value as WorkspaceExecResult
    const error = result.errorObject as { commandResult?: WorkspaceExecResult } | undefined
    return error?.commandResult ?? {
      stdout: '', stderr: '', exitCode: null,
      reason: result.status === 'canceled' ? 'aborted' : 'error',
      error: result.error ?? '远端命令失败', truncated: false
    }
  } finally {
    input.options.signal?.removeEventListener('abort', cancel)
  }
}
