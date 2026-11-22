/**
 * desktop 的 preload 侧：把传输桥包成 `contextBridge` 可直接暴露的对象。
 *
 * preload 跑在 `contextIsolation: true` 的隔离世界里，**只有这里能碰 `ipcRenderer`**；
 * 渲染端拿到的是 `AgentTransportBridge` 这个纯函数对象（不含任何 Electron 句柄）。
 *
 * ⚠️ 只依赖 `./channels`（零依赖），不要把 `./transport-ipc` 或 `./manager` 拖进来
 * —— 那会把 `electron.app` 与 `@fizz/server` 打进 preload。
 */
import { ipcRenderer, webUtils } from 'electron'
import {
  AGENT_IPC,
  type AgentHttpResponse,
  type AgentSseChunkEvent,
  type AgentSseEndEvent,
  type AgentSseOpenRequest,
  type AgentSseOpenResult,
  type AgentTransportBridge,
  type AgentTransportRequest,
  type LocalFileReadResult,
  type LocalFileWriteResult,
  type PtyDataEvent,
  type PtyExitEvent,
  type PtyOpenRequest,
  type PtyOpenResult,
  type WsClosedEvent,
  type WsDataEvent,
  type WsOpenRequest,
  type WsOpenResult,
  type WsSendPayload,
  type ZmodemPickedFile
} from './channels'

