/**
 * 内置上传适配器注册表：按 `FIZZ_UPLOAD_BACKEND` 选实现（缺省 local）。
 *
 * ⚠️ `adapterFor`（归属判定）扫描**全部已登记**的适配器，而不是只看当前选中的那个 ——
 * 换了存储后端之后，历史附件引用仍然要能通过校验并读回字节。
 */
import { LocalUploadAdapter } from './local'
import type { UploadAdapter } from './types'

const REGISTRY: Record<string, () => UploadAdapter> = {
  local: () => new LocalUploadAdapter()
}

/** 当前生效的适配器；未知值回落 local 并告警（宁可退回默认也别让上传整体不可用） */
export function resolveUploadAdapter(): UploadAdapter {
  const id = process.env.FIZZ_UPLOAD_BACKEND?.trim() || 'local'
  const factory = REGISTRY[id]
  if (factory) return factory()
  console.warn(`[upload] 未知 FIZZ_UPLOAD_BACKEND：${id}（已登记：${Object.keys(REGISTRY).join('、')}），回落 local`)
  return REGISTRY.local()
}

/** 按 URL 找管辖它的适配器；都不认 → null（调用方据此拒绝这条附件引用） */
export function adapterFor(url: string): UploadAdapter | null {
  for (const factory of Object.values(REGISTRY)) {
    const adapter = factory()
    if (adapter.owns(url)) return adapter
  }
  return null
}
