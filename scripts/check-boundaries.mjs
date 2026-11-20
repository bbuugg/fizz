/**
 * 包边界检查：把 AGENTS.md「架构对号入座」那张表的硬约束变成可执行的东西。
 *
 * ## 为什么需要它
 * 那张表的每一条（contracts 零 Electron / agent-client 零 React / packages 不反向依赖 apps…）
 * 都只能靠人记。写错不会报错、不会红，只会**把整条运行时拖进一个不该有它的产物**：
 * `contracts` 里 value-import 一次 `@fizz/agent`，浏览器侧产物就会多出 `node:fs` 之类
 * 一堆东西（甚至构建直接失败，报错还指向别处）。所以要在提交前拦下来。
 *
 * ## 判定口径（关键）
 * **`import type` 与纯类型的具名导入不算依赖** —— 编译期擦除，不进产物。这正是
 * `contracts` 能 `import type { AcpAgentConfig } from '@fizz/acp'` 的原因
 * （见 `packages/contracts/src/agent-api.ts` 的注释）。所以每条规则要说清是
 * 「连类型都禁」还是「只禁值导入」（`allowTypeOnly`）。
 *
 * 算纯类型的三条：`import type {X} from 'm'`、`import {type A, type B} from 'm'`（具名项
 * **全部**带 type）、`export type {X} from 'm'`。其余（默认 / 命名空间 / 混着值项 /
 * `export *` / `require` / `import()`）一律算值依赖 —— 宁可判严，这类误报一眼就能改。
 *
 * ## 为什么不用 TypeScript 的 parser，也不扫原文
 * 本仓库注释里**大量**出现 `@fizz/agent-kit/...` 这类路径文字，朴素正则会满屏假违规。
 * 想靠 `ts.createSourceFile` 精确解析也不行：仓库装的是 TypeScript 7（原生版），
 * 经典 compiler API 已经不在 `typescript` 主入口里了（入口只剩 `version.cjs`）。
 *
 * 所以这里按**语句**扫，不按字符扫：
 * - 只有「行首且缩进 ≤ 2」的 `import` / `export` 才算模块语句（真 import 一律在模块顶层，
 *   深度缩进只可能是模板字面量里的代码示例或 JSX 文本）；
 * - 多行具名导入按行拼接，直到拼出一条完整语句；
 * - `import()` / `require()` 这种行内动态依赖单独扫，带块注释状态跟踪。
 *
 * 这样既不会被 JSX 文本里的撇号（`Don't`）带偏，也不需要完整词法分析。
 *
 * ## 用法
 *   node scripts/check-boundaries.mjs           # 检查，有违规退出码 1
 *   node scripts/check-boundaries.mjs --dump    # 打印当前所有跨单元依赖边（调规则用）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（scripts/ 的上一级）；npm 脚本的 cwd 就是它 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 被扫描的顶层目录 → 里面的每个子目录都是一个「单元」（包 / 应用） */
const UNITS = ['packages', 'apps']

/** 只扫源码，构建产物 / 依赖目录不碰 */
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'release', '.vite'])

/**
 * 规则表。
 *
 * - `from`：单元名（`packages/<name>` 或 `apps/<name>` 的 `<name>`）
 * - `ban`：正则，匹配**模块说明符**（`@fizz/x/types` 这种子路径也算，用 `(\/|$)` 收尾）
 * - `allowTypeOnly`：`true` = 只禁值导入（`import type` 放行）
 * - `why`：违规时打出来的话，要写「不这样会怎样」
 *
 * 每条都按**当前真实依赖图**校准过（跑 `--dump` 可复核），所以基线是 0 违规。
 * 收紧规则前先看基线：一上线就红的检查会被习惯性忽略。
 */
