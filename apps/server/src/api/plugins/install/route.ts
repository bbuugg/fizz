/**
 * 安装插件：把用户选中的一个**插件目录**写进对应作用域的插件目录。
 *
 * ## 一个插件 = 一个目录
 *
 * 目录里必须有 `plugin.json`（接口见 `@fizz/plugin` 的 `PluginManifest`），入口由它指定。
 * 客户端传的是目录内的**文件清单**（相对路径 + base64），服务端不接受绝对路径，也不
 * 接受路径里带 `..` —— 安装目录由 manifest 的 `id` 决定。
 *
 * ## 协议只能是 JSON + base64
 *
 * desktop 的 IPC 桥 body 只支持字符串（`packages/agent-host/src/channels.ts`），
 * multipart 过不去 —— 与 `api/uploads` 同一个约束（那份文件头有说明）。
 *
 * ## 三条决定了这里怎么写
 *
 * 1. **目录由服务端推导**（`writableRoot`），客户端只给相对路径；
 * 2. **内置根不可写**：它随产品分发（进 git、打包后进 resourcesPath 还可能只读）；
 *    也不允许用同一个 id 顶掉内置 / 已有的插件；
 * 3. **装完立刻体检**：`readPluginManifest` 校验接口，`inspectPluginUi` 把插件 apply 一遍，
 *    失败就把刚写进去的目录删掉并报错 —— 不留一个每次扫盘都报错的坏目录。
 *
 * 写入先落在插件根下的临时目录（隐藏名，扫描跳过），校验通过后再 `rename` 成
 * `<manifest.id>`，避免「写了一半」被下一轮扫到。
 *
 * ## 热重载
 *
 * 装完清模块缓存（目录里任何文件变化都靠源码指纹失效，这里只是立刻生效）、作废上传源
 * 长驻 context、作废插件模型缓存；响应直接是重扫后的完整列表。
 */
import { join, resolve, sep } from 'node:path'
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import {
  inspectPluginUi,
  invalidatePluginModule,
  PLUGIN_MANIFEST_FILE,
  readPluginManifest
} from '@fizz/plugin/loader'
import type { PluginDescriptor } from '@fizz/plugin'
import { discoverServerPlugins, withRuntimeConfig } from '@/lib/server/plugin-roots'
import { syncPluginRootDeps } from '@/lib/server/plugin-deps'
import { invalidatePluginModels, refreshPluginModels } from '@/lib/server/plugin-models'
import { invalidateUploadProviders } from '@/lib/server/upload/registry'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import {
  listGlobal,
  listWorkspace,
  resolveWorkspace,
  writableRoot,
  type PluginScope
} from '../_lib/list'

/** 整包上限（base64 会胀 1/3）：插件是几百行源码 + 少量资源，5MB 足够 */
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024
/** 文件数上限：防止一次请求写几万个空文件 */
const MAX_FILES = 200
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * 归一化目录内相对路径：只认 POSIX 风格、不许绝对路径 / `..` / 空段 / 点号段。
 * 反斜杠统一成 `/`（Windows 上选目录时 `webkitRelativePath` 也是 `/`，这里只兜底）。
 */
function normalizeRelPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().replace(/\\/g, '/')
  if (!value || value.startsWith('/') || value.includes('\0')) return null
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{
    scope?: PluginScope
    workspaceId?: string
    /** 目录内文件清单（path 是相对路径，content 是 base64） */
    files?: Array<{ path?: string; content?: string }>
  }>(request)

  if (!Array.isArray(body?.files) || body.files.length === 0) {
    return jsonError(400, '缺少 files（插件目录内的文件清单）')
  }
  if (body.files.length > MAX_FILES) {
    return jsonError(400, `文件太多：${body.files.length} 个，上限 ${MAX_FILES} 个`)
  }

  const decoded: Array<{ path: string; bytes: Buffer }> = []
  let total = 0
  for (const item of body.files) {
    const rel = normalizeRelPath(item?.path)
    if (!rel) return jsonError(400, `文件路径不合法：${String(item?.path ?? '')}`)
    if (typeof item?.content !== 'string' || !BASE64_RE.test(item.content)) {
      return jsonError(400, `文件内容不是 base64：${rel}`)
    }
    const bytes = Buffer.from(item.content, 'base64')
    total += bytes.length
    if (total > MAX_PACKAGE_BYTES) {
      return jsonError(
        400,
        `插件包太大：超过 ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)}MB 上限`
      )
    }
    decoded.push({ path: rel, bytes })
  }
  if (!decoded.some((item) => item.path === PLUGIN_MANIFEST_FILE)) {
    return jsonError(400, `插件目录根下缺少 ${PLUGIN_MANIFEST_FILE}`)
  }

  const scope: PluginScope = body?.scope === 'global' ? 'global' : 'workspace'
  const root = writableRoot(scope, body?.workspaceId)
  if (!root) {
    return jsonError(400, scope === 'global' ? '用户级插件目录不可用' : '没有可安装的项目')
  }
  const workspace = scope === 'workspace' ? resolveWorkspace(body?.workspaceId) : undefined

  await mkdir(root.dir, { recursive: true })
  const rootDir = resolve(root.dir)
  const tempDir = await mkdtemp(join(rootDir, '.install-'))

  const rollback = async (): Promise<void> => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    invalidatePluginModule()
    await invalidateUploadProviders(workspace?.id)
    invalidatePluginModels()
  }

  try {
    for (const file of decoded) {
      const target = resolve(tempDir, file.path)
      // 第二道越界检查：normalize 已挡 `..`，这里再确认拼接后没跳出去
      if (target !== tempDir && !target.startsWith(tempDir + sep)) {
        await rollback()
        return jsonError(400, `文件路径跳出了插件目录：${file.path}`)
      }
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, file.bytes)
    }

    const { manifest } = await readPluginManifest(tempDir)
    const finalDir = resolve(rootDir, manifest.id)
    if (finalDir !== rootDir && !finalDir.startsWith(rootDir + sep)) {
      await rollback()
      return jsonError(400, '插件 id 不能用作目录名')
    }
    const descriptors = await discoverServerPlugins({
      workspaceId: workspace?.id,
      workspacePath: workspace?.path
    })
    if (descriptors.some((item) => item.id === manifest.id)) {
      await rollback()
      return jsonError(409, `插件 id「${manifest.id}」已经存在 —— 先卸载它，或者改 id 后再装`)
    }
    const existed = await stat(finalDir).then(
      () => true,
      () => false
    )
    if (existed) {
      // 理论上到不了：目录存在但没被扫到（多半 manifest 坏了）。不覆盖，交给用户处理。
      await rollback()
      return jsonError(409, `目标目录已存在：${manifest.id} —— 先删掉它再装`)
    }

    await rename(tempDir, finalDir)

    /*
     * 依赖必须**在体检之前**装好：插件顶层 `import` 了某个包而它没装时，`apply` 直接失败，
     * 用户看到的是「这个插件加载不起来」—— 真实原因（依赖没装）被埋在最后一行。
     * 装失败就把目录删掉：留一个缺依赖的插件，每轮扫盘都会报同一个错。
     */
    const depSync = await syncPluginRootDeps({
      rootDir,
      ...(workspace?.id ? { workspaceId: workspace.id } : {}),
      ...(workspace?.path ? { workspacePath: workspace.path } : {})
    })
    if (!depSync.ok) {
      await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
      await rollback()
      return jsonError(400, `插件依赖安装失败，已撤回：\n${depSync.output}`)
    }
    if (depSync.changed) invalidatePluginModule()

    const descriptor: PluginDescriptor | undefined = (
      await discoverServerPlugins({
        workspaceId: workspace?.id,
        workspacePath: workspace?.path
      })
    ).find((item) => item.id === manifest.id)
    const installed = descriptor ? { ...descriptor, enabled: true } : undefined
    if (!installed) {
      await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
      await rollback()
      return jsonError(400, `装上去了但扫不到它（id ${manifest.id}），已撤回`)
    }
    const { errors } = await inspectPluginUi(withRuntimeConfig([installed]))
    if (errors.length) {
      await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
      await rollback()
      return jsonError(400, `这个插件加载不起来，已撤回：\n${errors.join('\n')}`)
    }

    // 目录内文件都是新写的：整份缓存清掉最稳（安装是低频操作）
    invalidatePluginModule()
    await invalidateUploadProviders(workspace?.id)
    invalidatePluginModels()
    if (scope === 'global') await refreshPluginModels()

    return scope === 'global' ? listGlobal() : listWorkspace(workspace?.id)
  } catch (err) {
    await rollback()
    return jsonError(400, err instanceof Error ? err.message : String(err))
  }
}
