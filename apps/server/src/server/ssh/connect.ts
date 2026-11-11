/**
 * SSH 连接层：按跳板链逐级建连（等价 `ssh -J` / ProxyJump）。
 *
 * 职责：
 * - 解析跳板链（`jumpHostId` 逐级跟随），经上一跳的 direct-tcpip 通道接入下一跳；
 *   成环 / 超深 / 引用已删主机都给出明确报错；
 * - 连接中途失败时把已建立的中间连接全部收尾，不留半截跳板连接。
 *
 * 凭据解密在 `@fizz/workspace` 的 `resolveSshHost` 里做，这里只拿明文用、不落盘。
 *
 * ⚠️ 不做主机指纹校验（TOFU）：本服务是**本机 / 私有部署**的，工作区列表本身就是权限
 * 边界；手指纹校验要配一套 known_hosts 存储与「是否信任」交互，不在本次移植范围内。
 */
import type { Duplex } from 'node:stream'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshConnectStage } from '@fizz/contracts/agent-api'
import type { ResolvedSshHost } from '@fizz/workspace'
import { appLog } from '@fizz/workspace'
import { domain } from '../state'

/** 建连失败时写进应用日志的标号（成功那条在 `connectWithJumps` 末尾记，两处共用） */
const STAGE = 'ssh'

/** 跳板链最大深度（含目标本身）；病态配置直接拒绝而不是无限展开 */
const MAX_CHAIN_DEPTH = 8

/** 单跳建连超时 */
const READY_TIMEOUT_MS = 20_000

/**
 * 连接阶段真源在 `@fizz/contracts/agent-api`（渲染端也用同一套枚举）。
 * `resolving → handshake → authenticating` 由本模块上报；`opening-shell` / `ready`
 * 由 `session.ts` 在打开 shell 前 / shell 流建立后补上（见 `SshConnectStage`）。
 */
export type { SshConnectStage }

/** 连接阶段上报；`detail` 标注当前在连哪一跳（跳板链才有） */
export type StageReporter = (stage: SshConnectStage, detail?: string) => void

export interface ConnectedChain {
  /** 目标主机（链尾）的已就绪连接：shell 在它上面开 */
  client: Client
  /** 关闭整条链（逐跳 end；根断开时下游自然失效） */
  dispose: () => void
}

/**
 * 解析跳板链：根跳板在前、目标主机在最后。逐级跟随 `jumpHostId`。
 * 成环 / 超深 / 引用不存在的配置同步抛错（错误信息直接展示给用户）。
 */
function resolveChain(host: ResolvedSshHost): ResolvedSshHost[] {
  const chain: ResolvedSshHost[] = [host]
  const visited = new Set([host.id])
  let cursor = host
  while (cursor.jumpHostId) {
    if (chain.length >= MAX_CHAIN_DEPTH) {
      throw new Error(`跳板链超过 ${MAX_CHAIN_DEPTH} 层，请检查主机配置`)
    }
    if (visited.has(cursor.jumpHostId)) {
      throw new Error('跳板链存在循环引用，请检查各主机的跳板设置')
    }
    const next = domain.resolveSshHost(cursor.jumpHostId)
    visited.add(next.id)
    chain.unshift(next)
    cursor = next
  }
  return chain
}

/** 单跳连接参数（凭据 + 可选 sock：上一跳开出的转发通道） */
export function buildHopConfig(hop: ResolvedSshHost, sock?: Duplex): ConnectConfig {
  const config: ConnectConfig = {
    host: hop.host,
    port: hop.port || 22,
    username: hop.username,
    // ssh2 要毫秒。0 = 关闭保活，必须原样传 0 —— 这里再兜底 30 秒等于关不掉
    // （配置层 `normalizeKeepalive` 已经保证缺省是 30，走到这里 0 只能是用户显式配的）
    keepaliveInterval: hop.keepaliveInterval > 0 ? hop.keepaliveInterval * 1000 : 0,
    readyTimeout: READY_TIMEOUT_MS
  }
  if (hop.authType === 'privateKey' && hop.privateKey) {
    config.privateKey = hop.privateKey
    if (hop.passphrase) config.passphrase = hop.passphrase
  } else if (hop.password) {
    config.password = hop.password
  }
  if (sock) config.sock = sock
  return config
}

