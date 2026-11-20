import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { SPLASH_LOGO_DP } from './scripts/splash-brand.mjs'

/**
 * 构建开始时清掉 `assets/`（里面全部是带哈希的产物，旧哈希零引用）。
 *
 * ⚠️ `emptyOutDir` 必须保持 false：整目录清会把 public 拷来的 monaco-editor 一起删，
 * 撞上 IDE 的批量删除保护；但过期哈希产物也不能留（每次构建一套新哈希）。
 * 与 `apps/web` / `apps/desktop` 的同名插件逐字同源。
 */
function cleanStaleAssets(assetsDir: string): Plugin {
  return {
    name: 'clean-stale-assets',
    buildStart() {
      rmSync(assetsDir, { recursive: true, force: true })
    }
  }
}

/**
 * hosted 版（挂在 server 的 `/m/`）才注入 PWA 的 manifest / 图标 / 主题色 —— 让手机浏览器
 * 能把「手机版」安装成一个独立应用。没有这几项时 Chrome 直接报「无法安装此应用」。
 *
 * - **只在 hosted 注入**：APK 版是 Capacitor 壳，外壳在本地 `www`、没有可安装的地址，
 *   manifest 对它没意义（甚至会引一个多余的 `https://localhost/manifest.webmanifest` 请求）；
 * - 引用一律写**相对路径**：hosted 下文档在 `/m/`，`manifest.webmanifest` 自然解析到
 *   `/m/manifest.webmanifest`（manifest 里的 `start_url` / 图标也相对它所在目录解析，
 *   得到 `/m/`）；换成 `/m/...` 写死则换挂载点时要点改多处。
 */
function hostedPwaHead(): Plugin {
  return {
    name: 'hosted-pwa-head',
    transformIndexHtml(html: string): string {
      const tags = [
        '<link rel="manifest" href="manifest.webmanifest" />',
        '<link rel="apple-touch-icon" href="icon-192.png" />',
        '<meta name="theme-color" content="#0a0a0a" />',
        '<meta name="apple-mobile-web-app-capable" content="yes" />'
      ].join('\n    ')
      return html.replace('</head>', `    ${tags}\n  </head>`)
    }
  }
}

/**
 * 首屏启动屏的 logo（`index.html` 的 `#boot-splash`）。
 *
 * 必须**在 HTML 里就带 src**、并且内联成 data URI：
 * - 交给 `main.tsx` 设 src 的话，logo 要等整包 JS 执行完才出现，而此时首屏已经
 *   在 React 第一帧后淡出了 —— 用户基本看不见那个 logo；
 * - 放 `public/` 则是同一张图存两份（换 logo 时必漏一处）。
 *
 * 所以构建 / dev 起 HTML 时从共享包里读**同一份** logo 塞进去。
 *
 * 尺寸同理：直接填 `SPLASH_LOGO_DP`（原生那个 dp 值）。**不要**在 CSS 里改回 `vmin`
 * 之类的相对值 —— 原生侧是固定 dp，两边一旦不一致，原生 → 页面交接时 logo 会跳一下
 * （用户报过）。CSS px 与安卓 dp 是 1:1，所以同一个数字就是同一块像素。
 *
 * ⚠️ 占位符写成 `<img src="__FIZZ_BOOT_LOGO__">`、插件用 `order: 'pre'`：必须在
 * Vite 的 HTML 资源解析之前换掉，否则那条 src 会被当成相对路径去解析、直接构建失败
 * （换成 data URI 之后 Vite 会原样放过，`data:` 在它的排除名单里）。
 */
function bootSplashLogo(): Plugin {
  const logo = resolve(
    import.meta.dirname,
    '../../packages/agent-kit/src/shared/assets/logo.png'
  )
  return {
    name: 'boot-splash-logo',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string): string {
        const data = `data:image/png;base64,${readFileSync(logo).toString('base64')}`
        return html
          .replaceAll('__FIZZ_BOOT_LOGO_SIZE__', `${SPLASH_LOGO_DP}px`)
          .replaceAll('__FIZZ_BOOT_LOGO__', data)
      }
    }
  }
}

