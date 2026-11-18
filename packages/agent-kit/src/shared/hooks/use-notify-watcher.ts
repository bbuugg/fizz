/**
 * 系统通知的挂载点：**对话**侧的事件监听。
 *
 * 数据来源是**服务端广播的瞬时事件**（`subscribeServerEvent`）。为什么不用差分：
 * 「等你点头」「跑完了」这两件事发生在**别的会话**时，本标签页往往什么都没收到 ——
 * SSE 只发给发起那一轮的连接。服务端把事件广播给所有连接（见
 * `@fizz/contracts/types` 的 `ServerEvent`），哪一端都在第一时间知道。
 * 顺带不用再处理「首份快照只播种、不发通知」那个坑：事件天然只描述「刚刚发生」，
 * 历史数据不会伪装成新事件。
 *
 * 所以这里**没有新增任何连接、轮询**：都走那条已有的状态 WS。
 *
 * 内容组装（哪类事件要通知、正文取什么、用户是不是正看着这一屏）全在
 * `shared/lib/conversation-notify.ts`（纯函数、有单测）。这里**只做接线**：
 * 收事件 → 交给它 → `notify` 发出去。判据留在闭包里就会漏（审批 / 提问曾各漏一条
 * `alreadyInView`，用户盯着确认卡还被右下角弹一条）。
 */
import { useEffect } from 'react'
import {
  initStateClient,
  subscribeServerEvent
} from '@fizz/agent-kit/shared/lib/state-ws'
import {
  conversationNotify,
  isConversationNotifyEvent
} from '@fizz/agent-kit/shared/lib/conversation-notify'
import { initConversationActivity } from '@fizz/agent-kit/shared/lib/conversation-activity'
import { notify } from '@fizz/agent-kit/shared/lib/notify'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'

/**
 * 挂上对话的系统通知监听。**不需要返回值**，挂一次即可。
 *
 * 放在外壳里调而不是放进对话 slice：通知要覆盖**整个应用** ——
 * 用户切到设置页时另一条会话跑完了也该收到。
 */
export function useNotifyWatcher(): void {
  /**
   * 点通知要「选中会话」，正好是 `useAppContext()` 的 `openConversation`。
   *
   * 这里不再自己拼 URL：前端路由已移除，点通知与在侧栏点那一行走的是同一条路。
   */
  const { openConversation } = useAppContext()
  /**
   * 当前会话：用来判断「用户是不是正看着出事的那一屏」。
   *
   * ⚠️ 必须在这里（hook 里）取：事件回调可能被 `notify` 内部的异步（desktop 问主进程）
   * 推后执行，那一刻已经不能再调 hook。靠把它放进 effect 依赖，
   * 让订阅回调的闭包每次换会话后都换新值。
   */
  const activeConversationId = useAppContext().app.activeConversationId

  /**
   * 对话侧：直接消费服务端事件。
   *
   * 每条事件 → 至多一条通知（要不要发、走哪条通道由 `notify` 判：总开关关了两边都不发；
   * 否则后台 = 系统通知、前台 = 应用内 toast）。同 tag 互相顶掉，
   * 同一会话连着跑多轮不会在右下角 / 通知中心堆一串。
   */
  useEffect(() => {
    // 运行态（侧栏转圈 / 待办角标）与通知读的是同一条事件流，在这儿一并绑定
    initStateClient()
    initConversationActivity()
    return subscribeServerEvent((event) => {
      // 只认「审批 / 提问 / 跑完」三类；其余（预览文件变化、后台任务清单、各种 *-resolved）跳过
      if (!isConversationNotifyEvent(event)) return
      const { conversationId, options } = conversationNotify(event, activeConversationId)
      notify({ ...options, onClick: () => openConversation(conversationId) })
    })
  }, [openConversation, activeConversationId])
}
