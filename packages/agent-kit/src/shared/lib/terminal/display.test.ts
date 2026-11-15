/**
 * 终端工具结果的**展示口径**（消息列表那张卡）。
 *
 * 用户报过两件事：终端工具的输出「始终是一堆数字」，以及「没有输出也显示一个输出框」。
 * 这里把「哪些内容该显示、哪些是写给模型的废话」钉死 —— 这些字符串是工具与渲染端共用的，
 * 任何一边改了文案，测试会先炸。
 */
import { describe, expect, it } from 'vitest'
import {
  isTerminalTool,
  TERMINAL_EMPTY,
  TERMINAL_NO_OUTPUT,
  terminalOutputForDisplay
} from './display'

describe('terminalOutputForDisplay', () => {
  it('真实输出原样返回（多行、含数字都不动）', () => {
    const text = 'Filesystem Size Used Avail\n/dev/vda1 30G 28G 2.6G 92% /'
    expect(terminalOutputForDisplay(text)).toBe(text)
  })

  it('空 / 纯空白 → 不显示', () => {
    expect(terminalOutputForDisplay('')).toBe(null)
    expect(terminalOutputForDisplay('   \n\t ')).toBe(null)
  })

  it('「没捕获到输出」的占位 → 不显示（那是给模型的）', () => {
    expect(terminalOutputForDisplay(TERMINAL_NO_OUTPUT)).toBe(null)
    expect(terminalOutputForDisplay(TERMINAL_EMPTY)).toBe(null)
    expect(terminalOutputForDisplay('（无输出）')).toBe(null)
  })

  it('摘掉「等了约 N 秒没有新输出」的抬头，只留后面的屏幕内容', () => {
    const raw = `（等了约 8 秒没有新输出：命令可能仍在运行但暂时没打印，也可能已经跑完。\n**不要连续调用本工具**：确实只想看当前屏幕就传 waitMs: 0，要等长命令就再调一次让它继续等。）\n\n$ npm run build\ndone`
    expect(terminalOutputForDisplay(raw)).toBe('$ npm run build\ndone')
  })

  it('抬头后面还是占位 → 不显示', () => {
    const raw = `（等了约 8 秒没有新输出：命令可能仍在运行但暂时没打印，也可能已经跑完。）\n\n${TERMINAL_EMPTY}`
    expect(terminalOutputForDisplay(raw)).toBe(null)
  })

  it('只有抬头、没有屏幕内容 → 不显示', () => {
    expect(terminalOutputForDisplay('（等了约 8 秒没有新输出：命令可能仍在运行但暂时没打印。）')).toBe(
      null
    )
  })

  it('摘掉「到 waitMs 上限」的收尾注（那是对模型说的「别连续快速调用」）', () => {
    const raw = 'compiling...\ncompiling...\n（注：到 waitMs 上限（10 秒）时输出还没安静下来，命令可能仍在运行；再用 read_terminal_output 等下一段，别连续快速调用）'
    expect(terminalOutputForDisplay(raw)).toBe('compiling...\ncompiling...')
  })

  it('「输出被截断」的说明要留着（它告诉用户看到的不是全部）', () => {
    const raw = '（这段输出很长，更早的部分已经滚出缓冲，只能拿到最近的）\n…tail'
    expect(terminalOutputForDisplay(raw)).toBe(raw)
  })
})

describe('isTerminalTool', () => {
  it('只认客户端终端工具，不把 bash 算进来', () => {
    expect(isTerminalTool('run_in_terminal')).toBe(true)
    expect(isTerminalTool('read_terminal_output')).toBe(true)
    expect(isTerminalTool('send_keys')).toBe(true)
    expect(isTerminalTool('list_terminal_sessions')).toBe(true)
    // 服务端子进程那条命令是另一套（有自己的直显分支），不能混
    expect(isTerminalTool('bash')).toBe(false)
    expect(isTerminalTool('read')).toBe(false)
    expect(isTerminalTool(undefined)).toBe(false)
    expect(isTerminalTool('')).toBe(false)
  })
})