/**
 * 建立到目标主机的连接（必要时经跳板链）。
 *
 * 单跳时序列：resolving → handshake → authenticating → ready。
 * 多跳时每跳重放该序列，`detail` 标注「第 N/M 跳：user@host」。
 */
export async function connectWithJumps(
  host: ResolvedSshHost,
  opts: { onStage?: StageReporter } = {}
): Promise<ConnectedChain> {
  const chain = resolveChain(host)
  const total = chain.length
  const clients: Client[] = []

  const dispose = (): void => {
    for (const client of clients) {
      try {
        client.end()
      } catch {
        // 可能已在失败流程中关闭
      }
    }
  }

  const hopDetail = (hop: ResolvedSshHost, index: number): string | undefined =>
    total > 1 ? `第 ${index + 1}/${total} 跳：${hop.username}@${hop.host}` : undefined

  /** 这条链给日志看的落款（带跳板链时把链一起写上，否则「连不上」看不出在连哪儿） */
  const chainLabel =
    total > 1
      ? `${host.username}@${host.host}:${host.port || 22}（经 ${chain
          .slice(0, -1)
          .map((hop) => `${hop.username}@${hop.host}`)
          .join(' → ')}）`
      : `${host.username}@${host.host}:${host.port || 22}`

  /** 连接单跳；返回 ready 的 Client。`sock` 为上一跳开出的转发通道（首跳为空） */
  const connectHop = (hop: ResolvedSshHost, index: number, sock?: Duplex): Promise<Client> =>
    new Promise<Client>((resolve, reject) => {
      const client = new Client()
      clients.push(client)
      let settled = false
      const fail = (err: Error | string): void => {
        if (settled) return
        settled = true
        reject(err instanceof Error ? err : new Error(err))
      }
      const detail = hopDetail(hop, index)
      client
        .on('connect', () => opts.onStage?.('handshake', detail))
        .on('handshake', () => opts.onStage?.('authenticating', detail))
        .on('ready', () => {
          settled = true
          resolve(client)
        })
        .on('error', (err: Error) => {
          if (index === 0) {
            fail(err.message)
            return
          }
          const via = chain[index - 1]
          fail(
            `经跳板机 ${via.username}@${via.host} 连接 ${hop.host}:${hop.port || 22} 失败：${err.message}`
          )
        })
        .on('close', () => fail('连接在建立过程中被关闭'))
        .connect(buildHopConfig(hop, sock))
    })

  let upstream: Duplex | undefined
  let lastClient: Client | null = null
  try {
    for (let i = 0; i < total; i++) {
      const hop = chain[i]
      const detail = hopDetail(hop, i)
      opts.onStage?.('resolving', detail)
      if (i > 0) {
        // 经上一跳开一条到本跳的 direct-tcpip 通道，作为本跳的 sock
        const via = chain[i - 1]
        upstream = await new Promise<Duplex>((resolve, reject) => {
          lastClient!.forwardOut('127.0.0.1', 0, hop.host, hop.port || 22, (err, stream) => {
            if (err || !stream) {
              reject(
                new Error(
                  `经跳板机 ${via.username}@${via.host} 无法连接 ${hop.host}:${hop.port || 22}：` +
                    `${err?.message ?? '通道建立失败'}`
                )
              )
              return
            }
            resolve(stream)
          })
        })
      }
      lastClient = await connectHop(hop, i, upstream)
    }
  } catch (err) {
    dispose()
    const error = err instanceof Error ? err : new Error(String(err))
    // 这里是**所有** SSH 连接（终端 / SFTP / 隧道 / 监控）的唯一建连入口，
    // 所以失败在这一处记就够，别在调用方各记一份（同一次失败会重复好几条）
    appLog.error(STAGE, 'SSH 连接失败', `${chainLabel}\n${error.message}`)
    throw error
  }

  // 成功也记一条：它在日志面板里是「这台机器什么时候被连过」的唯一痕迹
  appLog.info(STAGE, 'SSH 已连接', chainLabel)
  return { client: clients[clients.length - 1]!, dispose }
}
