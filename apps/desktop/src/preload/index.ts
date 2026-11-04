/**
 * desktop 的 preload：暴露 Agent 传输桥 + 窗口桥两个对象。
 *
 * `contextIsolation: true` 下渲染端拿不到 `ipcRenderer`，所有与主进程的往来都必须
 * 经过这里暴露的纯函数（见 packages/agent-host/src/preload.ts）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { createAgentTransportBridge } from '@fizz/agent-host/preload'
import {
  WINDOW_IPC,
  type AppUpdateStatus,
  type DesktopAppInfo,
  type DesktopThemeMode,
  type DesktopWindowBridge,
  type IdeInfo,
  type OpenResult,
  type RemoteAccessInput,
  type RemoteAccessState,
  type SystemNotice
} from '../shared/window'

contextBridge.exposeInMainWorld('fizzHost', createAgentTransportBridge())

const windowBridge: DesktopWindowBridge = {
  minimize: () => ipcRenderer.invoke(WINDOW_IPC.minimize) as Promise<void>,
  toggleMaximize: () => ipcRenderer.invoke(WINDOW_IPC.toggleMaximize) as Promise<void>,
  close: () => ipcRenderer.invoke(WINDOW_IPC.close) as Promise<void>,
  quit: () => ipcRenderer.invoke(WINDOW_IPC.quit) as Promise<void>,
  isMaximized: () => ipcRenderer.invoke(WINDOW_IPC.isMaximized) as Promise<boolean>,
  notify: (notice: SystemNotice) => ipcRenderer.invoke(WINDOW_IPC.notify, notice) as Promise<boolean>,
  // sendSync：主进程持有这个偏好，渲染端启动时同步取一次（不能先显示错的值再跳）
  loadCloseToTray: () => ipcRenderer.sendSync(WINDOW_IPC.loadCloseToTray) as boolean,
  setCloseToTray: (enabled: boolean) =>
    ipcRenderer.invoke(WINDOW_IPC.setCloseToTray, enabled) as Promise<void>,
  openConversationWindow: (initialConversationId?: string) =>
    ipcRenderer.invoke(WINDOW_IPC.openConversationWindow, initialConversationId) as Promise<void>,
  closeConversationWindow: () =>
    ipcRenderer.invoke(WINDOW_IPC.closeConversationWindow) as Promise<void>,
  // sendSync：主窗口标题栏开关首帧就要正确（与 loadCloseToTray 同一套路）
  isConversationWindowOpen: () =>
    ipcRenderer.sendSync(WINDOW_IPC.isConversationWindowOpen) as boolean,
  onConversationWindowChange: (cb: (open: boolean) => void) => {
    const listener = (_e: unknown, open: boolean): void => cb(open)
    ipcRenderer.on(WINDOW_IPC.conversationWindowChange, listener)
    return () => ipcRenderer.off(WINDOW_IPC.conversationWindowChange, listener)
  },
  openInMainWindow: (conversationId?: string) =>
    ipcRenderer.invoke(WINDOW_IPC.openInMainWindow, conversationId) as Promise<void>,
  // sendSync：主窗口首帧就要把标签摆对，异步会先落旧会话再跳（与 loadAlwaysOnTop 同一套路）
  takePendingDeepLink: () => ipcRenderer.sendSync(WINDOW_IPC.takePendingDeepLink) as string | null,
  onDeepLink: (cb: (conversationId: string) => void) => {
    const listener = (_e: unknown, conversationId: string): void => cb(conversationId)
    ipcRenderer.on(WINDOW_IPC.deepLink, listener)
    return () => ipcRenderer.off(WINDOW_IPC.deepLink, listener)
  },
  setAlwaysOnTop: (enabled: boolean) =>
    ipcRenderer.invoke(WINDOW_IPC.setAlwaysOnTop, enabled) as Promise<void>,
  // sendSync：浮窗首帧就要正确的图钉状态（与 loadCloseToTray 同一套路）
  loadAlwaysOnTop: () => ipcRenderer.sendSync(WINDOW_IPC.loadAlwaysOnTop) as boolean,
  listIdes: () => ipcRenderer.invoke(WINDOW_IPC.listIdes) as Promise<IdeInfo[]>,
  openFileManager: (dir: string) =>
    ipcRenderer.invoke(WINDOW_IPC.openFileManager, dir) as Promise<OpenResult>,
  revealFile: (path: string) =>
    ipcRenderer.invoke(WINDOW_IPC.revealFile, path) as Promise<OpenResult>,
  openIde: (id: string, dir: string) =>
    ipcRenderer.invoke(WINDOW_IPC.openIde, id, dir) as Promise<OpenResult>,
  // sendSync：设置页挂载时同步取一次（与 loadCloseToTray 同一套路）
  loadRemoteAccess: () => ipcRenderer.sendSync(WINDOW_IPC.loadRemoteAccess) as RemoteAccessState,
  setRemoteAccess: (input: RemoteAccessInput) =>
    ipcRenderer.invoke(WINDOW_IPC.setRemoteAccess, input) as Promise<RemoteAccessState>,
  setTheme: (mode: DesktopThemeMode) =>
    ipcRenderer.invoke(WINDOW_IPC.setTheme, mode) as Promise<void>,
  // sendSync：关于弹窗打开时同步取一次（与 loadRemoteAccess 同一套路）
  loadAppInfo: () => ipcRenderer.sendSync(WINDOW_IPC.loadAppInfo) as DesktopAppInfo,
  // 应用内自动更新：状态机在主进程（autoUpdater 是全局单例，订阅只能有一份），
  // 这里全是「问一次 / 让主进程做一件事」，进度靠 appUpdateChanged 推回来
  appUpdateStatus: () => ipcRenderer.invoke(WINDOW_IPC.appUpdateStatus) as Promise<AppUpdateStatus>,
  appUpdateCheck: () => ipcRenderer.invoke(WINDOW_IPC.appUpdateCheck) as Promise<AppUpdateStatus>,
  appUpdateDownload: () =>
    ipcRenderer.invoke(WINDOW_IPC.appUpdateDownload) as Promise<AppUpdateStatus>,
  appUpdateCancel: () => ipcRenderer.invoke(WINDOW_IPC.appUpdateCancel) as Promise<AppUpdateStatus>,
  appUpdateInstall: () => ipcRenderer.invoke(WINDOW_IPC.appUpdateInstall) as Promise<boolean>,
  // 外部 Markdown 文件：先取存量（监听挂上之前就发完的那批），之后才靠事件接增量
  takePendingExternalFiles: () =>
    ipcRenderer.invoke(WINDOW_IPC.takePendingExternalFiles) as Promise<string[]>,
  onExternalFileOpen: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on(WINDOW_IPC.externalFileOpen, listener)
    return () => ipcRenderer.off(WINDOW_IPC.externalFileOpen, listener)
  },
  // 只推一个数字，主进程那边只更新缓存（退出拦截时读）—— 打得再频繁也没有开销
  setDirtyTabCount: (count: number) =>
    ipcRenderer.invoke(WINDOW_IPC.setDirtyTabCount, count) as Promise<void>,
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on(WINDOW_IPC.maximizedChanged, listener)
    return () => ipcRenderer.off(WINDOW_IPC.maximizedChanged, listener)
  },
  onAppUpdateChange: (cb: (status: AppUpdateStatus) => void) => {
    const listener = (_e: unknown, status: AppUpdateStatus): void => cb(status)
    ipcRenderer.on(WINDOW_IPC.appUpdateChanged, listener)
    return () => ipcRenderer.off(WINDOW_IPC.appUpdateChanged, listener)
  }
}

contextBridge.exposeInMainWorld('fizzWindow', windowBridge)
