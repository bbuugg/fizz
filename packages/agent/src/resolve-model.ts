/**
 * 由模型配置创建 AI SDK 的模型实例。
 *
 * 单独成文件（不依赖 electron / node-pty）是为了能直接跑真代码做验证：
 * `node --experimental-strip-types scripts/probe-reasoning.mjs` 就能把这里
 * 接上真实网关，实测「思考内容」到底有没有出来 —— 见该脚本。
 */
import { type LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { AiModelConfig } from '@fizz/contracts/types'

// ---------- 兼容网关的「思考内容」归一化 ----------

const sseEncoder = new TextEncoder()

/**
 * 把一行 SSE `data:` 里的「兼容网关怪癖」顺手修掉，再交给 AI SDK 解析：
 * - `delta.tool_calls[].type` 补成 `'function'`：规范要求字面量 `'function'`，但有些网关
 *   （如 StepFun 系）在工具调用的分片里给的是**空串** / 缺省，而 SDK 的 chunk schema 是
 *   `z.literal('function')` —— 差一个字符就整轮 `TypeValidationError`（invalid_union）；
 * - 思考字段统一改写成 `reasoning_content`（各家网关叫法不同，见下方说明）。
 * 不是 data 行、`[DONE]`、解析失败、无需改写 —— 一律原样返回。
 */
export function rewriteSseLine(line: string): string {
  if (!line.startsWith('data:')) return line
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return line
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    return line
  }
  const delta = (json as { choices?: { delta?: Record<string, unknown> }[] })?.choices?.[0]?.delta
  if (!delta || typeof delta !== 'object') return line

  let changed = false

  // ① tool_calls 的 type 归一化：非 'function'（空串 / 缺省）的补成 'function'
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls as Array<Record<string, unknown>>) {
      if (call && typeof call === 'object' && call.type !== 'function') {
        call.type = 'function'
        changed = true
      }
    }
  }

  // ② 思考字段归一化
  if (delta.reasoning_content === undefined) {
    let text = ''
    if (typeof delta.reasoning === 'string') {
      text = delta.reasoning
    } else if (Array.isArray(delta.reasoning_details)) {
      for (const detail of delta.reasoning_details) {
        const t = (detail as { text?: unknown })?.text
        if (typeof t === 'string') text += t
      }
    }
    if (text) {
      delta.reasoning_content = text
      changed = true
    }
  }

  return changed ? `data: ${JSON.stringify(json)}` : line
}

// ---------- 出站请求日志（dev 调试用） ----------

/** 单条请求 / 响应体最多打这么多字符，超长截断（否则一整轮 SSE 会刷屏） */
const DEBUG_BODY_LIMIT = 4000

/**
 * 这些 header 的值一律打码（只留前 4 位）。
 * ⚠️ 日志里**绝不能**出现完整密钥 —— apiKey 就在 Authorization / api-key 里。
 */
const SECRET_HEADER = /^(authorization|proxy-authorization|api-key|x-api-key|x-goog-api-key)$/i

/**
 * 出站日志总开关：`FIZZ_DEBUG_HTTP=1`。
 *
 * 两端统一由仓库根 `.env` 控制（桌面端主进程与服务端都走 `loadEnvFile`，缺省关闭）；
 * 真实环境变量优先于 `.env`，排障时也可以直接在 shell 里设 1。
 */
export function httpDebugEnabled(): boolean {
  return process.env.FIZZ_DEBUG_HTTP === '1'
}

function truncateBody(text: string): string {
  return text.length > DEBUG_BODY_LIMIT
    ? `${text.slice(0, DEBUG_BODY_LIMIT)}…（已截断，共 ${text.length} 字符）`
    : text
}

/** 请求体转可读文本；流 / FormData 之类的略过（dev 里够用，不值得为它做完整序列化） */
function describeRequestBody(body: unknown): string {
  if (body == null) return ''
  if (typeof body === 'string') return truncateBody(body)
  if (body instanceof Uint8Array) return truncateBody(new TextDecoder().decode(body))
  return '<非文本 body（流 / FormData 等），略过>'
}

function describeHeaders(headers: Headers): string {
  const lines: string[] = []
  headers.forEach((value, key) => {
    lines.push(`${key}: ${SECRET_HEADER.test(key) ? `${value.slice(0, 4)}…（已打码）` : value}`)
  })
  return lines.join('\n    ')
}