/**
 * 把目录下的模块逐条映射成 alias。
 *
 * ⚠️ 不能写带斜杠的通配（`@rollup/plugin-alias` 的 `matches` 只认 `===` 与
 * `startsWith(find + '/')`，带斜杠的 find 永不命中）；也不能只写包名本体（会被拼成
 * `…/index.ts/button`）。所以逐条展开，新增子路径不用改配置。
 */
function moduleAliases(dir: string, prefix: string): Record<string, string> {
  const base = resolve(import.meta.dirname, dir)
  return Object.fromEntries(
    readdirSync(base)
      .filter((file) => /\.tsx?$/.test(file) && !/^index\.tsx?$/.test(file))
      .map((file) => [`${prefix}/${file.replace(/\.tsx?$/, '')}`, resolve(base, file)])
  )
}

/**
 * 安卓壳（Capacitor）的构建配置。
 *
 * 与 `apps/web` 的三处**故意不同**：
 *
 * 1. **服务端地址不在构建期配置**：壳里页面的 origin 是 `https://localhost`，相对路径的
 *    `/api`、SSE、WS 一条都到不了 server，所以地址必须是绝对地址 —— 但改由登录页填写并
 *    存在本机（`fizz.mobile.serverUrl`，见 `src/server-url.ts`），同一个 APK 可以连不同服务器。
 *    `src/main.tsx` 启动时读出来交给 `@fizz/agent-client` 的 `setServerBase()`。
 * 2. `webDir` 由 Capacitor 指向本工程的 `dist`（不再是 `apps/web/dist` 的副本），
 *    于是移动端可以单独演进（自己的外壳、自己的入口）。
 * 3. dev 端口用 5180，避开 web 5178 / desktop 5175 / web preview 5179。
 *
 * 其余（alias 表、`base: '/'`、chunk 拆分、cleanStaleAssets）与 web 逐字同源。
 *
 * 另有一档 **`--mode hosted`**：构建「server 托管」版本（挂到 server 的 `/m/`，手机浏览器
 * 直接访问，配合 server 的 UA 自动跳转）。与 APK 版的差异只有三处：`base=/m/`、
 * `outDir=dist-server`、登录页服务地址留空即按同源（页面由 server 托管，相对路径 `/api`
 * 本来就通）。`npm run build:mobile:hosted`，不跑 cap sync，APK 那套（`build:mobile`）
 * 完全不受影响。
 */