const RULES = [
  {
    from: 'contracts',
    why: '契约层是浏览器 / 移动端 / 服务端共用的类型真源，一旦值依赖运行时包，前端产物会被整条拖进来',
    allowTypeOnly: true,
    ban: /^(electron|react|react-dom|@fizz\/(agent|tools|skills|plugin|mcp|git|shells|workspace|agent-kit|agent-client|agent-host|ui|i18n)(\/|$))/
  },
  {
    from: 'workspace',
    why: '存储层要能被任意宿主复用，值依赖 agent 运行时会把 Node 侧整包拖进渲染进程',
    allowTypeOnly: true,
    ban: /^(electron|react|react-dom|@fizz\/(agent|tools|agent-kit|agent-client|agent-host|ui)(\/|$))/
  },
  {
    from: 'agent',
    why: 'agent 运行时零 Electron：它要能跑在纯 Node（容器 / 服务端）里',
    allowTypeOnly: false,
    ban: /^(electron|@fizz\/(agent-host|agent-kit|ui)(\/|$))/
  },
  {
    from: 'agent-client',
    why: '能力层是 web / desktop / mobile 三端共用的**纯逻辑**，混进 React 或 UI 包就再也分不开',
    allowTypeOnly: false,
    ban: /^(react|react-dom|@fizz\/(agent-kit|ui|ui-tokens|agent-host)(\/|$))/
  },
  {
    from: 'agent-kit',
    why: '外壳层不得依赖 agent-host 与 apps：那两层依赖它，反向依赖会成环（打包直接炸）；包内也没有 `@/*` 别名',
    allowTypeOnly: false,
    ban: /^(@fizz\/agent-host(\/|$)|@\/(?!.*\.css$))/
  },
  {
    from: 'ui',
    why: 'ui 是无业务原语包：只吃 props 与设计令牌，不发请求、不读领域状态',
    allowTypeOnly: true,
    ban: /^(electron|@fizz\/(agent-client|agent-kit|agent-host|workspace|agent|tools)(\/|$))/
  },
  {
    from: 'ui-tokens',
    why: '设计令牌是零依赖的常量层，被所有端（含构建脚本）直接读',
    allowTypeOnly: true,
    ban: /^(electron|react|react-dom|@fizz\/)/
  },
  {
    from: 'i18n',
    why: '文案包要能被任何层引用（含浏览器与服务端工具描述），只能压在 contracts 之上，不能反过来依赖业务包',
    allowTypeOnly: true,
    ban: /^(electron|react|react-dom|@fizz\/(?!contracts(\/|$)))/
  },
  {
    from: 'plugin',
    why: '插件宿主是能力底座（被 agent / workspace 反过来依赖），不能反向引用上层',
    allowTypeOnly: true,
    ban: /^(electron|react|@fizz\/(agent|agent-kit|agent-client|agent-host|ui|workspace)(\/|$))/
  },
  {
    from: 'mcp',
    why: 'MCP 客户端只依赖协议与 AI SDK（被 agent / workspace 使用），不能反向依赖它们',
    allowTypeOnly: true,
    ban: /^(electron|react|@fizz\/(agent|agent-kit|agent-client|agent-host|ui|workspace)(\/|$))/
  },
  {
    from: 'skills',
    why: '技能加载是零 Electron 的纯 Node 能力，被 agent / tools 使用',
    allowTypeOnly: true,
    ban: /^(electron|react|@fizz\/(agent|agent-kit|agent-client|agent-host|ui|workspace)(\/|$))/
  },
  {
    from: 'tools',
    why: '工具集被 agent 挂载；它可以读存储（workspace）与 git / shells / skills，但不能反过来依赖 agent',
    allowTypeOnly: true,
    ban: /^(electron|react|@fizz\/(agent|agent-kit|agent-client|agent-host|ui)(\/|$))/
  },
  {
    from: 'git',
    why: 'git 能力是零 Electron 的纯 Node 封装，被 tools / agent 使用',
    allowTypeOnly: true,
    ban: /^(electron|react|@fizz\/(agent|agent-kit|agent-client|agent-host|ui|workspace)(\/|$))/
  },
  {
    from: 'shells',
    why: 'shell 探测是零 Electron 的纯 Node 能力，被 tools / agent 使用',
    allowTypeOnly: true,
    ban: /^(electron|react|@fizz\/(agent|agent-kit|agent-client|agent-host|ui|workspace)(\/|$))/
  },
  {
    from: 'acp',
    why: 'ACP 是外部 agent 协议层（被 contracts / agent 引用），不能反向依赖它们',
    allowTypeOnly: true,
    ban: /^(electron|react|@fizz\/(agent|agent-kit|agent-client|agent-host|ui|workspace|contracts)(\/|$))/
  }
]

