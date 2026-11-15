/**
 * 子进程管道的输出解码：**乐观 UTF-8、整行回退 GBK**。
 *
 * 为什么需要它：Windows 上 `bash` 走 Git Bash（见 `tools.ts` 的
 * `resolveShellSpawn`），Git Bash 的 coreutils 吐 UTF-8 —— 但命令里显式调用的
 * `powershell`（系统自带的 5.1）往管道写的是**系统 OEM 代码页**（中文 Windows 是
 * 936/GBK）。以前这里一律 `chunk.toString('utf8')`，于是 `Get-NetTCPConnection :
 * 无法绑定参数…` 全变成 `�` 一坨（用户实测反馈）。
 *
 * 为什么不能靠给 shell 加参数解决：外层是 bash，内层 powershell 是模型 / 用户写在
 * 命令里的，控制不了它的 `[Console]::OutputEncoding`。
 *
 * 判定顺序不能反：GBK 的汉字几乎不可能是合法 UTF-8（`中` = D6 D0，D6 是两字节前导、
 * D0 却不是后随字节，fatal 解码必炸）；反过来 UTF-8 的中文用 GBK 去解是「合法但错字」，
 * 不会报错。所以先严格试 UTF-8，失败才用 GBK —— 反了就永远解不对。
 *
 * 为什么要按行缓冲：流式解码器在 chunk 边界会吞掉半个汉字（D6 单独到达时它只缓冲、
 * 不出字），等到发现编码不对时那半个字已经取不回来了，没法回退重解。按 `\n` / `\r`
 * 切出完整的一行再判定，就不会出现「一行里半截 GBK 半截乱码」。
 * 代价：完全没有换行的输出（进度条）要攒到 64KB 才吐一次。
 */

/** 一行最多攒这么多字节就必须先吐出去（无换行的进度条 / 巨长的一行） */
const MAX_PENDING_BYTES = 64 * 1024

/** 严格 UTF-8：遇到非法字节直接抛，用来判「这段到底是不是 UTF-8」 */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })

/**
 * GBK 解码器。
 *
 * Node 自带 full-icu 时 `TextDecoder('gbk')` 可用（终端 SSH 那条路已经在用）；精简
 * 构建里会抛 —— 那时退回宽松 UTF-8（乱码，但至少不崩）。
 */
const GBK: InstanceType<typeof TextDecoder> | null = (() => {
  try {
    return new TextDecoder('gbk')
  } catch {
    return null
  }
})()

/** 一段**完整的**字节能是什么编码：先严格 UTF-8，失败才按 GBK */
function decodeSegment(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  try {
    return UTF8_STRICT.decode(bytes)
  } catch {
    return GBK ? GBK.decode(bytes) : new TextDecoder().decode(bytes)
  }
}

export type OutputDecoder = {
  /** 喂一块原始字节，返回**已确定编码**的那些行（可能为空串） */
  decode: (chunk: Uint8Array) => string
  /** 收口：把没有换行结尾的残留也吐出来（进程退出时调一次，之后别再用） */
  flush: () => string
}

/**
 * 建一条流（stdout / stderr 各一条）的解码器。
 *
 * 两条流必须分开建：同一个实例混着吃 stdout / stderr 会把两边的半行拼到一起。
 */
export function createOutputDecoder(): OutputDecoder {
  /** 还没遇到行分隔符的字节（可能是半行，也可能是半个多字节字符） */
  let pending: Buffer = Buffer.alloc(0)

  const takeLines = (): string => {
    let out = ''
    let start = 0
    for (let i = 0; i < pending.length; i += 1) {
      const byte = pending[i]
      if (byte !== 0x0a && byte !== 0x0d) continue
      out += decodeSegment(pending.subarray(start, i + 1))
      start = i + 1
    }
    if (start > 0) {
      // 复制一份：`subarray` 会一直攥着整块底层 buffer（大输出时等于泄漏）
      pending = start >= pending.length ? Buffer.alloc(0) : Buffer.from(pending.subarray(start))
    }
    /*
     * 一直没有换行：攒够上限就先吐（进度条 / `grep` 命中压缩过的 min.js 那种超长单行，
     * 不能永远等一个不会来的换行）。
     *
     * ⚠️ 切点必须落在**完整字符**上 —— 从上限往回找最后一个 ASCII 字节，切在它后面。
     * ASCII 在 UTF-8 与 GBK 里都是单字节字符，所以它后面一定是字符边界。硬切在 64KB 处
     * 一旦劈开一个汉字，这段的严格 UTF-8 判定就会失败、被误当成 GBK 解码，**整段 64KB
     * 中文瞬间变乱码**（比原来的乱码更糟：本来只有个别字错，现在整行错）。
     */
    if (pending.length >= MAX_PENDING_BYTES) {
      let cut = MAX_PENDING_BYTES
      while (cut > 0 && pending[cut - 1] >= 0x80) cut -= 1
      // 整段都是非 ASCII（极端）：找不到安全边界，只能整段解
      const safe = cut > 0 ? cut : pending.length
      out += decodeSegment(pending.subarray(0, safe))
      pending = safe >= pending.length ? Buffer.alloc(0) : Buffer.from(pending.subarray(safe))
    }
    return out
  }

  return {
    decode(chunk) {
      if (chunk.length === 0) return ''
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, Buffer.from(chunk)])
      return takeLines()
    },
    flush() {
      const out = decodeSegment(pending)
      pending = Buffer.alloc(0)
      return out
    }
  }
}
