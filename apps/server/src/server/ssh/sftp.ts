/**
 * 服务端 SFTP 服务：给「把本地文件拖进 SSH 终端」提供上传能力。
 *
 * 从 dogi 的 `src/main/services/sftp/sftp.ts` 移植。**架构差异决定了两处必须改**，
 * 其余（自建管道 / 取消语义 / 逐层建目录）照搬：
 *
 * 1. **连接归谁管**。dogi 在 Electron 主进程，渲染端按「一个标签一个 connId」主动
 *    open / close。这里 SSH 连接在**服务端**，而拖拽上传是一次性的、没有标签的东西 ——
 *    让渲染端管生命周期只会多出一堆「标签关了、连接没关」的漏。改成**服务端按 hostId
 *    池化**：同一台主机的多次上传复用一条连接，闲置一段时间自动回收。
 * 2. **数据从哪来**。dogi 的 `uploadFrom` 收的是**本地绝对路径**，直接
 *    `createReadStream`。这里服务端很可能跟浏览器不在同一台机器上（web 部署形态），
 *    **读不到用户的本地路径** —— 字节只能由渲染端送来（见 `SftpUploadChunkInput.dataBase64`），
 *    所以这里收 `Buffer`。
 *
 * 连带后果：dogi 的 `uploadDir`（递归上传整个目录）在这里**做不了** ——
 * 服务端看不见用户的本地目录树。目录要由渲染端自己遍历、逐文件送上来。
 *
 * 保真的部分：仍然用「读流 → SFTP 写流」自建管道而不是 `fastPut`。只有拿到两侧流，
 * 用户点「取消」时才能立刻销毁它们。
 *
 * ⚠️ **分片之后「取消」的语义变了**：销毁在途写流只保证**这一片**不再往里写，
 * 而远端已经留下一个内容完整、但只是前几片的**半份文件** —— 它必须由
 * `POST /api/sftp/abort` 显式删掉（见 `removeFileIfExists`），否则会留下一个
 * 「看起来成功」的坏文件。旧的一次性协议不需要这一步，因为那时文件只有
 * 「完整」和「不存在」两种状态。
 */
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { Client, SFTPWrapper, Stats } from 'ssh2'
import type { SftpEntry } from '@fizz/contracts/agent-api'
import { appLog } from '@fizz/workspace'
import { domain } from '../state'
import { connectWithJumps } from './connect'
import { appendFlagsFor } from './sftp-chunk'

/** ssh2 的 readdir 回调项（库里的类型没导出，这里按实际字段收窄一份） */
interface SftpReadDirItem {
  filename: string
  longname: string
}

/** 闲置多久回收连接（毫秒）。太短会让「连续拖几个文件」每次都重连，太长会挂着占资源 */
const IDLE_MS = 3 * 60 * 1000

/** 打开 SFTP 通道的超时：连接已 ready 却迟迟不给通道，属于病态，别无限等 */
const OPEN_TIMEOUT_MS = 20_000

/**
 * 写入远端时的分片大小。
 *
 * 不是为了吞吐（SFTP 自己会切包），而是为了**取消能及时生效**：整份 Buffer 一次性
 * push 进去的话，用户点取消时远端那侧可能已经开始收一整包了。64KB 让取消点足够密。
 */
const WRITE_CHUNK = 64 * 1024

/** 传输被用户主动取消。调用方据此区分「失败」与「取消」，不要把取消当错误展示 */
export class TransferCancelledError extends Error {
  constructor() {
    super('已取消上传')
    this.name = 'TransferCancelledError'
  }
}

export function isTransferCancelled(err: unknown): boolean {
  return err instanceof TransferCancelledError
}

/** 归一化远端路径：反斜杠转正斜杠、折叠重复斜杠、补前导斜杠、去掉尾部斜杠（根除外） */
export function normalizeSftpPath(input: string): string {
  const raw = String(input ?? '').trim()
  if (!raw) return '/'
  let p = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!p.startsWith('/')) p = '/' + p
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p || '/'
}

/**
 * 远端一项的元信息（工作区存在性探测 / 远端 backend 的 `stat` 用）。
 *
 * `mtimeMs` 可能缺：某些 SFTP 服务端不返回 mtime，调用方不能拿它当「文件存在」的判据。
 */
