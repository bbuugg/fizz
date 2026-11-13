/**
 * 助手的「能力与约束」提示词基线。
 *
 * 防的回归：**工具挂了但提示词没说**（模型不知道自己能跑命令），或反过来
 * 提示词教模型用 `write` / `run_in_background` 这种装配层根本没给的能力 ——
 * 后者比缺能力更糟，模型会反复试一条永远被拒的路。
 *
 * 工具集是 `startAssistantTurn` 里按白名单装配的，装配层与这段提示词分两处写，
 * 所以这里把「提示词里出现的工具名」钉住，改装配时漏改文案会先红。
 */
import { describe, expect, it } from 'vitest'
import { buildAssistantInstructions } from './assistant-turn'

describe('buildAssistantInstructions', () => {
  it('把当前能用的全局工具写清楚，并点明默认工作目录', () => {
    const s = buildAssistantInstructions()
    expect(s).toContain('bash 能执行 shell 命令')
    expect(s).toContain('默认工作目录是')
    expect(s).toContain('web_fetch')
    expect(s).toContain('todo_write')
    expect(s).toContain('用 read 加 offset / limit 续读')
  })

  it('如实说明没有写文件工具、没有后台通道', () => {
    const s = buildAssistantInstructions()
    expect(s).toContain('没有写文件 / 编辑类工具')
    expect(s).toContain('run_in_background 在助手里没有后台通道')
  })

  it('全局配置工具仍在能力清单里（模型配置 / MCP / ACP）', () => {
    const s = buildAssistantInstructions()
    expect(s).toContain('list_model_configs')
    expect(s).toContain('list_mcp_servers')
    expect(s).toContain('create_acp_agent')
    expect(s).toContain('probe_acp_models')
  })
})
