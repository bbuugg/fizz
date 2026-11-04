/**
 * 把插件的 `client.jsx` 编译成宿主能直接跑的 `client.js`。
 *
 * 用法：`npm run build:plugins`（默认构建 `plugins/` 下**所有**带 `client.jsx` 的插件，
 * 也可以在后面直接给目录）。
 *
 * 为什么不引入 esbuild / tsup：这一份只需要「JSX → `React.createElement`」，仓库自带
 * `typescript` 就够了。**少一个构建依赖，插件作者抄起来也简单**；真要打包第三方库
 * 时他们自己上 esbuild（SKILL 3.7 里写了）。
 *
 * 关键约定（别改，改了产物就跑不起来）：
 * - `--jsx react`：经典转换，产物里是 `React.createElement(...)`，而 `React` 由插件工厂
 *   参数注入（`window.__FIZZ_PLUGIN__('x', (host) => { const { React } = host; ... })`）；
 * - **不允许有 import / export**：产物要能塞进 `new Function(code)`。真用了 import，
 *   打出来的 ESM 在浏览器里会直接语法报错 —— 构建脚本这里提前拦一道。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 没给目录 = 扫描 `plugins/` 下所有带 `client.jsx` 的插件（新插件不必改这里） */
function defaultTargets() {
  const root = resolve('plugins')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(join(root, item.name, 'client.jsx')))
    .map((item) => join('plugins', item.name))
}

const dirs = process.argv.slice(2)
const targets = dirs.length ? dirs : defaultTargets()
const tsc = resolve('node_modules/typescript/bin/tsc')

for (const dir of targets) {
  const src = join(dir, 'client.jsx')
  if (!existsSync(src)) {
    console.log(`skip ${dir}（没有 client.jsx）`)
    continue
  }
  const out = join(dir, '.build')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  execFileSync(
    process.execPath,
    [
      tsc,
      '--ignoreConfig',
      '--jsx',
      'react',
      '--allowJs',
      '--target',
      'es2020',
      '--module',
      'es2020',
      '--outDir',
      out,
      src
    ],
    { stdio: 'inherit' }
  )
  const built = readFileSync(join(out, 'client.js'), 'utf8')
  const leaked = built.match(/^\s*(import|export)\s/m)
  if (leaked) {
    console.error(`${dir}/client.jsx 里有 import/export：产物进不了 new Function`)
    process.exitCode = 1
    continue
  }
  writeFileSync(
    join(dir, 'client.js'),
    `/* 由 scripts/build-plugin-client.mjs 生成，别手改 —— 改 client.jsx */\n${built}`
  )
  rmSync(out, { recursive: true, force: true })
  console.log(`built ${join(dir, 'client.js')} (${(built.length / 1024).toFixed(1)} KB)`)
}
