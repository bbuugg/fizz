/**
 * 浏览器 profile 的目录派生 / 占用统计 / 删除。
 *
 * 这条测试防的回归是**删了会话却不删 profile**：`BrowserSessionManager.purge()` 曾经
 * 写好了却全仓没人调，于是每删一个会话就在 `<dataDir>/browser-profiles` 下永久留下一份
 * 带 Cookie 的目录（谁的、什么时候的都没人知道）。现在删会话与删项目都接上了 purge，
 * 设置页还多了一颗「全部清除」，三处都依赖这里的两条口径：
 *
 * 1. **目录名由 sessionId 派生**（非 `[a-zA-Z0-9._-]` 一律换成 `-`）。改这条规则 = 所有
 *    存量 profile 失联，用户看到的是「所有会话都被登出了」；
 * 2. **清单按磁盘数**，不按会话池反推 —— 历史残留只有按磁盘数才看得见。
 *
 * 不拉起浏览器、不碰用户目录（只在系统临时目录里造一份假 profile）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  browserProfileDirOf,
  browserProfileDirs,
  browserProfilesRoot,
  browserProfileUsage,
  removeBrowserProfileDir,
  setBrowserProfilesRoot
} from './profiles'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fizz-browser-profiles-'))
  setBrowserProfilesRoot(root)
})

afterEach(async () => {
  setBrowserProfilesRoot(null)
  await rm(root, { recursive: true, force: true })
})

/** 造一份假 profile：`<root>/<name>/Default/Cookies`，内容长度可控 */
async function fakeProfile(name: string, bytes: number): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, 'Default'), { recursive: true })
  await writeFile(join(dir, 'Default', 'Cookies'), 'x'.repeat(bytes))
  return dir
}

describe('browserProfileDirOf', () => {
  it('把会话 id 里的非法字符换成 `-`（`agent-browser:<uuid>` 的冒号就是靠这条）', () => {
    expect(browserProfileDirOf('agent-browser:abc-123')).toBe(
      join(root, 'agent-browser-abc-123')
    )
  })

  it('没注入根目录时回 null：引擎退化成临时上下文，不落盘', () => {
    setBrowserProfilesRoot(null)
    expect(browserProfileDirOf('agent-browser:abc')).toBeNull()
    expect(browserProfilesRoot()).toBeNull()
  })
})

describe('browserProfileDirs / browserProfileUsage', () => {
  it('按磁盘数目录（含没有会话对应的残留），体积累加子目录', async () => {
    await fakeProfile('agent-browser-a', 100)
    await fakeProfile('agent-browser-b', 25)

    expect(browserProfileDirs().sort()).toEqual([
      join(root, 'agent-browser-a'),
      join(root, 'agent-browser-b')
    ])
    assertUsage(browserProfileUsage(), { count: 2, sizeBytes: 125 })
  })

  it('根目录还不存在时是「没有数据」，不是报错', () => {
    setBrowserProfilesRoot(join(root, 'nope'))
    expect(browserProfileDirs()).toEqual([])
    assertUsage(browserProfileUsage(), { count: 0, sizeBytes: 0 })
  })
})

describe('removeBrowserProfileDir', () => {
  it('删掉整份 profile（登录态一起走），其他会话不受影响', async () => {
    const doomed = await fakeProfile('agent-browser-gone', 64)
    const kept = await fakeProfile('agent-browser-kept', 64)

    await removeBrowserProfileDir(doomed)

    expect(existsSync(doomed)).toBe(false)
    expect(existsSync(kept)).toBe(true)
    assertUsage(browserProfileUsage(), { count: 1, sizeBytes: 64 })
  })

  it('目录不存在也不抛（重复清除 / 已经被删过）', async () => {
    await expect(removeBrowserProfileDir(join(root, 'never-existed'))).resolves.toBeUndefined()
    await expect(removeBrowserProfileDir(null)).resolves.toBeUndefined()
  })
})

/** 小工具：让断言失败时能一眼看出是 count 还是体积不对 */
function assertUsage(actual: { count: number; sizeBytes: number }, expected: { count: number; sizeBytes: number }) {
  expect({ count: actual.count, sizeBytes: actual.sizeBytes }).toEqual(expected)
}
