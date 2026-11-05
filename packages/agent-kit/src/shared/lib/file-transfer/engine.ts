/**
 * 传输引擎：分片上传 / 下载的编排（模块级，**不绑组件生命周期**）。
 *
 * 为什么在模块级而不是组件里：传输要活得比发起它的组件长 —— SFTP 面板关掉、切标签、
 * 面板被回收，传输都得继续跑并继续被传输徽标看见。所以现场在 store（`transfer` slice）、
 * 编排在这里，两边都不随组件挂载卸载。
 *
 * 进度 / 速度 / 取消三件事的分工：
 * - **进度**由分片自己算（`done / size`），不依赖任何「一次请求内部的字节进度」——
 *   一次请求只有 4MB，那个粒度既没必要、还会和分片进度打架。
 * - **速度**在 `plan.ts` 的 `nextSpeed`（EWMA）。
 * - **取消**：`cancelTransfer(id)` 打断在途请求；上传**还要**通知服务端销毁写流并删掉
 *   远端半份文件（见下）。
 */
import { SFTP_CHUNK_BYTES } from '@fizz/contracts/agent-api'
import type { SftpAbortInput } from '@fizz/contracts/agent-api'
import { toast } from 'sonner'
import type { AgentApi } from '@fizz/agent-client/api'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { joinSftpPath } from '@fizz/agent-kit/shared/lib/sftp-path'
import { createSink, type TransferSink } from '@fizz/agent-kit/shared/lib/file-transfer/sink'
import { nextSpeed, planUploadChunks } from '@fizz/agent-kit/shared/lib/file-transfer/plan'

export interface RunUploadInput {
  file: File
  hostId: string
  /** 主机显示名（清单里要能区分「传到哪台机器」） */
  hostLabel: string
  /** 远端目标目录 */
  dir: string
}

export interface RunDownloadInput {
  hostId: string
  hostLabel: string
  /** 远端文件绝对路径 */
  path: string
  /** 落盘用的文件名 */
  name: string
  /** 总字节（取目录项里的 `size`，**不要**为它多发一次 stat） */
  size: number
  /**
   * 覆盖落盘方式（不给就用 `createSink` 的三态自动选）。
   *
   * 目前只有一个用处：**文件夹下载**（`SftpPanel` 的 `downloadDir`）逐文件调本函数，
   * 走 `createSink` 会每个文件弹一次保存框 —— 50 个文件点 50 次。那里显式传
   * `createBlobSink`，保持「浏览器自己往下载目录里放」的老行为。
   */
  sink?: () => Promise<TransferSink | null>
}

/** 用户取消：与控制流里的其他异常分开，好在收场时区分 `canceled` 与 `failed` */
class TransferCanceled extends Error {
  constructor() {
    super('已取消')
  }
}

/**
 * 活跃传输：`AbortController` + 上传取消时要发给服务端的载荷。
 *
 * ⚠️ **不进 store**：`AbortController` 放进去会破坏可序列化，也会让 devtools 快照没法看。
 * ⚠️ 载荷（`hostId` / `dir` / `name`）**跟着控制器一起存**，而不是让 `cancelTransfer` 从
 * store 里的 `remotePath` 反推目录 —— 反推要切字符串，改天 `remotePath` 的拼法一动就静默错。
 */
interface ActiveTransfer {
  controller: AbortController
  /** 仅上传有：取消时通知服务端销毁写流并清掉远端半份文件 */
  abort?: SftpAbortInput
}

const active = new Map<string, ActiveTransfer>()

