/** 防止 SSH 助手把 glob 的相对模式锚到远端 /，以及取消/转后台时丢失任务生命周期。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sftp, exec } = vi.hoisted(() => ({
  sftp: { stat: vi.fn(), readFile: vi.fn() },
  exec: vi.fn()
}))
vi.mock('./sftp', () => ({ sftpService: sftp }))
vi.mock('./exec', () => ({ remoteExecService: { exec } }))
vi.mock('../state', () => ({ emitServerEvent: vi.fn() }))

import { createAssistantBackend, startAssistantCommand, waitAssistantCommand } from './assistant-backend'
import { getBackgroundTask, getBackgroundTaskDetail, listBackgroundTasks } from '../background-tasks'

const result = { stdout: '', stderr: '', exitCode: 0, reason: 'exit' as const, truncated: false }

beforeEach(() => {
  vi.resetAllMocks()
  sftp.stat.mockResolvedValue({ type: 'dir', size: 0 })
  exec.mockResolvedValue(result)
})

describe('SSH 助手路径', () => {
  it('相对路径基于默认目录，但绝对路径与 .. 可访问远端其它目录', () => {
    const backend = createAssistantBackend('h1', '/srv/app')
    expect(backend.resolve('src/a.ts')).toBe('/srv/app/src/a.ts')
    expect(backend.resolve('/etc/hosts')).toBe('/etc/hosts')
    expect(backend.resolve('../logs')).toBe('/srv/logs')
    expect(() => backend.resolve('a\nwhoami')).toThrow('非法字符')
  })

  it('带目录的 glob 相对默认目录匹配并返回远端绝对路径', async () => {
    exec.mockResolvedValue({ ...result, stdout: 'src/a.ts\0src/a.js\0' })
    const backend = createAssistantBackend('h1', '/srv/app')
    await expect(backend.find({ pattern: 'src/*.ts', subPath: '', maxResults: 100, ignore: () => false }))
      .resolves.toEqual(['/srv/app/src/a.ts'])
    expect(exec).toHaveBeenCalledWith('h1', expect.any(String), expect.objectContaining({ cwd: '/srv/app' }))
  })

  it('默认目录外的 glob 以指定远端目录匹配', async () => {
    exec.mockResolvedValue({ ...result, stdout: 'nginx/error.log\0' })
    const backend = createAssistantBackend('h1', '/srv/app')
    await expect(backend.find({ pattern: 'nginx/*.log', subPath: '/var/log', maxResults: 100, ignore: () => false }))
      .resolves.toEqual(['/var/log/nginx/error.log'])
  })

  it('显式点名默认目录外的文件时仍按文件名匹配', async () => {
    sftp.stat.mockResolvedValue({ type: 'file', size: 1 })
    const backend = createAssistantBackend('h1', '/srv/app')
    await expect(backend.find({ pattern: '*.log', subPath: '/var/log/error.log', maxResults: 100, ignore: () => true }))
      .resolves.toEqual(['/var/log/error.log'])
    expect(exec).not.toHaveBeenCalled()
  })

  it('grep 在整机后端搜索，但默认目录忽略规则与返回路径正确映射', async () => {
    exec.mockResolvedValue({ ...result, stdout: JSON.stringify({ type: 'match', data: {
      path: { text: 'srv/app/src/a.ts' }, line_number: 2, lines: { text: 'needle\n' }
    } }) })
    const ignore = vi.fn(() => false)
    const backend = createAssistantBackend('h1', '/srv/app')
    await expect(backend.search({ pattern: 'needle', subPath: '', context: 0, maxResults: 100, maxFileBytes: 1000, caseInsensitive: false, ignore }))
      .resolves.toEqual([{ file: '/srv/app/src/a.ts', hits: [{ line: 2, text: 'needle' }] }])
    expect(ignore).toHaveBeenCalledWith('src/a.ts', false)
  })
})

describe('SSH 助手任务', () => {
  it('失败保留输出与退出码，任务清单记为失败，日志逐行记录', async () => {
    exec.mockImplementation(async (_host, _command, options) => {
      options.onOutput?.('stderr', 'failed\n')
      return { ...result, stderr: 'failed\n', exitCode: 2 }
    })
    const task = startAssistantCommand({ backend: createAssistantBackend('h1', '/srv/app'), sessionId: 'failure', hostLabel: 'host', command: 'build', options: {} })
    const outcome = await task.wait()
    expect(outcome).toMatchObject({ status: 'failed', errorObject: { commandResult: { exitCode: 2, stderr: 'failed\n' } } })
    expect(getBackgroundTaskDetail(task.id)?.logs.some((line) => line.text === 'failed')).toBe(true)
  })

  it('前台取消等待远端清理完成，转后台后本轮停止不影响任务', async () => {
    let finish!: (value: typeof result) => void
    let signal!: AbortSignal
    exec.mockImplementation((_host, _command, options) => {
      signal = options.signal
      return new Promise((resolve) => { finish = resolve })
    })
    const controller = new AbortController()
    const pending = waitAssistantCommand({ backend: createAssistantBackend('h1', '/srv/app'), sessionId: 'detach', hostLabel: 'host', command: 'build', options: { signal: controller.signal } })
    const task = listBackgroundTasks().find((entry) => entry.sessionId === 'detach')!
    getBackgroundTask(task.id)!.detach()
    expect(await pending).toMatchObject({ reason: 'exit', stdout: expect.stringContaining(task.id) })
    controller.abort()
    expect(signal.aborted).toBe(false)
    let canceled = false
    const canceling = getBackgroundTask(task.id)!.cancel().then(() => { canceled = true })
    await Promise.resolve()
    expect(signal.aborted).toBe(true)
    expect(canceled).toBe(false)
    finish(result)
    await canceling
    expect(canceled).toBe(true)
    expect(exec).toHaveBeenCalledWith('h1', 'build', expect.objectContaining({ waitForCleanup: true }))
  })
})
