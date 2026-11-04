/**
 * @fizz/plugin：Fizz 的插件元框架（Cordis 风格精简版），TS 源码直接导出
 * （与 contracts / tools / agent 同一模式）。
 *
 * ⚠️ `plugins.yml` 加载器在子路径 `@fizz/plugin/config`（依赖 js-yaml + node:fs），
 * 刻意不从这里导出 —— 免得只想用 Core 的调用方（尤其前端）被迫吃进 Node-only 依赖。
 */
export * from './types'
export { Logger } from './logger'
export { Service } from './service'
export { Context, Fork, createAppContext } from './context'
export { EventsService } from './services/events'
export { ToolsService } from './services/tools'
export type { ToolOrigin, ToolRegistration, RegisterToolOptions, ResolvedTool } from './services/tools'
export { PromptService } from './services/prompt'
export type { PromptSection, PromptSectionOptions } from './services/prompt'
export { UiService } from './services/ui'
export type {
  PluginConfigInput,
  PluginSettingView,
  PluginUiDeclaration,
  PluginUiView,
  UiActivityBarItem,
  UiBlock,
  UiBlockTone,
  UiBlockView,
  UiButtonItem,
  UiListItem,
  UiPanel,
  UiRenderContext,
  UiSettingItem,
  UiSettingType,
  UiSurfaceDeclaration,
  UiSurfaceKind,
  UiSurfaceSpec
} from './services/ui'
export { WorkspaceService } from './services/workspace'
export type { WorkspaceInfo } from './services/workspace'
export { UploadsService, matchesUploadPrefix, normalizeUploadPrefix } from './services/uploads'
export { RpcService } from './services/rpc'
export type { RpcCallContext, RpcHandler } from './services/rpc'
export { ModelsService } from './services/models'
export type { PluginModelConfig, PluginModelRegistration } from './services/models'
export type {
  RegisterUploadProviderOptions,
  UploadProviderAccept,
  UploadProviderRegistration,
  UploadProviderSpec,
  UploadPutInput
} from './services/uploads'
export { HOOKS, HooksService, hookValue } from './hooks'
export type {
  HookName,
  PromptRenderListener,
  ToolCallListener,
  ToolResultListener,
  TurnFinishListener,
  TurnFinishPayload,
  TurnStartListener,
  TurnStartPayload
} from './hooks'