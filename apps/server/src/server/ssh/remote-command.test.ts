/**
 * 远端命令脚本的纯函数（不碰网络）。
 *
 * 防的回归：路径 / 命令里的单引号没被正确转义（会在远端被 shell 解释成另一条命令），
 * 以及中止时 pid 文件被提前删掉导致 `KILL` 找不到进程。
 */
import { describe, expect, it } from 'vitest'
import {
  buildCdLine,
  buildCleanupScript,
  buildExecScript,
  buildKillScript,
  parseTerminalCwd,
  pidFileFor,
  shellQuote
} from './remote-command'

describe('shellQuote', () => {
  it('普通值包单引号', () => {
    expect(shellQuote('/srv/app')).toBe(`'/srv/app'`)
  })

  it('值里的单引号转成四段拼接，不会被提前闭合', () => {
    expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`)
  })

  it('保留空格与特殊字符（引用后不再需要额外转义）', () => {
    expect(shellQuote('/srv/my app/$HOME')).toBe(`'/srv/my app/$HOME'`)
  })
})

describe('pidFileFor', () => {
  it('固定落在 /tmp，带调用方给的 id', () => {
    expect(pidFileFor('abc123')).toBe('/tmp/fizz-exec-abc123.pid')
  })
})

describe('buildExecScript', () => {
  it('优先 setsid，并先把当前 shell 的 pid 写进文件', () => {
    const script = buildExecScript('npm test', { pidFile: pidFileFor('x') })
    expect(script).toContain('command -v setsid')
    expect(script).toContain('setsid sh -c')
    expect(script).toContain('echo $$ >')
    expect(script).toContain('/tmp/fizz-exec-x.pid')
    expect(script).toContain('npm test')
  })

  it('cwd 存在时先 cd，失败退出 127', () => {
    const script = buildExecScript('ls', { pidFile: pidFileFor('x'), cwd: '/srv/app' })
    expect(script).toContain('cd ')
    expect(script).toContain('/srv/app')
    expect(script).toContain('|| exit 127;')
  })

  it('没有 cwd 时不拼 cd', () => {
    expect(buildExecScript('ls', { pidFile: pidFileFor('x') })).not.toContain('cd ')
  })

  it('命令里的单引号被安全转义', () => {
    const script = buildExecScript(`echo 'hi'`, { pidFile: pidFileFor('x') })
    expect(script).toContain(`'\\''`)
    expect(script).toContain('hi')
  })
})

describe('buildKillScript', () => {
  it('TERM 打负 pid（进程组）；pid 文件缺失时什么都不做', () => {
    const script = buildKillScript('/tmp/fizz-exec-x.pid', 'TERM')
    expect(script).toContain(`cat '/tmp/fizz-exec-x.pid'`)
    expect(script).toContain(`kill -TERM -"$p"`)
    expect(script).toContain('if [ -n "$p" ]')
  })

  it('KILL 额外按父子关系兜底（setsid 不可用时的分支）', () => {
    const script = buildKillScript('/tmp/fizz-exec-x.pid', 'KILL')
    expect(script).toContain(`kill -KILL -"$p"`)
    expect(script).toContain('pkill -KILL -P "$p"')
  })
})

describe('buildCleanupScript', () => {
  it('只删 pid 文件', () => {
    expect(buildCleanupScript('/tmp/fizz-exec-x.pid')).toBe(
      `rm -f '/tmp/fizz-exec-x.pid'`
    )
  })
})

describe('parseTerminalCwd', () => {
  it('接受 POSIX 绝对路径并归一化', () => {
    expect(parseTerminalCwd('/srv/app/../repo')).toBe('/srv/repo')
  })

  it('非绝对路径 / 空值一律当作没传', () => {
    expect(parseTerminalCwd('')).toBeUndefined()
    expect(parseTerminalCwd(null)).toBeUndefined()
    expect(parseTerminalCwd('srv/app')).toBeUndefined()
    expect(parseTerminalCwd('C:/repo')).toBeUndefined()
  })

  it('拒绝控制字符（避免往终端多塞几行命令）', () => {
    expect(parseTerminalCwd('/srv/app\nrm -rf /')).toBeUndefined()
    expect(parseTerminalCwd('/srv/app\u0000')).toBeUndefined()
  })
})

describe('buildCdLine', () => {
  it('单引号转义并用裸回车收尾', () => {
    expect(buildCdLine('/srv/my app')).toBe(`cd -- '/srv/my app'\r`)
    expect(buildCdLine(`/srv/a'b`)).toBe(`cd -- '/srv/a'\\''b'\r`)
  })
})