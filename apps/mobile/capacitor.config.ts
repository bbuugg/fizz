import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Fizz 安卓端（Capacitor）配置。
 *
 * ## 本地 `www`（前端形态）
 *
 * 壳加载的是**本工程自己构建的 `dist`**（`apps/mobile`，独立 vite 工程），页面 origin 是
 * `https://localhost`。API / SSE / WS 因此必须打**绝对地址**，但地址**不烘进产物**：
 * hosted `/m` 的连接页填写服务地址，存在本机（`fizz.mobile.serverUrl`，见 `src/server-url.ts`），
 * `src/main.tsx` 启动时交给 `setServerBase()`。同一个 APK 可以连不同服务器。
 *
 * 运行期还能用 `?server=http://host:port` 临时覆盖，不用改已保存的地址。
 *
 * ## 以前那种「远程加载」为什么不做了
 *
 * 早先 `server.url` 指向 server、直接加载 server 托管的 `apps/web/dist`，好处是天然同源。
 * 代价是**壳没有自己的前端**：移动端不能单独改一行 UI，且离线时整屏空白。
 * 服务端地址可配之后（`Connection.serverBase`），本地 `www` 这条路才真正成立。
 * APK 可选择附带 `@fizz/capacitor-local-runtime` 插件与运行时资产，让本机 Fizz server
 * 在 app 私有目录启动；未打入运行时的 hosted 构建仍在运行期配置 API 地址。
 *
 * 真要临时回到远程加载，把 `server.url` 加回来即可（记得 `/api` 与 WS 同源）。
 */

const config: CapacitorConfig = {
  appId: 'cn.codeemo.fizz',
  appName: 'Fizz',
  /** 本工程自己的构建产物（`vite build` → `apps/mobile/dist`），不再是 web dist 的副本 */
  webDir: 'dist',
  server: {
    /*
     * `androidScheme` 显式写 https（也是默认值）：origin = `https://localhost`。
     * 页面是 https、API 可能是局域网 http，所以下面 `allowMixedContent` 必须开。
     */
    androidScheme: 'https',
    /*
     * 服务端是 `http://` 时必须放行明文（安卓 9+ 默认禁）。地址是运行期由用户填的，
     * 构建时无从判断，所以一律放行 —— 局域网自建 server 最常见的就是 http。
     */
    cleartext: true
  },
  android: {
    /** 页面是 https、API 可能是 http（局域网自测）：不放行就是整块请求被拦 */
    allowMixedContent: true
  },
  plugins: {
    /*
     * ⚠️ 这个键不是可有可无的调优项，是「启动屏抖一下」的解药。
     *
     * SystemBars 的 `hasViewportCover` 默认 **false**，要等页面 commit 之后它才注入一段 JS
     * 去读 `meta[name=viewport]` 里有没有 `viewport-fit=cover`，读到之后才
     * `requestApplyInsets()` 重算一次。于是冷启动的次序是：
     *
     *   1. 监听器先按「没有 cover」跑一遍 → `decorView.setPadding(左, 状态栏高, 右, 手势条高)`
     *      → **WebView 被内缩**，页面视口跟着变小；
     *   2. 页面在这块小视口里画出 `#boot-splash`（`position: fixed; inset: 0`，logo 居中）；
     *   3. 页面 commit → JS 读到 cover → padding 清零 → **WebView 变大** → 视口变大 →
     *      首屏 logo 重新居中，位置跳一下（用户报的「splash 抖动一下」）。
     *
     * 把 hint 写成 `cover` 就是告诉它「一开始就有 cover」：监听器从第一帧起走
     * passthrough 分支（不 padding、只注入 `--safe-area-inset-*`），中途不再重排。
     * 这是官方为此留的开关，`SystemBars.java` 里那句注释的原话就是
     * "can help prevent layout shifting"。
     *
     * ⚠️ 它只影响「首帧之前」的判定，前提仍是 `index.html` 的 viewport 真的带
     * `viewport-fit=cover`（带了，见那边的注释）；两边必须一致，否则 inset 会算错。
     */
    SystemBars: {
      initialViewportFitValueHint: 'cover'
    },
    /*
     * ⚠️ 这里**不配 `StatusBar.overlaysWebView`**（曾经配的是 `false`）。
     *
     * Capacitor 8 的安卓端内置了 `SystemBars` 插件（`Bridge` 里自动注册，
     * `android.insetsHandling` 默认 `css`）：它把窗口切到 edge-to-edge、量出系统栏高度，
     * 再往 `<html>` 注入 `--safe-area-inset-top/right/bottom/left`。页面侧用这几个变量
     * 让出状态栏与手势条（见 `src/app/app-shell.tsx` 的根容器）。
     *
     * 而 `overlaysWebView: false` 走的是**已废弃**的 `systemUiVisibility`，Android 15+
     * 上 `setStatusBarColor` 也早就无效，但清 `LAYOUT_FULLSCREEN` 仍会跟上面那套抢布局 ——
     * 表现就是状态栏 / 手势条那两条露出原生窗口背景（`Theme.AppCompat.DayNight` 的底色，
     * 通常是白），与页面主题色对不上。
     *
     * 前提是 `index.html` 的 viewport 带 `viewport-fit=cover`：SystemBars 只在检测到它时
     * 才把 insets 透传给页面，否则会自己给 WebView 加 padding，页面再让一次就是双重内缩。
     */
    /**
     * 软键盘弹出时让布局视口一起缩，CSS 高度链（`height: 100%`）与 `visualViewport`
     * 都贴到键盘上沿，终端底部快捷键条 / 输入框不会被盖住。
     *
     * 两处缺一不可：原生这侧（`Keyboard.resize: 'native'` + `SystemBars` 在 IME 出现时
     * 给 decorView 加等高的底部 padding）与页面这侧的
     * `interactive-widget=resizes-content`（见 `index.html` 文件头）。只留原生时部分
     * WebView / 机型不会把布局视口缩下来，快捷键条就落到输入法下层。
     */
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true
    }
  }
}

export default config
