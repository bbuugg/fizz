/**
 * 这条测试在防什么回归：
 *
 * 设置页「拉取模型 / 拉能力」的 cwd 取自「登记表里第一个工作区」，而那个目录可能早就
 * 被删了（临时会话 `scratch`，会话一删目录就没了）。**cwd 不存在时 `spawn` 报的是
 * `spawn codebuddy ENOENT`** —— libuv 在 chdir 失败时也回 ENOENT，报错里却只有命令名，
 * 于是现象被误读成「CLI 没装 / 本机系统坏了」，实际换台数据目录干净的机器就全好。
 *
 * 所以两件事都不能退化：
 * ① 探针自己兜底到主目录（`resolveProbeCwd`）；
 * ② 真起不来时，摘要必须说清是「命令」还是「工作目录」的问题，完整路径留在
 *    `AcpSpawnError.detail`（模型选择器只显示摘要，检测 tooltip 才展开细节）。
 */
import { describe, expect, it } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpSpawnError, describeSpawnError, resolveProbeCwd } from './acp'

/** 造一个确定不存在的路径（不碰磁盘：只拼字符串） */
function missingPath(): string {
  return join(tmpdir(), `fizz-acp-missing-${process.pid}-${Date.now()}`)
}

describe('resolveProbeCwd', () => {
  it('给的是现存目录就原样用（探针还能读到项目配置）', () => {
    expect(resolveProbeCwd(tmpdir())).toBe(tmpdir())
  })

  it('目录没了 / 没给 / 只有空白 → 退回主目录', () => {
    expect(resolveProbeCwd(missingPath())).toBe(homedir())
    expect(resolveProbeCwd('')).toBe(homedir())
    expect(resolveProbeCwd('   ')).toBe(homedir())
    expect(resolveProbeCwd(undefined)).toBe(homedir())
  })
})

describe('describeSpawnError', () => {
  const enoent = (): Error =>
    Object.assign(new Error('spawn codebuddy ENOENT'), { code: 'ENOENT' })

  it('ENOENT 且 cwd 不存在 → 摘要一行说明，路径留在 detail', () => {
    const cwd = missingPath()
    const err = describeSpawnError(enoent(), 'codebuddy', cwd)
    expect(err).toBeInstanceOf(AcpSpawnError)
    expect(err.message).toContain('工作目录不存在')
    // 选择器只显示摘要：路径不能挤在主文案里（会变成「加载失败：启动失败：…（路径）」）
    expect(err.message).not.toContain(cwd)
    expect((err as AcpSpawnError).detail).toContain(cwd)
  })

  it('ENOENT 但 cwd 正常 → 指明是命令的问题，工作目录进 detail', () => {
    const err = describeSpawnError(enoent(), 'codebuddy', tmpdir())
    expect(err.message).toContain('命令不存在或无法执行')
    expect((err as AcpSpawnError).detail).toContain(tmpdir())
  })

  it('不是 ENOENT 的错误原样抛出（别改写 agent 自己的报错）', () => {
    const err = Object.assign(new Error('initialize 失败'), { code: 'ERR_ACP' })
    expect(describeSpawnError(err, 'codebuddy', tmpdir())).toBe(err)
  })
})