/**
 * 已知的、**写在文档 / 注释里的**例外。
 *
 * 每条都要带出处，否则半年后没人敢删。加例外之前先确认「改依赖」真的比「记一笔」贵。
 */
const EXCEPTIONS = [
  {
    unit: 'packages/agent-host',
    spec: /^@fizz\/server(\/|$)/,
    why: 'desktop 经 agent-host **进程内直连同一个 server**（AGENTS.md：没有第二条对话链路），这是那条设计的落点'
  },
  {
    file: 'apps/mobile/src/app/mobile-dialog.tsx',
    spec: /^\.\.\/.*packages\/ui\/src\/dialog$/,
    why: '`@fizz/ui/dialog` 的 vite 别名正指向本文件，从本文件 import 它就是自指（见该文件头注释）'
  },
  {
    file: 'apps/mobile/src/app/mobile-alert-dialog.tsx',
    spec: /^\.\.\/.*packages\/ui\/src\/alert-dialog$/,
    why: '与 mobile-dialog 相同：`@fizz/ui/alert-dialog` 的 vite 别名正指向本文件，宽屏须直接复用桌面实现（见该文件头注释）'
  }
]

/** 相对导入解析后必须还在本单元目录里（跨单元一律走 `@fizz/*` 包名） */
const RELATIVE_ESCAPE_WHY = '相对导入跑出了本单元的目录（跨单元一律走 @fizz/* 包名）'
/** `packages/*` 不得反向依赖 `apps/*`：apps 依赖 packages，反过来会成环 */
const REVERSE_APP_WHY = 'packages 不得反向依赖 apps（apps 依赖 packages，反过来会成环）'

// ---------- 抽模块说明符（按语句扫，见文件头） ----------

/** 一行最多拼多少行还算同一条 import（防病态输入） */
const MAX_STATEMENT_LINES = 40

/** 语句起始关键字（必须出现在行首、缩进 ≤ 2） */
const STATEMENT_START = /^(import|export)\b/

/** 具名项是不是**全部**带 `type`（`import { type A, type B }` 整条被擦除） */
function clauseIsTypeOnly(clause) {
  const trimmed = clause.trim()
  if (!trimmed) return false
  if (/^type\b/.test(trimmed)) return true
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  const items = trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 0 && items.every((item) => /^type\s+\S/.test(item))
}

/** 模块说明符的基本形态：无空白、不像 HTML / 代码片段 */
function looksLikeSpecifier(spec) {
  return Boolean(spec) && spec.length <= 200 && !/\s/.test(spec) && !spec.includes('<')
}

/**
 * 尝试把一段（可能跨行的）语句解析成模块说明符；拼不完整就返回 `null`，
 * 由调用方继续往下拼。
 */
function parseStatement(text) {
  const plain = text.replace(/\s+/g, ' ')

  // import 'x'（副作用导入）
  let matched = /^import\s+['"]([^'"]+)['"]/.exec(plain)
  if (matched) return { spec: matched[1], typeOnly: false }

  // import x = require('y')
  matched = /^import\s+[\w$]+\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(plain)
  if (matched) return { spec: matched[1], typeOnly: false }

  // import <clause> from 'x' / export <clause> from 'x'
  matched = /^(import|export)\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/.exec(plain)
  if (matched) {
    // `import type {…}` / `import {type A}` / `export type {…}` 都是编译期擦除的
    return { spec: matched[3], typeOnly: clauseIsTypeOnly(matched[2]) }
  }
  return null
}