export default defineConfig(({ mode }) => {
  const hosted = mode === 'hosted'

  /*
   * 手机壳把 `@fizz/ui/dialog` 与 `@fizz/ui/alert-dialog` 两个入口换成**底部抽屉版**
   * （`src/app/mobile-dialog.tsx` / `src/app/mobile-alert-dialog.tsx`，抽屉布局共用
   * `src/app/mobile-sheet.tsx`）。
   *
   * 手机版能弹到的弹窗全在共享包里（新建会话 / 插件 / 工作区设置 / 导入导出 / 命令式确认 …），
   * 在那些组件里逐个加「手机走抽屉」的分支会同时改到 web / desktop。这里只在手机壳
   * 的构建期换掉入口：导出名与 Radix 版一一对应，共享组件一行不改。
   *
   * 两个入口都要换：只换 Dialog 时，`useConfirm()` 弹出的确认框（「重试这条消息」这类）
   * 仍是居中卡片，与其它弹窗形态对不上（用户报过）。
   *
   * ⚠️ 必须 `delete` 之后再赋值：对象给**已有键**重新赋值不会改变它的位置，而
   * `@rollup/plugin-alias` 按表顺序取第一个命中项 —— moduleAliases 生成的旧键留在
   * 前面的话，新路径永远不会生效（构建不报错，只是抽屉没出现）。
   * `@fizz/ui` 本体那条键排在 `...uiAliases` 之后，所以重新插入的
   * `@fizz/ui/dialog` 仍然先被匹配到。
   *
   * `packages/ui` 内部的 `CommandDialog` 走相对路径 `./dialog`，不经过别名，
   * 命令面板仍是居中弹窗。
   */
  const uiAliases = moduleAliases('../../packages/ui/src', '@fizz/ui')
  delete uiAliases['@fizz/ui/dialog']
  uiAliases['@fizz/ui/dialog'] = resolve(import.meta.dirname, 'src/app/mobile-dialog.tsx')
  delete uiAliases['@fizz/ui/alert-dialog']
  uiAliases['@fizz/ui/alert-dialog'] = resolve(
    import.meta.dirname,
    'src/app/mobile-alert-dialog.tsx'
  )

  return {
    // 固定 root：否则从仓库根执行构建时，vite 会把仓库根当成站点根、找不到这个 index.html
    root: import.meta.dirname,
    base: hosted ? '/m/' : '/',
    /*
     * 版本号注入：设置侧栏底部要显示它（见 `packages/agent-kit/src/shared/lib/app-version.ts`）。
     * 读本 app 的 package.json —— 与 APK / hosted 版一起发，三端不会各说一个版本。
     */
    define: {
      __APP_VERSION__: JSON.stringify(
        (JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string })
          .version
      )
    },
    plugins: [
      react(),
      tailwindcss(),
      // 首屏启动屏的 logo（见 bootSplashLogo）：构建 / dev 都要先换上
      bootSplashLogo(),
      cleanStaleAssets(resolve(import.meta.dirname, hosted ? 'dist-server/assets' : 'dist/assets')),
      // hosted 版挂上 PWA 头（manifest / 图标），APK 版不挂 —— 见 hostedPwaHead 的说明
      ...(hosted ? [hostedPwaHead()] : [])
    ],
    resolve: {
      alias: {
        // `@` 指本 app 的 src：外壳（`src/app/`）就在这里，与 tsconfig 的 paths 一致
        '@': resolve(import.meta.dirname, 'src'),
        // 领域组件包：`features/*` / `shared/*` 两个目录前缀必须排在包名本体之前
        // （alias 是前缀替换，`@fizz/agent-kit` 会吃掉所有 `@fizz/agent-kit/…`）
        '@fizz/agent-kit/features': resolve(
          import.meta.dirname,
          '../../packages/agent-kit/src/features'
        ),
        '@fizz/agent-kit/shared': resolve(import.meta.dirname, '../../packages/agent-kit/src/shared'),
        '@fizz/agent-kit': resolve(import.meta.dirname, '../../packages/agent-kit/src/index.ts'),
        // 无业务原语（逐条展开，见 moduleAliases 的注释：通配写法在这里不生效）；
        // `@fizz/ui/dialog` 已被上面的 uiAliases 换成手机抽屉版
        ...uiAliases,
        '@fizz/ui': resolve(import.meta.dirname, '../../packages/ui/src/index.ts'),
        // 客户端能力层（API + 宿主契约 + 浏览器兜底）
        ...moduleAliases('../../packages/agent-client/src', '@fizz/agent-client'),
        '@fizz/agent-client': resolve(import.meta.dirname, '../../packages/agent-client/src/index.ts'),
        '@fizz/i18n': resolve(import.meta.dirname, '../../packages/i18n/src/index.ts'),
      '@fizz/contracts/types': resolve(import.meta.dirname, '../../packages/contracts/src/types.ts'),
        '@fizz/contracts/workspace-config': resolve(
          import.meta.dirname,
          '../../packages/contracts/src/workspace-config.ts'
        ),
        '@fizz/contracts/agent-api': resolve(
          import.meta.dirname,
          '../../packages/contracts/src/agent-api.ts'
        ),
        '@fizz/contracts': resolve(import.meta.dirname, '../../packages/contracts/src/index.ts')
      }
    },
    server: {
      port: 5180,
      proxy: {
        '/api': {
          target: process.env.FIZZ_SERVER ?? 'http://127.0.0.1:7801',
          changeOrigin: true,
          /*
           * ⚠️ `ws: true` 必须显式写：Vite 对 http(s) 目标默认**不代理** WebSocket 升级。
           * 不写的话 `/api/*` 的 WS 全都不被代理（`/api/state`、`/api/terminal`、
           * 节点工作台、浏览器画面一条都连不上），表现为「HTTP 全 200、WS 恒 0」。
           */
          ws: true
        }
      }
    },
    build: {
      // hosted 版输出到 dist-server：与 APK 的 dist/ 彻底分家，cap sync 永远不会拿到 base=/m/ 的产物
      outDir: resolve(import.meta.dirname, hosted ? 'dist-server' : 'dist'),
      // 不清空（保住 public 拷来的 monaco-editor，见 cleanStaleAssets 的注释）
      emptyOutDir: false,
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
  }
})
