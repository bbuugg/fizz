/**
 * 零依赖的 zip 读写（只用 `node:zlib` 的 deflate / inflate）。
 *
 * 两个用途，共用下面这套读写核心：
 * 1. **文件视图「下载文件夹」**（`zipDirectory`）—— 浏览器只能下单个文件，目录必须先打包；
 * 2. **数据导入 / 导出**（`createZip` / `readZip`）—— 把几份 JSON 打成一个包，或把包解开。
 *
 * 为什么自己写而不引 `archiver` / `jszip`：仓库里没有声明过任何 zip 依赖
 * （`node_modules` 里那个 `archiver` 是别人带进来的传递依赖，直接 import 会在
 * 换锁文件时消失，桌面端还会踩「裸依赖要进 asar」的坑）。ZIP 的存储格式很小，自己写更可控。
 *
 * 只支持 deflate / store 两种方式、不写 zip64（条目数与总量都有上限），
 * 文件名一律按 UTF-8 写并置通用标志位 11，中文名不会乱码。
 */
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { WorkspaceBackend } from '@fizz/contracts/workspace'

/** CRC32 查表（zip 的每个文件都要带校验和，zlib 不直接给，自己算最快） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间戳：秒只有 1/2 精度，年份从 1980 起算 —— zip 头里就这么存的 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(d.getFullYear(), 1980)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

/**
 * zip 写入器：本地文件头 + 数据先攒着，最后统一补中央目录与 EOCD。
 *
 * 抽出来是因为**两处都要写 zip**（打包目录、打包几份 JSON），而 zip 的字段偏移
 * 一写错就是一包坏文件 —— 让它只有一份实现。
 */
class ZipWriter {
  private readonly body: Buffer[] = []
  private readonly central: Buffer[] = []
  /** 已写出的字节数 = 下一个本地头的偏移 */
  private offset = 0
  private count = 0

  /** 已写出的条目数（目录条目也计入） */
  get entries(): number {
    return this.count
  }

  private push(b: Buffer): void {
    this.body.push(b)
    this.offset += b.length
  }

  /** 写「本地文件头 + 名字 + 数据」，并把对应信息记进中央目录（zip 要求末尾再列一遍） */
  addEntry(zipName: string, raw: Buffer, mtime: Date, isDir: boolean): void {
    const nameBuf = Buffer.from(zipName, 'utf8')
    const crc = isDir ? 0 : crc32(raw)
    // 压不小就退回 store：小文件 / 已压缩格式（png、zip…）deflate 反而更大
    let method = 0
    let data = raw
    if (raw.length > 0) {
      const deflated = deflateRawSync(raw)
      if (deflated.length < raw.length) {
        method = 8
        data = deflated
      }
    }
    const { time, date } = dosDateTime(mtime)
    const localOffset = this.offset

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    header.writeUInt16LE(20, 4) // 解压所需版本
    header.writeUInt16LE(0x0800, 6) // 标志位 11：文件名是 UTF-8
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28) // 扩展字段长度
    this.push(header)
    this.push(nameBuf)
    if (data.length > 0) this.push(data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // 中央目录签名
    cd.writeUInt16LE(20, 4) // 制作版本
    cd.writeUInt16LE(20, 6) // 解压所需版本
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // 扩展字段长度
    cd.writeUInt16LE(0, 32) // 注释长度
    cd.writeUInt16LE(0, 34) // 起始磁盘号
    cd.writeUInt16LE(0, 36) // 内部属性
    cd.writeUInt32LE(isDir ? 0x41ed0010 : 0x81a40000, 38) // 外部属性（0755 目录 / 0644 文件）
    cd.writeUInt32LE(localOffset, 42)
    this.central.push(cd, nameBuf)

    this.count++
  }

  /** 收尾：中央目录 + EOCD，拼成完整 zip */
  finish(): Buffer {
    const centralBuf = Buffer.concat(this.central)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0) // 中央目录结尾签名
    eocd.writeUInt16LE(0, 4) // 当前磁盘号
    eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘号
    eocd.writeUInt16LE(this.count, 8)
    eocd.writeUInt16LE(this.count, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(this.offset, 16)
    eocd.writeUInt16LE(0, 20) // 注释长度
    return Buffer.concat([...this.body, centralBuf, eocd])
  }
}

/** 打进包里的一个内存文件 */
export interface ZipInputFile {
  name: string
  data: Buffer
}

/** 解包出的一个内存文件 */
export interface ZipOutputFile {
  name: string
  data: Buffer
}

/**
 * 把若干内存文件打成一个 zip（**不写磁盘**，数据导入 / 导出用）。
 *
 * 与 `zipDirectory` 的区别：这里没有目录概念，条目就是给进来的那几个（顺序即写入顺序）。
 */
export function createZip(files: ZipInputFile[], mtime: Date = new Date()): Buffer {
  const writer = new ZipWriter()
  for (const file of files) writer.addEntry(file.name, file.data, mtime, false)
  return writer.finish()
}