export interface RemoteStat {
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtimeMs?: number
}

/** 在目录下拼一项（根目录不会再拼出双斜杠：`/` + `name` → `/name`） */
export function joinSftpPath(dir: string, name: string): string {
  const base = normalizeSftpPath(dir)
  return base === '/' ? `/${name}` : `${base}/${name}`
}

/** 回调风格的 SFTP 单步操作统一包成 Promise */
function call<T>(fn: (cb: (err: Error | undefined, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}

interface PooledConn {
  hostId: string
  /** 用于日志与报错文案 */
  title: string
  client: Client
  sftp: SFTPWrapper
  /** 关闭整条跳板链 */
  dispose: () => void
  /** 闲置回收定时器（每次使用重置）；建立瞬间还没设，故可缺省 */
  idleTimer?: NodeJS.Timeout
}

class SftpService {
  /** hostId → 已建立的连接 */
  private conns = new Map<string, PooledConn>()
  /**
   * hostId → 正在建立中的连接。
   *
   * 少了它，一次拖入多个文件会**并发**为同一台主机开多条 SSH 连接（每条都要完整握手，
   * 慢且浪费），而且先建好的那条会被后建好的覆盖掉、变成谁也关不掉的孤儿。
   */
  private opening = new Map<string, Promise<PooledConn>>()
  /** transferId → 取消函数（销毁两侧流） */
  private transfers = new Map<string, () => void>()

  /** 取消一笔进行中的上传；不存在（已结束）时静默忽略 —— 取消是幂等的 */
  abortTransfer(transferId: string): void {
    this.transfers.get(transferId)?.()
  }

  /**
   * 取（或建立）到某台主机的 SFTP 连接。凭据在这里解密，明文只在服务端内存里流转。
   */
  private async acquire(hostId: string): Promise<PooledConn> {
    const existing = this.conns.get(hostId)
    if (existing) {
      this.touch(existing)
      return existing
    }
    const pending = this.opening.get(hostId)
    if (pending) return pending

    const task = this.connect(hostId)
    this.opening.set(hostId, task)
    try {
      const entry = await task
      this.conns.set(hostId, entry)
      return entry
    } finally {
      this.opening.delete(hostId)
    }
  }

  private async connect(hostId: string): Promise<PooledConn> {
    // 主机被删 / 是条本机终端配置 / 凭据解密失败：`resolveSshHost` 抛的话本身就是
    // 给用户看的（「SSH 主机不存在或已被删除」这类），原样往上带，别再包一层
    const host = domain.resolveSshHost(hostId)

    const title = `${host.username}@${host.host}`
    const chain = await connectWithJumps(host)
    try {
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error('SFTP 通道打开超时'))
        }, OPEN_TIMEOUT_MS)
        /** 失败统一收尾：清定时器 + 断开连接（成功路径不经这里） */
        const fail = (err: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        }
        chain.client.on('error', (err: Error) => fail(err))
        chain.client.on('close', () => fail(new Error('连接在建立 SFTP 通道前关闭')))
        chain.client.sftp((err, s) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (err || !s) {
            reject(err ?? new Error('无法打开 SFTP 通道'))
            return
          }
          resolve(s)
        })
      })

      const entry: PooledConn = {
        hostId,
        title,
        client: chain.client,
        sftp,
        dispose: chain.dispose
      }
      // 就绪后掉线：摘掉池里的条目（Promise 阶段挂的监听此时 reject 已是 no-op）
      chain.client.on('error', () => this.drop(hostId))
      chain.client.on('close', () => this.drop(hostId))
      this.touch(entry)
      return entry
    } catch (err) {
      // 通道没开成：整条链都得收掉，否则留一条「连上了但没人用」的连接
      chain.dispose()
      const message = err instanceof Error ? err.message : String(err)
      // 建通道失败 = 这台主机的文件面板整个用不了，是最该在日志里看到的一类故障
      appLog.error('sftp', 'SFTP 通道建立失败', `主机: ${title}\n${message}`)
      throw new Error(`连接 ${title} 的 SFTP 通道失败：${message}`)
    }
  }

  /**
   * 一次改动类操作成功 → 记 info。
   *
   * 只记**写操作**（建目录 / 重命名 / 删除 / 复制 / 移动 / 上传 / 下载 / 连上主机），
   * 列表、stat、断点续传的探测这类高频只读动作**不记** —— 记了会把日志刷成一片噪音，
   * 真正要回溯的「谁动了哪台机器的哪个文件」反而被淹掉。
   */
  private logOk(action: string, entry: PooledConn, detail: string): void {
    appLog.info('sftp', action, `主机: ${entry.title}\n${detail}`)
  }

  /** 一次改动类操作失败 → 记 error（失败永远值得留档，不做上面的采样考虑） */
  private logFail(action: string, entry: PooledConn, detail: string, err: unknown): void {
    appLog.error(
      'sftp',
      action,
      `主机: ${entry.title}\n${detail}\n${err instanceof Error ? err.message : String(err)}`
    )
  }

  /** 标记一次使用并重置闲置回收计时 */
  private touch(entry: PooledConn): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => this.close(entry.hostId), IDLE_MS)
    // 别让这个定时器把进程吊住（服务端该退出就退出）
    entry.idleTimer.unref?.()
  }

  /** 解析远端绝对路径（`path` 缺省或 `.` = 远端默认工作目录，通常是家目录） */
  async realpath(hostId: string, path?: string): Promise<string> {
    const entry = await this.acquire(hostId)
    const target = path?.trim() || '.'
    try {
      return await call<string>((cb) => entry.sftp.realpath(target, cb as never))
    } catch (err) {
      this.touch(entry)
      throw new Error(`解析远端路径失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 把一个**分片**写到远端 `dir/name`（`dir` 不存在时逐层创建）。
   *
   * 同名文件直接覆盖：拖拽是用户的显式动作，再弹一次「要不要覆盖」收益很低。
   * 覆盖语义落在 `index === 0` 那一支的 `'w'` 上（见 `appendFlagsFor`）。
   *
   * `transferId` 给了就能被 `abortTransfer` 取消 —— 只作用于**在途的那一片**；
   * 已写入的半份文件由 `POST /api/sftp/abort` 负责删（见 `removeFileIfExists`）。
   *
   * ⚠️ 调用方必须**串行**发分片：服务端是无状态的，这里校验不了顺序，
   * 并发写同一个追加流会**静默**损坏文件内容。
   */
  async appendFile(
    hostId: string,
    dir: string,
    name: string,
    data: Buffer,
    opts: { index: number; transferId?: string }
  ): Promise<void> {
    const entry = await this.acquire(hostId)
    const target = normalizeSftpPath(dir)
    const remotePath = joinSftpPath(target, name)
    const flags = appendFlagsFor(opts.index)
    // 日志带分片序号：一次上传会刷出几百条长得一样的日志，不带序号分不清是哪一片
    const where = `${remotePath}（第 ${opts.index + 1} 片，${formatBytes(data.length)}）`
    try {
      // 目录只在第一片时建：后续分片时它必然已存在，白跑一趟 mkdir 只是拖慢每一片
      if (opts.index === 0) await this.mkdirRecursive(entry.sftp, target)
      await this.writeFile(
        entry.sftp,
        remotePath,
        data,
        flags,
        opts.transferId ?? `ul-${Date.now()}-${name}`
      )
      this.logOk('上传', entry, where)
    } catch (err) {
      // 用户主动取消**不算失败**：AbortController 的 abort 只是收尾动作，报错会误导
      // （文件面板那条也是这么区分的）
      if (err instanceof TransferCancelledError) {
        appLog.info('sftp', '上传已取消', `主机: ${entry.title}\n远端: ${where}`)
      } else {
        appLog.error(
          'sftp',
          '上传失败',
          `主机: ${entry.title}\n远端: ${where}\n${err instanceof Error ? err.message : String(err)}`
        )
      }
      throw err
    } finally {
      // 无论成功 / 失败 / 取消，这次使用都算数：重置闲置计时，别在传输刚结束时把连接掐了
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /**
   * 「读流 → SFTP 写流」自建管道。
   *
   * 不用 `fastPut` 的原因就是取消：只有拿到两侧流，取消时才能立刻 destroy 它们。
   *
   * `flags` 由 `appendFlagsFor(index)` 定：`'w'` 截断创建（第 0 片）/ `'a'` 追加。
   * ⚠️ 传错等于静默写坏文件 —— 截断的传成追加会接在旧内容尾巴上。
   */
  private writeFile(
    sftp: SFTPWrapper,
    remotePath: string,
    data: Buffer,
    flags: 'w' | 'a',
    transferId: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const read = Readable.from(chunksOf(data))
      const write = sftp.createWriteStream(remotePath, { flags })
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        this.transfers.delete(transferId)
        if (err) {
          read.destroy()
          write.destroy()
          reject(err)
          return
        }
        resolve()
      }
      this.transfers.set(transferId, () => finish(new TransferCancelledError()))
      read.on('error', (err: Error) => finish(err))
      write.on('error', (err: Error) => finish(err))
      // finish = 分片都已交给远端句柄；close = 句柄已关（autoClose 默认 true）。
      // 两个都当完成信号、谁先到算谁；destroy 触发的 close 由 settled 挡住，不会误判成功。
      write.on('finish', () => finish())
      write.on('close', () => finish())
      read.pipe(write)
    })
  }

  /**
   * 逐层创建远端目录（SFTP 的 mkdir 不递归）。
   *
   * 某层已存在时按「lstat 确认是目录」放行，其余失败（权限等）照常抛出 ——
   * 别把任何错误都当成「已存在」静默吞掉。
   */
  private async mkdirRecursive(sftp: SFTPWrapper, path: string): Promise<void> {
    let current = ''
    for (const part of normalizeSftpPath(path).split('/').filter(Boolean)) {
      current = joinSftpPath(current, part)
      try {
        await call<void>((cb) => sftp.mkdir(current, cb as never))
      } catch (err) {
        const st = await call<Stats>((cb) => sftp.lstat(current, cb as never)).catch(() => null)
        if (!st?.isDirectory()) throw err
      }
    }
  }

  /**
   * 列一个远端目录（**SFTP 文件管理**标签用的读接口）。
   *
   * 每个条目再 lstat 一次拿类型 / 大小 / 时间：SFTP 的 readdir 只回文件名与 longname，
   * 没有结构化的属性。个别条目 lstat 失败（软链接悬空、权限不足）**不拖垮整份列表** ——
   * 降级成「按文件、0 字节」继续展示，总比整个目录打不开强。
   *
   * 排序在服务端做（目录优先、各自按名）而不是交给两端各排一次：web 与 desktop 的
   * `localeCompare` 行为不一定一致，放一处才能保证两边看到的顺序相同。
   */
  /**
   * 取远端路径的元信息；**不存在返回 null**，连接 / 认证失败照常抛出。
   *
   * 两者必须分开：工作区巡检据此判断「目录被删」（可标 `dirMissing`）还是「主机暂时
   * 连不上」（不能把用户的目录标成丢了）。ssh2 的 ENOENT 是 code 2。
   */
  async stat(hostId: string, rawPath: string): Promise<RemoteStat | null> {
    const entry = await this.acquire(hostId)
    const remote = normalizeSftpPath(rawPath)
    try {
      const st = await call<Stats>((cb) => entry.sftp.stat(remote, cb as never))
      this.touch(entry)
      const type: RemoteStat['type'] = st.isDirectory()
        ? 'dir'
        : st.isSymbolicLink()
          ? 'symlink'
          : st.isFile()
            ? 'file'
            : 'other'
      return {
        type,
        size: st.size,
        ...(typeof st.mtime === 'number' ? { mtimeMs: st.mtime * 1000 } : {})
      }
    } catch (err) {
      this.touch(entry)
      if ((err as { code?: number }).code === 2) return null
      throw err
    }
  }

  /**
   * 读整份远端文件（工作区后端的 `readFile`）。
   *
   * `maxBytes` 先按 stat 拦一道（大文件连读流都不用开）；流式收集时再拦一次，
   * 防「stat 之后文件又长大」的竞态。不存在 / 不是文件都抛错，由调用方转成人话。
   */
  async readFile(
    hostId: string,
    rawPath: string,
    opts?: { maxBytes?: number }
  ): Promise<Buffer> {
    const entry = await this.acquire(hostId)
    const remote = normalizeSftpPath(rawPath)
    try {
      const st = await call<Stats>((cb) => entry.sftp.stat(remote, cb as never))
      if (st.isDirectory()) throw new Error('不是文件')
      const max = opts?.maxBytes
      if (max !== undefined && Number(st.size) > max) {
        throw new Error(`文件过大（${st.size} 字节，超过 ${max} 字节上限）`)
      }
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        let settled = false
        const finish = (err?: Error): void => {
          if (settled) return
          settled = true
          if (err) {
            read.destroy()
            reject(err)
            return
          }
          resolve(Buffer.concat(chunks))
        }
        const read = entry.sftp.createReadStream(remote)
        read.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (max !== undefined && size > max) {
            finish(new Error(`文件过大（超过 ${max} 字节上限）`))
            return
          }
          chunks.push(chunk)
        })
        read.on('error', (err: Error) => finish(err))
        read.on('end', () => finish())
        read.on('close', () => finish())
      })
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /**
   * 写整份远端文件（工作区后端的 `writeFile`）。
   *
   * `atomic`：先写同目录临时文件再 rename —— 断线 / 崩溃时不会在目标位置留下半份内容
   * （工具 `write_file` 就是这么写的）。SFTP v3 的 rename 在 OpenSSH 上覆盖已有文件；
   * 目标存在导致 rename 失败时退回「删目标再 rename」。
   */
  async writeBuffer(
    hostId: string,
    rawPath: string,
    data: Buffer | string,
    opts?: { atomic?: boolean; createParents?: boolean }
  ): Promise<void> {
    const entry = await this.acquire(hostId)
    const target = normalizeSftpPath(rawPath)
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const dir = target.slice(0, target.lastIndexOf('/')) || '/'
    try {
      if (opts?.createParents !== false) await this.mkdirRecursive(entry.sftp, dir)
      if (!opts?.atomic) {
        await this.writeFile(entry.sftp, target, bytes, 'w', `ws-${randomUUID()}`)
        return
      }
      const tmp = joinSftpPath(dir, `.fizz-tmp-${randomUUID().slice(0, 12)}`)
      await this.writeFile(entry.sftp, tmp, bytes, 'w', `ws-${randomUUID()}`)
      try {
        await call<void>((cb) => entry.sftp.rename(tmp, target, cb as never))
      } catch (err) {
        // 个别 SFTP 服务的 rename 不覆盖已有目标：删掉再试一次，失败时清临时文件
        await call<void>((cb) => entry.sftp.unlink(target, cb as never)).catch(() => undefined)
        await call<void>((cb) => entry.sftp.rename(tmp, target, cb as never)).catch(
          async (renameErr) => {
            await call<void>((cb) => entry.sftp.unlink(tmp, cb as never)).catch(() => undefined)
            throw renameErr ?? err
          }
        )
      }
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /** 逐层创建远端目录（工作区后端的 `mkdirp`） */
  async mkdirs(hostId: string, rawPath: string): Promise<void> {
    const entry = await this.acquire(hostId)
    try {
      await this.mkdirRecursive(entry.sftp, normalizeSftpPath(rawPath))
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /**
   * 删除文件 / 目录（工作区后端的 `remove`）。
   *
   * `force` 只吞「目标本来就不存在」（ENOENT = code 2），权限等真错误照常抛 ——
   * 与 `fs.rm({ force })` 的语义一致。
   */
  async removePath(
    hostId: string,
    rawPath: string,
    opts?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    const entry = await this.acquire(hostId)
    const remote = normalizeSftpPath(rawPath)
    try {
      const st = await call<Stats>((cb) => entry.sftp.lstat(remote, cb as never))
      if (st.isDirectory()) {
        if (opts?.recursive) await this.removeEntry(entry.sftp, remote)
        else await call<void>((cb) => entry.sftp.rmdir(remote, cb as never))
      } else {
        await call<void>((cb) => entry.sftp.unlink(remote, cb as never))
      }
    } catch (err) {
      if (!(opts?.force && (err as { code?: number }).code === 2)) throw err
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /**
   * 列一个远端目录（**SFTP 文件管理**标签用的读接口）。
   *
   * 每个条目再 lstat 一次拿类型 / 大小 / 时间：SFTP 的 readdir 只回文件名与 longname，
   * 没有结构化的属性。个别条目 lstat 失败（软链接悬空、权限不足）**不拖垮整份列表** ——
   * 降级成「按文件、0 字节」继续展示，总比整个目录打不开强。
   *
   * 排序在服务端做（目录优先、各自按名）而不是交给两端各排一次：web 与 desktop 的
   * `localeCompare` 行为不一定一致，放一处才能保证两边看到的顺序相同。
   */
  async list(hostId: string, rawPath: string): Promise<SftpEntry[]> {
    const entry = await this.acquire(hostId)
    const path = normalizeSftpPath(rawPath)
    try {
      const raw = await call<SftpReadDirItem[]>((cb) => entry.sftp.readdir(path, cb as never))
      const entries = await Promise.all(
        raw.map(async (item): Promise<SftpEntry> => {
          const full = joinSftpPath(path, item.filename)
          try {
            const st = await call<Stats>((cb) => entry.sftp.lstat(full, cb as never))
            return {
              name: item.filename,
              path: full,
              isDir: st.isDirectory(),
              size: st.isDirectory() ? 0 : Number(st.size) || 0,
              mtime: st.mtime ? new Date(st.mtime).getTime() : 0
            }
          } catch {
            // 见上：单条失败降级，不放倒整份列表
            return { name: item.filename, path: full, isDir: false, size: 0, mtime: 0 }
          }
        })
      )
      return entries.sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
      )
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /** 新建一个远端目录（SFTP 的 mkdir **不递归**；中间层不存在就报错，由调用方决定） */
  async mkdir(hostId: string, path: string): Promise<void> {
    const entry = await this.acquire(hostId)
    const remote = normalizeSftpPath(path)
    try {
      await call<void>((cb) => entry.sftp.mkdir(remote, cb as never))
      this.logOk('新建目录', entry, remote)
    } catch (err) {
      this.logFail('新建目录失败', entry, remote, err)
      throw new Error(`创建目录失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /** 重命名 / 移动（SFTP 原生 rename；跨文件系统的移动由调用方另行兜底） */
  async rename(hostId: string, from: string, to: string): Promise<void> {
    const entry = await this.acquire(hostId)
    const src = normalizeSftpPath(from)
    const dst = normalizeSftpPath(to)
    try {
      await call<void>((cb) => entry.sftp.rename(src, dst, cb as never))
      this.logOk('重命名', entry, `${src} → ${dst}`)
    } catch (err) {
      this.logFail('重命名失败', entry, `${src} → ${dst}`, err)
      throw new Error(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /** 删除文件或目录（目录**递归**删除，等价 `rm -rf`） */
  async remove(hostId: string, path: string): Promise<void> {
    const entry = await this.acquire(hostId)
    const remote = normalizeSftpPath(path)
    try {
      await this.removeEntry(entry.sftp, remote)
      this.logOk('删除', entry, remote)
    } catch (err) {
      this.logFail('删除失败', entry, remote, err)
      throw new Error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  private async removeEntry(sftp: SFTPWrapper, path: string): Promise<void> {
    const st = await call<Stats>((cb) => sftp.lstat(path, cb as never))
    if (st.isDirectory()) {
      const items = await call<SftpReadDirItem[]>((cb) => sftp.readdir(path, cb as never))
      for (const item of items) {
        await this.removeEntry(sftp, joinSftpPath(path, item.filename))
      }
      await call<void>((cb) => sftp.rmdir(path, cb as never))
    } else {
      await call<void>((cb) => sftp.unlink(path, cb as never))
    }
  }

  /**
   * 删掉一个**文件**；是目录就跳过，任何错误都吞掉。
   *
   * ⚠️ **取消上传时清理半份文件专用，不能拿 `remove()` 顶替** —— 那个是递归删除
   * （等价 `rm -rf`），而这里的 path 是客户端给的 `dir` + `name` 拼出来的：万一远端
   * 恰好有一个同名**目录**，一次取消就会把它整棵删掉。这个方法是「只删文件」的窄口子。
   *
   * 幂等：文件不存在（已传完 / 已删过 / 路径本来就没有）时静默返回，**不抛错** ——
   * 清理是取消流程的尽力而为，不能让它把已经成功的取消变成一次失败。
   */
  async removeFileIfExists(hostId: string, path: string): Promise<void> {
    const entry = await this.acquire(hostId)
    const remote = normalizeSftpPath(path)
    try {
      const st = await call<Stats>((cb) => entry.sftp.lstat(remote, cb as never))
      if (st.isDirectory()) {
        // 是目录 = 它不可能是我们写出来的半份文件（上传只会建**文件**）。
        // 宁可留着，也绝不递归删掉用户的东西。
        appLog.warn(
          'sftp',
          '取消上传时跳过清理：目标是个目录，未删除',
          `主机: ${entry.title}\n远端: ${remote}`
        )
        return
      }
      await call<void>((cb) => entry.sftp.unlink(remote, cb as never))
      appLog.info('sftp', '已清理取消上传留下的半份文件', `主机: ${entry.title}\n远端: ${remote}`)
    } catch {
      // 吞掉：lstat 失败（文件不存在，最常见）或 unlink 失败（权限等）都不该让
      // 取消流程报错 —— 取消本身已经成功了
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /**
   * 远端复制（ssh2 原生无 copy，自行「读流 → 写流」）。目录递归。
   *
   * 逐文件串行 `pumpRemote`，不做并发：远端同一账号的并发写既没快多少，
   * 又会让「传了一半失败」的现场更乱。
   */
  async copy(hostId: string, from: string, to: string): Promise<void> {
    const entry = await this.acquire(hostId)
    const src = normalizeSftpPath(from)
    const dst = normalizeSftpPath(to)
    try {
      await this.copyEntry(entry.sftp, src, dst)
      this.logOk('复制', entry, `${src} → ${dst}`)
    } catch (err) {
      this.logFail('复制失败', entry, `${src} → ${dst}`, err)
      throw new Error(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  private async copyEntry(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
    const st = await call<Stats>((cb) => sftp.lstat(from, cb as never))
    if (st.isDirectory()) {
      // 目标目录已存在（合并语义）：mkdir 失败时确认它确实是目录再放行
      try {
        await call<void>((cb) => sftp.mkdir(to, cb as never))
      } catch (err) {
        const dst = await call<Stats>((cb) => sftp.lstat(to, cb as never)).catch(() => null)
        if (!dst?.isDirectory()) throw err
      }
      const items = await call<SftpReadDirItem[]>((cb) => sftp.readdir(from, cb as never))
      for (const item of items) {
        await this.copyEntry(sftp, joinSftpPath(from, item.filename), joinSftpPath(to, item.filename))
      }
      return
    }
    await this.pumpRemote(sftp, from, to)
  }

  /**
   * 移动：优先 SFTP 原生 rename（同一文件系统内瞬时完成）；失败（跨文件系统）时
   * 回退为「复制 + 删除源」。与 dogi 的 `moveEntry` 同一取舍。
   */
  async move(hostId: string, from: string, to: string): Promise<void> {
    const entry = await this.acquire(hostId)
    const src = normalizeSftpPath(from)
    const dst = normalizeSftpPath(to)
    try {
      try {
        await call<void>((cb) => entry.sftp.rename(src, dst, cb as never))
      } catch {
        await this.copyEntry(entry.sftp, src, dst)
        await this.removeEntry(entry.sftp, src)
      }
      this.logOk('移动', entry, `${src} → ${dst}`)
    } catch (err) {
      this.logFail('移动失败', entry, `${src} → ${dst}`, err)
      throw new Error(`移动失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /**
   * 读远端文件 `[offset, offset + length)` 这一段成 Buffer（**SFTP 文件管理**的下载接口）。
   *
   * 自发 `createReadStream(remote, { start, end })` 收全这一段再回，而不是 `fastGet`
   * 到临时文件再读回来 —— 服务端的形态是「把字节交回渲染端」，落一个临时文件只多
   * 一次 IO 和一处要记得清的东西。
   *
   * ⚠️ 只驻留**这一段**（≤ `SFTP_CHUNK_BYTES`），不再是整份文件 —— 这是分片带来的
   * 主要收益：内存峰值与文件大小脱钩。
   *
   * `offset` 落在文件末尾之后时读到 0 字节、**不报错**：那是正常收尾（调用方按
   * `isEof` 判），不是错误。
   */
  async readRange(hostId: string, path: string, offset: number, length: number): Promise<Buffer> {
    const entry = await this.acquire(hostId)
    const remote = normalizeSftpPath(path)
    try {
      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        // ssh2 的 end 是**闭区间**：要读 length 字节，右端就是 offset + length - 1
        const read = entry.sftp.createReadStream(remote, {
          start: offset,
          end: offset + length - 1
        })
        let settled = false
        const finish = (err?: Error): void => {
          if (settled) return
          settled = true
          if (err) {
            read.destroy()
            reject(err)
            return
          }
          resolve(Buffer.concat(chunks))
        }
        read.on('data', (chunk: Buffer) => chunks.push(chunk))
        read.on('error', (err: Error) => finish(err))
        read.on('end', () => finish())
        // 部分 SFTP 实现对目录会走 close 而不是报错；提前挡一下，给一句人能读的话
        read.on('close', () => finish())
      })
      // 带偏移：一次下载会刷出几百条长得一样的日志，不带偏移分不清是哪一段
      this.logOk('下载', entry, `${remote}（第 ${offset} 字节起，${formatBytes(data.length)}）`)
      return data
    } catch (err) {
      this.logFail('下载失败', entry, remote, err)
      throw new Error(`读取文件失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /**
   * 远端文件大小（取不到时返回 null，交给调用方按「未知」处理）。
   *
   * ⚠️ 分片之后它**不再承担「下载前判上限」的职责**（那件事随 `SFTP_UPLOAD_MAX_BYTES`
   * 一起消失了）：文件大小现在从文件列表的 `SftpEntry.size` 拿，下载本身按段拉、
   * 不需要事先知道总量。留在这里是给「只要一个数字」的调用方用的工具方法。
   */
  async sizeOf(hostId: string, path: string): Promise<number | null> {
    const entry = await this.acquire(hostId)
    try {
      const st = await call<Stats>((cb) => entry.sftp.lstat(normalizeSftpPath(path), cb as never))
      if (st.isDirectory()) return null
      return Number(st.size) || 0
    } catch {
      return null
    } finally {
      if (this.conns.has(hostId)) this.touch(entry)
    }
  }

  /** 「SFTP 读流 → SFTP 写流」直通管道（远端复制 / 移动的复制阶段用，无进度、不可取消） */
  private pumpRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const read = sftp.createReadStream(from)
      const write = sftp.createWriteStream(to)
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) {
          read.destroy()
          write.destroy()
          reject(err)
          return
        }
        resolve()
      }
      read.on('error', (err: Error) => finish(err))
      write.on('error', (err: Error) => finish(err))
      write.on('finish', () => finish())
      write.on('close', () => finish())
      read.pipe(write)
    })
  }

  /** 主动关闭某台主机的连接（闲置回收与 `closeAll` 都走它） */
  close(hostId: string): void {
    const entry = this.conns.get(hostId)
    if (!entry) return
    this.conns.delete(hostId)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    try {
      entry.dispose()
    } catch {
      // 可能已经在掉线流程里关过了
    }
  }

  closeAll(): void {
    for (const hostId of [...this.conns.keys()]) this.close(hostId)
  }

  /** 远端断开 / 出错后的统一清理（主动 close 的已先摘掉，不会再走到这） */
  private drop(hostId: string): void {
    const entry = this.conns.get(hostId)
    if (!entry) return
    this.conns.delete(hostId)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    try {
      entry.dispose()
    } catch {
      // 忽略
    }
    // 掉线时把该连接上还在传的都掐掉，否则它们会一直挂在 transfers 里等一个永远不来的 finish
    for (const [transferId, cancel] of [...this.transfers]) {
      cancel()
      this.transfers.delete(transferId)
    }
  }
}

/** 字节数给人看（日志里只作粗略参考，不必精确到小数） */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 把整份 Buffer 切成小片（`subarray` 是视图，不复制，100MB 也就 1600 个引用） */
function chunksOf(data: Buffer): Buffer[] {
  if (data.length <= WRITE_CHUNK) return [data]
  const out: Buffer[] = []
  for (let i = 0; i < data.length; i += WRITE_CHUNK) {
    out.push(data.subarray(i, i + WRITE_CHUNK))
  }
  return out
}

export const sftpService = new SftpService()
