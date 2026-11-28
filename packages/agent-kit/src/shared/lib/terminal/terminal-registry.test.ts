/**
 * `liveTerminal` / `focusTerminal` 的行为契约。
 *
 * 前者决定「命令面板就地运行脚本」写不写得进去：错判的后果是脚本被静默丢进一个不存在 /
 * 已退出 / 根本不是主机的终端。所以边界逐条固定下来：必须登记过、必须是终端（容器工作台
 * 不算）、必须还活着。
 *
 * 后者只回答「焦点有没有交到那条终端手上」，没有就不做声（弹窗退场后再补一拍是调用方的事）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  focusTerminal,
  liveTerminal,
  registerTerminal,
  unregisterTerminal,
  type TerminalHandle
} from './terminal-registry'

function makeHandle(
  tabKey: string,
  kind: TerminalHandle['kind'],
  alive = true
): TerminalHandle {
  return {
    tabKey,
    title: tabKey,
    kind,
    read: () => '',
    write: () => {},
    focus: () => {},
    isAlive: () => alive
  }
}

/** 自己记下注册过的 key（登记表是模块级单例，逐用例清空避免互相污染） */
const registeredKeys: string[] = []
function register(handle: TerminalHandle): void {
  registerTerminal(handle)
  registeredKeys.push(handle.tabKey)
}

afterEach(() => {
  for (const key of registeredKeys) unregisterTerminal(key)
  registeredKeys.length = 0
})

describe('liveTerminal', () => {
  it('命中登记在册、还活着的 SSH 终端', () => {
    register(makeHandle('host:h1#1', 'ssh'))
    expect(liveTerminal('host:h1#1')?.tabKey).toBe('host:h1#1')
  })

  it('本机终端同样可写（当前视图是本机终端时就地跑）', () => {
    register(makeHandle('local:1', 'local'))
    expect(liveTerminal('local:1')?.tabKey).toBe('local:1')
  })

  it('已退出的终端不算（否则脚本会写进一个死掉的会话）', () => {
    register(makeHandle('host:h1#1', 'ssh', false))
    expect(liveTerminal('host:h1#1')).toBeNull()
  })

  it('容器工作台不算（脚本是主机侧的东西，写进纯文本通道会跑错地方）', () => {
    register(makeHandle('container:1', 'container'))
    expect(liveTerminal('container:1')).toBeNull()
  })

  it('没登记过的标签返回 null（那条终端不在这台设备上开着）', () => {
    expect(liveTerminal('host:h9#3')).toBeNull()
  })

  it('空标签（当前视图不是标签）返回 null', () => {
    register(makeHandle('host:h1#1', 'ssh'))
    expect(liveTerminal(null)).toBeNull()
    expect(liveTerminal(undefined)).toBeNull()
    expect(liveTerminal('')).toBeNull()
  })

  it('按 key 精确认，不会因为同一主机有别的终端就串到别处', () => {
    register(makeHandle('host:h1#1', 'ssh'))
    register(makeHandle('host:h1#2', 'ssh'))
    expect(liveTerminal('host:h1#2')?.tabKey).toBe('host:h1#2')
    expect(liveTerminal('host:h1#1')?.tabKey).toBe('host:h1#1')
  })

  it('注销之后立刻失效', () => {
    register(makeHandle('host:h1#1', 'ssh'))
    unregisterTerminal('host:h1#1')
    expect(liveTerminal('host:h1#1')).toBeNull()
  })
})

describe('focusTerminal', () => {
  it('把焦点交给登记在册的那条终端', () => {
    const focus = vi.fn()
    register({ ...makeHandle('host:h1#1', 'ssh'), focus })
    focusTerminal('host:h1#1')
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('没登记的标签什么也不做（弹窗退场后补拍时那条标签可能已经关了）', () => {
    expect(() => focusTerminal('host:gone#9')).not.toThrow()
  })
})
