/**
 * 浏览器原生语音输入（Web Speech API）。
 *
 * 只用 `SpeechRecognition` / `webkitSpeechRecognition`，不引入第三方依赖 ——
 * Chrome / Edge / Safari 都内置了，项目里没有语音库，也没必要为了这一个功能
 * 去装一个。
 *
 * 设计上**只做语音这一摊事**：收音、识别、把最终文本抛给调用方。
 * 文本怎么并到输入框是调用方的事 —— Composer 是受控组件，value 归调用方管，
 * 这里不碰 textarea，免得跟「编辑并重发」这类往里灌文本的入口打架。
 *
 * - `continuous: true`：一段话说完不停，继续收，直到用户点停或浏览器主动结束。
 * - `interimResults: true`：边说边显临时结果，`onTranscript` 只在**最终确认**
 *   （一段话的停顿点）时触发一次 —— 临时文本不会污染输入框。
 * - 回调用 ref 存，避免闭包陷阱（start/stop 在依赖数组里没列它，不能直接引用）。
 * - 启动看门狗：`start()` 成功不代表引擎真的接了麦克风。`START_TIMEOUT_MS` 内没等到
 *   `audiostart` / `speechstart` / `result` 就 abort 并回调 `onUnavailable`，把「按钮
 *   亮着但没收音」的静默失败变成明确错误。
 */
import { useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// 浏览器原生 SpeechRecognition 类型。
//
// 这个项目的 TypeScript（7.0.2）lib 里不带 Web Speech API 的类型声明，
// 而 `SpeechRecognition` 又是可选 API（Safari 桌面端没有、Chrome 有但要前缀），
// 标准库里干脆没收。这里自己声明一份最小集合，只覆盖本 hook 真正用到的几个
// 属性 —— 够用就行，别把整个 API 面都抄一遍（抄漏了反而报错）。
// ---------------------------------------------------------------------------
interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResult {
  readonly length: number
  readonly isFinal: boolean
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
}

interface SpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null
  onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  onend: ((this: SpeechRecognition, ev: Event) => void) | null
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
  start(): void
  stop(): void
  abort(): void
}

declare var SpeechRecognition: {
  prototype: SpeechRecognition
  new (): SpeechRecognition
}

declare var webkitSpeechRecognition: {
  prototype: SpeechRecognition
  new (): SpeechRecognition
}

/**
 * 点开麦后多久没有收到 `audiostart`（麦克风真的开始采集）就判定识别服务没接管音频（ms）。
 *
 * 为什么需要：`start()` 是乐观置位 —— 只要它没同步抛错，按钮就变成「录音中」。
 * 有些环境（国产 Chromium 壳、识别服务不可达的 Chrome）构造器存在、`start()` 也
 * 不抛错，但引擎从不打开麦克风，也不发任何事件 —— 用户看到的就是「按钮亮着，
 * 什么都没发生」。这个看门狗把那类静默失败变成一次明确的失败回调。
 *
 * 只看 `onstart` 不够：它只说明服务接受了这次请求，不代表音频被采集。`onspeechstart`
 * / `onresult` 也认（有人说话 / 出了结果，显然已经在收）。
 */
const START_TIMEOUT_MS = 6000

/** 麦克风权限是否还在等用户确认（浏览器不支持查询时按「不在等」处理） */
async function micPermissionPending(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state === 'prompt'
  } catch {
    return false
  }
}

export interface UseVoiceInputOptions {
  /** 收到最终识别结果时的回调（一段话说完、停顿点触发） */
  onTranscript: (text: string) => void
  /** 语言代码，默认跟随浏览器 */
  lang?: string
  /**
   * 连续静音多少毫秒后自动停止收听。浏览器对停顿很敏感（`continuous: true` 也会在
   * 半句话后 `onend`），本 hook 会在这类非主动 `onend` 上自动续听；这个超时才是
   * 真正「何时停」的闸门：一段时间没有新识别结果就停。0 / 负 = 不自动停，一直听到手动停。
   */
  silenceTimeoutMs?: number
  /**
   * 识别引擎在 `START_TIMEOUT_MS` 内没有发出任何「开始收声音」事件时的回调。
   * 「按钮亮着、麦克风其实没开」这类静默失败靠它告诉用户，而不是一直假装在录。
   */
  onUnavailable?: () => void
}

export interface UseVoiceInputResult {
  /** 浏览器是否支持语音识别 */
  supported: boolean
  /** 是否正在收听 */
  listening: boolean
  /** 当前临时识别结果（边说边显，未最终确认；停止后清空） */
  interim: string
  /** 开始收听。返回是否**真的**开启了：false = 本来就在听（如已由按钮开启），没接管。 */
  start: () => boolean
  /** 停止收听 */
  stop: () => void
}

