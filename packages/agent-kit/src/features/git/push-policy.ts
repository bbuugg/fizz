/**
 * 「推送」这一下的**前置判据**（从 `GitPanel.tsx` 抽出，纯函数、零 React 依赖）。
 *
 * 独立成文件的理由：推送有两个入口 —— 「更多」菜单里那条（只有仓库才渲染）和**面板级快捷键**
 * （`Ctrl / ⌘ + Shift + Enter`，只要面板可见就收得到，与当前是不是仓库无关）。快捷键这条路上
 * 「现在到底能不能推」只能靠状态现算，而算错的代价是：
 *
 * - 工作区还不是 git 仓库时去开「管理远端」弹窗 —— 那个弹窗填了地址也 `set-remote` 不了
 *   （服务端会回「这个工作区不是 git 仓库」），用户看到的是一个走不通的死路；
 * - 状态还没拿到（面板刚挂出来 / 上一次刷新失败）时拿 `null` 当「没有远端」，同样误开弹窗。
 *
 * 所以判据收敛成这一个函数，面板只负责把结果翻译成 toast / 开弹窗。
 */
import type { GitStatusResult } from '@fizz/git'
import { t } from '@fizz/i18n'

/**
 * 这一次「推送」该怎么走：
 * - `ok`：发请求；
 * - `unknown`：还没拿到仓库状态（加载中 / 刷新失败过），既不能推也不能猜；
 * - `not-repo`：这个工作区不是 git 仓库（含「这台机器上没装 git」）→ **什么都不做**，只告诉用户；
 * - `detached`：分离头指针，没有分支可推；
 * - `no-remote`：是仓库但一个远端都没配 → 这时才开「管理远端」让用户填地址。
 */
export type PushGate = 'ok' | 'unknown' | 'not-repo' | 'detached' | 'no-remote'

/**
 * 判这一次推送。
 *
 * `remote` 是「推送到…」子菜单挑的那个远端名：显式指定时**不在这里校验**它存不存在
 * （服务端有权威的远端清单，这里拦只会让两个入口的报错口径不一致）。
 */
export function pushGate(
  status: Pick<GitStatusResult, 'isRepo' | 'detached' | 'remotes'> | null,
  remote?: string
): PushGate {
  // 状态还没到：`null` 不是「没有远端」，别拿它去开弹窗（这条是用户报过的那次误弹）
  if (!status) return 'unknown'
  if (!status.isRepo) return 'not-repo'
  if (status.detached) return 'detached'
  if (remote) return 'ok'
  return status.remotes.length === 0 ? 'no-remote' : 'ok'
}

/** 不能推时给用户的那句话（`ok` / `no-remote` 没有话 —— 前者直接推、后者开弹窗） */
export function pushBlockedMessage(gate: PushGate): string | null {
  switch (gate) {
    case 'unknown':
      return t('还没读到仓库状态（正在刷新）：稍等一下再推')
    case 'not-repo':
      return t('这个工作区还不是 git 仓库：没有可推送的内容（先在面板里初始化）')
    case 'detached':
      return t('现在处于分离头指针：先切回一个分支再推送')
    default:
      return null
  }
}
