/**
 * 传输引擎的**取消**路径（防回归）。
 *
 * 实际发生过的故障：在清单里点「取消传输」毫无反应，进度一路涨到 100% 变成「已完成」。
 * 两个原因叠在一起，各写一条用例钉住：
 *
 * 1. **分片请求没带 `transferId`** —— 服务端按它登记「这一片的取消函数」
 *    （`apps/server/src/server/ssh/sftp.ts` 的 `writeFile`），漏了服务端就只能用
 *    `ul-${Date.now()}-${name}` 这种每片都不同的临时 key，`POST /api/sftp/abort`
 *    永远命中不了：取消只剩「客户端不发下一片」，远端还留着半份文件。
 * 2. **分片循环不看 `signal.aborted`** —— desktop 的 IPC 桥不转发 `AbortSignal`
 *    （`agent-host/src/transport-ipc.ts`），那边 `abort()` 对已经发出去的那一片是空转，
 *    取消只能等整份文件传完。
 *
 * 只 mock store（引擎从 `useAgentStore.getState()` 取 api 与写入方法），**不** mock 传输
 * 协议本身：断言的就是「发了几片、每片带了什么、终态是什么」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    getApi: vi.fn(),
    addTransfer: vi.fn(),
    patchTransfer: vi.fn(),
    settleTransfer: vi.fn()
  }
}))

vi.mock('@fizz/agent-kit/shared/lib/stores/agent-store', () => ({
  useAgentStore: { getState: () => mocks.state }
}))

import { SFTP_CHUNK_BYTES } from '@fizz/contracts/agent-api'
import {
  cancelTransfer,
  runDownload,
  runUpload
} from '@fizz/agent-kit/shared/lib/file-transfer/engine'
import type { TransferSink } from '@fizz/agent-kit/shared/lib/file-transfer/sink'

/** 造一个指定字节数的假文件（内容无所谓，只关心切片与请求） */
function makeFile(size: number): File {
  return new File([new Uint8Array(size)], 'big.bin')
}

/** 造一段「发出去就挂着」的请求：好让测试在它挂住的时候点取消 */
function pending<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runUpload 的取消', () => {
  it('取消后不再发下一片，且每片都带同一个 transferId', async () => {
    const first = pending<{ ok: boolean }>()
    const calls: { index: number; transferId?: string }[] = []
    const sftpUploadChunk = vi.fn((input: { index: number; transferId?: string }) => {
      calls.push(input)
      return calls.length === 1 ? first.promise : Promise.resolve({ ok: true })
    })
    const sftpAbort = vi.fn(async (_input: Record<string, unknown>) => {})
    mocks.state.getApi.mockReturnValue({ sftpUploadChunk, sftpAbort })

    // +1 字节保证至少两片（一片挂住时取消，才有「下一片」可断言）
    const file = makeFile(SFTP_CHUNK_BYTES + 1)
    const task = runUpload({ file, hostId: 'h1', hostLabel: '主机', dir: '/tmp' })

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const id = calls[0]?.transferId
    expect(id, '分片请求必须带 transferId，否则服务端无法取消在途写流').toBeTruthy()

    cancelTransfer(id!)
    first.release({ ok: true })

    await expect(task).resolves.toBe('canceled')
    expect(calls, '取消之后不该再发第二片').toHaveLength(1)
    expect(sftpAbort, '上传取消必须通知服务端销毁写流并删掉半份文件').toHaveBeenCalledTimes(1)
    expect(sftpAbort.mock.calls[0]?.[0]).toMatchObject({
      transferId: id,
      hostId: 'h1',
      dir: '/tmp',
      name: 'big.bin'
    })
  })

  it('最后一片刚成功时点取消，仍算取消而不是完成', async () => {
    const last = pending<{ ok: boolean }>()
    const calls: { index: number; transferId?: string }[] = []
    const sftpUploadChunk = vi.fn((input: { index: number; transferId?: string }) => {
      calls.push(input)
      return last.promise
    })
    mocks.state.getApi.mockReturnValue({ sftpUploadChunk, sftpAbort: vi.fn(async () => {}) })

    // 小文件 = 单片：这一片就是「最后一片」，取消与它的应答赛跑
    const task = runUpload({ file: makeFile(10), hostId: 'h1', hostLabel: '主机', dir: '/tmp' })

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    cancelTransfer(calls[0]!.transferId!)
    last.release({ ok: true })

    await expect(task).resolves.toBe('canceled')
  })
})

describe('runDownload 的取消', () => {
  it('取消后不再拉下一片，落盘走 abort', async () => {
    const first = pending<{ dataBase64: string; eof: boolean }>()
    const calls: unknown[] = []
    const sftpDownloadChunk = vi.fn(() => {
      calls.push(1)
      return calls.length === 1 ? first.promise : Promise.resolve({ dataBase64: '', eof: true })
    })
    const sftpAbort = vi.fn(async () => {})
    mocks.state.getApi.mockReturnValue({ sftpDownloadChunk, sftpAbort })

    const written: Uint8Array[] = []
    const sink: TransferSink = {
      write: async (chunk) => {
        written.push(chunk)
      },
      close: async () => {},
      abort: async () => {},
      localPath: null,
      streaming: true
    }

    // 2 片：第一片挂住时取消
    const task = runDownload({
      hostId: 'h1',
      hostLabel: '主机',
      path: '/tmp/big.bin',
      name: 'big.bin',
      size: SFTP_CHUNK_BYTES + 1,
      sink: async () => sink
    })

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    // 上传的 id 只有引擎自己知道；下载同理 —— 从 store 的 addTransfer 里取
    const id = mocks.state.addTransfer.mock.calls[0]?.[0]?.id as string
    expect(id).toBeTruthy()

    cancelTransfer(id)
    first.release({ dataBase64: btoa('abc'), eof: false })

    await expect(task).resolves.toBe('canceled')
    expect(calls, '取消之后不该再拉第二片').toHaveLength(1)
    expect(written, '取消时不该把没收完的字节写进落点').toHaveLength(0)
    expect(sftpAbort, '下载没有在途状态要收拾，不该发 abort').not.toHaveBeenCalled()
  })
})