export function createAgentTransportBridge(): AgentTransportBridge {
  return {
    request: (input: AgentTransportRequest) =>
      ipcRenderer.invoke(AGENT_IPC.http, input) as Promise<AgentHttpResponse>,

    cancelRequest: (requestId: string) =>
      ipcRenderer.invoke(AGENT_IPC.httpCancel, requestId) as Promise<void>,

    openSse: (input: AgentSseOpenRequest) =>
      ipcRenderer.invoke(AGENT_IPC.sseOpen, input) as Promise<AgentSseOpenResult>,

    closeSse: (streamId: string) => ipcRenderer.invoke(AGENT_IPC.sseClose, streamId) as Promise<void>,

    onSseChunk: (cb: (event: AgentSseChunkEvent) => void) => {
      // 只转发本窗口自己的流：main 侧按 streamId 推，事件里带着它
      const listener = (_e: unknown, payload: AgentSseChunkEvent): void => cb(payload)
      ipcRenderer.on(AGENT_IPC.sseChunk, listener)
      return () => ipcRenderer.off(AGENT_IPC.sseChunk, listener)
    },

    onSseEnd: (cb: (event: AgentSseEndEvent) => void) => {
      const listener = (_e: unknown, payload: AgentSseEndEvent): void => cb(payload)
      ipcRenderer.on(AGENT_IPC.sseEnd, listener)
      return () => ipcRenderer.off(AGENT_IPC.sseEnd, listener)
    },

    pickDirectory: () => ipcRenderer.invoke(AGENT_IPC.pickDirectory) as Promise<string | null>,

    /*
     * 拖拽落点取路径：**不经 IPC**，`webUtils` 在 preload 里直接可用（沙箱 preload 的
     * 白名单模块之一），而 `File` 对象只有渲染端有 —— 绕去主进程反而拿不到它。
     *
     * `webUtils.getPathForFile` 在 Electron 的类型声明里收 DOM 的 `File`，本包（主进程
     * 也编）没有 DOM lib，所以按结构化类型调；传进来的不是 File 时它会抛，吃成空串
     * 交给调用方当「没拖到东西」。
     */
    getPathForFile: (file) => {
      const api = webUtils as unknown as { getPathForFile(target: object): string }
      try {
        return api.getPathForFile(file) ?? ''
      } catch {
        return ''
      }
    },

    pickLocalMarkdownFile: () =>
      ipcRenderer.invoke(AGENT_IPC.pickLocalMarkdownFile) as Promise<string | null>,

    readLocalFile: (path: string) =>
      ipcRenderer.invoke(AGENT_IPC.localFileRead, path) as Promise<LocalFileReadResult>,

    writeLocalFile: (path: string, content: string) =>
      ipcRenderer.invoke(AGENT_IPC.localFileWrite, path, content) as Promise<LocalFileWriteResult>,

    openPty: (input: PtyOpenRequest) =>
      ipcRenderer.invoke(AGENT_IPC.ptyOpen, input) as Promise<PtyOpenResult>,

    ptyWrite: (sessionId: string, data: string | Uint8Array) =>
      ipcRenderer.invoke(AGENT_IPC.ptyWrite, sessionId, data) as Promise<void>,

    ptyResize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(AGENT_IPC.ptyResize, sessionId, cols, rows) as Promise<void>,

    ptyKill: (sessionId: string) =>
      ipcRenderer.invoke(AGENT_IPC.ptyKill, sessionId) as Promise<void>,

    ptyStop: (sessionId: string) =>
      ipcRenderer.invoke(AGENT_IPC.ptyStop, sessionId) as Promise<void>,

    onPtyData: (cb: (event: PtyDataEvent) => void) => {
      const listener = (_e: unknown, payload: PtyDataEvent): void => cb(payload)
      ipcRenderer.on(AGENT_IPC.ptyData, listener)
      return () => ipcRenderer.off(AGENT_IPC.ptyData, listener)
    },

    onPtyExit: (cb: (event: PtyExitEvent) => void) => {
      const listener = (_e: unknown, payload: PtyExitEvent): void => cb(payload)
      ipcRenderer.on(AGENT_IPC.ptyExit, listener)
      return () => ipcRenderer.off(AGENT_IPC.ptyExit, listener)
    },

    zmodemPickFiles: () =>
      ipcRenderer.invoke(AGENT_IPC.zmodemPickFiles) as Promise<ZmodemPickedFile[]>,

    zmodemAskSavePath: (defaultName: string) =>
      ipcRenderer.invoke(AGENT_IPC.zmodemAskSavePath, defaultName) as Promise<string | null>,

    zmodemSaveFileTo: (target: string, data: Uint8Array) =>
      ipcRenderer.invoke(AGENT_IPC.zmodemSaveFileTo, target, data) as Promise<string | null>,

    fileAskSavePath: (defaultName: string) =>
      ipcRenderer.invoke(AGENT_IPC.fileAskSavePath, defaultName) as Promise<string | null>,

    // `data` 走结构化克隆到主进程是 `Uint8Array`，主进程直接交给 `fs`，渲染端不做编码
    fileSaveChunk: (target: string, data: Uint8Array, append: boolean) =>
      ipcRenderer.invoke(AGENT_IPC.fileSaveChunk, target, data, append) as Promise<string | null>,

    fileRemovePath: (target: string) =>
      ipcRenderer.invoke(AGENT_IPC.fileRemovePath, target) as Promise<boolean>,

    openExternal: (url: string) =>
      ipcRenderer.invoke(AGENT_IPC.openExternal, url) as Promise<{ ok: boolean; error?: string }>,

    openPath: (path: string) =>
      ipcRenderer.invoke(AGENT_IPC.openPath, path) as Promise<{ ok: boolean; error?: string }>,

    openWs: (input: WsOpenRequest) =>
      ipcRenderer.invoke(AGENT_IPC.wsOpen, input) as Promise<WsOpenResult>,

    sendWs: (payload: WsSendPayload) =>
      ipcRenderer.invoke(AGENT_IPC.wsSend, payload) as Promise<void>,

    closeWs: (streamId: string) => ipcRenderer.invoke(AGENT_IPC.wsClose, streamId) as Promise<void>,

    onWsData: (cb: (event: WsDataEvent) => void) => {
      const listener = (_e: unknown, payload: WsDataEvent): void => cb(payload)
      ipcRenderer.on(AGENT_IPC.wsData, listener)
      return () => ipcRenderer.off(AGENT_IPC.wsData, listener)
    },

    onWsClosed: (cb: (event: WsClosedEvent) => void) => {
      const listener = (_e: unknown, payload: WsClosedEvent): void => cb(payload)
      ipcRenderer.on(AGENT_IPC.wsClosed, listener)
      return () => ipcRenderer.off(AGENT_IPC.wsClosed, listener)
    }
  }
}
