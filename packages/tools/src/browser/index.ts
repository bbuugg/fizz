/**
 * 浏览器自动化：引擎（Playwright + CDP screencast）+ Agent 工具集。
 * 与宿主解耦（依赖经 configureBrowser 注入），可被纯 Node 验证脚本直接跑。
 */
export {
  browserSessions,
  configureBrowser,
  createBrowserSessionHandlers,
  ensureBrowserSession,
  normalizeUrl,
  purgeAllBrowserProfiles,
  resolveBrowserChannel,
  setBrowserChannelResolver,
  subscribeBrowser,
  type BrowserEvent,
  type BrowserSession,
  type BrowserSessionHandlers,
  type BrowserSessionManager
} from './engine'
export {
  browserProfileDirOf,
  browserProfileDirs,
  browserProfilesRoot,
  browserProfileUsage,
  removeBrowserProfileDir,
  setBrowserProfilesRoot
} from './profiles'
export { buildBrowserToolSet, BROWSER_PROMPT_SECTION, type BrowserToolOptions } from './tools'
export { launchAttempts } from './resolver'
export { buttonBit, nextButtonsMask, toCdpCommand, type CdpCommand } from './input'
