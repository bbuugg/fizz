import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

/**
 * 本地 Capacitor 插件（`apps/mobile/plugins/app-updater`，原生名 `FizzUpdater`）。
 *
 * 只包了「下载 / 取消 / 查安装权限 / 去开权限 / 调起安装器」五件事，版本判断与
 * GitHub 查询全在 JS（见 `./github-release`）。原生代码由 `cap sync` 通过插件的
 * `package.json` → `capacitor.android.src` 链接进安卓工程。
 *
 * ⚠️ 与 `native-notify.ts` 同一条纪律：插件对象是 Proxy，**不能把它包进 async 返回值**
 * （任何属性都会返回函数，`then` 被当成 thenable），只能直接 `await 它的方法`。
 */
export interface FizzUpdaterPlugin {
  download(options: { url: string }): Promise<void>
  cancel(): Promise<void>
  canInstall(): Promise<{ allowed: boolean }>
  openInstallPermissionSettings(): Promise<void>
  install(): Promise<void>
  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (event: { percent: number }) => void
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'downloadCompleted',
    listenerFunc: (event: { percent: number }) => void
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'downloadFailed',
    listenerFunc: (event: { code: string }) => void
  ): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

export const FizzUpdater = registerPlugin<FizzUpdaterPlugin>('FizzUpdater')