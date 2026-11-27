/**
 * 内置上传适配器的接口。服务端其余部分（POST 路由、chat-turn 的归属校验、附件读取）
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
  /** 必须能够读回字节，交给模型时统一内联 base64。 */
  get(url: string): Promise<{ mediaType: string; bytes: Uint8Array } | null>
  /**
   * 删掉一条**已落盘**的附件。只在「上传成功、但结果被丢弃」（客户端恰好在这一刻取消）
   * 时由上传路由调用，用来收拾孤儿对象。缺省 = 不支持删除，服务端保持现状。
   */
  remove?(url: string): Promise<void>
}
