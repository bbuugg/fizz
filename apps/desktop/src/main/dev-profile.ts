/**
 * dev 版用独立的一套 userData，安装版（Fizz.exe / 打包产物）可以和 `npm run dev:desktop`
 * 同时跑，互不干扰：
 *
 * - 单实例锁按 userData 目录区分 —— 不隔离的话后启动的那个会直接 `app.quit()`；
 * - Chromium 缓存 / window-prefs.json / 远程访问配置不共用；
 * - 数据目录（JsonStore）不共用：两个进程各持一份内存快照，写盘是整份覆盖，
 *   同目录下会静默互相覆盖。
 *
 * 判定只看 `VITE_DEV_SERVER_URL`（`scripts/dev.mjs` 注入）：`electron .` 直接跑构建产物
 * 时没有这个变量，仍与安装版共用 profile —— 那是「本机试运行」，语义上就该是同一个应用。
 *
 * ⚠️ 必须在 `@fizz/agent-host` 之前求值：`agent-host/env` 在模块初始化阶段就把
 * `FIZZ_DATA_DIR` 定下来（见 index.ts 的第一条 import，不要调整顺序）。
 */
import { join } from 'node:path'
import { app } from 'electron'

export const IS_DEV_INSTANCE = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL?.trim()

if (IS_DEV_INSTANCE) {
  const root = join(app.getPath('appData'), 'Fizz Dev')
  app.setPath('userData', root)
  // 仍保留显式覆盖能力（想连真实数据时自己设 FIZZ_DATA_DIR）
  if (!process.env.FIZZ_DATA_DIR?.trim()) {
    process.env.FIZZ_DATA_DIR = join(root, 'server-data')
  }
}
