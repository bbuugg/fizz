import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const APP_ROOT = import.meta.dirname
/** 仓库根：`apps/extension` 往上两层 */
const REPO_ROOT = resolve(APP_ROOT, '../..')
/** 手机版工程：本扩展的整个外壳都是从这里来的（见 README 的「为什么引用手机版」） */
const MOBILE_ROOT = resolve(APP_ROOT, '../mobile')

/**
 * 把目录下的模块逐条映射成 alias。
 *
 * ⚠️ 不能写带斜杠的通配（`@rollup/plugin-alias` 的 `matches` 只认 `===` 与
 * `startsWith(find + '/')`，带斜杠的 find 永不命中）；也不能只写包名本体（会被拼成
 * `…/index.ts/button`）。所以逐条展开 —— 与 `apps/web` / `apps/mobile` 逐字同源。
 */
function moduleAliases(dir: string, prefix: string): Record<string, string> {
  const base = resolve(APP_ROOT, dir)
  return Object.fromEntries(
    readdirSync(base)
      .filter((file) => /\.tsx?$/.test(file) && !/^index\.tsx?$/.test(file))
      .map((file) => [`${prefix}/${file.replace(/\.tsx?$/, '')}`, resolve(base, file)])
  )
}

/**
 * 生成 `dist/manifest.json`。
 *
 * 版本号从 `package.json` 取：MV3 的 `version` 必须与产物对得上，手写两处必然有一天忘掉
 * 其中一处（和仓库里「版本号只有一处算数」那条规矩同一个道理）。源文件 `manifest.json`
 * 留在工程根、**不**进 `public/` —— 放了会被原样拷进 dist，盖掉这里注入的版本。
 */
