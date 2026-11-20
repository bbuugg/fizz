/**
 * SSE（Server-Sent Events）工具：在 Next.js Route Handler 里实现 SSE 流。
 *
 * 替代 Hono 的 `streamSSE`：用标准 ReadableStream，手动编 SSE 帧
 * （`event:` / `data:` / 空行）。
 */

/** SSE 帧的编码格式 */
export interface SseEncoder {
  event: string
  data: string
}

/** 编码一条 SSE 帧 */
export function encodeSSE({ event, data }: SseEncoder): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/**
 * 链路心跳间隔。
 *
 * 15s 是「比任何常见空闲超时都短、又不至于把日志刷花」的取值：nginx 的
 * `proxy_read_timeout` 缺省 60s，各类本地代理 / 安全软件的静默超时普遍在 30~120s。
 */
const HEARTBEAT_MS = 15_000

/** 心跳本身：SSE 的**注释行**（以 `:` 开头），不是事件，客户端只认 `data:` 行会天然忽略 */
const HEARTBEAT_FRAME = ': keep-alive\n\n'

/**
 * 创建一条 SSE 流。
 *
 * @param onStream 接收一个 `writer` 对象，可以 `write` 帧 / `close` 流。
 *                 返回的 Promise resolve 后流自动关闭。
 */
export function createSSEStream(
  onStream: (
    writer: {
      write: (frame: SseEncoder) => Promise<void>
      close: () => void
    },
    /**
     * 「读端已经走了」的信号（见下面 ReadableStream 的 `cancel`）。
     *
     * 语义严格限定为**连接层**：它只说明这条 HTTP 连接没了，服务端那一轮**不因此中止**
     * （要停它得显式调 abort 端点）。`pipeRun` 拿它从「等下一帧」的挂起里醒来、把订阅者
     * 摘掉。
     */
    clientGone: AbortSignal
  ) => Promise<void>
): Response {
  const encoder = new TextEncoder()
  /** 读端断开时置位（连接断了 / 渲染端 closeSse / 桥主动 cancel） */
  const gone = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      /**
       * 应用层心跳（间隔与取值理由见 `HEARTBEAT_MS`）。
       *
       * 为什么要它：SSE 是**哑**通道 —— 没有帧的时候链路上一个字节都没有，而一条对话
       * 流在「模型憋长回答 / agent 在跑长工具 / agent 卡住」时静默几分钟是常态。链路
       * 上任何一环的空闲超时（系统代理 / 安全软件 / 休眠唤醒 / 标签页冻结）都会把它
       * 当死连接掐掉，用户看到的是「连接中断，正在重连」+ 列表回放（实测踩过）。
       * 终端 WS 早就因为同样的理由加了应用层心跳（见 `packages/agent-ui` 的
       * `lib/terminal-liveness.ts`），这里补上同一件事。
       *
       * 注释帧不动协议：客户端 `readSseFrames` 只认 `data:` 行，收到它等于什么都没收到。
       */
      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(HEARTBEAT_FRAME))
        } catch {
          // 客户端已经走了
        }
      }, HEARTBEAT_MS)
      // 别让心跳吊住进程（桌面端是进程内直连，退出时不该被它多拖 15 秒）
      heartbeat.unref?.()
      const writer = {
        async write(frame: SseEncoder) {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(encodeSSE(frame)))
          } catch {
            // 客户端已经走了
          }
        },
        close() {
          if (closed) return
          closed = true
          try {
            controller.close()
          } catch {
            // 已经关了
          }
        }
      }
      try {
        await onStream(writer, gone.signal)
      } finally {
        clearInterval(heartbeat)
        writer.close()
      }
    },
    /** 唤醒 pipeRun 的挂起写泵，让它清理订阅；断开本身不会中止 run。 */
    cancel() {
      gone.abort()
    }
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  })
}