export function useVoiceInput({
  onTranscript,
  lang,
  silenceTimeoutMs,
  onUnavailable
}: UseVoiceInputOptions): UseVoiceInputResult {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const recRef = useRef<SpeechRecognition | null>(null)
  const onTranscriptRef = useRef(onTranscript)
  const onUnavailableRef = useRef(onUnavailable)
  const langRef = useRef(lang)
  /** 静音超时（ms）的 ref：onresult / onend 的闭包只随会话建一次，得从 ref 读最新值 */
  const silenceTimeoutRef = useRef(silenceTimeoutMs)
  /** 是不是「用户主动要停」（点停止钮 / 静音超时到点）。onend 靠它区分续听还是收尾 */
  const stopRequestedRef = useRef(false)
  /** 续听重启定时器：浏览器遇停顿 onend 后，隔一小会儿再 start() */
  const restartTimerRef = useRef<number | null>(null)
  /** 静音超时定时器：这段时间没有新识别结果就停 */
  const silenceTimerRef = useRef<number | null>(null)
  /** 启动看门狗：这段时间内没有 audiostart 就判定识别服务没接管音频 */
  const startTimerRef = useRef<number | null>(null)
  /** 启动看门狗是否已经为「权限弹窗」延长过一轮（每次用户点开麦重置） */
  const startExtendedRef = useRef(false)
  /** 「正在听」的同步镜像：start 的重入守卫要在同一 tick 内准（React state 更新是异步的，
   *  只看 listening 会在连着两次 start 之间漏判，导致重复 start 抛错）。onend / onerror
   *  结束后由下面的 useEffect 同步回来。 */
  const listeningRef = useRef(false)
  /** start() 退避重试定时器：识别刚被 stop 过、还没 settle 时 Chrome 会抛
   *  InvalidStateError，等它 settle 一会儿再重试，避免「第二次按没反应」。 */
  const retryTimerRef = useRef<number | null>(null)

  // 保持回调 / 配置引用最新，避免 start/stop 的闭包拿到旧值
  useEffect(() => {
    onTranscriptRef.current = onTranscript
    onUnavailableRef.current = onUnavailable
  })
  useEffect(() => {
    langRef.current = lang
  }, [lang])
  useEffect(() => {
    silenceTimeoutRef.current = silenceTimeoutMs
  }, [silenceTimeoutMs])
  // 识别被浏览器结束（onend / onerror）时 listening 会变false，这里把镜像同步回去，
  // 免得 listeningRef 卡在 true 让下一次 start 被重入守卫挡掉。
  useEffect(() => {
    listeningRef.current = listening
  }, [listening])

  const clearRestartTimer = (): void => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current)
      restartTimerRef.current = null
    }
  }
  const clearSilenceTimer = (): void => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }
  const clearRetryTimer = (): void => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }
  const clearStartTimer = (): void => {
    if (startTimerRef.current !== null) {
      clearTimeout(startTimerRef.current)
      startTimerRef.current = null
    }
  }
  const clearTimers = (): void => {
    clearRestartTimer()
    clearSilenceTimer()
    clearRetryTimer()
    clearStartTimer()
  }

  /** 看门狗到点后的收尾：收掉「录音中」，并把失败告诉调用方 */
  const failStart = (): void => {
    stopRequestedRef.current = true
    clearRestartTimer()
    clearSilenceTimer()
    clearRetryTimer()
    try {
      recRef.current?.abort()
    } catch {
      /* ignore */
    }
    listeningRef.current = false
    setListening(false)
    setInterim('')
    onUnavailableRef.current?.()
  }

  /**
   * 武装启动看门狗。
   *
   * 已有看门狗时**不重置**：onend 自动续听的链路会频繁重建识别（有的环境一句都
   * 没开始就立刻 onend），每重建一次就往后推计时的话，看门狗永远等不到触发。
   */
  const armStartTimer = (): void => {
    if (startTimerRef.current !== null) return
    startTimerRef.current = window.setTimeout(() => {
      startTimerRef.current = null
      if (!listeningRef.current) return
      void (async () => {
        /*
         * 麦克风权限弹窗还开着时先不判失败：用户可能只是还没点到「允许」。
         * 只延长一轮，免得某个权限状态永远停在 prompt 的环境把看门狗架空。
         */
        const pending = !startExtendedRef.current && (await micPermissionPending())
        // 等权限查询的这一下里用户可能已经点了停：别再补一次失败提示
        if (!listeningRef.current) return
        if (pending) {
          startExtendedRef.current = true
          armStartTimer()
          return
        }
        failStart()
      })()
    }, START_TIMEOUT_MS)
  }

  /** 重新武装静音超时：每次开始 / 每来一次识别结果都重置（这批结果到点后若还静默就停） */
  const armSilenceTimer = (): void => {
    clearSilenceTimer()
    const ms = silenceTimeoutRef.current
    if (!ms || ms <= 0) return
    silenceTimerRef.current = window.setTimeout(() => {
      silenceTimerRef.current = null
      // 到点 = 用户不想再说了：标记成「主动停」，让 onend 走收尾分支而不是续听
      stopRequestedRef.current = true
      clearRestartTimer()
      clearStartTimer()
      try {
        recRef.current?.stop()
      } catch {
        /* ignore */
      }
      setListening(false)
      setInterim('')
    }, ms)
  }

  useEffect(() => {
    // 只在浏览器环境跑，SSR 安全
    if (typeof window === 'undefined') return
    const Win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognition
      webkitSpeechRecognition?: new () => SpeechRecognition
    }
    const SR = Win.SpeechRecognition || Win.webkitSpeechRecognition
    if (!SR) {
      setSupported(false)
      return
    }
    setSupported(true)

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = langRef.current || navigator.language || 'zh-CN'
    /*
     * 「麦克风真的开始收声音」的信号才算启动成功，撤掉看门狗。
     * 刻意**不认 `onstart`**：它只代表服务接受了请求（有些环境会先报 start、实际
     * 没接麦克风），正是要抓的那种静默失败。
     */
    const engineAlive = (): void => {
      clearStartTimer()
    }
    rec.onaudiostart = engineAlive
    rec.onspeechstart = engineAlive
    rec.onresult = (e: SpeechRecognitionEvent) => {
      clearStartTimer()
      let final = ''
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const last = result[result.length - 1]
        if (result.isFinal) {
          final += last.transcript
        } else {
          interimText += last.transcript
        }
      }
      if (final.trim()) {
        onTranscriptRef.current(final.trim())
      }
      setInterim(interimText)
      // 来结果 = 人在说：重置静音闸门
      armSilenceTimer()
    }
    /**
     * onend：浏览器自己结束了识别（用户点停 / 停顿被端点检测掐断 / 出错后续）。
     * 只有当**不是用户主动停**时才续听 —— 这正是治「刚说了半句就停」的关键。
     */
    rec.onend = () => {
      if (stopRequestedRef.current) {
        setListening(false)
        setInterim('')
        return
      }
      // 隔一小会儿再 start：onend 后立刻 start 在部分浏览器（Chrome）会抛
      // InvalidStateError / 报 network，给一点喘息更稳。期间保持 listening，按钮不闪。
      clearRestartTimer()
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null
        const r = recRef.current
        if (!r || stopRequestedRef.current) return
        try {
          r.start()
          setListening(true)
          armSilenceTimer()
          armStartTimer()
        } catch {
          // 重启失败（极端）：当作结束
          setListening(false)
          setInterim('')
        }
      }, 120)
    }
    // 致命错误（没权限 / 网络 / 采集不到音频）别再续听，否则会无限重启；
    // 非致命（no-speech 说话停顿、aborted）交给 onend 处理（多半会续听）。
    const FATAL_ERRORS = new Set([
      'network',
      'not-allowed',
      'service-not-allowed',
      'audio-capture',
      'language-not-supported',
      'bad-grammar'
    ])
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (FATAL_ERRORS.has(e.error)) {
        stopRequestedRef.current = true
        clearTimers()
        setListening(false)
        setInterim('')
      }
    }
    recRef.current = rec

    return () => {
      clearTimers()
      stopRequestedRef.current = true
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
    }
    // rec 只建一次（一次收听会话里常驻）；这里引用的 armSilenceTimer / clearTimers
    // 内部只读 ref、写定时器，把它们列进依赖会让 effect 每次渲染重建会话、打断收听。
    // 与 TerminalPanel 那个「只建一次」的 effect 同样处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = (): boolean => {
    const rec = recRef.current
    if (!rec || listeningRef.current) return false
    stopRequestedRef.current = false
    startExtendedRef.current = false
    clearRestartTimer()
    clearRetryTimer()
    // 真正把识别拉起来的那一下：成功就点亮 listening（图标跟着变），失败则退避重试。
    const attempt = (): void => {
      try {
        rec.start()
        listeningRef.current = true
        setListening(true)
        armSilenceTimer()
        armStartTimer()
      } catch {
        // 多半是「刚 stop() 过、识别还没 settle」——Chrome 会抛 InvalidStateError。
        // 「按住说话」场景下这是常态（松手再按），等 150ms 重试一次；用户若已松手
        // （stopRequestedRef 为 true）就不再重试。
        if (stopRequestedRef.current) return
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          if (stopRequestedRef.current || listeningRef.current) return
          attempt()
        }, 150)
      }
    }
    attempt()
    return true
  }

  const stop = () => {
    // 先标记主动停，再停识别：onend 回来后才会走收尾、不会又给续听起来
    stopRequestedRef.current = true
    clearTimers()
    const rec = recRef.current
    if (rec && listeningRef.current) {
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
    }
    listeningRef.current = false
    setListening(false)
    setInterim('')
  }

  return { supported, listening, interim, start, stop }
}