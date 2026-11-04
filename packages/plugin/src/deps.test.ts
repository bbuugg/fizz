/**
 * 这些用例在防什么回归：
 *
 * 插件依赖是**按插件根合成**的一张表（见 `deps.ts` 文件头）。合成逻辑一旦出错，
 * 症状是「插件装上了但 import 不到」或者「两个插件互相顶掉版本」，而且不报错 ——
 * 所以这里把合并、冲突告警、顺序确定性三条口径钉住。
 */
import { describe, expect, it } from 'vitest'
import { planRootDependencies } from './deps'

describe('planRootDependencies', () => {
  it('把多个插件的依赖合并成一张表', () => {
    const plan = planRootDependencies([
      { id: 'a', dependencies: { 'ioredis': '^5.4.1', 'dayjs': '^1.11.10' } },
      { id: 'b', dependencies: { 'mysql2': '^3.9.7' } }
    ])
    expect(plan.dependencies).toEqual({
      dayjs: '^1.11.10',
      ioredis: '^5.4.1',
      mysql2: '^3.9.7'
    })
    expect(plan.warnings).toEqual([])
  })

  it('同一区间不告警，不同区间按插件 id 先到先得并告警', () => {
    const same = planRootDependencies([
      { id: 'a', dependencies: { zod: '^3.23.8' } },
      { id: 'b', dependencies: { zod: '^3.23.8' } }
    ])
    expect(same.warnings).toEqual([])
    expect(same.dependencies.zod).toBe('^3.23.8')

    const conflict = planRootDependencies([
      { id: 'z-plugin', dependencies: { nanoid: '^4.0.0' } },
      { id: 'a-plugin', dependencies: { nanoid: '^5.0.0' } }
    ])
    // 字典序先到先得：a-plugin 赢，且必须**说清是谁要的**（否则用户不知道该改哪个插件）
    expect(conflict.dependencies.nanoid).toBe('^5.0.0')
    expect(conflict.warnings).toHaveLength(1)
    expect(conflict.warnings[0]).toContain('a-plugin')
    expect(conflict.warnings[0]).toContain('z-plugin')
  })

  it('与插件的发现顺序无关（同样的输入顺序不同，结果必须一致）', () => {
    const a = { id: 'a', dependencies: { pkg: '^1.0.0' } }
    const b = { id: 'b', dependencies: { pkg: '^2.0.0' } }
    expect(planRootDependencies([a, b]).dependencies).toEqual(planRootDependencies([b, a]).dependencies)
  })

  it('没有插件声明依赖时给出空表（调用方据此跳过 pnpm）', () => {
    expect(planRootDependencies([{ id: 'a' }, { id: 'b', dependencies: {} }]).dependencies).toEqual({})
  })
})
