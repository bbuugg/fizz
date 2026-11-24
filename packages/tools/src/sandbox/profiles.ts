/**
 * 各平台沙箱 runner 的 profile 拼装（纯函数，不 spawn）。
 *
 * 这里只做「把一份文件效果策略翻译成 runner 认识的参数」这一件事，探针与选择在
 * `index.ts`。三份方言的来源是 harness 的 `sandbox-local/src/profiles.ts`：
 *
 * - bwrap：`--ro-bind / /` 把整个根挂成只读，再用 `--tmpfs /tmp` + `--bind` 开两个写口；
 * - Seatbelt：SBPL 里 `(deny file-write*)` 后再按 canonical 路径放开；
 * - Windows ACL：不在这里（需要受限令牌 + capability SID，见 README/阶段计划）。
 *
 * ⚠️ `workspaceRoot` 必须已经是**执行世界里的绝对路径**。Seatbelt 的匹配是
 * canonical 的（macOS 上 `/tmp` 就是 `/private/tmp`），所以写口统一过
 * {@link writableRoots} 做 realpath + 去重，别在这里自己拼。
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@fizz/contracts/workspace'

/**
 * 解析到执行层真正比较的那个路径（符号链接全部展开）。
 *
 * 解析失败（不存在 / 无权限）时**原样返回**：不存在的写口本来就匹配不到任何东西，
 * 这是保守结果；随手回落到一个「看起来能用」的目录反而会放开调用方没点名的路径。
 */
export function canonicalPath(path: string): string {
  try {
    // 用 native 实现：JS 版会先把 `..` 词法折叠，symlink/.. 这种组合与内核解析不一致
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * `workspace-write` 真正允许写的根：工作区 + 宿主 `/tmp` + 平台临时目录。
 *
 * `os.tmpdir()` 不能省：mkstemp 一族默认往那里写，少了它这个模式承诺的
 * 「可用临时目录」就是假的。
 */
export function writableRoots(policy: SandboxExecutionPolicy, tempRoot: string = tmpdir()): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tempRoot].map(canonicalPath))]
}

/**
 * bwrap 的 profile 参数（`--` 与命令 argv 之前的那一段）。
 *
 * `--die-with-parent` 必须有：不然宿主进程被强杀后，沙箱里的命令会变成孤儿继续跑。
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent'
  ]
  if (policy.mode === 'workspace-write') {
    // 顺序有意义：先整根只读，再临时目录可写，最后叠加工作区可写
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/** 把一个路径写成 SBPL 字符串字面量（反斜杠与双引号都要转义） */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * macOS `sandbox-exec` 的参数（`-p <profile>`，后面接 `--` 与命令 argv）。
 *
 * 只关 `file-write*`：读全放开（`allow default`），否则 bash 连自己的配置都读不了。
 */
export function seatbeltProfileArgs(policy: SandboxPolicy, tempRoot?: string): string[] {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`
  ]
  const roots = writableRoots(policy, tempRoot)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