/** 生成传输 id。`crypto.randomUUID` 在 `file://` / 非安全上下文下可能没有，退化成时间戳 */
function newTransferId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return `t-${c?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

/**
 * 取全局 API 客户端（带 token 与宿主桥）。
 *
 * ⚠️ **不要**在这里自己 `createApi()`：那个客户端的传输层是宿主注入的（web 是
 * `globalThis.fetch`，desktop 是 preload 的 IPC 桥），鉴权头要靠 store 里当前连接的 token
 * —— 自建的那个既拿不到 token 也拿不到宿主桥。未连接时返回 null，由调用方提示。
 */
function getApi(): AgentApi | null {
  return useAgentStore.getState().getApi()
}

/**
 * base64 编码（分片上传的载荷）。
 *
 * ⚠️ **必须分块** `String.fromCharCode`：4MB 的字节数组一次性展开成实参（`...bytes`）
 * 会直接爆调用栈（V8 的实参上限约 6 万），而且那个报错是 `RangeError: Maximum call
 * stack size exceeded`，看起来像别的地方出的问题。
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** base64 解码（分片下载的应答）。与 `shared/lib/pick-file.ts` 的同名函数同一套 */
function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `runUpload` 的终态。没有 `skipped`：上传不需要用户先选落点，永远发得出去 */
export type UploadOutcome = 'done' | 'failed' | 'canceled'

/**
 * 上传一个文件到 `dir/name`（分片串行）。
 *
 * 不抛：一切结果都落成清单里那条任务的终态（`done` / `failed` / `canceled`），**并回给
 * 调用方** —— 调用方（SftpPanel / TerminalPanel）逐文件 `await` 它，只为了知道「这一个
 * 传完了，接着下一个」，以及最后能报一句「几项成功 / 几项失败」。不该为每个调用点包一层
 * try/catch。
 */
export async function runUpload(input: RunUploadInput): Promise<UploadOutcome> {
  const api = getApi()
  if (!api) {
    toast.error('尚未连接到服务端，无法上传')
    return 'failed'
  }
  const { file, hostId, hostLabel, dir } = input
  const store = useAgentStore.getState()
  const id = newTransferId()

  store.addTransfer({
    id,
    kind: 'upload',
    hostId,
    hostLabel,
    name: file.name,
    remotePath: joinSftpPath(dir, file.name),
    size: file.size,
    done: 0,
    status: 'active',
    startedAt: Date.now(),
    speed: 0
  })

  const controller = new AbortController()
  active.set(id, {
    controller,
    abort: { hostId, dir, name: file.name, transferId: id }
  })

  try {
    const plan = planUploadChunks(file.size, SFTP_CHUNK_BYTES)
    let speed = 0
    let lastAt = performance.now()

    /**
     * ⚠️ **必须 `for` + `await` 串行，改成 `Promise.all` 会静默损坏文件**：
     * 服务端按 `index === 0` 用 `'w'` 截断创建、其余用 `'a'` 追加，而**追加的顺序就是
     * 到达的顺序** —— 服务端手里没有任何序号可以用来校验或重排（无状态协议）。并发下发
     * 会让分片乱序落盘，得到一个「大小对、内容错」的文件：**不报错、不失败**，
     * 直到用户打开才发现。这是本改造唯一会静默出错的地方。
     */
    for (const part of plan) {
      /**
       * 用户点了取消：**下一片都不再发**。
       *
       * ⚠️ 不能只指望 `signal` 把在途请求打断 —— desktop 的 IPC 桥不转发 `AbortSignal`
       * （见 `cancelTransfer`），那边 `abort()` 只是把 signal 置位、请求照旧跑到底。
       * 少了这一句，取消要等到「服务端主动回 canceled」才有机会生效；而服务端若不知道
       * （见下面的 `transferId`），就一路传到 100% 变成「已完成」—— 用户看到的就是
       * 「点了取消没反应」。
       */
      if (controller.signal.aborted) throw new TransferCanceled()

      const bytes = new Uint8Array(await file.slice(part.start, part.end).arrayBuffer())
      /**
       * ⚠️ `transferId` **每一片都必须带**：服务端按它登记这一片的取消函数
       * （`sftp.ts` 的 `writeFile` → `transfers` map），`POST /api/sftp/abort` 靠它
       * 销毁在途写流并删掉半份文件。漏了它服务端只能用一个临时 key
       * （`ul-${Date.now()}-${name}`，每片都不同），`sftpAbort` 永远命中不了 ——
       * 取消就只剩「客户端不发下一片」，远端还留着一个内容完整但只有前几片的坏文件。
       */
      const result = await api.sftpUploadChunk(
        {
          hostId,
          dir,
          name: file.name,
          index: part.index,
          transferId: id,
          dataBase64: bytesToBase64(bytes)
        },
        { signal: controller.signal }
      )
      // 服务端回了「已取消」（用户在别处点了取消、或服务端先停）——按取消收场
      if (result.canceled) throw new TransferCanceled()

      const now = performance.now()
      speed = nextSpeed(speed, part.end - part.start, now - lastAt)
      lastAt = now
      useAgentStore.getState().patchTransfer(id, { done: part.end, speed })
    }

    /**
     * 最后一次检查：取消可能正好落在「最后一片刚成功」那一瞬。不挡的话这条会报 `done`，
     * 而用户明明点了取消 —— 清单里「已取消」自己跳成「已完成」就是从这里来的。
     */
    if (controller.signal.aborted) throw new TransferCanceled()

    useAgentStore.getState().settleTransfer(id, 'done')
    return 'done'
  } catch (err) {
    if (err instanceof TransferCanceled || controller.signal.aborted) {
      useAgentStore.getState().settleTransfer(id, 'canceled')
      return 'canceled'
    }
    useAgentStore.getState().settleTransfer(id, 'failed', { error: describe(err) })
    return 'failed'
  } finally {
    active.delete(id)
  }
}

/** `runDownload` 的终态；`skipped` = 用户在选择落点时取消了（**一个请求都没发**） */
export type DownloadOutcome = 'done' | 'failed' | 'canceled' | 'skipped'

/**
 * 下载远端 `path` 到本机（分片串行，边收边落盘）。
 *
 * 不抛，理由同 `runUpload`；但**回终态**，因为文件夹下载要按文件统计成败
 * （`SftpPanel` 的 `downloadDir`）—— 让它去 store 里按 `remotePath` 反查是又脆又绕。
 */
export async function runDownload(input: RunDownloadInput): Promise<DownloadOutcome> {
  const api = getApi()
  if (!api) {
    toast.error('尚未连接到服务端，无法下载')
    return 'skipped'
  }
  const { hostId, hostLabel, path, name, size } = input

  /**
   * ⚠️ **先开 sink（= 先让用户选落点）再记任务**：用户在保存框里点取消时，`createSink`
   * 回 `null`，这里**一个分片请求都不发、清单里也不留任何记录**。反过来先 `addTransfer`
   * 的话，用户会看到一条永远停在 0% 的「已取消」，还得自己清掉。
   */
  const sink = await (input.sink ? input.sink() : createSink(name))
  if (!sink) return 'skipped'

  const id = newTransferId()
  useAgentStore.getState().addTransfer({
    id,
    kind: 'download',
    hostId,
    hostLabel,
    name,
    remotePath: path,
    size,
    done: 0,
    status: 'active',
    startedAt: Date.now(),
    speed: 0
  })

  const controller = new AbortController()
  active.set(id, { controller })

  try {
    // 空文件：一个请求都不发（`eof` 判定在 size === 0 上没有意义），直接把落点收尾
    if (size <= 0) {
      await sink.close()
      // 空文件也一样：`close()` 期间点了取消就按取消收场（与下面的成功路径同一条规矩）
      if (controller.signal.aborted) throw new TransferCanceled()
      useAgentStore.getState().settleTransfer(id, 'done', { localPath: sink.localPath ?? undefined })
      return 'done'
    }

    let offset = 0
    let speed = 0
    let lastAt = performance.now()

    // 串行，理由同 runUpload（下载侧是顺序追加到 sink，乱序同样会写坏）
    while (offset < size) {
      // 取消检查同 runUpload：desktop 那条 IPC 桥不转发 signal，只能自己查
      if (controller.signal.aborted) throw new TransferCanceled()

      const length = Math.min(SFTP_CHUNK_BYTES, size - offset)
      const res = await api.sftpDownloadChunk(
        { hostId, path, offset, length },
        { signal: controller.signal }
      )
      const bytes = base64ToBytes(res.dataBase64)

      /**
       * 取消可能刚好在这一片在途时发生（desktop 的 abort 拦不住它）—— 返回之后再看一眼：
       * 用户已经不要这次下载了，这批字节就不该再往落点里写（FSA 支 abort 之后再 write 还会抛）。
       */
      if (controller.signal.aborted) throw new TransferCanceled()

      /**
       * ⚠️ 防御分支：**0 字节且 `eof === false`** 是异常（正常只会出现在 `offset` 恰好
       * 落在文件末尾且 `eof === true` 时）。放过去的话 `offset` 一动不动 = 死循环，
       * 表现是清单里那条进度永远卡住、网络请求一直发 —— 比报错难查得多。
       */
      if (bytes.length === 0 && !res.eof) {
        throw new Error(`远端在偏移 ${offset} 处提前结束（服务端回了 0 字节却没标记 eof）`)
      }

      if (bytes.length > 0) {
        await sink.write(bytes)
        const now = performance.now()
        speed = nextSpeed(speed, bytes.length, now - lastAt)
        lastAt = now
        offset += bytes.length
        useAgentStore.getState().patchTransfer(id, { done: offset, speed })
      }

      if (res.eof) break
    }

    await sink.close()
    // 同上传：最后一片刚落地时点了取消，不该报 done（用户点的取消要算数）
    if (controller.signal.aborted) throw new TransferCanceled()
    useAgentStore.getState().settleTransfer(id, 'done', { localPath: sink.localPath ?? undefined })

    /**
     * ⚠️ **不静默降级**：第三支（Firefox / Safari 没有 FSA）是把字节攒在内存里、
     * 结束时才 `Blob` 另存为 —— 文件其实没有「边收边落盘」，大文件仍然吃内存。
     * 用户以为自己在流式下大文件、结果标签页崩了才知道，那就太晚了。
     */
    if (!sink.streaming) {
      toast.info('浏览器不支持流式落盘，本次下载的内容是攒完再保存的（大文件会占用较多内存）')
    }
    return 'done'
  } catch (err) {
    // 收尾：丢掉已写内容（desktop 支还会删掉落点上的半份文件）。
    // ⚠️ 包 try/catch：`sink.close()` 已经跑过时 FSA 支的 `abort()` 会抛 —— 不能让它
    // 顶掉真正的失败原因
    try {
      await sink.abort()
    } catch {
      // 忽略：收尾失败不该掩盖下面的原始错误
    }
    if (controller.signal.aborted || err instanceof TransferCanceled) {
      useAgentStore.getState().settleTransfer(id, 'canceled')
      return 'canceled'
    }
    useAgentStore.getState().settleTransfer(id, 'failed', { error: describe(err) })
    return 'failed'
  } finally {
    active.delete(id)
  }
}

/**
 * 取消一笔传输。
 *
 * 这里只做三件事：置位 `signal`、把这一条标成「已取消」、通知服务端收尾 —— 真正「停」
 * 是**引擎循环自己查 `signal.aborted`** 做到的（`runUpload` / `runDownload` 每片开头）。
 *
 * ⚠️ 为什么不靠 `abort()` 打断在途请求：desktop 的 IPC 桥**不转发 `AbortSignal`**
 * （只有 SSE 那条路有，见 `agent-host/src/transport-ipc.ts`）。在桌面端 `abort()` 对
 * 已经发出去的那一片是空转 —— 曾经因此出现「点了取消，进度一路涨到 100% 变成已完成」：
 * 循环不查 signal、服务端也收不到取消（分片没带 `transferId`，见 `runUpload` 里的说明）。
 *
 * ⚠️ 上传**必须**再调一次 `sftpAbort`：销毁在途写流 + 删掉远端那个只写了一半的文件。
 * 分片协议下它是真实存在、内容完整的一堆前缀字节，不删就是一个「看起来成功」的坏文件。
 * 下载不需要：它是「客户端拉」，不拉了就是取消，服务端那边没有在途状态要收拾。
 */
export function cancelTransfer(id: string): void {
  const entry = active.get(id)
  /**
   * 引擎已经收场（`finally` 里删了）—— 点取消本来就该什么都不发生。
   * 不去乐观改一条「已经没有引擎在管」的记录：那种行一旦被标成取消，就再也没人会纠正它。
   */
  if (!entry) return

  entry.controller.abort()
  /**
   * **立刻**标成取消：不等当前这一片返回（桌面端一片可能跑上几秒），点了要马上有反应。
   * 不会和引擎的 `done` 打架 —— 两条成功路径在 `settleTransfer(done)` 之前都查了
   * `signal.aborted`，`patchTransfer` 也只动 `active` 的行。
   */
  useAgentStore.getState().settleTransfer(id, 'canceled')

  if (!entry.abort) return
  // 刻意不 await、也不报错：取消是正常操作，服务端那条路本身幂等（见 api.ts 的 sftpAbort）
  void getApi()?.sftpAbort(entry.abort)
}
