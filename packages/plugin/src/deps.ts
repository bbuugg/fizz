/**
 * 插件依赖安装（Node-only 子路径 `@fizz/plugin/deps`）。
 *
 * ## 一个插件根 = 一个 pnpm 工程，不是「每个插件一个 node_modules」
 *
 * 目录长这样（`<根>` 是 `~/.fizz/plugins` 或 `<项目>/.fizz/plugins`）：
 *
 * ```
 * <根>/package.json          # 由本模块**按各插件 manifest 的 dependencies 合成**（派生，别手改）
 * <根>/pnpm-workspace.yaml   # packages: ['.'] —— 让 pnpm 认这里为根，不会被上层 workspace 劫走
 * <根>/.npmrc                # node-linker=hoisted / auto-install-peers=false
 * <根>/node_modules/         # 扁平依赖，所有插件共用
 * <根>/my-plugin/{plugin.json,index.ts}
 * ```
 *
 * 为什么共用一份而不是每个插件一份：`cordis` 类容器要求**全进程只有一个 `ctx` 实例**。
 * 每个插件各自 `npm i` 会拿到自己那份 `@fizz/plugin`，`ctx instanceof Context` 为假、
 * `ctx.set` 写进另一个服务表，表现是「插件加载了但什么都不生效」且没有任何报错。
 * 扁平 + `auto-install-peers:false` + 宿主别名（`loader.ts` 的 `HOST_SHARED_PACKAGES`）
 * 一起把这个问题按住。
 *
 * 代价（必须知道）：同一个包的两个不兼容版本只能有一个生效，`planRootDependencies`
 * 会把冲突作为 warning 报出来。要真正独立请拆到不同插件根（用户级 / 项目级）。
 *
 * ## 为什么失败要回滚 package.json + lockfile
 *
 * 依赖装不上时如果留着新 package.json，下一次启动插件会 `Cannot find module`，
 * 而用户看到的是「插件坏了」而不是「依赖没装上」。所以失败 = 恢复到上一次能用的状态。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 规划输入：只关心 id 与它声明的依赖 */
export interface DependencyOwner {
  id: string
  dependencies?: Record<string, string>
}

export interface RootDependencyPlan {
  /** 合成的依赖表（包名 → 版本区间） */
  dependencies: Record<string, string>
  /**
   * 同一个包被多个插件要求了不同区间 —— 只有一个会被装。
   * 措辞里带上「谁要的」，否则用户没法判断该删哪个。
   */
  warnings: string[]
}

export interface SyncResult {
  ok: boolean
  /** pnpm 的输出（已裁剪，最多 60 行；失败时原话回给用户） */
  output: string
  warnings: string[]
}

/** 依赖表为空时用不到 pnpm，直接跳过 */
function isEmpty(map: Record<string, string>): boolean {
  return Object.keys(map).length === 0
}

/**
 * 把各插件的 `dependencies` 合成一份依赖表。
 *
 * 冲突策略：**按插件 id 字典序先到先得**，后面的只记 warning。
 * 不定成「报错拒绝安装」是因为插件之间通常只是边界版本差异（`^1` vs `^1.2`），
 * 按区间字符串比较也判断不出是否真兼容；装一个能跑的、把冲突说清楚更有用。
 */
export function planRootDependencies(owners: DependencyOwner[]): RootDependencyPlan {
  const sorted = [...owners].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const dependencies: Record<string, string> = {}
  /** 包名 → 第一次要求它的 range + 要它的插件 */
  const claimed = new Map<string, { range: string; owner: string }>()
  const warnings: string[] = []
  for (const owner of sorted) {
    for (const [name, range] of Object.entries(owner.dependencies ?? {})) {
      const prev = claimed.get(name)
      if (!prev) {
        claimed.set(name, { range, owner: owner.id })
        dependencies[name] = range
        continue
      }
      if (prev.range !== range) {
        warnings.push(
          `${name}：插件 ${prev.owner} 要 ${prev.range}，插件 ${owner.id} 要 ${range} —— 只会装 ${prev.range}`
        )
      }
    }
  }
  return { dependencies, warnings }
}

