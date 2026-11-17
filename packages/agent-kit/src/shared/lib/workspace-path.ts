/**
 * 工具入参里的文件路径 → **工作区相对路径**。
 *
 * ## 为什么需要
 *
 * 右侧「文件」面板（`FilesPanel`）里的路径一律是**工作区相对**的（`/api/workspaces/:id/files`
 * 按工作区根解析），而模型给的 `file_path` 两种都有：
 * - 相对路径（`src/parts.ts`）—— 直接就是面板要的形状；
 * - 绝对路径（`D:\repo\src\parts.ts` / `/repo/src/parts.ts`）—— 得按工作区根削掉前缀。
 *
 * 不归一化的话，「点工具卡里的文件名」要么开到别处，要么直接报「路径不存在」。
 *
 * ## 边界
 *
 * 这里**不做越界校验**：能不能读是服务端 `resolveInside` 的事（工具能跑通就说明路径在工作区
 * 内）。这里只回答「这个路径能不能落到面板里的某个相对路径」—— 落不到就返回 `null`，
 * 调用方据此**不做成可点**（点了没反应比不能点更糟）。
 *
 * Windows 的大小写不敏感也照顾到了：盘符路径的前缀比对退到小写再比一次（同一个目录
 * 大小写混写很常见），其余情况严格按字符比（POSIX 下 `Src` 与 `src` 是两个目录）。
 */

/** 盘符开头的绝对路径（`C:\a` / `C:/a`） */
const DRIVE_PREFIX = /^[a-zA-Z]:[\\/]/

/** 统一分隔符：后面所有比对都在 `/` 口径下做 */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/** 去掉末尾的分隔符（`/repo/` → `/repo`）；根路径（`/`、`C:`）原样保留 */
function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') || path : path
}

/** 绝对路径（POSIX 根 / Windows 盘符 / UNC） */
export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('//') || DRIVE_PREFIX.test(path)
}

/**
 * `target` 是否以 `root` 开头（按**整段**比，`/repo2` 不算 `/repo` 的子路径）。
 * 命中返回 `root` 的长度（用来切掉前缀），否则 null。
 */
function prefixLength(target: string, root: string): number | null {
  if (!root || target.length <= root.length) return null
  const cut = (t: string, r: string): number | null =>
    t.startsWith(r) && t[r.length] === '/' ? r.length : null
  const direct = cut(target, root)
  if (direct !== null) return direct
  // 盘符路径（Windows）大小写不敏感
  return DRIVE_PREFIX.test(root) ? cut(target.toLowerCase(), root.toLowerCase()) : null
}

/**
 * 把工具入参里的路径解析成**工作区相对路径**（`/` 分隔，无前导分隔符）。
 *
 * @param path 模型给的路径（绝对或相对；分隔符两种都认）
 * @param root 工作区根目录的绝对路径；空串 = 不知道根，此时只认相对路径
 * @returns 相对路径；路径就是根目录本身 / 在工作区之外 / 空串 → `null`
 */
export function workspaceRelativePath(path: string, root: string): string | null {
  const target = trimTrailingSlash(toPosix(path.trim()))
  if (!target || target === '.') return null

  const hit = prefixLength(target, trimTrailingSlash(toPosix(root.trim())))
  if (hit !== null) {
    // 等于根目录本身时上面那句 `target.length <= root.length` 已经挡掉（那是目录，不是文件）
    return target.slice(hit).replace(/^\/+/, '') || null
  }

  if (isAbsoluteFilePath(target)) return null
  // 相对路径：`./src/a.ts` 与 `src/a.ts` 是同一个位置
  const rel = target.replace(/^\.\/+/, '')
  return rel && rel !== '.' ? rel : null
}