/** `readZip` 的防线：导入包是**用户给的文件**，不能让它把内存吃干 */
export interface ZipReadOptions {
  /** 条目数上限。默认 64（导入包只有几个 JSON） */
  maxEntries?: number
  /** 解压后总字节上限。默认 64MB */
  maxTotalBytes?: number
  /** 单个条目解压后上限。默认 32MB */
  maxFileBytes?: number
}

/**
 * 解包一个 zip（内存里，**不落盘**）。
 *
 * EOCD 在文件末尾（后面可能跟着注释，最长 64KB），所以从后往前扫签名而不是按固定偏移读。
 * 只认 deflate(8) 与 store(0) 两种压缩方式 —— 其余（bzip2 / lzma…）直接报错，
 * 免得解出来一堆乱码还被当成 JSON 去解析。
 *
 * ⚠️ 返回的 `name` 是**归档内的原始路径**（可能带 `a/b.json` 这样的目录前缀），
 * 不做任何扁平化：这是读 zip 的通用行为，压平了会让 `a/x.json` 与 `b/x.json` 撞名。
 * 需要「只看文件名」的调用方自己取 `basename`（数据导入就是这么做的）。
 */
export function readZip(buffer: Buffer, options: ZipReadOptions = {}): ZipOutputFile[] {
  const maxEntries = options.maxEntries ?? 64
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024
  const maxFileBytes = options.maxFileBytes ?? 32 * 1024 * 1024

  let eocd = -1
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')

  const total = buffer.readUInt16LE(eocd + 10)
  if (total > maxEntries) throw new Error(`压缩包条目过多（${total} > ${maxEntries}）`)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const files: ZipOutputFile[] = []
  let totalBytes = 0

  for (let i = 0; i < total; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('zip 目录已损坏')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)

    // 目录条目（以 '/' 结尾）不产出文件
    if (name.endsWith('/')) {
      cursor += 46 + nameLen + extraLen + commentLen
      continue
    }
    if (uncompressedSize > maxFileBytes || totalBytes + uncompressedSize > maxTotalBytes) {
      throw new Error(`压缩包解压后过大（${name}）`)
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`压缩包用了不支持的压缩方式（${method}，只支持 store / deflate）`)
    }

    // 目录条目里的 extra 长度可能与本地头不一致，数据起点一律按**本地头**算
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('zip 本地文件头已损坏')
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    if (start + compressedSize > buffer.length) throw new Error('zip 数据超出文件范围')
    const raw = buffer.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    totalBytes += data.length
    files.push({ name, data })

    cursor += 46 + nameLen + extraLen + commentLen
  }

  return files
}

/** 认一下这是不是一个 zip（本地文件头签名 `PK\x03\x04`）；导入时用来分流 zip / JSON */
export function looksLikeZip(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  )
}

export interface ZipBuildOptions {
  /** 单个文件超过它就跳过（不整个读进内存）。默认 64MB */
  maxFileBytes?: number
  /** 归档总字节上限（读进来的原始字节和）。默认 256MB */
  maxTotalBytes?: number
  /** 条目数上限（含目录条目）。默认 20000 */
  maxEntries?: number
  /** 返回 true 表示**跳过**该绝对路径（目录命中即整棵子树跳过）；调用方一般接工作区忽略规则 */
  ignore?: (abs: string, isDir: boolean) => boolean
  /** 被丢掉的条目会上报一次，供调用方提示「有哪些没进包」 */
  onSkip?: (reason: 'ignored' | 'too-large' | 'limit', name: string) => void
}

export interface ZipBuildResult {
  buffer: Buffer
  /** 因忽略 / 超限而没进包的条目数 */
  skipped: number
}

/**
 * 把一批**绝对路径**打成 zip（文件管理器「压缩」用）。
 *
 * 归档内的顶层名字就是各自的 `basename`：选中 `a.txt` 与 `docs/` 得到 `a.txt` + `docs/…`。
 * 目录会先写一条以 `/` 结尾的目录条目，空目录解出来才不会消失。
 */
