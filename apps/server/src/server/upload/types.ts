/**
 * 上传适配器的接口。服务端其余部分（POST 路由、chat-turn 的归属校验、模型 URL 解析）
 * 只认这个接口 —— 换存储后端（S3 / OSS / 图床…）= 新增一个实现 + 注册表登记，
 * 别在调用点写 if (backend === 'local')。
 */
export interface UploadAdapter {
  /** 适配器 id（local / s3 / oss …），`FIZZ_UPLOAD_BACKEND` 按它选择 */
  readonly id: string
  /**
   * 落存储并返回对外 URL。local 返回相对 `/api/uploads/<uuid>.<ext>`（由 GET 路由
   * 公开服务）；远端存储适配器可直接返回绝对 https URL（不经过本地 GET 路由）。
   */
   put(input: { name: string; mediaType: string; bytes: Uint8Array; signal?: AbortSignal }): Promise<{ url: string }>
  /** 该 URL 是否由本适配器管辖（chat-turn 校验附件引用归属用，防任意 URL 注入历史） */
  owns(url: string): boolean
  /**
   * 模型提交用的绝对地址：local = `FIZZ_PUBLIC_BASE_URL ?? origin` + 相对路径；
   * 远端存储适配器原样返回（自己的 URL 本来就是绝对的）。
   */
  resolveModelUrl(url: string, origin: string): string
  /** 读回字节；缺省 = 该适配器不支持读回（当前没有调用方，先留口子） */
  get?(url: string): Promise<{ mediaType: string; bytes: Uint8Array } | null>
}