function chromeManifest(): Plugin {
  return {
    name: 'chrome-manifest',
    apply: 'build',
    generateBundle() {
      const pkg = JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8')) as {
        version: string
      }
      const manifest = JSON.parse(readFileSync(resolve(APP_ROOT, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >
      manifest.version = pkg.version
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`
      })
    }
  }
}

/**
 * Chrome 扩展（MV3）的构建配置。
 *
 * ## 外壳来自手机版
 *
 * 界面**整棵**复用 `apps/mobile/src/app`（`App` / `AppProvider` / `AppShell` /
 * `PanelView` / `ConnectGate`），本工程只提供三样手机版没有的东西：
 *
 * 1. `src/host.ts` —— 宿主的存储实现（键前缀 `fizz.ext.*`）；
 * 2. `src/main.tsx` —— 启动链（注入宿主 → 注入服务端地址 → 渲染）；
 * 3. `manifest.json` + `public/background.js` —— 扩展自己的壳（侧栏 / 右键菜单）。
 *
 * 所以 `@` 别名指向 `apps/mobile/src`，而不是本工程的 `src`（手机版内部就是这么 import
 * 的）。只有 `@/server-url` 例外，换成扩展自己那一个 —— 见 `src/server-url.ts`。
 *
 * ## 与 web / mobile 的差异
 *
 * - `base: '/'`：扩展页面在 `chrome-extension://<id>/index.html`，绝对路径照样对；
 * - 不做 `/api` 代理：请求全部是**跨源**打到用户登录时填的服务端（扩展有
 *   `host_permissions`，不受 CORS 约束）。dev 端口 5190 只用于调样式，登录页照常填地址；
 * - `emptyOutDir: true`：dist 里只有本工程产物（monaco 从 `public/` 拷进来，不是 dist
 *   里长出来的），整目录清干净最省事。web / desktop 那套 `cleanStaleAssets` 是因为它们的
 *   monaco 早就躺进 dist 了，才不敢整目录清。
 */
export default defineConfig({
  root: APP_ROOT,
  base: '/',
  define: {
    // 设置侧栏底部显示版本号（见 `@fizz/agent-kit` 的 `shared/lib/app-version.ts`）
    __APP_VERSION__: JSON.stringify(
      (JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8')) as { version: string })
        .version
    )
  },
  plugins: [react(), tailwindcss(), chromeManifest()],
  resolve: {
    alias: {
      // ⚠️ 顺序有意义：`@/server-url` 必须排在 `@` 前面（alias 按表顺序取第一个命中项）。
      // 只换这一个文件，其余 `@/...` 全部落在手机版。
      '@/server-url': resolve(APP_ROOT, 'src/server-url.ts'),
      // 手机版外壳的内部 import（`@/app/...`）—— 指向手机版，不是本工程
      '@': resolve(MOBILE_ROOT, 'src'),

      // 领域组件包：`features/*` / `shared/*` / `shell/*` 三段前缀必须排在包名本体之前
      // （alias 是前缀替换，`@fizz/agent-kit` 会吃掉所有 `@fizz/agent-kit/…`）
      '@fizz/agent-kit/features': resolve(REPO_ROOT, 'packages/agent-kit/src/features'),
      '@fizz/agent-kit/shared': resolve(REPO_ROOT, 'packages/agent-kit/src/shared'),
      '@fizz/agent-kit/shell': resolve(REPO_ROOT, 'packages/agent-kit/src/shell'),
      '@fizz/agent-kit': resolve(REPO_ROOT, 'packages/agent-kit/src/index.ts'),

      // 无业务原语（逐条展开）。`@fizz/ui/dialog` / `@fizz/ui/alert-dialog` 换成手机版的
      // **底部抽屉**，与手机版逐字一致（见 `apps/mobile/vite.config.ts` 里那段长注释）
      ...withMobileModals(moduleAliases('../../packages/ui/src', '@fizz/ui')),
      '@fizz/ui': resolve(REPO_ROOT, 'packages/ui/src/index.ts'),

      // 客户端能力层（API + 宿主契约 + 浏览器兜底）
      ...moduleAliases('../../packages/agent-client/src', '@fizz/agent-client'),
      '@fizz/agent-client': resolve(REPO_ROOT, 'packages/agent-client/src/index.ts'),

      '@fizz/i18n': resolve(REPO_ROOT, 'packages/i18n/src/index.ts'),
      '@fizz/contracts/types': resolve(REPO_ROOT, 'packages/contracts/src/types.ts'),
      '@fizz/contracts/workspace-config': resolve(REPO_ROOT, 'packages/contracts/src/workspace-config.ts'),
      '@fizz/contracts/agent-api': resolve(REPO_ROOT, 'packages/contracts/src/agent-api.ts'),
      '@fizz/contracts': resolve(REPO_ROOT, 'packages/contracts/src/index.ts')
    }
  },
  server: {
    port: 5190,
    // 允许读仓库里其它目录（外壳在 ../mobile、包在 ../../packages）
    fs: { allow: [REPO_ROOT] }
  },
  build: {
    outDir: resolve(APP_ROOT, 'dist'),
    emptyOutDir: true,
    // 不开 sourcemap：产物就是「装进浏览器的那份」，多一个 .map 只是多一层暴露面
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@xterm')) return 'xterm'
          if (id.includes('monaco-editor')) return 'monaco'
          if (id.includes('react') || id.includes('scheduler')) return 'react-vendor'
          // shiki 走默认拆分：语言 / 主题本就按需动态 import，合起来会成 10MB 巨块
          if (id.includes('/shiki') || id.includes('@shikijs')) return undefined
          return 'vendor'
        }
      }
    }
  }
})

/**
 * 把 `@fizz/ui/dialog` / `@fizz/ui/alert-dialog` 换成手机版的抽屉实现。
 *
 * 两个入口都要换：只换 Dialog 时确认框（`useConfirm` 的「重试这条消息」这类）还是居中卡片，
 * 与其它弹窗形态对不上（见 `apps/mobile/vite.config.ts` 里那段长注释）。
 *
 * ⚠️ 必须 `delete` 之后再赋值：对象给**已有键**重新赋值不会改变它的位置，而 alias 按表
 * 顺序命中 —— 旧键留在前面的话新路径永远不生效（构建不报错，只是抽屉没出现）。
 */
function withMobileModals(aliases: Record<string, string>): Record<string, string> {
  delete aliases['@fizz/ui/dialog']
  aliases['@fizz/ui/dialog'] = resolve(MOBILE_ROOT, 'src/app/mobile-dialog.tsx')
  delete aliases['@fizz/ui/alert-dialog']
  aliases['@fizz/ui/alert-dialog'] = resolve(MOBILE_ROOT, 'src/app/mobile-alert-dialog.tsx')
  return aliases
}
