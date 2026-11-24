#!/usr/bin/env node
/**
 * 把 Windows 沙箱 runner 打成**单文件 ESM**，放到宿主（server / desktop）能定位的位置。
 *
 *   node packages/win-sandbox/build.mjs --out apps/server/dist/win-sandbox
 *
 * 为什么必须独立产物：
 * - 它要在独立进程里跑（koffi 崩了不能拖着主进程一起死）；
 * - Electron 打包态的子进程读不到 asar，只能用 `app.asar.unpacked` 里的真实文件；
 * - 所以它是「随包分发的静态文件」，不是被主 bundle 内联的模块。
 *
 * `koffi` 保持 external：它要 dlopen 同目录的原生 `.node`，内联会破坏它的路径探测。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

const outFlag = process.argv.indexOf('--out')
const outDir =
  outFlag === -1
    ? resolve(repoRoot, 'packages/win-sandbox/dist')
    : resolve(repoRoot, process.argv[outFlag + 1] ?? '')

await build({
  configFile: false,
  root: repoRoot,
  publicDir: false,
  logLevel: 'warn',
  build: {
    lib: {
      entry: resolve(here, 'src/acl/runner.ts'),
      formats: ['es'],
      fileName: () => 'runner.mjs'
    },
    outDir,
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rollupOptions: {
      external: (id) => id === 'koffi' || id.startsWith('node:')
    }
  }
})

console.log(`win-sandbox runner → ${outDir}/runner.mjs`)
