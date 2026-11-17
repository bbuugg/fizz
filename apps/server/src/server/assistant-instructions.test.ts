/**
 * 助手的「能力与约束」提示词基线。
 *
 * 防的回归：**工具挂了但提示词没说**（模型不知道自己能干什么），或反过来
 * 提示词教模型用 `bash` / `read` / `todo` / `create_conversation` 这种装配层
 * 根本没给的能力 —— 后者比缺能力更糟，模型会反复试一条永远被拒的路。
 *
 * 工具集是 `startAssistantTurn` 里按白名单装配的，装配层与这段提示词分两处写，
 * 所以这里把「提示词里出现的工具名」钉住，改装配时漏改文案会先红。
 *
 * 2026-11 撤掉了 `bash` / `read` / `todo` / `create_conversation` 四个工具
 * （助手不再有任何文件 / 命令类能力），下面第二组用例就是那次改动的护栏。
 */
import { describe, expect, it } from 'vitest'
import { buildAssistantInstructions } from './assistant-turn'

describe('buildAssistantInstructions', () => {
  it('把当前能用的能力写清楚（项目 / 定时任务 / web_fetch）', () => {
    const s = buildAssistantInstructions()
    expect(s).toContain('list_projects')
    expect(s).toContain('create_task_trigger')
    expect(s).toContain('web_fetch')
  })

  it('如实说明没有任何文件 / 命令类工具，且不许声称跑过命令', () => {
    const s = buildAssistantInstructions()
    expect(s).toContain('没有任何文件 / 命令类工具')
    expect(s).toContain('不要声称自己已经看过文件或跑过命令')
  })

  it('不再教模型去用已撤掉的 bash / read / todo / create_conversation', () => {
    const s = buildAssistantInstructions()
    // 工具名可以出现在「都不挂」这类否定句里，但不能出现在「你可以用它做…」的说明里
    expect(s).not.toContain('bash 能执行 shell 命令')
    expect(s).not.toContain('默认工作目录是')
    expect(s).not.toContain('用 read 加 offset / limit 续读')
    expect(s).not.toContain('todo 只在确实有三步以上时建清单')
    expect(s).not.toContain('run_in_background 在助手里没有后台通道')
    expect(s).not.toContain('create_conversation')
  })

  it('全局配置工具仍在能力清单里（模型配置 / MCP / ACP）', () => {
    const s = buildAssistantInstructions()
    expect(s).toContain('list_model_configs')
    expect(s).toContain('list_mcp_servers')
    expect(s).toContain('create_acp_agent')
    expect(s).toContain('probe_acp_models')
  })
})
