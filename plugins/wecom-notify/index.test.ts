/**
 * 企业微信插件的自动通知半场（`conversation:*` 钩子）里那些纯逻辑。
 *
 * 这些函数是通知内容与去重的唯一入口：默认值写反了会让「等待审批」静默不推、
 * 去重写漏了会把同一条待办刷满群、结果文案漏了 `max-steps` 会把撞上限的一轮
 * 当成正常完成。全都不联网就能钉住。
 */
import { describe, expect, it } from 'vitest'
import { __internals } from './index'

const {
  readSettings,
  createOnce,
  formatFinished,
  formatConfirm,
  formatFollowup,
  validateWebhook,
  mentionList
} = __internals

const base = {
  conversationId: 'conv-1',
  requestId: 'req-1',
  title: '修一下登录'
}

describe('readSettings', () => {
  it('完成通知默认关、等待通知默认开（与设置页 default 一致）', () => {
    const settings = readSettings({})
    expect(settings.notifyOnFinish).toBe(false)
    expect(settings.notifyOnWait).toBe(true)
    expect(settings.enabled).toBe(true)
    expect(settings.webhookUrl).toBe('')
    expect(settings.defaultMentions).toEqual([])
  })

  it('显式配置覆盖默认值，@ 列表按逗号 / 空白拆分', () => {
    const settings = readSettings({
      notifyOnFinish: true,
      notifyOnWait: false,
      defaultMentions: ' zhangsan,lisi， wangwu ',
      enabled: false
    })
    expect(settings.notifyOnFinish).toBe(true)
    expect(settings.notifyOnWait).toBe(false)
    expect(settings.defaultMentions).toEqual(['zhangsan', 'lisi', 'wangwu'])
    expect(settings.enabled).toBe(false)
  })
})

describe('createOnce', () => {
  it('同一个 key 只放行一次', () => {
    const once = createOnce()
    expect(once('confirm:1')).toBe(true)
    expect(once('confirm:1')).toBe(false)
    expect(once('confirm:2')).toBe(true)
  })

  it('超过上限时淘汰最早的 key，内存不会无界增长', () => {
    const once = createOnce(2)
    expect(once('a')).toBe(true)
    expect(once('b')).toBe(true)
    expect(once('c')).toBe(true)
    // a 已被挤掉，重新出现时算第一次
    expect(once('a')).toBe(true)
  })
})

describe('formatFinished', () => {
  it('正常运行带摘要', () => {
    const message = formatFinished({
      ...base,
      finishReason: 'done',
      excerpt: '已经修好了',
      finishedAt: 1
    })
    expect(message.title).toBe('会话已完成')
    expect(message.content).toContain('修一下登录')
    expect(message.content).toContain('状态：已完成')
    expect(message.content).toContain('已经修好了')
  })

  it('撞步数上限时说明用了多少步，不能伪装成正常完成', () => {
    const message = formatFinished({
      ...base,
      finishReason: 'done',
      stopReason: 'max-steps',
      steps: 24,
      finishedAt: 1
    })
    expect(message.title).toBe('会话已用满 24 步上限')
    expect(message.content).toContain('状态：已用满 24 步上限')
  })

  it('出错时优先展示失败原因而不是摘要', () => {
    const message = formatFinished({
      ...base,
      finishReason: 'error',
      error: '模型网关 502',
      excerpt: '看起来要成功了',
      finishedAt: 1
    })
    expect(message.content).toContain('**失败原因**：模型网关 502')
    expect(message.content).not.toContain('看起来要成功了')
  })

  it('带工作区名时标题里能看出是哪个项目', () => {
    const message = formatFinished({
      ...base,
      workspaceName: '演示项目',
      finishReason: 'aborted',
      finishedAt: 1
    })
    expect(message.title).toBe('会话已停止 · 演示项目')
  })
})

describe('formatConfirm / formatFollowup', () => {
  it('待确认：正文里有操作与意图', () => {
    const message = formatConfirm({
      ...base,
      confirm: { id: 'c1', toolName: 'bash', command: 'rm -rf build', intent: '清理构建产物' }
    })
    expect(message.title).toBe('待确认')
    expect(message.content).toContain('操作：rm -rf build')
    expect(message.content).toContain('意图：清理构建产物')
  })

  it('待回答：列出第一题，多题时提示回 Fizz 作答', () => {
    const message = formatFollowup({
      ...base,
      followup: {
        id: 'f1',
        questions: [{ question: '部署到哪个环境？' }, { question: '需要通知谁？' }]
      }
    })
    expect(message.title).toBe('待回答')
    expect(message.content).toContain('问题：部署到哪个环境？')
    expect(message.content).toContain('共 2 题')
  })

  it('没题时也有兜底文案，不发空消息', () => {
    const message = formatFollowup({ ...base, followup: { id: 'f1', questions: [] } })
    expect(message.content).toContain('Agent 发来了一个问题表单。')
  })
})

describe('webhook 安全边界', () => {
  it('只接受企业微信官方域名且必须带 key', () => {
    expect(
      validateWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc').hostname
    ).toBe('qyapi.weixin.qq.com')
    expect(() =>
      validateWebhook('https://evil.example.com/cgi-bin/webhook/send?key=abc')
    ).toThrow(/qyapi\.weixin\.qq\.com/)
    expect(() => validateWebhook('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc')).toThrow(
      /https/
    )
    expect(() => validateWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send')).toThrow(
      /key/
    )
  })

  it('@ 列表归一成裸 id，all 变成 <@all>', () => {
    expect(mentionList(['zhangsan', '<@lisi>', 'all'])).toEqual(['zhangsan', 'lisi', '<@all>'])
  })
})