export async function zipPaths(
  absPaths: string[],
  options: ZipBuildOptions = {}
): Promise<ZipBuildResult> {
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024
  const maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024
  const maxEntries = options.maxEntries ?? 20000

  const writer = new ZipWriter()
  let totalBytes = 0
  let skipped = 0

  const walk = async (dirAbs: string, zipPrefix: string): Promise<void> => {
    const dirents = await fs.readdir(dirAbs, { withFileTypes: true })
    dirents.sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirents) {
      // 名字是自造的目录条目也要占一个名额，所以上限判断放在最前面
      if (writer.entries >= maxEntries) {
        skipped++
        options.onSkip?.('limit', d.name)
        continue
      }
      const abs = join(dirAbs, d.name)
      const zipName = zipPrefix ? `${zipPrefix}/${d.name}` : d.name
      const isDir = d.isDirectory()
      if (options.ignore?.(abs, isDir)) {
        skipped++
        options.onSkip?.('ignored', zipName)
        continue
      }
      // 符号链接 / 设备文件等一律跳过：跟进去可能成环或拿到非普通文件
      if (!isDir && !d.isFile()) continue
      const stat = await fs.lstat(abs).catch(() => null)
      if (!stat) continue

      if (isDir) {
        // 空目录也要在解压后留下来，所以目录本身也得有一条（以 '/' 结尾，长度 0）
        writer.addEntry(`${zipName}/`, Buffer.alloc(0), stat.mtime, true)
        await walk(abs, zipName)
        continue
      }

      if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
        skipped++
        options.onSkip?.('too-large', zipName)
        continue
      }
      const raw = await fs.readFile(abs)
      totalBytes += raw.length
      writer.addEntry(zipName, raw, stat.mtime, false)
    }
  }

  for (const abs of absPaths) {
    const stat = await fs.lstat(abs)
    // 根路径（`/`、`C:\`）的 basename 是空串，给个占位名字，否则归档里会出现 `//x`
    const name = basename(abs) || 'archive'
    if (stat.isDirectory()) {
      writer.addEntry(`${name}/`, Buffer.alloc(0), stat.mtime, true)
      await walk(abs, name)
      continue
    }
    if (!stat.isFile()) continue
    if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
      skipped++
      options.onSkip?.('too-large', name)
      continue
    }
    if (writer.entries >= maxEntries) {
      skipped++
      options.onSkip?.('limit', name)
      continue
    }
    const raw = await fs.readFile(abs)
    totalBytes += raw.length
    writer.addEntry(name, raw, stat.mtime, false)
  }

  return { buffer: writer.finish(), skipped }
}

/**
 * 把一个目录递归打成 zip，**归档内保留该目录名作为顶层目录**
 * （下 `tools` 得到 `tools.zip`，解压出来就是 `tools/…`）。
 *
 * 实现上就是「只选一个目录」的 `zipPaths` —— 两处共用同一套递归，zip 的字段偏移
 * 只有一份代码在写（写错一个字节就是一包坏文件）。
 */
export async function zipDirectory(
  rootAbs: string,
  options: ZipBuildOptions = {}
): Promise<ZipBuildResult> {
  return zipPaths([rootAbs], options)
}

/**
 * 把**远端**（SSH 工作区）的一个目录递归打成 zip。
 *
 * 与 `zipDirectory` 的骨架、忽略规则、大小 / 条目上限、目录条目语义完全一致，差别只有
 * 取数据的方式：这里全部经 `WorkspaceBackend`（远端 = SFTP），本地路径不进 `fs`。
 * 两边共用同一个 `ZipWriter` —— zip 的字段偏移只有一份实现。
 *
 * 符号链接 / 设备文件按「跳过」处理（与 `zipPaths` 同一取舍）：跟进去可能成环。
 * 注意远端 `readDir` 对符号链接报的是 `file`（lstat 语义），这里再用 `stat`（跟随链接）
 * 判一次类型，指向目录的链接同样跳过，不会无限递归。
 */
export async function zipRemoteDirectory(
  backend: WorkspaceBackend,
  rootAbs: string,
  options: ZipBuildOptions = {}
): Promise<ZipBuildResult> {
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024
  const maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024
  const maxEntries = options.maxEntries ?? 20000

  const rootStat = await backend.stat(rootAbs)
  if (!rootStat) throw new Error('文件夹不存在')
  if (rootStat.type !== 'dir') throw new Error('不是文件夹')

  const writer = new ZipWriter()
  let totalBytes = 0
  let skipped = 0
  const dateOf = (mtimeMs?: number): Date => new Date(mtimeMs ?? Date.now())

  const walk = async (dirAbs: string, zipPrefix: string): Promise<void> => {
    const entries = await backend.readDir(dirAbs)
    for (const entry of entries) {
      if (writer.entries >= maxEntries) {
        skipped++
        options.onSkip?.('limit', entry.name)
        continue
      }
      const abs = backend.join(dirAbs, entry.name)
      const zipName = `${zipPrefix}/${entry.name}`
      if (options.ignore?.(abs, entry.type === 'dir')) {
        skipped++
        options.onSkip?.('ignored', zipName)
        continue
      }
      const st = await backend.stat(abs).catch(() => null)
      if (!st) continue
      if (entry.type === 'dir') {
        if (st.type !== 'dir') continue
        writer.addEntry(`${zipName}/`, Buffer.alloc(0), dateOf(st.mtimeMs), true)
        await walk(abs, zipName)
        continue
      }
      // 符号链接 / 设备文件等（stat 跟随链接后仍不是普通文件）一律跳过
      if (st.type !== 'file') continue
      if (st.size > maxFileBytes || totalBytes + st.size > maxTotalBytes) {
        skipped++
        options.onSkip?.('too-large', zipName)
        continue
      }
      const raw = await backend.readFile(abs).catch(() => null)
      if (!raw) continue
      totalBytes += raw.length
      writer.addEntry(zipName, raw, dateOf(st.mtimeMs), false)
    }
  }

  const name = backend.basename(rootAbs) || 'archive'
  writer.addEntry(`${name}/`, Buffer.alloc(0), dateOf(rootStat.mtimeMs), true)
  await walk(rootAbs, name)
  return { buffer: writer.finish(), skipped }
}