/** 生成 `package.json` 的正文（派生文件，头部注释提醒别手改） */
function renderPackageJson(plan: RootDependencyPlan): string {
  const body = {
    name: 'fizz-plugin-root',
    private: true,
    description: '由 Fizz 根据各插件的 plugin.json 自动生成，请勿手工编辑',
    dependencies: plan.dependencies
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

const PNPM_WORKSPACE = `# 由 Fizz 生成：让 pnpm 把插件根当作工程根，不会被上层 workspace 劫走
packages:
  - .
`

/**
 * `.npmrc`：hoisted + 不自动装 peer。
 *
 * 为什么两个都要写（而不是只写 `pnpm-workspace.yaml` 里的 camelCase 键）：
 * `nodeLinker` / `autoInstallPeers` 这两个键是 pnpm 9.5+ 才认的 yaml 设置，
 * 老版本只认 `.npmrc` 的 kebab-case。两份都写 = 老新 pnpm 行为一致。
 */
const NPMRC = `# 由 Fizz 生成
node-linker=hoisted
auto-install-peers=false
strict-peer-dependencies=false
`

/** 跑一条命令，返回退出码与合并后的输出（超时按失败处理） */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 180_000
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const isWindows = process.platform === 'win32'
    const child = isWindows
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
          cwd,
          windowsHide: true
        })
      : spawn('/bin/sh', ['-c', command], { cwd })
    const chunks: string[] = []
    let size = 0
    const collect = (buf: Buffer): void => {
      if (size > 64_000) return
      const text = buf.toString('utf8')
      size += text.length
      chunks.push(text)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, output: tail(chunks.join('')) })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(-1)
    }, timeoutMs)
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
  })
}

/** 只留最后 60 行 / 6000 字符：留开头没用，错误信息都在末尾 */
function tail(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  const kept = lines.slice(-60).join('\n')
  return kept.length > 6000 ? `…${kept.slice(-6000)}` : kept
}

/**
 * pnpm 是否存在。
 *
 * **只缓存成功的结果**：缓存 `null` 会让「刚装完 pnpm 再点安装依赖」永远失败，
 * 用户只能重启整个进程才能生效（而设置页那颗按钮看起来毫无反应）。
 */
let pnpmVersion: string | null = null
export async function detectPnpm(cwd: string): Promise<string | null> {
  if (pnpmVersion) return pnpmVersion
  const res = await runCommand('pnpm --version', cwd, 15_000)
  if (res.code !== 0) return null
  pnpmVersion = res.output.split(/\r?\n/)[0].trim() || null
  return pnpmVersion
}

/** 同步一个插件根的依赖。`owners` 只传**这个根里**的插件（别的根的插件互不影响） */
export async function syncRootDependencies(opts: {
  rootDir: string
  owners: DependencyOwner[]
  log?: (line: string) => void
}): Promise<SyncResult> {
  const plan = planRootDependencies(opts.owners)
  const log = opts.log ?? (() => {})
  if (isEmpty(plan.dependencies)) {
    // 没有任何插件要依赖：把派生文件清掉，免得留一份空 package.json 让 pnpm 反复扫
    await fs.rm(join(opts.rootDir, 'package.json'), { force: true }).catch(() => {})
    return { ok: true, output: '', warnings: plan.warnings }
  }
  const version = await detectPnpm(opts.rootDir)
  if (!version) {
    return {
      ok: false,
      output: '没有找到 pnpm：插件的 npm 依赖由 pnpm 安装（它会做扁平的 node_modules）。请先安装 pnpm 再重试。',
      warnings: plan.warnings
    }
  }
  await fs.mkdir(opts.rootDir, { recursive: true })
  const pkgPath = join(opts.rootDir, 'package.json')
  const lockPath = join(opts.rootDir, 'pnpm-lock.yaml')
  const [prevPkg, prevLock] = await Promise.all([
    fs.readFile(pkgPath, 'utf8').catch(() => null),
    fs.readFile(lockPath, 'utf8').catch(() => null)
  ])
  await fs.writeFile(pkgPath, renderPackageJson(plan), 'utf8')
  await fs.writeFile(join(opts.rootDir, 'pnpm-workspace.yaml'), PNPM_WORKSPACE, 'utf8')
  const npmrcPath = join(opts.rootDir, '.npmrc')
  const hasNpmrc = await fs
    .access(npmrcPath)
    .then(() => true)
    .catch(() => false)
  // 用户自己的 .npmrc（私有 registry / 镜像）不覆盖：只在他没有时写默认值
  if (!hasNpmrc) await fs.writeFile(npmrcPath, NPMRC, 'utf8')

  log(`[plugin] pnpm ${version} · ${Object.keys(plan.dependencies).length} 个依赖 · ${opts.rootDir}`)
  const res = await runCommand('pnpm install --reporter=append-only', opts.rootDir)
  if (res.code === 0) {
    for (const line of res.output.split(/\r?\n/).slice(-10)) if (line.trim()) log(`[plugin] ${line}`)
    return { ok: true, output: res.output, warnings: plan.warnings }
  }
  // 失败：还原到上一次能用的状态（见文件头「为什么失败要回滚」）
  if (prevPkg === null) await fs.rm(pkgPath, { force: true }).catch(() => {})
  else await fs.writeFile(pkgPath, prevPkg, 'utf8').catch(() => {})
  if (prevLock !== null) await fs.writeFile(lockPath, prevLock, 'utf8').catch(() => {})
  return { ok: false, output: res.output || `pnpm install 失败（退出码 ${res.code}）`, warnings: plan.warnings }
}