/**
 * 把 fetch 包一层：出发前打「方法 + URL + 请求头 + 请求体」，回来后打「状态码 + 耗时 + 响应体」。
 *
 * 响应体是**流**（对话走 SSE），所以读日志那一份用 `res.clone()` —— 原流原样返回给调用方，
 * 不改变任何行为。tee 出来的两个分支互不阻塞，流式输出照旧；代价是这一轮的响应体会被
 * clone 缓冲在内存里（dev 专用，可接受）。SSE 的响应体要等整轮结束才会整段打出来。
 *
 * 关掉开关时**直接透传**，不引入任何额外开销。
 */
export function debugHttpFetch(
  ...args: Parameters<typeof globalThis.fetch>
): ReturnType<typeof globalThis.fetch> {
  if (!httpDebugEnabled()) return globalThis.fetch(...args)
  const [input, init] = args
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (
    init?.method ??
    (typeof input === 'object' && !(input instanceof URL) ? input.method : 'GET')
  ).toUpperCase()
  const headers = new Headers(
    init?.headers ??
      (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined)
  )
  const body = describeRequestBody(init?.body)
  const started = Date.now()
  console.log(
    `[http] → ${method} ${url}\n    ${describeHeaders(headers)}${body ? `\n    body: ${body}` : ''}`
  )
  return globalThis
    .fetch(...args)
    .then((res) => {
      console.log(`[http] ← ${res.status} ${res.statusText} ${method} ${url}（${Date.now() - started}ms）`)
      // ⚠️ 必须 clone：直接读 res.body 会把调用方要消费的那条流吃掉
      void res
        .clone()
        .text()
        .then((text) => console.log(`[http]   res: ${truncateBody(text)}`))
        .catch(() => undefined)
      return res
    })
    .catch((err: unknown) => {
      console.log(
        `[http] ✗ ${method} ${url}（${Date.now() - started}ms）${err instanceof Error ? err.message : String(err)}`
      )
      throw err
    })
}

/**
 * 归一化 fetch：把 SSE 流里各家的思考字段统一改写成 `reasoning_content`。
 *
 * OpenAI 官方的 chat-completions 协议里没有「思考」这个概念，各家兼容网关就各造了一套：
 * - GLM / airouter / StepFun：`delta.reasoning_content`（字符串）
 * - OpenRouter：`delta.reasoning`（字符串）+ `delta.reasoning_details`（数组）
 *
 * 服务两条路：
 * 1. **`openai` kind 的 chat-completions 分支**（`createOpenAI().chat()`）—— 这里两件事都需要：
 *    官方实现对思考字段一个都不解析（reasoning 恒 0 字），且它的 chunk schema 是
 *    `z.literal('function')`，网关把 `tool_calls[].type` 给成空串就整轮 `TypeValidationError`；
 * 2. **`openai-compatible` kind**（`@ai-sdk/openai-compatible`）—— 它自己就认
 *    `reasoning_content ?? reasoning`、也完全不看 `tool_calls[].type`，挂这层只为把
 *    OpenRouter 那种 `reasoning_details` 数组归一成字符串（否则那家会丢思考内容）。
 *
 * 所以别把这里当成「openai-compatible 的补丁」删掉 —— 删了第 1 条路立刻坏。
 */
export function normalizeReasoningFetch(
  ...args: Parameters<typeof globalThis.fetch>
): ReturnType<typeof globalThis.fetch> {
  // 走 debugHttpFetch：这样「兼容网关」这条路也照样有出站日志（日志读的是 clone，不影响改写）
  return debugHttpFetch(...args).then((res) => {
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.body || !contentType.includes('text/event-stream')) return res

    let buffer = ''
    const decoder = new TextDecoder()
    const stream = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true })
          const lines = buffer.split('\n')
          // 最后一段可能是被切断的半行，留在缓冲里等下一块
          buffer = lines.pop() ?? ''
          if (!lines.length) return
          controller.enqueue(sseEncoder.encode(lines.map(rewriteSseLine).join('\n') + '\n'))
        },
        flush(controller) {
          buffer += decoder.decode()
          if (buffer) controller.enqueue(sseEncoder.encode(rewriteSseLine(buffer)))
        }
      })
    )
    const headers = new Headers(res.headers)
    // 体积/编码已变，留着会让上层按错误的长度或压缩方式解析
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(stream, { status: res.status, statusText: res.statusText, headers })
  })
}

