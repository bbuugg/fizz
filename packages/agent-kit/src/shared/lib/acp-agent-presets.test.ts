/**
 * 防回归：预设按**命令文件名**匹配（而不是整条命令），否则用户把全局 CLI 的绝对路径
 * （Windows 的 `…\gemini.cmd`）写进配置后，图标与「已添加」标记会一起消失。
 */
import { describe, expect, it } from 'vitest'
import { acpCommandBasename, findAcpPreset } from './acp-agent-presets'

describe('acpCommandBasename', () => {
  it('去掉目录与 Windows 的 .cmd/.exe 后缀', () => {
    expect(acpCommandBasename('C:\\Users\\x\\AppData\\Roaming\\npm\\gemini.cmd')).toBe('gemini')
    expect(acpCommandBasename('/usr/local/bin/opencode')).toBe('opencode')
    expect(acpCommandBasename('  CODEX-ACP.EXE ')).toBe('codex-acp')
  })

  it('空命令不产生匹配', () => {
    expect(acpCommandBasename('   ')).toBe('')
  })
})

describe('findAcpPreset', () => {
  it('按命令匹配预设，忽略参数差异', () => {
    expect(findAcpPreset('gemini')?.id).toBe('gemini')
    expect(findAcpPreset('C:\\Tools\\gemini.CMD')?.id).toBe('gemini')
    expect(findAcpPreset('pi-acp')?.id).toBe('pi')
  })

  it('未知命令返回 null（交给 Bot 兜底图标）', () => {
    expect(findAcpPreset('my-private-agent')).toBeNull()
    expect(findAcpPreset('')).toBeNull()
  })
})