/**
 * 这条语句还明显没写完吗（要不要接着往下拼）。
 *
 * 关键在 `export`：`export function foo() {` / `export const x = 1` **不是**模块语句，
 * 绝不能往下吞行 —— 否则下一行的 `import('x')` 会被当成它的一部分吞掉，动态依赖直接漏报。
 */
function shouldAccumulate(text) {
  const plain = text.replace(/\s+/g, ' ')
  // 已经出现引号 = 说明符读到了
  if (/['"]/.test(plain)) return false
  if (/^import\b/.test(plain)) return true
  if (/^export\s+(type\s+)?\*/.test(plain)) return true
  // `export {…} from 'x'` 可能跨行；大括号闭合了就说明只剩 from 没写（那是语法错，不追）
  if (/^export\s+(type\s+)?\{/.test(plain)) return !/\}/.test(plain)
  return false
}

/** 行内动态依赖：`import('x')` / `require('x')` */
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * 抽出文件里的所有模块说明符。
 *
 * 返回 `{ spec, line, typeOnly }`，`line` 是 1 起的行号（与编辑器一致）。
 */
function importsOf(src) {
  const lines = src.split('\n')
  const out = []
  /** 是否处在多行块注释里 */
  let inBlockComment = false

  const scanDynamic = (text, lineNo) => {
    DYNAMIC_RE.lastIndex = 0
    let matched
    while ((matched = DYNAMIC_RE.exec(text))) {
      if (!looksLikeSpecifier(matched[1])) continue
      out.push({ spec: matched[1], line: lineNo, typeOnly: false })
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNo = i + 1
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length

    // ---- 注释（块注释状态要跨行维护，否则注释里举的例子会被当成真依赖） ----
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('//')) continue
    if (trimmed.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true
      continue
    }
    if (trimmed.startsWith('*')) continue

    // ---- 语句级：import / export（只在顶层、缩进 ≤ 2 的行首） ----
    if (indent <= 2 && STATEMENT_START.test(trimmed)) {
      let text = trimmed
      const consumed = []
      for (;;) {
        const parsed = parseStatement(text)
        if (parsed && looksLikeSpecifier(parsed.spec)) {
          out.push({ spec: parsed.spec, line: lineNo, typeOnly: parsed.typeOnly })
          break
        }
        if (!shouldAccumulate(text) || consumed.length >= MAX_STATEMENT_LINES) break
        const next = lines[i + consumed.length + 1]
        if (next === undefined) break
        consumed.push({ text: next, lineNo: lineNo + consumed.length + 1 })
        text += ' ' + next.trim()
      }
      // 被这条语句吃掉的行里也可能藏着 `import('x')`，不能跳过去
      for (const entry of consumed) scanDynamic(entry.text, entry.lineNo)
      i += consumed.length
    }

    // ---- 行内动态依赖（含上面那条语句自己那一行） ----
    scanDynamic(line, lineNo)
  }
  return out
}

// ---------- 遍历文件 ----------

function walk(dir, sink) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(resolve(dir, entry.name), sink)
    } else if (SOURCE_EXT.test(entry.name)) {
      sink.push(resolve(dir, entry.name))
    }
  }
}

/**
 * 收集所有单元：`[{ kind, name, unitLabel, packageName, root, files }]`。
 *
 * `packageName` 来自各自的 `package.json`（`@fizz/server` 这种），用来识别
 * 「`packages/*` 通过包名依赖 `apps/*`」——只匹配路径是看不出来的。
 */