/**
 * 根据配置创建对应 provider 的模型实例（agent 服务复用）。
 *
 * `openai-compatible` 走**专门的** `@ai-sdk/openai-compatible`（以前是拿 deepseek 的实现兼职，
 * 因为只有它会解析 `reasoning_content`）。换过来的三个理由：
 * 1. 它原生解析 `reasoning_content ?? reasoning`（流式与非流式都认）；
 * 2. 它的 chunk schema **根本不看 `tool_calls[].type`** —— 网关给空串也不会 `TypeValidationError`；
 * 3. 思考强度走 OpenAI 原生的 `reasoning_effort`，不注入 DeepSeek 专属的 `thinking: {…}`。
 *
 * 而 deepseek 兼职那套有三个副作用（对非 deepseek 模型 id 全部命中）：`isDeepSeekV4Model()`
 * 不匹配即返回 true → 每条 assistant 历史都被塞 `reasoning_content: ""`、有思考内容时整段回传；
 * 同一判定让 `isThinkingEnabled` 恒真 → **`temperature` / `top_p` 被静默丢弃**；设了思考强度时
 * 还会往请求体里塞 DeepSeek 的 `thinking` 字段。严格网关（OpenAI 官方 / Azure）会因此 400。
 *
 * ⚠️ `@ai-sdk/openai-compatible` **没有 Responses API**（只有 chat/completions + 老 `/completions`
 * + embedding + image），所以 `apiStyle: 'responses'` 那条路仍归 `@ai-sdk/openai`。
 * ⚠️ 它的 `includeUsage` **没有默认值**：不传就不发 `stream_options.include_usage`，流式响应里
 * 拿不到 usage（上下文圆环的「已用」会永远是空、压缩只能靠估算）—— 所以这里显式传 true。
 *
 * 每个 provider 都挂了出站日志：`debugHttpFetch`（SSE 归一化那条路是 normalizeReasoningFetch，
 * 它内部也走 debugHttpFetch）。**模型网关的请求只有这里能看到** —— 桌面端渲染进程走 IPC 不出网，
 * dev 下要看就得靠它；`FIZZ_DEBUG_HTTP=1` 才生效，否则完全透传。
 */
export function resolveModel(config: AiModelConfig): LanguageModel {
  switch (config.kind) {
    case 'anthropic': {
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        fetch: debugHttpFetch
      })
      return provider(config.model)
    }
    case 'deepseek': {
      const provider = createDeepSeek({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        fetch: normalizeReasoningFetch
      })
      return provider(config.model)
    }
    case 'google': {
      const provider = createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        fetch: debugHttpFetch
      })
      return provider(config.model)
    }
    case 'openai-compatible': {
      const style = config.apiStyle ?? 'chat-completions'
      if (style === 'responses') {
        // 兼容包里没有 Responses 实现，这条路只能借用官方包（网关得真支持 /v1/responses）
        const provider = createOpenAI({
          apiKey: config.apiKey ?? 'EMPTY',
          baseURL: config.baseURL,
          fetch: debugHttpFetch
        })
        return provider.responses(config.model)
      }
      /**
       * `baseURL` 是**必填**的：这个包没有兜底端点（deepseek / openai 都有默认域名），
       * 缺了会拼出 `undefined/chat/completions` 这种非法 URL。宁可在这里给人话。
       */
      const baseURL = config.baseURL?.trim()
      if (!baseURL) {
        throw new Error('「OpenAI 兼容」类型必须填写 baseURL（如 https://openrouter.ai/api/v1）')
      }
      const provider = createOpenAICompatible({
        // provider 名：只用于 `providerOptions['openai-compatible']` 的命名空间，本项目不传 providerOptions
        name: 'openai-compatible',
        apiKey: config.apiKey ?? 'EMPTY',
        baseURL,
        // 不传就不发 stream_options.include_usage → 流式拿不到 usage（见上面的注释）
        includeUsage: true,
        fetch: normalizeReasoningFetch
      })
      return provider(config.model)
    }
    case 'openai':
    default: {
      // openai 官方：默认 Responses API（官方 chat-completions 里本就没有思考内容可解析）
      const style = config.apiStyle ?? 'responses'
      if (style === 'chat-completions') {
        // 显式用 chat-completions（常见于「openai 类型 + 兼容网关」）时同样过一遍归一化：
        // 修网关的 tool_calls.type / 思考字段怪癖，否则一发起工具调用就会 schema 校验失败
        const provider = createOpenAI({
          apiKey: config.apiKey ?? 'EMPTY',
          baseURL: config.baseURL,
          fetch: normalizeReasoningFetch
        })
        return provider.chat(config.model)
      }
      const provider = createOpenAI({
        apiKey: config.apiKey ?? 'EMPTY',
        baseURL: config.baseURL,
        fetch: debugHttpFetch
      })
      return provider.responses(config.model)
    }
  }
}
