/**
 * 拖入目录时「挑哪一个」的判定。
 *
 * ## 防的是什么
 *
 * 1. 把**文件**当目录登记：`dataTransfer.files` 里的文件与文件夹长得一样，不看
 *    `webkitGetAsEntry().isDirectory` 就会把用户拖进来的 `.txt` 送去 `addWorkspace`，
 *    服务端只能回「不是目录」——用户看到的是「拖什么都没反应，还报个错」。
 * 2. 一次拖进多个时挑错对象：Windows 上全选拖拽很常见，必须稳定地取**第一个目录**。
 * 3. 取不到路径（不是真实 File）时把整次 drop 判死：后面还有目录时要接着看。
 */
import { describe, expect, it, vi } from 'vitest'
import { firstDroppedDirectoryPath } from './dropped-directory'

/** 造一次 drop：`dirs` 里 `null` 表示 `webkitGetAsEntry()` 给不出条目 */
function drop(names: string[], dirs: (boolean | null)[]): DataTransfer {
  const files = names.map((name) => ({ name }))
  const items = dirs.map((isDirectory) => ({
    webkitGetAsEntry: () => (isDirectory === null ? null : { isDirectory })
  }))
  return { files, items } as unknown as DataTransfer
}

/** 假宿主：路径 = `name` 前面加个盘符，取不到（空串）就照实返回 */
function getPath(file: File): string {
  return file.name === 'broken' ? '' : `C:\\drop\\${file.name}`
}

describe('firstDroppedDirectoryPath', () => {
  it('跳过文件、取第一个目录', () => {
    const data = drop(['note.txt', 'project'], [false, true])
    expect(firstDroppedDirectoryPath(data, getPath)).toBe('C:\\drop\\project')
  })

  it('全是文件时返回 null（交给调用方提示「只能拖入文件夹」）', () => {
    const data = drop(['a.txt', 'b.md'], [false, false])
    expect(firstDroppedDirectoryPath(data, getPath)).toBeNull()
  })

  it('多个目录时取第一个', () => {
    const data = drop(['one', 'two'], [true, true])
    expect(firstDroppedDirectoryPath(data, getPath)).toBe('C:\\drop\\one')
  })

  it('拿不到 entry 时不拦，照样交给服务端去校验', () => {
    const data = drop(['project'], [null])
    expect(firstDroppedDirectoryPath(data, getPath)).toBe('C:\\drop\\project')
  })

  it('某个条目取不到路径就接着看下一个', () => {
    const getPathSpy = vi.fn(getPath)
    const data = drop(['broken', 'project'], [true, true])
    expect(firstDroppedDirectoryPath(data, getPathSpy)).toBe('C:\\drop\\project')
    expect(getPathSpy).toHaveBeenCalledTimes(2)
  })
})