function collectUnits() {
  const units = []
  for (const kind of UNITS) {
    const base = resolve(REPO_ROOT, kind)
    let names
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const name of names) {
      const root = resolve(base, name)
      const files = []
      walk(resolve(root, 'src'), files)
      // 没有 src 的（纯配置包）没有边界问题
      if (!files.length) continue
      let packageName = ''
      try {
        packageName = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name ?? ''
      } catch {
        /* 没有 package.json 就只按路径判 */
      }
      units.push({ kind, name, unitLabel: `${kind}/${name}`, packageName, root, files })
    }
  }
  return units
}

// ---------- 主流程 ----------

const args = new Set(process.argv.slice(2))
const dump = args.has('--dump')

const units = collectUnits()
const byPackageName = new Map(units.filter((unit) => unit.packageName).map((unit) => [unit.packageName, unit]))
const rulesByUnit = new Map()
for (const rule of RULES) {
  const list = rulesByUnit.get(rule.from) ?? []
  list.push(rule)
  rulesByUnit.set(rule.from, list)
}

const isExcepted = (unitLabel, fileRel, spec) =>
  EXCEPTIONS.some(
    (exception) =>
      (!exception.unit || exception.unit === unitLabel) &&
      (!exception.file || exception.file === fileRel) &&
      exception.spec.test(spec)
  )

const violations = []
const edges = []

for (const unit of units) {
  const rules = rulesByUnit.get(unit.name) ?? []
  for (const file of unit.files) {
    const fileRel = relative(REPO_ROOT, file).split(sep).join('/')
    const src = readFileSync(file, 'utf8')

    for (const { spec, line, typeOnly } of importsOf(src)) {
      const where = `${fileRel}:${line}`
      const isBare = !spec.startsWith('.') && !spec.startsWith('/')

      if (dump && isBare) edges.push(`${unit.unitLabel} → ${spec}${typeOnly ? ' (type)' : ''}`)
      if (isExcepted(unit.unitLabel, fileRel, spec)) continue

      // ---- 相对导入：解析后必须还在本单元目录里 ----
      if (!isBare) {
        const target = resolve(dirname(file), spec)
        if (target !== unit.root && !target.startsWith(unit.root + sep)) {
          violations.push({ where, spec, why: RELATIVE_ESCAPE_WHY })
        }
        continue
      }

      // ---- packages 不得反向依赖 apps（按包名判，`@fizz/server` 也是 apps） ----
      if (unit.kind === 'packages') {
        const scopeName = spec.startsWith('@fizz/') ? `@fizz/${spec.split('/')[1]}` : ''
        const target = scopeName ? byPackageName.get(scopeName) : undefined
        if (target?.kind === 'apps') {
          violations.push({ where, spec, why: REVERSE_APP_WHY })
          continue
        }
      }

      // ---- 各包自己的禁令 ----
      for (const rule of rules) {
        if (!rule.ban.test(spec)) continue
        if (typeOnly && rule.allowTypeOnly !== false) continue
        violations.push({ where, spec, why: `${unit.unitLabel}：${rule.why}` })
        break
      }
    }
  }
}

if (dump) {
  const unique = [...new Set(edges)].sort()
  console.log(`跨单元依赖边（${unique.length} 条）：`)
  for (const edge of unique) console.log('  ' + edge)
  console.log('')
}

if (violations.length) {
  console.error(`✗ 包边界违规 ${violations.length} 处：\n`)
  for (const violation of violations) {
    console.error(`  ${violation.where}`)
    console.error(`    导入：${violation.spec}`)
    console.error(`    原因：${violation.why}\n`)
  }
  console.error(
    '修法二选一：把依赖挪到该在的层，或在 scripts/check-boundaries.mjs 的 RULES / EXCEPTIONS 里' +
      '补一条（后者要带出处，并先想清楚为什么原来的约束不成立）。'
  )
  process.exit(1)
}

const fileCount = units.reduce((n, unit) => n + unit.files.length, 0)
console.log(`✓ 包边界 0 违规（扫了 ${units.length} 个单元 / ${fileCount} 个文件）`)
