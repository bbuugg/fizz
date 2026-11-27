/**
 * ACP agent 的**附属资源安装**。目前只有一个：**pi** 的权限询问扩展。
 *
 * 背景：pi 自己不对工具调用求批准（官方 `docs/security.md`），要它问只能靠扩展；
 * 而 `pi-acp` 会把扩展的 `ctx.ui.confirm` / `select` 桥接成 ACP 的
 * `session/request_permission`（→ 我们的确认卡）。
 *
 * 时机：**新建 ACP 会话时**（`POST /api/conversations` 的 ACP 分支），且必须在
 * `session/new` **之前** —— pi 是在启动 / 建会话时加载扩展的，晚一步这一轮就赶不上。
 *
 * 落点：**项目级** `<工作区>/.pi/extensions/confirm-tools.ts`（pi 的约定位置之一）。
 *
 * ⚠️ **装了不等于会加载**：`.pi/extensions` 属于 pi 的**受项目信任保护**资源，而 pi-acp 用
 * `pi --mode rpc` 起 pi —— RPC 模式无法弹信任提示，缺省 `defaultProjectTrust: "ask"` 会
 * **直接跳过**这些资源。要真生效，用户还得自己二选一：
 * - `~/.pi/agent/settings.json` 里设 `defaultProjectTrust: "always"`（全局放宽）；或
 * - 对该项目 `/trust` 一次（落进 `~/.pi/agent/trust.json`，逐目录生效）。
 *
 * 这两件事都等于**放宽安全边界**，所以本模块只 warn、绝不代劳。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AcpAgentConfig } from '@fizz/acp'

/**
 * 仓库里随代码走的扩展源码（相对仓库根 / 打包资源目录的路径）。
 *
 * ⚠️ 这个目录**必须跟着仓库走**：`Dockerfile` 运行阶段要 `COPY acp`，
 * 桌面端要在 electron-builder 的 `extraResources` 里带上它。少一处就会出现
 * 「源码找不到 → 静默不安装 → pi 照旧不问」。
 */
const PI_CONFIRM_EXTENSION_REL = join('acp', 'pi', 'extensions', 'confirm-tools.ts')

/** 项目内目标位置（相对工作区根） */
const PI_CONFIRM_EXTENSION_TARGET = join('.pi', 'extensions', 'confirm-tools.ts')

/**
 * 定位随代码分发的扩展源码，找不到返回 `null`。
 *
 * 三种运行形态的落点不一样，逐个试：
 * - **开发 / Docker**：`process.cwd()` 就是仓库根（容器里是 `/app`）；
 * - **打包后的桌面端**：cwd 不可靠，源码由 `extraResources` 放进 `process.resourcesPath`；
 * - 再从 cwd **逐级往上**找 8 层，覆盖「从 `apps/server` 之类子目录启动」的情形。
 *
 * `FIZZ_PI_EXTENSION_SOURCE` 可显式指定（把 server 单独拷出去跑的场景）。
 */
function resolveExtensionSource(): string | null {
  const override = process.env.FIZZ_PI_EXTENSION_SOURCE?.trim()
  if (override && existsSync(override)) return override
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates: string[] = [
    join(process.cwd(), PI_CONFIRM_EXTENSION_REL),
    ...(resourcesPath ? [join(resourcesPath, PI_CONFIRM_EXTENSION_REL)] : [])
  ]
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, PI_CONFIRM_EXTENSION_REL))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * 这个外部 agent 是不是 pi —— 决定要不要给它装 pi 专属资源。
 *
 * 新配置认稳定的预设身份；兼容旧类型和没有预设的启动命令（包括 npx -y pi-acp）。
 * 这只是内部资源适配，不参与模式或思考档的能力判断。
 */
export function isPiAcpAgent(agent: AcpAgentConfig): boolean {
  if (agent.preset === 'pi' || agent.type === 'pi') return true
  return `${agent.command} ${agent.args.join(' ')}`.toLowerCase().includes('pi-acp')
}

export type EnsurePiExtensionStatus =
  /** 刚装好 */
  | 'installed'
  /** 目标已存在 → 跳过（不覆盖用户改过的版本） */
  | 'exists'
  /** 不是 pi，什么都没做 */
  | 'not-pi'
  /** 仓库里的源码不见了（比如服务端不是从仓库根启动的） */
  | 'missing-source'
  /** 写盘失败 */
  | 'failed'

export interface EnsurePiExtensionResult {
  status: EnsurePiExtensionStatus
  /** 目标路径（`installed` / `exists` 时有） */
  path?: string
  error?: string
}

/**
 * 把 pi 的权限扩展装进这个工作区（幂等）。
 *
 * **失败不抛错**：装不上不该挡住建会话 —— 最坏情况就是 pi 照旧不问，而不是会话建不出来。
 */
export function ensurePiConfirmExtension(
  agent: AcpAgentConfig,
  workspacePath: string
): EnsurePiExtensionResult {
  if (!isPiAcpAgent(agent)) return { status: 'not-pi' }
  const target = join(workspacePath, PI_CONFIRM_EXTENSION_TARGET)
  try {
    // 已存在就跳过：用户可能手改过（改判据 / 换问法），别冲掉
    if (existsSync(target)) return { status: 'exists', path: target }
    const source = resolveExtensionSource()
    if (!source) {
      console.warn(
        `[acp:pi] 找不到扩展源码 ${PI_CONFIRM_EXTENSION_REL}，跳过安装（pi 将不会询问权限）`
      )
      return { status: 'missing-source' }
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    console.log(
      `[acp:pi] 已安装权限扩展 → ${target}\n` +
        '         ⚠️ 项目级扩展受 pi 的「项目信任」保护：RPC 模式下需 defaultProjectTrust: "always"' +
        '（或对该目录 /trust 一次）才会加载，否则 pi 仍然不会询问。'
    )
    return { status: 'installed', path: target }
  } catch (err) {
    console.warn('[acp:pi] 安装权限扩展失败：', err)
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
