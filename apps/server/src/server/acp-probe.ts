/**
 * ACP 探针（设置页「拉取模型」/「拉能力」）用的 cwd。
 *
 * ACP 没有「列模型」方法：清单来自 agent 在 `session/new` 里广告的 `configOptions`，
 * 所以要真起一次它的进程 —— 而 `spawn` 需要一个**存在的**工作目录。这里给的就是那个目录。
 */
import { statSync } from 'node:fs'
// 同目录相对引用：`@/…` 别名只在 vite / tsc 里配了，vitest 没配（见 AGENTS.md「测试」），
// 用别名会让引用它的单测直接 `Cannot find package`。
import { domain } from './state'

/**
 * 登记表里第一个**本地、目录还在**的工作区；一个都没有返回 `undefined`
 * （`probeAcp*` 会退回用户主目录）。
 *
 * ⚠️ 别退回 `listWorkspaces()[0].path` 这种写法：登记表里常年躺着已经被删掉的
 * 「临时会话」（`scratch`，目录在 `<数据目录>/conversations/<会话 id>`，会话一删就没了，
 * 巡检已经把它标成 `dirMissing`）。拿这种路径当 cwd 去 spawn，Node 报的是
 * **`spawn codebuddy ENOENT`** —— cwd 不存在也是 ENOENT，且报错里只有命令名。
 * 用户侧看到的现象是「设置页里**所有** ACP agent 都拉不到模型，换台机器（数据目录干净）
 * 又全好」，很容易被误判成「本机系统 / PATH 坏了」。
 *
 * 远端工作区的 `path` 是 SSH 主机上的 POSIX 路径，本地 `spawn` 同样到不了，一并跳过。
 */
export function acpProbeCwd(): string | undefined {
  for (const workspace of domain.listWorkspaces()) {
    if (!workspace.path || workspace.remote || workspace.dirMissing) continue
    try {
      // `dirMissing` 是 30s 一轮的巡检结论，可能慢半拍：这里自己再 stat 一次
      if (statSync(workspace.path).isDirectory()) return workspace.path
    } catch {
      // 目录不在了，看下一个
    }
  }
  return undefined
}
