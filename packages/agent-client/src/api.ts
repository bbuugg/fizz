/**
 * Agent 客户端的 API 层：与 CLI 调的是**同一份契约**（`@fizz/contracts/agent-api`）。
 *
 * 本模块**不关心宿主**：请求怎么发出去由调用方注入的 `fetchImpl` 决定 ——
 * - web：`globalThis.fetch` 打 HTTP/SSE（dev 由 vite 代理到 server，生产由 server 同源托管）；
 * - desktop：preload 注入的 IPC 桥（把 `app.fetch()` 包成 fetch 形状，零端口零 token）。
 *
 * 两个约定：
 * - `url` 留空 = 同源；填了地址就是跨源，需要 server 侧自行处理跨域。
 * - 对话是 SSE：`event: <start|event|end>` + `data: <ChatStreamFrame>`。
 */
import { API_ROUTES, FILES_API } from "@fizz/contracts/agent-api";
import type { AppLanguage, BrowserProfileUsage, BrowserSettings, PrefsPatch, PrefsResult } from "@fizz/contracts";
import type {
  AppLogFrame,
  AppLogResult,
  FmArchiveResult,
  FmEntry,
  FmListResult,
  FmOpInput,
  FmOpResult,
  FmReadResult,
  FmRootsResult,
  FmTrashResult,
  FmUploadInput,
  FsScaffoldInput,
  FsScaffoldResult,
  FsUploadInput,
} from "@fizz/contracts/agent-api";
import type {
  SftpAbortInput,
  SftpCopyInput,
  SftpDownloadChunkInput,
  SftpDownloadChunkResult,
  SftpListInput,
  SftpListResult,
  SftpMkdirInput,
  SftpMoveInput,
  SftpMutationResult,
  SftpRealpathInput,
  SftpRealpathResult,
  SftpRenameInput,
  SftpRemoveInput,
  SftpUploadChunkInput,
  SftpUploadChunkResult,
} from "@fizz/contracts/agent-api";
import { getAgentHostOrNull } from "./host";
import {
  normalizeServerBase,
  resolveServerUrl,
  getServerBaseOverride,
} from "./server-base";
import { downloadFile, DownloadError } from "./download-file";
import type {
  AgentBackend,
  AgentStreamEvent,
  AcpAgentInput,
  AcpAgentView,
  AcpProcessInfo,
  AgentChatMessage,
  AgentConversation,
  AgentFsFile,
  AgentWorkspace,
  AssistantSendInput,
  ChatActiveResult,
  ChatCompressFrame,
  ChatCompressResult,
  ChatRequest,
  DetectedAcpAgent,
  ChatStreamFrame,
  CommandHistoryEntry,
  ConfirmReplyInput,
  ClientToolResultInput,
  ConversationSummary,
  CollabSettings,
  CollabStateResult,
  CollabCancelResult,
  ConversationSearchHit,
  ConversationTargetInput,
  UsageSummary,
  SystemMetrics,
  SystemTaskKillInput,
  SystemTaskKillResult,
  SystemTaskList,
  HostMetrics,
  FollowupReplyInput,
  FsDirsResult,
  FsListResult,
  FsMkdirInput,
  FsMkdirResult,
  FsWorkspaceMkdirInput,
  HealthInfo,
  McpServerToolsResult,
  ModelInput,
  ModelView,
  UpstreamModelsInput,
  UpstreamModelsResult,
  UploadFileRef,
  UploadInput,
  UploadResult,
  WorkspaceCloneInput,
  WorkspaceCloneResult,
  BackgroundTasksResult,
  BackgroundTaskDetail,
  WorkspaceDeleteInput,
  WorkspaceInput,
  WorktreeInput,
  WorktreeLoadInput,
  WorktreeScanEntry,
  SteerResult,
  SteerRemoveResult,
  ForkResult,
  CommandStopResult,
  PermissionSetResult,
} from "@fizz/contracts/agent-api";
import type {
  AiPermissionMode,
  AiReasoningEffort,
  ApiArrangeInput,
  ApiGroup,
  ApiGroupInput,
  ApiGroupsAndRequests,
  ApiHistoryEntry,
  ApiHttpResponse,
  ApiRequestEntry,
  ApiSendInput,
  ScriptArrangeInput,
  ScriptEntry,
  ScriptGroup,
  ScriptGroupInput,
  ScriptInput,
  ScriptsAndGroups,
  TransferExportResult,
  TransferFormat,
  TransferImportResult,
  TransferInspectResult,
  TransferKind,
  AskFollowupAnswer,
  QueuedMessage,
  HostConfig,
  HostArrangeInput,
  HostGroup,
  HostGroupInput,
  HostGroupsAndHosts,
  HostInput,
  NotesCreateResult,
  NotesDirResult,
  NotesFileResult,
  NotesRenameResult,
  NotesRoot,
  NotesRootInput,
  NotesWriteInput,
  SshTunnelInput,
  SshTunnelsSnapshot,
  SubagentDefinition,
  SubagentId,
  TaskTrigger,
  TaskTriggerInput,
} from "@fizz/contracts/types";
import type { AcpModelChoices, AcpProbeResult } from "@fizz/acp";
import type { ShellDetectResult } from "@fizz/shells";
import type { McpServerConfig, McpServerInput, McpToolInfo } from "@fizz/mcp";
import type { SkillListResult } from "@fizz/skills";
import type {
  BrowserRuntimeResult,
  PluginRpcResponse,
  PluginSurfaceActionResult,
  PluginSurfaceContent,
  PluginSurfacesResult,
  SubagentsResponse,
  UploadProviderView,
  UploadProvidersResult,
} from "@fizz/contracts/agent-api";
// 系统监控偏好 / 容器型项目类型走根入口（子路径 alias 只在各端列出来的那几个里有效，见 packages/workspace/src/store.ts）
import type {
  ContainerImagesSnapshot,
  ContainerProjectCreateInput,
  ContainerProjectUpdateInput,
  ContainerProjectsSnapshot,
  SystemMonitorSettings,
} from "@fizz/contracts";
/**
 * 公网访问域名的**生效视图**（`GET/POST /api/system/container-public` 的响应）。
 *
 * 字段语义见 `apps/server/src/api/system/container-public/route.ts` 文件头：
 * `domains` 空 = 关闭；`enabled` false = 配了域名但公网入口端口没在监听。
 */
export interface ContainerPublicSettingsView {
  /** 生效域名清单（空 = 关闭；可多个） */
  domains: string[];
  /** 每个域名对应的 `*.domain` DNS 记录 */
  wildcards: string[];
  /** 建议的解析目标（公网 IP / 本机内网 IP）；没有就是 `null` */
  target: string | null;
  /** 现在能不能真用（配了域名 + 公网入口端口确实在监听） */
  enabled: boolean;
}
import type {
  PluginDescriptor,
  PluginSettings,
  PluginUiView,
  PluginUploadSourceInfo,
} from "@fizz/plugin";
import type {
  GitActionInput,
  GitActionResult,
  GitBranchesResult,
  GitCommitDiffResult,
  GitDiffResult,
  GitLogResult,
  GitStatusResult,
} from "@fizz/git";
import type {
  WorkspaceConfig,
  WorkspaceConfigSnapshot,
} from "@fizz/contracts/workspace-config";

/** `GET/POST /api/plugins` 的响应：磁盘上扫到的插件 + 启停设置 + 扫过的根目录 + 插件声明的 UI */
export interface PluginsResponse {
  plugins: PluginDescriptor[];
  settings: PluginSettings;
  roots: Array<{ source: string; dir: string }>;
  /**
   * 插件 id → 它 `ctx.ui` 声明的设置项 / 面板 **+ 当前值**（无声明 = 没有这个键）。
   *
   * 设置项是**可编辑**的：值由服务端存（密钥项只给 `hasValue`，明文不出网），
   * 保存走 `api.savePluginConfig`。
   */
  ui: Record<string, PluginUiView>;
  /**
   * 插件 id → 它 `ctx.uploads` 注册的**上传源**（没注册 = 没有这个键）。
   *
   * 上传源只在「上传时」生效（不是回合能力），所以设置页里要能看出「这个插件给了我一个
   * 可选的附件上传目标」—— 它出现在输入框左下角回形针菜单的「传到哪儿」里。
   */
  uploads: Record<string, PluginUploadSourceInfo[]>;
  /**
   * 加载 / 校验失败的插件（一条一个插件，含失败原因）。
   * 收集 UI 时会把插件真跑一遍 apply，所以这里也涵盖了「工具形状不对」这类装配期错误
   * —— 这类插件本轮不生效，得让用户看见（不然只会看到对话卡在「执行中」）。
   */
  errors: string[];
}

/**
 * 连接信息：登录后拿到的 JWT + 服务端地址。持久化交给宿主（web 存 localStorage）。
 * token 与密码同级敏感。
 *
 * `serverBase` 指的是**服务端的绝对地址**（如 `https://fizz.example.com`）：
 * - 缺省 = 同源（页面由 server 托管，`/api`、WS、SSE 全部打当前 host）——
 *   `apps/web` 与 desktop 都是这个形态，行为逐字不变；
 * - 填了 = 跨源（`http://127.0.0.1:5173` 这种由别的 vitest / dev server 托管的页面，
 *   或 Capacitor 本地 `www` 的 `https://localhost`）：API / SSE / WS 全部打到它。
 *
 * ⚠️ 跨源时 **WS 的 Origin 校验、CORS、来源白名单**都要服务端放行（`FIZZ_CORS_ORIGINS`）。
 */
export interface Connection {
  token: string;
  /** 服务端绝对地址（`http://host:port` / `https://host`），不带结尾斜杠；缺省 = 同源 */
  serverBase?: string;
}

/**
 * 服务端地址的真源在 `./server-base`（`api.ts` 与 `host.ts` 都要用，放这里会形成循环依赖）。
 * 这里再导出一次，是因为历史代码一直从 `@fizz/agent-client/api` 引这两个函数。
 */
export { normalizeServerBase, resolveServerUrl } from "./server-base";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 常见状态码的人话说明。
 *
 * 为什么需要：502 / 503 / 504 多半是前面的反向代理（Nginx / Cloudflare / 面板）直接回的，
 * 错误体是一整页 HTML。以前把正文前 200 字塞进 message，用户就在 toast 里看到
 * `<!DOCTYPE html><html>...` 半截标签 —— 既看不懂，也判断不出是网关挂了。
 */
const STATUS_HINTS: Record<number, string> = {
  400: "请求有误",
  401: "未登录或登录已过期",
  403: "没有访问权限",
  404: "接口不存在",
  405: "请求方法不被允许",
  408: "请求超时",
  413: "请求体过大",
  415: "不支持的请求格式",
  429: "请求过于频繁，请稍后再试",
  500: "服务端内部错误",
  501: "服务端不支持该请求",
  502: "网关错误，后端服务可能没起来",
  503: "服务暂不可用",
  504: "网关超时，后端服务没有响应",
};

/**
 * 把「状态码 + 响应正文」翻成给人看的错误文案。
 *
 * - 正文是本服务的错误形状（`{ error }` / `{ message }`）→ 原样透出，业务话最准；
 * - 正文不是 JSON（典型是代理回的 HTML 错误页）或为空 → **只报状态码 + 一句人话**，
 *   绝不把 HTML 正文当消息（那是 502 被 toast 出来的原因）。
 */
export function httpErrorMessage(status: number, body: string): string {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      const detail =
        typeof parsed?.error === "string" && parsed.error
          ? parsed.error
          : typeof parsed?.message === "string" && parsed.message
            ? parsed.message
            : "";
      if (detail) return detail;
    } catch {
      /* 非 JSON：落到下面的状态码兜底 */
    }
  }
  const hint = STATUS_HINTS[status];
  return hint ? `HTTP ${status} ${hint}` : `HTTP ${status}`;
}

/** 统一解析错误体（server 的错误形状就是 `{ error }`） */
async function toError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  return new ApiError(httpErrorMessage(res.status, text), res.status);
}

/**
 * 全局 401 钩子：任意 API 请求（含 SSE / 媒体拉取）拿到 401 都会触发一次，
 * 由宿主决定怎么收场（清本地数据 + 退回登录页）。错误仍照常往上抛，钩子只是「顺手通知」。
 */
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}
/** 宿主层（raw fetch，如工作区配置）也能触发同一套 401 收场，避免各调用方各自处理 */
export function reportUnauthorized(): void {
  unauthorizedHandler?.();
}

/**
 * 逐帧读一条 SSE 响应：`data:` 行的 JSON 就是帧体（以空行分帧）。
 *
 * 泛型是因为对话（`ChatStreamFrame`）等流共用它。调用方显式传类型参数 ——
 * 从回调形参推不出来。
 *
 * ⚠️ **帧处理的异常绝不能让它穿出这个函数**（下面两处 try/catch 就是为这件事存在的）。
 *
 * 因为它的调用方是「把 reject 当连接断了」的语义：`attachRun` 的 catch 一收到异常就去
 * `peekActiveRun` 确认服务端那轮还在不在跑，在跑就弹「连接中断，正在自动重连」并**从帧日志
 * 头部重连回放**。于是「某一帧处理时抛错」会被完整地误判成一次断线：重连 → 回放 → 同一帧
 * 再抛一次 → 再弹 → **无限重连**（`attachRun` 的重连循环没有次数上限）。而真实原因只是
 * 客户端某处的一个 reducer 异常 / 一个本端不认识的事件 —— 一次坏帧只该丢一帧。
 *
 * 同一段逻辑也决定了：**注释心跳帧**（`: keep-alive`，见 server 的 `createSSEStream`）
 * 在这里被天然忽略（`raw` 里没有 `data:` 行）。
 */
async function readSseFrames<T>(
  res: Response,
  onFrame: (frame: T) => void,
): Promise<void> {
  if (!res.body) throw new ApiError("服务端没有返回流");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf("\n\n");
      const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let frame: T;
      try {
        frame = JSON.parse(dataLine.slice(5).trim()) as T;
      } catch {
        // 半截 / 损坏的帧：丢掉它继续读，别把整条连接判死
        console.warn(
          "[api] SSE 帧不是合法 JSON，已丢弃：",
          dataLine.slice(0, 200),
        );
        continue;
      }
      try {
        onFrame(frame);
      } catch (err) {
        console.error("[api] 处理 SSE 帧时抛错，已丢弃该帧（连接继续）：", err);
      }
    }
  }
}

/**
 * 从一个错误里读 HTTP 状态码。
 *
 * 为什么需要它：web 端抛的是 `ApiError`（自带 `status`），而 **desktop 端抛的是宿主桥造的
 * 普通 `Error`** —— 桌面端的请求经 IPC 走主进程，状态码本来在桥上传不下来。调用方
 * （`attachRun` 的 catch）只认 `instanceof ApiError` 的话，桌面端的 401（token 失效 → 登出）
 * 与 404（run 已过期 → 正常收场）两条分支全是**死代码**，只能绕一圈 `peekActiveRun` 才收场。
 * 宿主桥现在会把 `status` 挂到 Error 上（见 `apps/desktop/src/renderer/host.ts` 的 `openSse`），
 * 这里一并认掉，两端走同一条判定。
 */
export function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.status;
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" && status > 0 ? status : undefined;
}

/**
 * 默认请求实现：**运行时**解析宿主 —— web = `globalThis.fetch`，desktop = IPC 桥。
 *
 * 写成延迟委派而不是在 `createApi` 的默认参数里直接取 `globalThis.fetch`，是因为
 * 宿主注入（`setAgentHost`）可能晚于本模块求值 / store 创建：`api` 实例是按 token
 * 缓存的，一旦把错误的 fetch 绑死在里面，desktop 会拿着 `globalThis.fetch` 去打
 * 一个根本不存在的 HTTP 地址。
 */
export const hostFetch: typeof fetch = (input, init) => {
  const host = getAgentHostOrNull();
  const impl = host ? host.fetch : globalThis.fetch;
  return impl(input, init);
};

/** File → 纯 base64（去掉 data URL 前缀）；上传协议的载荷编码（接口请求的 form-data 文件字段也用它） */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 把绝对路径拼进 query（文件管理器那批接口共用）。
 *
 * Windows 路径里既有 `:` 又有空格 / `#`，**必须**编码，否则 query 会被截断成
 * `C:\a` 这种半截路径；`path` 缺省时连 `?path=` 都不加（服务端按主目录处理）。
 */
function pathQuery(base: string, path?: string): string {
  if (!path) return base;
  return `${base}?path=${encodeURIComponent(path)}`;
}

export function createApi(
  connection: Connection,
  fetchImpl: typeof fetch = hostFetch,
  onUnauthorized?: () => void,
) {
  /** 有 token 才带鉴权头 */
  const authHeaders = (): Record<string, string> =>
    connection.token ? { authorization: `Bearer ${connection.token}` } : {};
  /** 服务端地址（缺省 = 同源）。见 `Connection.serverBase` */
  const serverBase = normalizeServerBase(connection.serverBase);
  /**
   * 把服务端相对路径接成真正要请求的地址。
   *
   * ⚠️ 所有出口都必须过这一道：`fetchImpl`（web = `globalThis.fetch`，跨源时相对路径会
   * 打到页面自己的 origin）、XHR 上传、`downloadFile`、以及两个 `*RawUrl`（它们返回的
   * 地址会被直接塞进 `<img src>`，相对路径在 Capacitor 本地 `www` 下指向 `https://localhost`）。
   *
   * desktop 走 IPC 桥，桥自己会把绝对地址裁回 path+query（`toPath`），所以对它也无害。
   */
  const endpoint = (path: string): string => resolveServerUrl(serverBase, path);
  /** 401 的收场：实例自带回调优先，否则回落到全局钩子（宿主在 useAgentApp 注册） */
  const fireUnauthorized = (): void => (onUnauthorized ?? reportUnauthorized)();

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(endpoint(path), {
      ...init,
      headers: {
        ...authHeaders(),
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      if (res.status === 401) fireUnauthorized();
      throw await toError(res);
    }
    const text = await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      /*
       * HTTP 200 却不是 JSON：典型是请求**没命中 API 路由**，被 SPA 回退（或反向代理 /
       * dev server）当成页面请求，把 `index.html` 发了回来 —— 前端路由已移除，服务端那条
       * `app.get('*')` 回退就是专门干这个的。直接 JSON.parse 会抛裸 SyntaxError
       * （"Unexpected token '<'"），让「会话加载失败 + 重试」显示得没头没脑 ——
       * 换成能读懂的话。
       */
      throw new ApiError(
        `服务端返回了非 JSON 响应（HTTP ${res.status}，content-type: ${res.headers.get("content-type") ?? "未知"}）：${text.slice(0, 120)}`,
        res.status,
      );
    }
  }

  return {
    /** 连通性 + 配置概览；用于连接校验与顶栏状态 */
    health: () => request<HealthInfo>(API_ROUTES.health),

    /** 修改登录密码（校验旧密码，服务端只保存新密码的哈希） */
    changePassword: (input: { currentPassword: string; newPassword: string }) =>
      request<{ ok: true }>(API_ROUTES.authPassword, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    // ---------- 客户端偏好（服务端权威的一份） ----------

    /**
     * 读全量偏好（归一化后的）。功能上等价于 `state-ws` 的 `prefs` 快照域 ——
     * 留着是为了「还没连上 WS / 快照丢了」时也能对账，以及给 CLI 之类的非 WS 客户端用。
     */
    getPrefs: () => request<PrefsResult>(API_ROUTES.prefs),

    /**
     * 提交改动项：**传几个 key 就改几个**，缺的保留（服务端 `normalizePrefsPatch` 做白名单 +
     * 归一化）。落盘后服务端经 `state-ws` 推给所有端，所以调用方不需要自己广播。
     */
    savePrefs: (patch: PrefsPatch) =>
      request<PrefsResult>(API_ROUTES.prefs, {
        method: "POST",
        body: JSON.stringify({ prefs: patch }),
      }),

    // ---------- 附件上传 ----------

    /**
     * 上传对话附件（图片 / PDF）：读成 base64 走 **JSON**（desktop 的 IPC 桥 body 只支持
     * 字符串，FormData 会被静默丢掉，两端必须同一条协议）。
     *
     * 进度的两种现实：web 走 XHR（`upload.onprogress` 真进度）；desktop 进程内直连秒传，
     * 完成时补一次 `onProgress(100)`。
     */
    async uploadFile(
      file: File,
      opts?: {
        onProgress?: (percent: number) => void;
        /** 用哪个上传源；缺省 = 服务端的内置存储（见 `listUploadProviders`） */
        provider?: string;
        /** 这次上传属于哪个项目（带项目级插件提供的上传源才用得上） */
        workspaceId?: string;
      },
    ): Promise<UploadResult> {
      const onProgress = opts?.onProgress;
      const input: UploadInput = {
        name: file.name,
        mediaType: file.type || "application/octet-stream",
        dataBase64: await fileToBase64(file),
        ...(opts?.provider ? { provider: opts.provider } : {}),
        ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      };
      if (getAgentHostOrNull()?.platform === "desktop") {
        const result = await request<UploadResult>(API_ROUTES.upload, {
          method: "POST",
          body: JSON.stringify(input),
        });
        onProgress?.(100);
        return result;
      }
      // web：fetch 拿不到请求体的上传进度，用 XHR
      return await new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", endpoint(API_ROUTES.upload));
        for (const [key, value] of Object.entries(authHeaders()))
          xhr.setRequestHeader(key, value);
        xhr.setRequestHeader("content-type", "application/json");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            onProgress?.(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          let json:
            | ({ error?: string; message?: string } & Partial<UploadResult>)
            | null = null;
          try {
            json = JSON.parse(xhr.responseText);
          } catch {
            // 解析不了就按状态码兜底报错
          }
          if (xhr.status >= 200 && xhr.status < 300 && json?.url) {
            resolve(json as UploadResult);
            return;
          }
          if (xhr.status === 401) fireUnauthorized();
          reject(
            new ApiError(
              json?.error || json?.message || `上传失败（HTTP ${xhr.status}）`,
              xhr.status,
            ),
          );
        };
        xhr.onerror = () => reject(new ApiError("上传失败：网络错误", 0));
        xhr.send(JSON.stringify(input));
      });
    },

    // ---------- 主机终端：SFTP 上传（把本地文件拖进 SSH 终端） ----------

    /**
     * 解析远端绝对路径（`path` 缺省或 `.` = 远端默认工作目录，通常是家目录）。
     *
     * 拖拽上传拿它当**目标目录的初值**：shell 的当前工作目录拿不到（默认不发 OSC 7、
     * 解析提示符不可靠），所以先给家目录，让用户在确认条里改，并在会话内记住上次用的。
     */
    sftpRealpath: async (hostId: string, path?: string): Promise<string> => {
      const body: SftpRealpathInput = { hostId, ...(path ? { path } : {}) };
      const result = await request<SftpRealpathResult>(
        API_ROUTES.sftpRealpath,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      return result.path;
    },

    /**
     * 写**一个分片**到远端 `dir/name`（`index === 0` 时服务端逐层创建目录并以 `'w'` 截断）。
     *
     * 分片怎么切、怎么串行，全在调用方（`shared/lib/file-transfer/engine.ts`）；这里只负责
     * 「打一次请求、把被取消归一化」。
     *
     * ⚠️ **从 XHR 换成 `request`（fetch）是有意的**：XHR 当初是为了 `upload.onprogress`
     * 拿请求体的真进度，而分片协议下**进度由分片数自己算**（`done / size`），一次 4MB 的
     * 请求内部的字节级进度既不必要、还会和分片进度打架（两个进度条来回跳）。换成 fetch 后
     * 两端同一条路，也顺带接上了 `signal`。
     *
     * **取消走 `signal`**，并把「被取消」归一化成 `{ ok: false, canceled: true }` 返回而不是
     * 抛错 —— 取消是正常路径，不该让调用点包一层 try/catch 去分辨「取消」和「真失败」。
     *
     * ⚠️ 上传**还要**另外调一次 `sftpAbort(input)`：`signal` 在 desktop 上是空转的
     * （IPC 桥的普通请求**不转发 `AbortSignal`**，只有 SSE 那条路有，见
     * `agent-host/src/transport-ipc.ts`），那一下才是让服务端销毁写流、清掉半份文件的那半。
     */
    sftpUploadChunk: async (
      input: SftpUploadChunkInput,
      opts?: { signal?: AbortSignal },
    ): Promise<SftpUploadChunkResult> => {
      const signal = opts?.signal;
      if (signal?.aborted) return { ok: false, canceled: true };
      try {
        return await request<SftpUploadChunkResult>(
          API_ROUTES.sftpUploadChunk,
          {
            method: "POST",
            body: JSON.stringify(input),
            ...(signal ? { signal } : {}),
          },
        );
      } catch (err) {
        // fetch 的 abort 表现为 AbortError；按「已取消」收场，与旧实现一致
        if (signal?.aborted) return { ok: false, canceled: true };
        throw err;
      }
    },

    /**
     * 通知服务端停止写某笔上传（幂等）并清掉远端半份文件。
     *
     * 四个字段缺一不可：`transferId` 用来**打断在途的写流**，`hostId` / `dir` / `name`
     * 用来定位并删除那个只写了一半的文件 —— 分片协议下它是真实存在、内容完整的一堆前缀
     * 字节，不删就是一个「看起来成功」的坏文件。
     *
     * **刻意吞掉错误**：取消是用户的正常操作，服务端也把它设计成幂等。这里再抛一个
     * 「取消失败」出来，只会让用户在「点了取消」之后又看到一个报错弹窗。
     */
    sftpAbort: async (input: SftpAbortInput): Promise<void> => {
      try {
        await request<null>(API_ROUTES.sftpAbort, {
          method: "POST",
          body: JSON.stringify(input),
        });
      } catch {
        // 见上：取消失败不值得打扰用户
      }
    },

    // ---------- SFTP 文件管理（右击主机 →「SFTP 文件管理」标签） ----------
    //
    // 下面这一组都是「一问一答」的短操作，直接 `request` 打过去、拿到结果就返回；
    // 没有进度、没有取消通道（理由见 contracts 的 `SftpListInput` / `SftpMoveInput`）。
    // 上传 / 下载（唯一带进度与取消的两个操作）走上面的 `sftpUploadChunk` /
    // `sftpDownloadChunk` / `sftpAbort`，并由 `shared/lib/file-transfer/engine.ts` 编排。

    /**
     * 列一个远端目录。返回归一化后的路径（回填路径栏）与排好序的目录项。
     *
     * 目录项里的 `path` 都是**绝对路径**，可直接喂回 remove / rename / download，
     * 渲染端不必自己拼路径。
     */
    sftpList: async (hostId: string, path: string): Promise<SftpListResult> => {
      const body: SftpListInput = { hostId, path };
      return await request<SftpListResult>(API_ROUTES.sftpFileList, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /** 新建远端目录（不递归；父目录必须已存在） */
    sftpMkdir: async (hostId: string, path: string): Promise<void> => {
      const body: SftpMkdirInput = { hostId, path };
      await request<SftpMutationResult>(API_ROUTES.sftpFileMkdir, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /** 重命名 / 同盘移动（跨盘移动请用 `sftpMove`，服务端会自动回退到复制 + 删除） */
    sftpRename: async (
      hostId: string,
      from: string,
      to: string,
    ): Promise<void> => {
      const body: SftpRenameInput = { hostId, from, to };
      await request<SftpMutationResult>(API_ROUTES.sftpFileRename, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /** 删除文件 / 目录（目录**递归**删除，不可逆） */
    sftpRemove: async (hostId: string, path: string): Promise<void> => {
      const body: SftpRemoveInput = { hostId, path };
      await request<SftpMutationResult>(API_ROUTES.sftpFileRemove, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /** 远端复制（目录递归；同名目标覆盖） */
    sftpCopy: async (
      hostId: string,
      from: string,
      to: string,
    ): Promise<void> => {
      const body: SftpCopyInput = { hostId, from, to };
      await request<SftpMutationResult>(API_ROUTES.sftpFileCopy, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /** 远端移动（服务端优先 rename，跨盘自动回退「复制 + 删除源」） */
    sftpMove: async (
      hostId: string,
      from: string,
      to: string,
    ): Promise<void> => {
      const body: SftpMoveInput = { hostId, from, to };
      await request<SftpMutationResult>(API_ROUTES.sftpFileMove, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /**
     * 读远端文件的一段（返回 **base64 字节**，**不是**「写到某个本地路径」）。
     *
     * 与「下载」语义的差别：服务端很可能跟浏览器不在同一台机器上，它没有用户的本地路径，
     * 只能把字节交回渲染端；由渲染端落盘（见 `shared/lib/file-transfer/sink.ts`）。
     *
     * 这里**只负责搬运**，不解析 base64、不判 eof —— 循环与 `eof` 判定都在
     * `engine.ts`（那里的两个边界：`eof === false` 却 0 字节 = 死循环，`size === 0` =
     * 一个请求都不发）。`length` 由调用方按 `SFTP_CHUNK_BYTES` 算好，服务端会再校验一次。
     *
     * **不带 `transferId`、也不需要 abort**：下载是「客户端拉」，不拉了就是取消，
     * 服务端那边没有在途状态要收拾（见契约里的说明）。
     */
    sftpDownloadChunk: async (
      input: SftpDownloadChunkInput,
      opts?: { signal?: AbortSignal },
    ): Promise<SftpDownloadChunkResult> => {
      const signal = opts?.signal;
      return await request<SftpDownloadChunkResult>(
        API_ROUTES.sftpFileDownloadChunk,
        {
          method: "POST",
          body: JSON.stringify(input),
          ...(signal ? { signal } : {}),
        },
      );
    },

    /**
     * 可用的上传源清单（内置存储 + 插件注册的）。
     *
     * 两个用途：**放宽本地预校验**（`splitUploadable` 默认按契约白名单拦文件，插件上传源
     * 可以声明自己的 accept，所以要按并集判）与**渲染「传到哪儿」选择器**。
     * 不传 `workspaceId` 也能拿到（只有插件 + 内置）—— 上传可能发生在还没选项目时。
     */
    listUploadProviders: async (
      workspaceId?: string,
    ): Promise<UploadProviderView[]> => {
      const query = workspaceId
        ? `?workspaceId=${encodeURIComponent(workspaceId)}`
        : "";
      const result = await request<UploadProvidersResult>(
        `${API_ROUTES.uploadProviders}${query}`,
      );
      return result.providers ?? [];
    },

    // ---------- 模型 ----------
    listModels: () => request<ModelView[]>(API_ROUTES.models),
    saveModel: (input: ModelInput) =>
      request<ModelView>(API_ROUTES.models, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    deleteModel: (id: string) =>
      request<ModelView[]>(`${API_ROUTES.models}/${id}`, { method: "DELETE" }),
    /** 向模型上游要一份可选模型清单（设置页「从上游拉取」；收的是还没保存的草稿配置） */
    probeUpstreamModels: (input: UpstreamModelsInput) =>
      request<UpstreamModelsResult>(API_ROUTES.modelsProbe, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    // ---------- 工作区 / 会话 ----------
    listWorkspaces: () => request<AgentWorkspace[]>(API_ROUTES.workspaces),
    addWorkspace: (input: WorkspaceInput) =>
      request<AgentWorkspace>(API_ROUTES.workspaces, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /**
     * 从 Git 导入：服务端克隆远端仓库到 `parentDir/<目录名>` 并登记成项目。
     *
     * 克隆可能要跑几分钟（大仓库慢网）。返回形状有三种，**都是正常结局**（一律 200）：
     * - `AgentWorkspace`：克隆完成并已登记；
     * - `{ canceled: true }`：被取消（`cancelBackgroundTask(cloneId)`）；
     * - `{ detached: true }`：转到后台了（`detachBackgroundTask(cloneId)` 或
     *   `input.background`），克隆仍在服务端跑，进度在 `listBackgroundTasks()` 里。
     *
     * 失败（认证 / 仓库不存在 / 目标已存在）才抛错，`error` 里是 git 的原话。
     */
    cloneWorkspace: (input: WorkspaceCloneInput) =>
      request<WorkspaceCloneResult>(API_ROUTES.workspaceClone, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    // ---------- 后台任务（服务端进程内的「正在跑 / 刚跑完」清单） ----------
    //
    // 这几条都回同一个形状（全量清单），前端拿到直接整体替换本地状态，
    // 不用自己维护「插入 / 删除 / 改状态」的增量逻辑。

    /** 后台任务清单：运行中的在前，新活的在上（只带最新一行日志，整份日志走 `getBackgroundTask`） */
    listBackgroundTasks: () => request<BackgroundTasksResult>(API_ROUTES.backgroundTasks),
    /**
     * 单条任务详情：任务本体 + 保留的日志行（时间升序）。
     *
     * 只在用户**展开某一行**时调：日志不进列表轮询，白传几十 KB没人看。
     */
    getBackgroundTask: (id: string) =>
      request<BackgroundTaskDetail>(API_ROUTES.backgroundTask.replace(":id", id)),
    /**
     * 取消一条正在跑的后台任务（幂等）。
     *
     * 回包时服务端的清理（杀进程树 + 删半成品）**已经做完**，所以返回后可以立刻重试
     * 同一件事。任务已结束 / 不存在也回 200，不会抛错 —— 取消是用户的正常操作。
     *
     * ⚠️ 刻意**不**靠 abort 掉发起请求那条连接来取消：desktop 的 IPC 桥不转发
     * `AbortSignal`，断了也停不住服务端进程，必须走这条显式请求。
     */
    cancelBackgroundTask: (id: string) =>
      request<BackgroundTasksResult>(API_ROUTES.backgroundTaskCancel.replace(":id", id), {
        method: "POST",
      }),
    /**
     * 转到后台：只断开等待那条请求，任务继续跑（`cloneWorkspace` 会立刻回
     * `{ detached: true }`）。幂等。
     */
    detachBackgroundTask: (id: string) =>
      request<BackgroundTasksResult>(API_ROUTES.backgroundTaskDetach.replace(":id", id), {
        method: "POST",
      }),
    /** 关掉一条**已结束**的任务（还在跑的会被服务端拒绝，409） */
    dismissBackgroundTask: (id: string) =>
      request<BackgroundTasksResult>(API_ROUTES.backgroundTask.replace(":id", id), {
        method: "DELETE",
      }),
    /** 清掉全部已结束的任务（运行中的不动） */
    clearBackgroundTasks: () =>
      request<BackgroundTasksResult>(API_ROUTES.backgroundTasks, { method: "DELETE" }),
    /** 重命名工作区（项目）—— 只改展示名，路径与标记不动 */
    renameWorkspace: (id: string, name: string) =>
      request<AgentWorkspace>(`${API_ROUTES.workspaces}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    /**
     * 在某个项目下按分支创建 git worktree，并登记成一个新的（worktree）项目。
     * 返回新建出来的那个工作区（前端据此选中它）。
     */
    createWorktree: (id: string, input: WorktreeInput) =>
      request<AgentWorkspace>(API_ROUTES.workspaceWorktree.replace(":id", id), {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /**
     * 扫描某个项目 `.worktree/` 下**磁盘上既有**的 worktree（「管理工作区」弹窗的数据源）。
     * 已在工作区列表里的那条会带上 `workspaceId`，弹窗据此显示「已加载」。
     */
    scanWorktrees: (id: string) =>
      request<WorktreeScanEntry[]>(
        API_ROUTES.workspaceWorktree.replace(":id", id),
      ),
    /** 把扫描到的既有 worktree 目录登记成一个新项目（不建目录、不建分支） */
    loadWorktree: (id: string, input: WorktreeLoadInput) =>
      request<AgentWorkspace>(
        API_ROUTES.workspaceWorktreeLoad.replace(":id", id),
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    /**
     * 移除工作区（连它的全部会话一起清掉）。
     * `options.deleteWorktree` 勾上时，服务端会连磁盘上的 git worktree 目录一起删
     * （分支保留）；默认只摘记录、不碰磁盘。
     */
    deleteWorkspace: (id: string, options?: WorkspaceDeleteInput) =>
      request<AgentWorkspace[]>(`${API_ROUTES.workspaces}/${id}`, {
        method: "DELETE",
        // 始终发 body（哪怕是空对象）：服务端只按字段语义判断，传不传无所谓，
        // 但省掉一次「有没有 body」的分支
        body: JSON.stringify(options ?? {}),
      }),

    // ---------- 容器型项目（服务端专属能力，见 packages/contracts 的 ContainerProjectConfig） ----------

    /**
     * 容器型项目的整体快照：能力开关 + 公网域名 + 每个项目的运行态。
     *
     * 平时**不必调它** —— state ws 的 `containerProjects` 域一直在推同一份投影
     * （界面用 `useStateValue('containerProjects', …)` 读）。留这个出口只为「手动刷新」。
     */
    containerProjects: () =>
      request<ContainerProjectsSnapshot>(API_ROUTES.containerProjects),
    /**
     * 新建容器型项目（目录由服务端固定生成；用户填名称 / 选镜像 / 可选 clone 地址）。
     *
     * **没有预览端口参数**：端口由服务端按镜像自动分配，用户拿到的是
     * `https://<slug>.<域名>`（见 `ContainerProjectCreateInput`）。
     */
    createContainerProject: (input: ContainerProjectCreateInput) =>
      request<AgentWorkspace>(API_ROUTES.containerProjects, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /**
     * 改容器型项目（改名 / 换镜像 / 公网访问开关 / 内存与 CPU 上限）。
     *
     * ⚠️ 换镜像会**销毁旧容器**（下次启动按新配置重建，预览端口跟着新镜像走）——
     * 服务端负责这件事。
     *
     * ⚠️ `memoryLimitMb` / `cpus` 只落盘、**不动正在跑的容器**（改的是「下次 `docker run`
     * 的形状」）。想立刻生效要接着调 `rebuildContainerProject`；不调则下一次启动时由
     * 运行参数指纹自动重建。
     */
    updateContainerProject: (id: string, input: ContainerProjectUpdateInput) =>
      request<AgentWorkspace>(
        API_ROUTES.containerProjectUpdate.replace(":id", id),
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      ),
    /**
     * 启动容器（异步长操作：确保镜像 → 起容器 → 等容器内 agent 就绪，可能几分钟）。
     *
     * **返回最新快照**（不是「已在启动中」这种回应）：拿到时 `state` 已经是 `running`
     * 或 `error`，界面不必自己轮询。失败原因在快照对应项目的 `error` 里，不抛错。
     * 幂等：并发调用服务端会合并成一次。
     */
    startContainerProject: (id: string) =>
      request<{ snapshot: ContainerProjectsSnapshot }>(
        API_ROUTES.containerProjectStart.replace(":id", id),
        { method: "POST" },
      ),
    /** 停容器（**停而不删**：端口映射与挂载留着，下次启动走 `docker start` 冷启动） */
    stopContainerProject: (id: string) =>
      request<{ snapshot: ContainerProjectsSnapshot }>(
        API_ROUTES.containerProjectStop.replace(":id", id),
        { method: "POST" },
      ),
    /**
     * 强制重建容器（同镜像也重建）：停 → 删 → 起，返回最新快照。
     *
     * 镜像在设置页被重新构建后，**已在跑的容器仍是旧镜像** —— 必须走这一步才生效。
     * 也可以用来把被弄脏的容器重置回干净状态（`/workspace` 里的项目文件不动）。
     */
    rebuildContainerProject: (id: string) =>
      request<{ snapshot: ContainerProjectsSnapshot }>(
        API_ROUTES.containerProjectRebuild.replace(":id", id),
        { method: "POST" },
      ),
    /**
     * 容器镜像状态（设置页「容器」的数据源）。
     *
     * `building: true` 期间轮询它拿构建日志尾部与结果；docker 不可达时
     * `available: false` + 人话原因，不抛错。
     */
    /**
     * 重新探测 docker 引擎（「连不上 docker 引擎」卡片上的重试）。
     *
     * 服务端会清掉探测缓存后**现问一次** daemon，所以把 Docker Desktop 起来后点它立刻见效；
     * 只在前端重拉快照是不够的（那边有 60s 失败缓存 + 30s 成功缓存）。
     * `reason` 为空 = 现在已经可用了。
     */
    retryContainerDocker: () =>
      request<{ reason?: string }>(API_ROUTES.containerProjectDockerRetry, {
        method: "POST",
      }),
    containerImages: () =>
      request<ContainerImagesSnapshot>(API_ROUTES.containerImages),
    /**
     * 强制重建某个镜像（`env` = `node` / `php` / `golang` / `base`）。
     *
     * **立即返回**当前快照（此时 `building: true`）—— 构建要几分钟，不在这里等。
     * 结果靠轮询 `containerImages()` 拿；失败原因在快照对应项的 `error` 里。
     */
    buildContainerImage: (env: string) =>
      request<ContainerImagesSnapshot>(
        API_ROUTES.containerImageBuild.replace(":env", env),
        {
          method: "POST",
        },
      ),
    /**
     * 读工作区目录配置（`<工作区>/.fizz/workspace.json`）。
     * 必须走 `request`（带 Bearer 鉴权 + 统一 401 收场）—— 走裸 fetch 会 401。
     */
    getWorkspaceConfig: (id: string) =>
      request<WorkspaceConfigSnapshot>(
        API_ROUTES.workspaceConfig.replace(":id", id),
      ),
    /** 写工作区目录配置（同上，必须带鉴权头） */
    saveWorkspaceConfig: (id: string, config: WorkspaceConfig) =>
      request<WorkspaceConfigSnapshot>(
        API_ROUTES.workspaceConfig.replace(":id", id),
        {
          method: "PUT",
          body: JSON.stringify(config),
        },
      ),
    /**
     * 列**服务端**目录（只列子目录），给「选一个服务端上的目录当工作区」用。
     * `path` 留空 = 从服务端用户主目录起。
     */
    listServerDirs: (path = "") =>
      request<FsDirsResult>(
        `${API_ROUTES.fsDirs}?path=${encodeURIComponent(path)}`,
      ),
    /**
     * 在**服务端**某个目录下新建文件夹（同上，web 端专用），返回新目录的绝对路径。
     * 名字只收单层目录名，服务端会校验（见 `apps/server/src/routes/fs.ts`）。
     */
    createServerDir: (input: FsMkdirInput) =>
      request<FsMkdirResult>(API_ROUTES.fsMkdir, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    // ---------- 笔记（登记任意目录，管理其中的 Markdown） ----------
    //
    // 分两类：**根目录清单**走 state-ws 的 `notesRoots` 快照域推送（下面的
    // `listNotesRoots` 只在首次绑定失败时兜底用，正常路径是 store 里那份）；
    // **文件读写**是一问一答，没有任何缓存 —— 磁盘上的文件才是真源。
    /** 已登记的笔记根目录 */
    listNotesRoots: () => request<NotesRoot[]>(API_ROUTES.notesRoots),
    /**
     * 登记一个目录当笔记根。
     *
     * 服务端会校验「绝对路径 + 目录存在」，并且**幂等**：同一个目录重复登记返回既有那条，
     * 不会在侧栏里长出两行。
     */
    addNotesRoot: (input: NotesRootInput) =>
      request<NotesRoot>(API_ROUTES.notesRoots, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 移除登记（**只摘登记，不碰磁盘** —— 笔记文件照旧留在原地） */
    removeNotesRoot: (id: string) =>
      request<null>(
        API_ROUTES.notesRoot.replace(":id", encodeURIComponent(id)),
        {
          method: "DELETE",
        },
      ),
    /** 列笔记目录的**某一层**（`dir` 留空 = 根目录）；前端展开子目录时逐层调它 */
    listNoteFiles: (rootId: string, dir = "") =>
      request<NotesDirResult>(
        `${API_ROUTES.notesFiles}?rootId=${encodeURIComponent(rootId)}&dir=${encodeURIComponent(dir)}`,
      ),
    /** 读一篇笔记（只支持 `.md` / `.markdown`） */
    readNoteFile: (rootId: string, path: string) =>
      request<NotesFileResult>(
        `${API_ROUTES.notesFile}?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`,
      ),
    /** 覆盖保存一篇笔记（文件不存在则创建；服务端会补建中间目录） */
    writeNoteFile: (rootId: string, path: string, content: string) => {
      const body: NotesWriteInput = { rootId, path, content };
      return request<null>(API_ROUTES.notesFile, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    /** 在 `dir` 下新建一篇空笔记，返回它的相对路径（调用方拿它直接开标签） */
    createNoteFile: (rootId: string, dir = "") =>
      request<NotesCreateResult>(API_ROUTES.notesFileNew, {
        method: "POST",
        body: JSON.stringify({ rootId, dir }),
      }),
    /** 重命名（只换文件名，不换目录），返回**新的**相对路径（标签登记表要跟着改） */
    renameNoteFile: (rootId: string, path: string, name: string) =>
      request<NotesRenameResult>(API_ROUTES.notesFileRename, {
        method: "POST",
        body: JSON.stringify({ rootId, path, name }),
      }),
    /** 删除一篇笔记（**真删，没有回收站** —— 界面上必须二次确认） */
    deleteNoteFile: (rootId: string, path: string) =>
      request<null>(
        `${API_ROUTES.notesFile}?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`,
        { method: "DELETE" },
      ),

    listConversations: () =>
      request<ConversationSummary[]>(API_ROUTES.conversations),
    /**
     * 搜会话（标题 + 消息正文）。结果只带摘要与命中片段，不带整条消息。
     */
    searchConversations: (keyword: string, limit?: number) =>
      request<ConversationSearchHit[]>(
        `${API_ROUTES.conversationSearch}?q=${encodeURIComponent(keyword)}${
          limit ? `&limit=${limit}` : ""
        }`,
      ),
    /**
     * 用量汇总（按天 + 按会话）。只返回 token，**不含金额** —— 没有单价表，
     * 折算出来的钱会骗人（见 `UsageSummary` 注释）。
     */
    getUsage: (days?: number, limit?: number) =>
      request<UsageSummary>(
        `${API_ROUTES.usage}${days ? `?days=${days}` : ""}${limit ? `${days ? "&" : "?"}limit=${limit}` : ""}`,
      ),

    /**
     * 服务器性能监控快照（当前值 + 近期曲线）。
     *
     * `detail` = 追加磁盘分区占用 / Top 进程 / CPU 温度这些「较重」的采集 —— 侧栏常驻卡片
     * 只走轻量（不传），打开详情弹窗再传 `true`，成本按需付（见 `SystemSnapshot` 注释）。
     */
    getSystemMetrics: (detail?: boolean) =>
      request<SystemMetrics>(
        `${API_ROUTES.system}${detail ? "?detail=1" : ""}`,
      ),
    /**
     * 任务管理器：读服务端那台机器的进程表（含瞬时 CPU / 内存 / 累计 CPU 时间）。
     *
     * ⚠️ 与 `getSystemMetrics` **是两条采集通路**：那个读常驻采样器的快照（零子进程），
     * 这个每次**现采**一次 `ps` / `tasklist`。所以只在任务管理器标签打开时调它 ——
     * 别顺手塞进某个每 2s 的全局轮询里，那会把「按需」变成「常驻」。
     */
    listSystemTasks: () => request<SystemTaskList>(API_ROUTES.systemTasks),
    /**
     * 结束一个进程。
     *
     * **不要用 `try/catch` 兜业务失败**：进程已退出 / 没权限 / 是系统进程这些都回 200 +
     * `ok: false`，原因在 `error` 里（见 `SystemTaskKillResult`）。这里只会在网络 /
     * 鉴权层面抛。
     */
    killSystemTask: (input: SystemTaskKillInput) =>
      request<SystemTaskKillResult>(API_ROUTES.systemTaskKill, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /**
     * 读系统监控偏好（总开关）。关掉后服务端不采样、状态栏也不显示监控条。
     * 设置页「系统监控」小节的状态源，也是 `refresh()` 全量刷新的一项。
     */
    /** 读界面语言（全局一份） */
    getLanguage: () =>
      request<{ language: AppLanguage }>(API_ROUTES.systemLanguage),
    /** 保存界面语言（服务端归一化后返回生效值） */
    saveLanguage: (language: AppLanguage) =>
      request<{ language: AppLanguage }>(API_ROUTES.systemLanguage, {
        method: "POST",
        body: JSON.stringify({ language }),
      }),
    getSystemMonitorSettings: () =>
      request<SystemMonitorSettings>(API_ROUTES.systemSettings),
    /**
     * 保存系统监控偏好。**缺字段 = 保留**（与其它偏好保存接口同款语义）。
     * 服务端落盘后会立刻同步采样器（关 = 停采，开 = 重新起采）。
     */
    saveSystemMonitorSettings: (patch: Partial<SystemMonitorSettings>) =>
      request<SystemMonitorSettings>(API_ROUTES.systemSettings, {
        method: "POST",
        body: JSON.stringify(patch),
      }),
    /**
     * 读容器型项目的**公网访问域名**（设置页「容器」一节）。
     *
     * 返回的是**生效值**不是盘上原值：`domains` 为空 = 公网访问关闭；
     * `enabled` 为 false 表示「配了域名，但公网入口端口没在监听」（`FIZZ_PUBLIC_HTTP_PORT`
     * 没配），此时界面要给提示，而不是一个打不开的地址。
     */
    getContainerPublicSettings: () =>
      request<ContainerPublicSettingsView>(API_ROUTES.containerPublicSettings),
    /**
     * 存公网访问域名（可多个；只发前端拼好的**后半截**，`xxx.` 那截由项目 slug 决定）。
     * 服务端会逐个归一化（去 `*.` / 协议 / 端口 / 路径、去重），**改完立刻生效、不用重启**。
     */
    saveContainerPublicSettings: (patch: { domains?: string[] }) =>
      request<ContainerPublicSettingsView>(API_ROUTES.containerPublicSettings, {
        method: "POST",
        body: JSON.stringify(patch),
      }),
    createConversation: (input: {
      /**
       * 会话归属的项目。**缺省 = 服务端建一个临时工作区**（目录
       * `<数据目录>/conversations/<会话 id>`）并绑上去 —— 就是输入框下方没选项目时
       * 直接发消息的那条路。会话的 workspaceId 落库后不可改，所以这一步必须发生在
       * 创建时，不能事后补绑。
       */
      workspaceId?: string;
      title?: string;
      /** 会话形态（缺省 = 普通对话）；`collab` 只支持内置 Agent 后端 */
      kind?: "chat" | "collab";
      /** 协作配置（仅 `kind: 'collab'`） */
      collab?: CollabSettings;
      backend?: AgentBackend;
      configId?: string;
      modelId?: string;
      /** 内置 Agent 的思考强度（缺省 = 跟随模型） */
      reasoningEffort?: AiReasoningEffort;
      /** 导入 agent 侧既有会话时带上它的 sessionId */
      acpSessionId?: string;
      /** 创建时就定下这个会话允许用哪些 MCP server（缺省 = 全不选） */
      mcpServerIds?: string[];
      /**
       * 创建时就一并落下的浏览器偏好（开关 + 来源）。
       *
       * 「开始新对话」页的这两项选择只活在 `draftSettings` 里，发出第一条消息时随本请求
       * 交出；服务端不落它就是「发完消息浏览器自己关了、MCP 也没了」。
       */
      browserSettings?: BrowserSettings;
      /**
       * 创建时就一并落下的历史消息（整体写入，不做追加）。
       *
       * 目前唯一的调用方是「ACP 会话转内置 Agent」（见 `lib/acp-convert.ts`）：转换产物
       * 直接作为新会话的历史。服务端 `POST /api/conversations` 本来就收这个字段
       * （对 内置后端不做任何特判，直接进 `domain.saveConversation`）。
       */
      messages?: AgentChatMessage[];
    }) =>
      request<ConversationSummary>(API_ROUTES.conversations, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /**
     * 拉 ACP agent 侧的既有会话清单（导入用；cwd 过滤 = 「这个项目下有哪些会话」）。
     * `supported: false` = agent 没广告 sessionCapabilities.list，界面隐藏导入入口。
     */
    listAcpAgentSessions: (id: string, cwd?: string) =>
      request<{
        supported: boolean;
        sessions: Array<{
          sessionId: string;
          cwd: string;
          title?: string;
          updatedAt?: string;
        }>;
      }>(
        `${API_ROUTES.acpAgentSessions.replace(":id", encodeURIComponent(id))}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`,
      ),
    /**
     * 查 acp 会话的权限档位（ACP Session Modes）。`supported: false` = agent 没广告档位
     * 或会话未激活 —— 界面据此隐藏档位切换 pill。
     */
    listAcpAgentModes: (id: string, conversationId: string) =>
      request<{
        supported: boolean;
        modes: Array<{ id: string; name?: string; description?: string }>;
        currentModeId: string | null;
      }>(
        `${API_ROUTES.acpAgentMode.replace(":id", encodeURIComponent(id))}?conversationId=${encodeURIComponent(conversationId)}`,
      ),
    /** 切换 acp 会话的权限档位（session/set_mode，规范的直接调用，无映射） */
    setAcpAgentMode: (id: string, conversationId: string, modeId: string) =>
      request<{ ok: boolean; error?: string }>(
        API_ROUTES.acpAgentMode.replace(":id", encodeURIComponent(id)),
        {
          method: "POST",
          body: JSON.stringify({ conversationId, modeId }),
        },
      ),
    /** 切换 acp 会话的思考档（configOptions 的 thought_level，pi 用它） */
    setAcpAgentThoughtLevel: (
      id: string,
      conversationId: string,
      value: string,
    ) =>
      request<{ ok: boolean; error?: string }>(
        API_ROUTES.acpAgentThoughtLevel.replace(":id", encodeURIComponent(id)),
        {
          method: "POST",
          body: JSON.stringify({ conversationId, value }),
        },
      ),
    /**
     * 删 ACP agent 侧的既有会话（删除会话弹窗勾选「同时删除 agent 侧会话」时调用）。
     * `supported: false` = agent 没广告 sessionCapabilities.delete，删不了 —— 前端提示后照常删本地。
     */
    deleteAcpAgentSession: (id: string, sessionId: string) =>
      request<{ ok: boolean; supported: boolean }>(
        `${API_ROUTES.acpAgentSessions.replace(":id", encodeURIComponent(id))}?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      ),
    /** 打开 acp 会话时的视图恢复：session/load 回放折成结构化消息（历史在 agent 侧，本地不落盘） */
    getAcpTranscript: (
      id: string,
      conversationId: string,
      sessionId: string,
      cwd: string,
    ) =>
      request<{ messages: AgentChatMessage[] }>(
        `${API_ROUTES.acpAgentTranscript.replace(":id", encodeURIComponent(id))}` +
          `?conversationId=${encodeURIComponent(conversationId)}&sessionId=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd)}`,
      ),
    /**
     * 重启 acp 会话：杀掉 agent 进程、**保留 sessionId** —— 下一轮发消息时走 session/load
     * 把原上下文接回来（是「重连」不是「新建」）。用它让 agent 侧的变更生效（新装的权限扩展、
     * 改过的项目信任设置…）。会话未激活时是幂等空操作，照样返回 ok。
     */
    restartAcpAgentSession: (id: string, conversationId: string) =>
      request<{ ok: boolean; error?: string }>(
        API_ROUTES.acpAgentRestart.replace(":id", encodeURIComponent(id)),
        {
          method: "POST",
          body: JSON.stringify({ conversationId }),
        },
      ),
    getConversation: (id: string) =>
      request<AgentConversation>(`${API_ROUTES.conversations}/${id}/messages`),
    /** 读协作会话的运行态快照（任务 / 消息 / 最近状态）；普通会话 400 */
    getCollabState: (id: string) =>
      request<CollabStateResult>(
        API_ROUTES.conversationCollab.replace(":id", encodeURIComponent(id)),
      ),
    /** 全量覆盖协作配置（增删改 Agent / 并行与单轮上限） */
    saveCollabSettings: (id: string, collab: CollabSettings) =>
      request<AgentConversation>(
        API_ROUTES.conversationCollab.replace(":id", encodeURIComponent(id)),
        {
          method: "PATCH",
          body: JSON.stringify({ collab }),
        },
      ),
    /** 取消协作会话里某个正在跑的子任务（找不到在跑的 run / 任务已结束 = ok:false） */
    cancelCollabTask: (conversationId: string, taskId: string) =>
      request<CollabCancelResult>(API_ROUTES.collabCancel, {
        method: "POST",
        body: JSON.stringify({ conversationId, taskId }),
      }),
    deleteConversation: (id: string) =>
      request<ConversationSummary[]>(`${API_ROUTES.conversations}/${id}`, {
        method: "DELETE",
      }),
    /**
     * 清除**这一个会话**的网站数据（Cookie / 登录态 / localStorage / HTTP 缓存）。
     *
     * 内置浏览器一个会话一份持久化 profile，删掉 = 关掉浏览器进程 + 删目录，
     * **会话与历史消息不动**，下次启动要重新登录。
     *
     * 服务端回 204（没有可展示的新状态）；正在看这个会话的面板会收到 `closed`
     * 事件（reason「网站数据已清除」），自己切回「未启动」。
     */
    clearConversationBrowserData: (id: string) =>
      request<void>(
        API_ROUTES.conversationBrowserData.replace(":id", id),
        { method: "DELETE" },
      ),
    /** 重命名会话（web / 桌面端侧边栏改标题） */
    renameConversation: (id: string, title: string) =>
      request<ConversationSummary[]>(
        API_ROUTES.conversationRename.replace(":id", id),
        {
          method: "PATCH",
          body: JSON.stringify({ title }),
        },
      ),
    /**
     * 归档 / 取消归档会话（不删数据，只是从项目树收进「已归档」区）。
     * 应答回整份会话清单，与重命名 / 删除同一个用法。
     */
    archiveConversation: (id: string, archived: boolean) =>
      request<ConversationSummary[]>(
        API_ROUTES.conversationArchive.replace(":id", id),
        {
          method: "PATCH",
          body: JSON.stringify({ archived }),
        },
      ),
    /**
     * 标记会话「已看过」：清掉定时任务触发出来的那颗红点（见 `AgentConversation.unseen`）。
     * 由 `openConversation` 顺手调用，幂等；应答同样是整份会话清单。
     */
    markConversationSeen: (id: string) =>
      request<ConversationSummary[]>(
        API_ROUTES.conversationSeen.replace(":id", id),
        { method: "POST" },
      ),
    /**
     * 设置 / 清除会话记住的模型（每个会话可选不同模型并持久化）。
     * `target` 字段显式传 null = 清除，回到「默认」。
     */
    setConversationTarget: (id: string, target: ConversationTargetInput) =>
      request<null>(API_ROUTES.conversationTarget.replace(":id", id), {
        method: "PATCH",
        body: JSON.stringify(target),
      }),
    /**
     * 读待发送队列（会话进行中排队的消息，本轮结束由泵依次发）。
     * 队列持久化在服务端：刷新 / 换设备都能续上，拖拽排序也跨端一致。
     */
    getConversationQueue: (id: string) =>
      request<{ items: QueuedMessage[] }>(
        API_ROUTES.conversationQueue.replace(":id", id),
      ),
    /** 覆盖待发送队列（**全量覆盖**；数组顺序就是发送顺序） */
    setConversationQueue: (id: string, items: QueuedMessage[]) =>
      request<null>(API_ROUTES.conversationQueue.replace(":id", id), {
        method: "PATCH",
        body: JSON.stringify({ items }),
      }),
    /**
     * 探针：这个外部 Agent（ACP）**自己**能选哪些模型（设置页列候选用）。
     *
     * ACP 没有「列模型」方法，清单来自 agent 在 `session/new` 里广告的 configOptions，
     * 所以这一问会在服务端把它的进程拉起来问一句（一次性会话，问完就收掉）。
     */
    probeAcpModels: (agentId: string) =>
      request<AcpModelChoices>(
        API_ROUTES.acpAgentModels.replace(":id", agentId),
      ),
    /**
     * 探针：这个外部 Agent（ACP）的**完整能力**（模型 + 模式 / 思考档）。
     *
     * 「开始新对话」页选中 ACP agent 时调：那时还没有会话，而模式 / 思考档 pill 的数据
     * 平时只存在会话配置里。同 `/models` 一样是起一次进程问一句、问完收掉。
     */
    probeAcpCapabilities: (agentId: string) =>
      request<AcpProbeResult>(
        API_ROUTES.acpAgentCapabilities.replace(":id", agentId),
      ),
    /** 清空会话（删掉全部消息，保留会话本身） */
    clearConversation: (id: string) =>
      request<ConversationSummary[]>(
        API_ROUTES.conversationClear.replace(":id", id),
        {
          method: "DELETE",
        },
      ),
    /** 删除会话里单条消息 */
    deleteMessage: (id: string, messageId: string) =>
      request<ConversationSummary[]>(
        API_ROUTES.conversationMessage
          .replace(":id", id)
          .replace(":messageId", messageId),
        { method: "DELETE" },
      ),
    /**
     * 删除这条消息**及其后的全部消息**（编辑重发 / 「从这里重新开始」）。
     *
     * 一个请求删完 —— 别在客户端里循环 `deleteMessage`（那样 N 条消息就是 N 次往返，
     * 长历史下几秒钟没反应，见服务端路由的注释）。
     */
    deleteMessagesFrom: (id: string, messageId: string) =>
      request<ConversationSummary[]>(
        `${API_ROUTES.conversationMessage.replace(":id", id).replace(":messageId", messageId)}?from=1`,
        { method: "DELETE" },
      ),

    // ---------- 工作区文件树 / 媒体（桌面 Agent 文件面板在 web 上的对等能力） ----------
    /**
     * 列工作区某目录。`includeIgnored` = 连命中忽略规则（默认黑名单 + 工作区
     * `.gitignore`）的条目也一起列 —— 文件树的「显示被忽略」开关用它；那些条目会带
     * `ignored: true`，由界面压暗。
     */
    listWorkspaceFiles: (id: string, dir = "", includeIgnored = false) =>
      request<FsListResult>(
        `${API_ROUTES.workspaceFiles.replace(":id", id)}?dir=${encodeURIComponent(dir)}${
          includeIgnored ? "&ignored=1" : ""
        }`,
      ),
    readWorkspaceFile: (id: string, path: string) =>
      request<AgentFsFile>(
        `${API_ROUTES.workspaceFileRead.replace(":id", id)}?path=${encodeURIComponent(path)}`,
      ),
    /**
     * 上传文件到工作区目录（web 文件面板用）。
     *
     * 与 `writeWorkspaceFile`（UTF-8 文本）**分开**：这里读成 base64 走 JSON，服务端解码成
     * 字节原样落盘 —— 图片 / 压缩包塞进文本那条路会被编码破坏。
     *
     * `overwrite: false`（缺省）时目标已存在会抛 **409**（`ApiError.status === 409`），
     * 调用方据此问过用户再带 `overwrite: true` 重传。
     */
    uploadWorkspaceFile: async (
      id: string,
      path: string,
      file: File,
      overwrite = false,
    ): Promise<void> => {
      const input: FsUploadInput = {
        path,
        dataBase64: await fileToBase64(file),
        ...(overwrite ? { overwrite: true } : {}),
      };
      await request<null>(API_ROUTES.workspaceFileUpload.replace(":id", id), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    writeWorkspaceFile: (id: string, path: string, content: string) =>
      request<null>(API_ROUTES.workspaceFileRead.replace(":id", id), {
        method: "POST",
        body: JSON.stringify({ path, content }),
      }),
    /**
     * 脚手架：给工作区新建一份模板文件（技能 SKILL.md / AGENTS.md 空骨架）。
     * 斜线命令 `/create-skill` 已移除，目前没有界面入口；`/init` 也不走这条 ——
     * 那份文档由模型读项目后自己写，服务端只给空模板的话用户拿到的是空骨架。
     *
     * 与 `writeWorkspaceFile` 的分工：那条路**不 mkdir**、也不管覆盖，是「按已知路径
     * 写已知内容」；这条由服务端出正文、会建中间目录，且**已存在一律 409**
     * （`ApiError.status === 409`）。要覆盖就开编辑器改，别指望它。
     */
    scaffoldWorkspaceFile: (id: string, input: FsScaffoldInput) =>
      request<FsScaffoldResult>(
        API_ROUTES.workspaceScaffold.replace(":id", id),
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    /**
     * 删除工作区里的文件或目录（递归删）。
     * DELETE /api/workspaces/:id/files/delete?path=相对路径
     */
    deleteWorkspaceFile: (id: string, path: string) =>
      request<null>(
        `${API_ROUTES.workspaceFileDelete.replace(":id", id)}?path=${encodeURIComponent(path)}`,
        { method: "DELETE" },
      ),
    /**
     * 复制工作区里的文件或目录到指定父目录。
     * POST /api/workspaces/:id/files/copy  body: { path, dest }
     * 返回新条目的相对路径；目标已存在同名时服务端返回 409。
     */
    copyWorkspaceFile: (id: string, path: string, dest: string) =>
      request<{ path: string }>(
        API_ROUTES.workspaceFileCopy.replace(":id", id),
        {
          method: "POST",
          body: JSON.stringify({ path, dest }),
        },
      ),
    /**
     * 移动 / 重命名工作区里的文件或目录到指定父目录。
     * POST /api/workspaces/:id/files/move  body: { path, dest, name? }
     * 返回新条目的相对路径；目标已存在同名时服务端返回 409。
     * 传 `name` = 重命名（只换最后一段，父目录仍是 `dest`）。
     */
    moveWorkspaceFile: (
      id: string,
      path: string,
      dest: string,
      name?: string,
    ) =>
      request<{ path: string }>(
        API_ROUTES.workspaceFileMove.replace(":id", id),
        {
          method: "POST",
          body: JSON.stringify(
            name === undefined ? { path, dest } : { path, dest, name },
          ),
        },
      ),
    /**
     * 在工作区某个目录下新建文件夹，返回新目录的**相对路径**。
     * POST /api/workspaces/:id/files/mkdir  body: { parent, name }
     *
     * 与 `createServerDir` 的区别：那条收的是**宿主机绝对路径**（给「选工作区目录」
     * 弹窗用，只认本机）；这条收工作区相对路径，远端工作区也能建。
     */
    createWorkspaceDir: (id: string, input: FsWorkspaceMkdirInput) =>
      request<{ path: string }>(
        API_ROUTES.workspaceFileMkdir.replace(":id", id),
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    /**
     * 以带鉴权的方式把工作区媒体文件拉成 object URL（`<img>`/`<video>` 不能带
     * Authorization 头，所以不直接拼 src，而是 fetch→blob→createObjectURL）。
     */
    async fetchWorkspaceMedia(id: string, path: string): Promise<string> {
      const res = await fetchImpl(
        endpoint(
          `${API_ROUTES.workspaceMedia.replace(":id", id)}?path=${encodeURIComponent(path)}`,
        ),
        { headers: authHeaders() },
      );
      if (!res.ok) {
        if (res.status === 401) fireUnauthorized();
        throw await toError(res);
      }
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    },
    /**
     * 把工作区里的文件**下载到本机**（浏览器另存为）。
     *
     * 单文件复用 `/media` 路由（它本来就整块吐出文件体）；`isDir` 时改走
     * `/files?zip=`，由服务端把文件夹打包成 zip —— 浏览器只能下单个文件，目录必须先打包。
     * 桌面与 web 是同一个地址，差别只在 `fetchImpl` 走 IPC 桥还是真网络。
     * 整块进内存大文件（见 `lib/download-file.ts` 的说明）。
     */
    async downloadWorkspaceFile(
      id: string,
      path: string,
      fileName: string,
      isDir = false,
    ): Promise<string | null> {
      try {
        const url = isDir
          ? `${API_ROUTES.workspaceFiles.replace(":id", id)}?zip=${encodeURIComponent(path)}`
          : `${API_ROUTES.workspaceMedia.replace(":id", id)}?path=${encodeURIComponent(path)}`;
        await downloadFile(endpoint(url), fileName, {
          fetchImpl,
          headers: authHeaders(),
        });
        return null;
      } catch (err) {
        // 401 与其它请求同一条收场（登出 / 回连接页）；下载按钮本身照常可再点
        if (err instanceof DownloadError && err.status === 401)
          fireUnauthorized();
        return err instanceof Error ? err.message : String(err);
      }
    },

    // ---------- 源代码管理（git，见 apps/server/src/routes/git.ts） ----------
    /** 仓库状态：分支 / ahead-behind / 暂存·未暂存·未跟踪（不是仓库时 `isRepo: false`） */
    gitStatus: (id: string) =>
      request<GitStatusResult>(
        API_ROUTES.workspaceGitStatus.replace(":id", id),
      ),
    /** 单文件 diff 的**原始 unified 文本**（未跟踪的新文件由服务端补「空 → 全文」） */
    gitDiff: (id: string, path: string, staged: boolean) =>
      request<GitDiffResult>(
        `${API_ROUTES.workspaceGitDiff.replace(":id", id)}?path=${encodeURIComponent(path)}&staged=${staged ? "1" : "0"}`,
      ),
    /**
     * 分支清单。`prune = true` 时服务端顺带 `git fetch --prune --all`：
     * 只在用户手动点刷新时开（远端 fetch 要走网络，面板自己刷新时带上会拖慢每一次操作）。
     */
    gitBranches: (id: string, prune = false) =>
      request<GitBranchesResult>(
        `${API_ROUTES.workspaceGitBranches.replace(":id", id)}${prune ? "?prune=1" : ""}`,
      ),
    gitLog: (id: string, limit = 30, skip = 0) =>
      request<GitLogResult>(
        `${API_ROUTES.workspaceGitLog.replace(":id", id)}?limit=${limit}${skip > 0 ? `&skip=${skip}` : ""}`,
      ),
    /** 一次提交的元信息 + 文件清单 + unified 文本（历史面板点开某次提交时取） */
    gitCommit: (id: string, hash: string) =>
      request<GitCommitDiffResult>(
        `${API_ROUTES.workspaceGitCommit.replace(":id", id)}?hash=${encodeURIComponent(hash)}`,
      ),
    /** 写操作：暂存 / 取消暂存 / 提交 / 检出 / 推送（失败抛 `ApiError`，消息就是 git 的原话） */
    gitAction: (id: string, input: GitActionInput) =>
      request<GitActionResult>(
        API_ROUTES.workspaceGitAction.replace(":id", id),
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),

    // ---------- ACP agent（外部 agent 进程，后端为 acp 的会话用） ----------
    listAcpAgents: () => request<AcpAgentView[]>(API_ROUTES.acpAgents),
    /** 当前常驻的 ACP 进程（诊断页 / 设置页的「运行中」列表） */
    listAcpProcesses: () =>
      request<{ sessions: AcpProcessInfo[] }>(API_ROUTES.acpProcesses),
    /** 结束某个常驻 ACP 进程（幂等；下一轮会 session/load 重建） */
    killAcpProcess: (agentId: string, conversationId: string) =>
      request<{ ok: true }>(API_ROUTES.acpProcesses, {
        method: "DELETE",
        body: JSON.stringify({ agentId, conversationId }),
      }),
    saveAcpAgent: (input: AcpAgentInput) =>
      request<AcpAgentView>(API_ROUTES.acpAgents, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    deleteAcpAgent: (id: string) =>
      request<AcpAgentView[]>(`${API_ROUTES.acpAgents}/${id}`, {
        method: "DELETE",
      }),
    /** 扫服务端 PATH 上已装的 ACP agent（只读探测） */
    detectAcpAgents: () => request<DetectedAcpAgent[]>(API_ROUTES.acpDetect),

    // ---------- MCP server（配置在服务端，Agent 在服务端连这些 server：stdio / http / sse） ----------
    listMcpServers: () => request<McpServerConfig[]>(API_ROUTES.mcpServers),
    saveMcpServer: (input: McpServerInput) =>
      request<McpServerConfig[]>(API_ROUTES.mcpServers, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    deleteMcpServer: (id: string) =>
      request<McpServerConfig[]>(`${API_ROUTES.mcpServers}/${id}`, {
        method: "DELETE",
      }),
    /** 构建工具集并返回工具信息 / 连接错误（MCP 设置页预览；只读，不建会话） */
    listMcpTools: () =>
      request<{ infos: McpToolInfo[]; errors: string[] }>(API_ROUTES.mcpTools),
    /** 列**某一个** MCP server 自己的工具（服务端连上、列完、把进程收掉） */
    probeMcpServerTools: (id: string) =>
      request<McpServerToolsResult>(
        API_ROUTES.mcpServerTools.replace(":id", id),
      ),

    // ---------- 主机清单（SSH 主机 + 本机终端；凭据加密存服务端，终端连接由服务端发起） ----------
    /** 列全部主机条目（SSH 脱敏：只有 `has*` 标记，不含明文凭据；本机终端无凭据） */
    listSshHosts: () => request<HostConfig[]>(API_ROUTES.sshHosts),
    /** 当前 SSH 主机的快照和近期趋势；轮询顺带续租采集器，不依赖终端会话。 */
    getSshHostMetrics: (id: string, intervalMs?: number) =>
      request<HostMetrics>(
        `${API_ROUTES.sshHostMetrics.replace(":id", encodeURIComponent(id))}${
          intervalMs === undefined
            ? ""
            : `?interval=${encodeURIComponent(intervalMs)}`
        }`,
      ),
    /** 新建 / 更新一条主机条目（带 id 更新；按 kind 区分 SSH / 本机终端）→ 最新列表 */
    saveSshHost: (input: HostInput) =>
      request<HostConfig[]>(API_ROUTES.sshHosts, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 删除一条主机条目 → 最新列表 */
    deleteSshHost: (id: string) =>
      request<HostConfig[]>(`${API_ROUTES.sshHosts}/${id}`, {
        method: "DELETE",
      }),

    // ---------- 主机分组（主机 / 终端共用的多级归类树） ----------
    /** 全部分组（多级，按显示顺序的 DFS 前序） */
    listHostGroups: () => request<HostGroup[]>(API_ROUTES.hostGroups),
    /** 新建 / 更新一个分组（带 id 更新，可改 parentId 换层级）→ 最新分组树 */
    saveHostGroup: (input: HostGroupInput) =>
      request<HostGroup[]>(API_ROUTES.hostGroups, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /**
     * 删除一个分组（含多级子树）→ `{ groups, hosts }`。
     * 默认只删分组、组内主机上移一级；`deleteHosts` 勾上就连主机一起删。
     */
    deleteHostGroup: (id: string, deleteHosts = false) =>
      request<HostGroupsAndHosts>(
        `${API_ROUTES.hostGroups}/${encodeURIComponent(id)}${
          deleteHosts ? "?deleteHosts=1" : ""
        }`,
        { method: "DELETE" },
      ),
    /** 拖拽重排 / 移动到分组（分组层级 + 主机归属一次提交）→ `{ groups, hosts }` */
    arrangeHosts: (input: HostArrangeInput) =>
      request<HostGroupsAndHosts>(API_ROUTES.hostArrange, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    // ---------- SSH 隧道（本地转发 -L / 远程转发 -R / SOCKS5 动态代理 -D） ----------
    //
    // ⚠️ 监听端口绑在**跑 server 的那台机器**上（桌面端 = 你本机，VPS 部署 = VPS 自己），
    // 这是 `ssh -L/-R/-D` 的标准语义。界面文案一律写「服务端所在机器的端口」。
    //
    // 这些方法只在「改」时调一次：改完返回最新快照，之后靠 state-ws 的 `sshTunnels`
    // 快照域推送同步（连接数这种高频变化也走推送，不轮询）。
    /** 隧道配置 + 运行态（同一份快照形状，与 WS 推送一致） */
    listSshTunnels: () => request<SshTunnelsSnapshot>(API_ROUTES.sshTunnels),
    /** 新建 / 更新一条隧道（带 id 更新）→ 最新快照 */
    saveSshTunnel: (input: SshTunnelInput) =>
      request<SshTunnelsSnapshot>(API_ROUTES.sshTunnels, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 删除一条隧道（服务端会先停掉它）→ 最新快照 */
    deleteSshTunnel: (id: string) =>
      request<SshTunnelsSnapshot>(
        `${API_ROUTES.sshTunnels}/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
      ),
    /** 启动一条隧道（要建 SSH 连接，可能经跳板链）→ 返回时状态已定 */
    startSshTunnel: (id: string) =>
      request<SshTunnelsSnapshot>(
        `${API_ROUTES.sshTunnels}/${encodeURIComponent(id)}/start`,
        { method: "POST" },
      ),
    /** 停止一条隧道（幂等）→ 最新快照 */
    stopSshTunnel: (id: string) =>
      request<SshTunnelsSnapshot>(
        `${API_ROUTES.sshTunnels}/${encodeURIComponent(id)}/stop`,
        { method: "POST" },
      ),

    // ---------- 接口请求（api-client，Postman 式的 HTTP / WS 调试） ----------
    //
    // 请求由**服务端**发出（绕开渲染端 CORS）；集合 / 分组 / 历史落服务端数据目录，
    // 经 state-ws 全量快照推给渲染端（这里的方法只在「改」时调一次，随后靠推送同步）。
    /** 保存的接口请求集合 */
    listApiRequests: () => request<ApiRequestEntry[]>(API_ROUTES.apiRequests),
    /** 新建 / 更新一条请求（带 id 更新）→ 最新列表 */
    saveApiRequest: (input: ApiRequestEntry) =>
      request<ApiRequestEntry[]>(API_ROUTES.apiRequests, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 删除一条请求 → 最新列表 */
    deleteApiRequest: (id: string) =>
      request<ApiRequestEntry[]>(
        API_ROUTES.apiRequest.replace(":id", encodeURIComponent(id)),
        {
          method: "DELETE",
        },
      ),
    /** 拖拽重排（分组树 + 请求归属）→ `{ groups, requests }` */
    arrangeApi: (input: ApiArrangeInput) =>
      request<ApiGroupsAndRequests>(API_ROUTES.apiArrange, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 请求分组列表 */
    listApiGroups: () => request<ApiGroup[]>(API_ROUTES.apiGroups),
    /** 新建 / 更新一个分组（带 id 更新）→ 最新列表 */
    saveApiGroup: (input: ApiGroupInput) =>
      request<ApiGroup[]>(API_ROUTES.apiGroups, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 删除一个分组（含多级子树）；`deleteRequests` = 连同子树内请求一起删 */
    deleteApiGroup: (id: string, deleteRequests = false) =>
      request<ApiGroupsAndRequests>(
        `${API_ROUTES.apiGroup.replace(":id", encodeURIComponent(id))}${
          deleteRequests ? "?deleteRequests=1" : ""
        }`,
        { method: "DELETE" },
      ),
    /** 请求历史（最新在前） */
    listApiHistory: () => request<ApiHistoryEntry[]>(API_ROUTES.apiHistory),
    /** 覆盖写入整段历史（渲染端裁剪后的窗口）→ 最新列表 */
    saveApiHistory: (entries: ApiHistoryEntry[]) =>
      request<ApiHistoryEntry[]>(API_ROUTES.apiHistory, {
        method: "POST",
        body: JSON.stringify(entries),
      }),
    /** 清空历史 → `[]` */
    clearApiHistory: () =>
      request<ApiHistoryEntry[]>(API_ROUTES.apiHistory, { method: "DELETE" }),
    /** 执行一次 HTTP 请求（服务端发出）；`sendId` 供 `abortApiRequest` 取消 */
    sendApiRequest: (input: ApiSendInput) =>
      request<ApiHttpResponse>(API_ROUTES.apiSend, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 取消进行中的请求（中断后 `sendApiRequest` 照常回 `status:0 + error`） */
    abortApiRequest: (sendId: string) =>
      request<{ ok: boolean }>(API_ROUTES.apiSendAbort, {
        method: "POST",
        body: JSON.stringify({ sendId }),
      }),

    // ---------- 主机脚本（scripts，可在主机上一键执行的命令文本） ----------
    //
    // 与接口请求同款管道：集合 / 分组落服务端数据目录，经 state-ws 全量快照推给渲染端
    // （这里的方法只在「改」时调一次，随后靠推送同步）。
    /** 保存的主机脚本集合 */
    listScripts: () => request<ScriptEntry[]>(API_ROUTES.scripts),
    /** 新建 / 更新一条脚本（带 id 更新）→ 最新列表 */
    saveScript: (input: ScriptInput) =>
      request<ScriptEntry[]>(API_ROUTES.scripts, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 删除一条脚本 → 最新列表 */
    deleteScript: (id: string) =>
      request<ScriptEntry[]>(
        API_ROUTES.script.replace(":id", encodeURIComponent(id)),
        {
          method: "DELETE",
        },
      ),
    /** 拖拽重排（分组顺序 + 脚本归属）→ `{ groups, scripts }` */
    arrangeScripts: (input: ScriptArrangeInput) =>
      request<ScriptsAndGroups>(API_ROUTES.scriptArrange, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 脚本分组列表 */
    listScriptGroups: () => request<ScriptGroup[]>(API_ROUTES.scriptGroups),
    /** 新建 / 更新一个脚本分组（带 id 更新）→ 最新列表 */
    saveScriptGroup: (input: ScriptGroupInput) =>
      request<ScriptGroup[]>(API_ROUTES.scriptGroups, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 删除一个脚本分组；`deleteScripts` = 连同组内脚本一起删 */
    deleteScriptGroup: (id: string, deleteScripts = false) =>
      request<ScriptsAndGroups>(
        `${API_ROUTES.scriptGroup.replace(":id", encodeURIComponent(id))}${
          deleteScripts ? "?deleteScripts=1" : ""
        }`,
        { method: "DELETE" },
      ),

    // ---------- 数据导入 / 导出（左下角菜单）----------
    //
    // 三类数据（接口请求 / 主机 / 脚本）打包带走或导回。内容走 **base64 JSON**
    // （desktop 的 IPC 桥 body 只支持字符串），所以这里不做二进制流。
    //
    // 导入分两步：`inspectTransfer` 先拿摘要（不写库）让用户勾选，`applyTransfer` 才真正写。
    /** 导出：`{ kinds, format }` → 文件内容（base64）+ 建议文件名 */
    exportTransfer: (input: {
      kinds: TransferKind[];
      format: TransferFormat;
    }) =>
      request<TransferExportResult>(API_ROUTES.transferExport, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 解析导入包看摘要（**不写库**）：`{ dataBase64, fileName? }` → `{ format, entries }` */
    inspectTransfer: (input: { dataBase64: string; fileName?: string }) =>
      request<TransferInspectResult>(API_ROUTES.transferInspect, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /** 真正写库：`{ dataBase64, fileName?, kinds }` → 按类型分列的「新增 / 覆盖 / 跳过」条数 */
    applyTransfer: (input: {
      dataBase64: string;
      fileName?: string;
      kinds: TransferKind[];
    }) =>
      request<TransferImportResult>(API_ROUTES.transferApply, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    // ---------- 技能 ----------
    listSkills: () => request<SkillListResult>(API_ROUTES.skills),
    /**
     * 全量保存技能偏好：启停 + **额外发现目录**。
     * ⚠️ 两个字段都是**完整清单**（服务端的 `saveSkillSettings` 按全量语义写），
     * 所以调用方必须把当前另一项一起带上，不能只传一个（见 slice 的 toggleSkill / setSkillDirs）。
     */
    saveSkills: (disabled: string[], extraDirs: string[]) =>
      request<SkillListResult>(API_ROUTES.skills, {
        method: "POST",
        body: JSON.stringify({ disabled, extraDirs }),
      }),

    // ---------- 子任务（subagent） ----------
    /** 读子任务偏好（默认全关） */
    listSubagents: () => request<SubagentsResponse>(API_ROUTES.subagents),
    /**
     * 保存子任务偏好。`enabled` 是全量清单（传 `[]` = 全关）；模型两项缺省 =
     * **保留原值**（`null` 才是清空），所以启停开关不会顺手把模型设置抹掉。
     *
     * `maxSteps` 也是整体替换（传 `{}` = 全部回默认），缺省 = 保留。
     */
    saveSubagents: (patch: {
      enabled?: SubagentId[];
      /** 自定义子智能体：**整份替换**（增删改都由调用方算好新数组） */
      definitions?: SubagentDefinition[];
      modelConfigId?: string | null;
      modelId?: string | null;
      maxSteps?: Partial<Record<SubagentId, number>>;
    }) =>
      request<SubagentsResponse>(API_ROUTES.subagents, {
        method: "POST",
        body: JSON.stringify(patch),
      }),

    // ---------- 浏览器（本机运行时） ----------
    /**
     * 自带浏览器的安装状态（装在哪、占多少、是否正在装）+ 最近一次安装任务。
     *
     * `runtime.installed` 是「装没装」的唯一判据（`refresh()` 也读它来填
     * `browserInstalled`，决定工具条那颗开关显不显示）。
     */
    getBrowserRuntime: () =>
      request<BrowserRuntimeResult>(API_ROUTES.browserRuntime),

    /**
     * 开始安装自带浏览器（幂等，**立刻返回**）。
     *
     * 下载约 150MB，挂在后台任务上跑：返回的 `task` 立刻是 `running`，
     * 之后轮询 `getBrowserRuntime` 或直接看状态栏那张任务列表。
     */
    installBrowserRuntime: () =>
      request<BrowserRuntimeResult>(API_ROUTES.browserRuntimeInstall, {
        method: "POST",
      }),

    /** 卸载自带浏览器（先关掉所有浏览器会话，再删目录） */
    uninstallBrowserRuntime: () =>
      request<BrowserRuntimeResult>(API_ROUTES.browserRuntime, {
        method: "DELETE",
      }),

    /**
     * 网站数据占用：几个会话的 profile、共占多少字节。
     *
     * 注意这是**按磁盘目录统计**的，可能大于会话数（历史残留）。会遍历几十个
     * Chromium profile，**只在设置页打开 / 清完之后调**，不要塞进任何轮询。
     */
    getBrowserData: () => request<BrowserProfileUsage>(API_ROUTES.browserData),

    /**
     * 清除**所有会话**的网站数据（先关掉所有浏览器会话再删目录），回清完之后的占用。
     *
     * 日常场景不要用它 —— 用户想清的是「我这个会话登错号了」，
     * 那边是 `clearConversationBrowserData`。这条只在设置页当兜底。
     */
    clearAllBrowserData: () =>
      request<BrowserProfileUsage>(API_ROUTES.browserData, {
        method: "DELETE",
      }),

    // ---------- 插件（磁盘上的 .ts / .js，服务端发现；不加载模块） ----------
    //
    // 两个面刻意分开（服务端 `?scope=global` 与 `?workspaceId=` 是同一份路由）：
    // 「插件」在设置页管，「项目插件」在侧栏项目「更多」→「插件」里管，互不牵动。
    /** 读**某个项目**的插件清单（只含该项目自己的插件）+ 该项目启停偏好 */
    listPlugins: (workspaceId: string) =>
      request<PluginsResponse>(
        `/api/plugins?workspaceId=${encodeURIComponent(workspaceId)}`,
      ),
    /**
     * 全量保存**某个项目**的启停（`disabled` 是完整清单；传 `[]` = 该项目全启用）。
     * 只影响该项目自己的插件 —— 用户级插件的开关是全局的，不在这里。
     */
    savePlugins: (workspaceId: string, disabled: string[]) =>
      request<PluginsResponse>("/api/plugins", {
        method: "POST",
        body: JSON.stringify({ workspaceId, disabled }),
      }),
    /**
     * 保存一个插件的**设置项**（增量：只写传上来的键；`null` = 清空）。
     *
     * 密钥项留空 = 不改（明文不在浏览器手里，没法回传）；要清空显式传 `null`。
     * 项目级插件的设置项也要带 `workspaceId` 才找得到（它按项目扫）。
     */
    savePluginConfig: (
      pluginId: string,
      values: Record<string, string | number | boolean | null>,
      workspaceId?: string,
    ) =>
      request<{ ok: boolean }>("/api/plugins/config", {
        method: "POST",
        body: JSON.stringify({
          id: pluginId,
          values,
          ...(workspaceId ? { workspaceId } : {}),
        }),
      }),
    /** 读**全局（用户级）**插件清单（`~/.fizz/plugins`）+ 全局启停偏好 — 设置 →「插件」用 */
    listGlobalPlugins: () =>
      request<PluginsResponse>("/api/plugins?scope=global"),
    /** 全量保存**全局（用户级）**插件的启停（`disabled` 是完整清单；传 `[]` = 全启用） */
    saveGlobalPlugins: (disabled: string[]) =>
      request<PluginsResponse>("/api/plugins", {
        method: "POST",
        body: JSON.stringify({ scope: "global", disabled }),
      }),
    /**
     * **安装**一个插件目录：把目录内所有文件（相对路径 + base64）发给服务端，
     * 由它写进**对应作用域的插件目录** —— 安装目录名取 `plugin.json` 的 `id`，
     * 客户端不能传绝对路径。协议只能是 JSON + base64（desktop 的 IPC 桥 body 只支持
     * 字符串，multipart 过不去，见 `api/uploads` 的说明）。
     *
     * 服务端装完会**立刻体检**（manifest 校验 + apply 一遍），坏插件会被撤回并报错（400）。
     * 返回的是**重扫后的完整清单** —— 前端直接覆盖，不必再拉一次（这就是热重载）。
     */
    installPlugin: (input: {
      scope: "global" | "workspace";
      workspaceId?: string;
      /** 目录内文件清单；`path` 是相对路径（不含最外层目录名） */
      files: Array<{ path: string; content: string }>;
    }) =>
      request<PluginsResponse>("/api/plugins/install", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    /**
     * **卸载**一个插件：服务端从磁盘删掉它的文件，并清掉设置值 / 启停名单里的残留。
     *
     * **内置插件会被拒绝（400）** —— 它随产品分发，不能卸载，只能停用。
     * 同样返回重扫后的完整清单。
     */
    uninstallPlugin: (input: {
      scope: "global" | "workspace";
      workspaceId?: string;
      /** 插件 id（= 目录里 plugin.json 的 id） */
      pluginId: string;
    }) =>
      request<PluginsResponse>("/api/plugins/uninstall", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    // ---------- 插件界面（标签页）----------
    //
    // 内容**不在前端算**：插件的 `render()` 在服务端跑，这里拿到的只是一串「块」
    // （`PluginBlock`）。插件因此不需要写 React，也不会往界面注入代码。
    /**
     * 当前可见插件注册的所有界面。
     *
     * 正常情况下全是 `view`（标签页）——「插件」侧栏的列表与 `PanelView` 的标签都吃它。
     * 老插件仍可能返回 `activityBar` / `sider`（界面上已没有它们的位置，`sider` 会被
     * 当成标签页打开）。
     */
    listPluginSurfaces: (workspaceId?: string) =>
      request<PluginSurfacesResult>(
        `/api/plugins/surfaces${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
      ),
    /**
     * 渲染一面：调插件的 `render()`，拿回一串块（渲染失败不回 5xx，结果里带 `error`）。
     *
     * `params` 是**这一面被打开时带的参数**（如「哪个连接」）—— 同一个面用不同参数
     * 可以开出多个标签页，服务端会把它原样带给插件的 `render` / `onAction`。
     */
    renderPluginSurface: (
      pluginId: string,
      kind: "activityBar" | "sider" | "view",
      id: string,
      workspaceId?: string,
      params?: Record<string, string | number | boolean>,
    ) => {
      const query = new URLSearchParams({ pluginId, kind, id });
      if (workspaceId) query.set("workspaceId", workspaceId);
      // JSON 塞进 query：参数是插件自定义的扁平键值，不需要更复杂的形态
      if (params) query.set("params", JSON.stringify(params));
      return request<PluginSurfaceContent>(
        `/api/plugins/surfaces?${query.toString()}`,
      );
    },
    /** 面里某个可点的项被点了（按钮 / 列表项 / 输入框 / 表单）→ 调插件的 `onAction` */
    runPluginSurfaceAction: (input: {
      pluginId: string;
      kind: "activityBar" | "sider" | "view";
      id: string;
      actionId: string;
      args?: Record<string, string | number | boolean>;
      /** 这一面是哪个参数开的；插件据此区分「哪个实例」 */
      params?: Record<string, string | number | boolean>;
      workspaceId?: string;
    }) =>
      request<PluginSurfaceActionResult>("/api/plugins/surfaces/action", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    /**
     * 插件前端半的 bundle 源码（`renderMode: "client"` 的面用它）。
     *
     * 为什么返回**文本**而不是给一个 `<script src>`：desktop 的渲染进程没有 HTTP 端口
     * （走 IPC 桥，`<script>` 根本发不出去），而且 `<script>` 带不了 `authorization` 头。
     * 三端共用这一条 JSON 通道，前端拿到源码后用 `new Function` 执行并只喂给模块表。
     */
    /*
     * `workspaceId` 不能省：**项目级插件**只在那一个项目的插件根里，不带它会 404
     * （表现是「这个插件的前端面在别的项目里好好的，在这个项目里打不开」）。
     */
    loadPluginClient: (pluginId: string, workspaceId?: string) =>
      request<{ code: string; rev: string }>(
        `/api/plugins/client?pluginId=${encodeURIComponent(pluginId)}${
          workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ''
        }`,
      ),

    /**
     * 调插件注册的 RPC 方法（插件端是 `ctx.rpc.handle(name, fn)`）。
     *
     * 插件前端半**唯一的**后端入口：它不能在宿主进程里注册路由（desktop 没有端口），
     * 也不想让它直接摸到 `/api/*` 的其它能力。体积上限 256KB，超时 60s。
     */
    pluginRpc: (input: {
      pluginId: string;
      method: string;
      payload?: unknown;
      workspaceId?: string;
    }) =>
      request<PluginRpcResponse>("/api/plugins/rpc", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    /**
     * 同步一个插件根的 npm 依赖（`plugin.json` 的 `dependencies`）。
     *
     * 走「安装插件」装的会自动装，这个接口只服务**手工拷进去**的插件：点了设置页那颗
     * 「安装依赖」才跑。`changed: false` = 这个根里没有任何插件声明依赖，什么都没做。
     * 失败时服务端会把 pnpm 的原话放在 400 的 `error` 里（pnpm 没装 / 版本冲突 / 网络不通）。
     */
    syncPluginDeps: (input: { scope: "global" | "workspace"; workspaceId?: string }) =>
      request<{
        ok: boolean;
        changed: boolean;
        root: string;
        warnings: string[];
        output: string;
      }>("/api/plugins/deps", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    /**
     * 这台机器（web = 服务端，desktop = 本机）上有哪些 shell —— 终端面板的
     * 「选择终端」下拉用。只读探测，不发任何进程。
     */
    listTerminalShells: () =>
      request<ShellDetectResult>(API_ROUTES.terminalShells),

    // ---------- 终端命令历史（按项目，落 <项目>/.fizz/terminal-history.json） ----------
    /** 全部历史（最新在前）：预测与终端面板的历史管理共用 */
    listTerminalHistory: (id: string) =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalHistory.replace(":id", encodeURIComponent(id)),
      ),
    /** 记录一条（终端回车时上报；服务端去重置顶）。返回最新全量，调用方可直接换掉本地镜像 */
    addTerminalHistory: (id: string, cmd: string) =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalHistory.replace(":id", encodeURIComponent(id)),
        { method: "POST", body: JSON.stringify({ cmd }) },
      ),
    /** 删除单条（按命令文本定位） */
    deleteTerminalHistory: (id: string, cmd: string) =>
      request<{ entries: CommandHistoryEntry[] }>(
        `${API_ROUTES.terminalHistory.replace(":id", encodeURIComponent(id))}?cmd=${encodeURIComponent(cmd)}`,
        { method: "DELETE" },
      ),
    /** 清空该项目的全部历史 */
    clearTerminalHistory: (id: string) =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalHistory.replace(":id", encodeURIComponent(id)),
        { method: "DELETE" },
      ),

    // ---------- SSH 主机终端的命令历史（不挂项目，全局一份，落服务端数据目录） ----------
    //
    // 与上面那组（按项目）是两份独立数据：SSH 过去的是另一台机器，命令与本地项目不是
    // 一回事。四条的请求/响应形状与项目那份**逐条对应**，只是不带 workspaceId。
    /** 全部历史（最新在前）：SSH 终端的预测与历史管理共用 */
    listSshTerminalHistory: () =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalSshHistory,
      ),
    /** 记录一条（回车时上报；服务端去重置顶）。返回最新全量，调用方可直接换掉本地镜像 */
    addSshTerminalHistory: (cmd: string) =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalSshHistory,
        {
          method: "POST",
          body: JSON.stringify({ cmd }),
        },
      ),
    /** 删除单条（按命令文本定位） */
    deleteSshTerminalHistory: (cmd: string) =>
      request<{ entries: CommandHistoryEntry[] }>(
        `${API_ROUTES.terminalSshHistory}?cmd=${encodeURIComponent(cmd)}`,
        { method: "DELETE" },
      ),
    /** 清空 SSH 的全部历史 */
    clearSshTerminalHistory: () =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalSshHistory,
        {
          method: "DELETE",
        },
      ),

    // ---------- 宿主本机终端的命令历史（「主机与终端」里配的那条；不挂项目，全局一份） ----------
    //
    // 第三份历史：与「按项目」和「SSH」都分开。它是**独立功能**开出来的宿主 shell，
    // 与当前项目无关，落 `<FIZZ_DATA_DIR>/local-terminal-history.json`。
    // 四条与上面两组**逐条对应**，同样不带 workspaceId。
    /** 全部历史（最新在前）：宿主本机终端的预测与历史管理共用 */
    listLocalTerminalHistory: () =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalLocalHistory,
      ),
    /** 记录一条（回车时上报；服务端去重置顶）。返回最新全量，调用方可直接换掉本地镜像 */
    addLocalTerminalHistory: (cmd: string) =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalLocalHistory,
        {
          method: "POST",
          body: JSON.stringify({ cmd }),
        },
      ),
    /** 删除单条（按命令文本定位） */
    deleteLocalTerminalHistory: (cmd: string) =>
      request<{ entries: CommandHistoryEntry[] }>(
        `${API_ROUTES.terminalLocalHistory}?cmd=${encodeURIComponent(cmd)}`,
        { method: "DELETE" },
      ),
    /** 清空宿主本机终端的全部历史 */
    clearLocalTerminalHistory: () =>
      request<{ entries: CommandHistoryEntry[] }>(
        API_ROUTES.terminalLocalHistory,
        {
          method: "DELETE",
        },
      ),

    /**
     * 定时任务（「什么时候自动起一个会话」：cron / 一次性）。
     *
     * 服务端在到点时自己派发一条普通会话，**不起容器**。
     */
    listTaskTriggers: (workspaceId?: string) =>
      request<TaskTrigger[]>(
        workspaceId
          ? `${API_ROUTES.taskTriggers}?workspaceId=${encodeURIComponent(workspaceId)}`
          : API_ROUTES.taskTriggers,
      ),
    saveTaskTrigger: (input: TaskTriggerInput) =>
      request<TaskTrigger>(API_ROUTES.taskTriggers, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    setTaskTriggerEnabled: (id: string, enabled: boolean) =>
      request<TaskTrigger>(API_ROUTES.taskTriggerDetail.replace(":id", id), {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    /** 手动跑一次（已停用 / 一次性已跑过的也能跑）；服务端异步派发，只回「已开始」 */
    runTaskTrigger: (id: string) =>
      request<{ ok: true }>(
        `${API_ROUTES.taskTriggerDetail.replace(":id", id)}/run`,
        { method: "POST" },
      ),
    deleteTaskTrigger: (id: string) =>
      request<{ ok: boolean }>(
        API_ROUTES.taskTriggerDetail.replace(":id", id),
        {
          method: "DELETE",
        },
      ),

    // ---------- 对话 ----------
    /**
     * 中止一轮对话（用户点「停止」）。**这是停服务端的唯一通道** ——
     * `streamChat` / `streamAssistant` 的 AbortSignal 只掐断这条 SSE，服务端的
     * runner 照旧跑完（见它们的注释）。
     *
     * 两种定位方式二选一（服务端也支持两个一起给，但它优先认 requestId）：
     * - `requestId`：拿得到就用它（最准，停止按钮手里一般都有）；
     * - `conversationId`：start 帧还没到（requestId 还是空串）时按会话兜底 ——
     *   服务端会去 run 注册表里找这个会话正在跑的那条。
     *
     * 幂等：没在跑 = `{ aborted: false }`。服务端会**等这一轮真正收尾**才返回，
     * 所以这个 promise 也顺便可以当「服务端已经腾出手了」的信号用（见助手切片的
     * `stopSettling`）。
     */
    abort: (requestId: string, conversationId?: string) =>
      request<{ aborted: boolean }>(API_ROUTES.chatAbort, {
        method: "POST",
        body: JSON.stringify(requestId ? { requestId } : { conversationId }),
      }),

    /**
     * 只停这一条 execute_command（杀进程树，不影响整轮）。幂等：命令已结束 /
     * run 已结束 = `{ stopped: false }`。
     */
    stopCommand: (requestId: string, toolCallId: string) =>
      request<CommandStopResult>(API_ROUTES.chatCommandStop, {
        method: "POST",
        body: JSON.stringify({ requestId, toolCallId }),
      }),

    /**
     * 运行中切换权限档：把该 run 的**活档**改掉，闸门下一次工具调用立刻按新档裁决
     * （不必等下一轮）。幂等：run 已结束 = `{ updated: false }`。
     */
    setChatPermission: (requestId: string, permissionMode: AiPermissionMode) =>
      request<PermissionSetResult>(API_ROUTES.chatPermission, {
        method: "POST",
        body: JSON.stringify({ requestId, permissionMode }),
      }),

    /**
     * 运行中插话（steer）：把一句话（可带附件）递给该会话正在跑的 run，agent 在下一个
     * 工具步骤边界把这整条按 user 消息注入当前轮。**409 = 当前没有运行中的任务** ——
     * 调用方（facade 的 `steer`）据此回落普通发送（附件一起带过去，零损失）。
     */
    steer: (conversationId: string, text: string, files?: UploadFileRef[]) =>
      request<SteerResult>(API_ROUTES.chatSteer, {
        method: "POST",
        body: JSON.stringify({
          conversationId,
          text,
          ...(files?.length ? { files } : {}),
        }),
      }),

    /**
     * 重排还没生效的插话（**整份覆盖**：`ids` 就是新顺序，与队列的
     * `setConversationQueue` 同语义）。收件箱在服务端的活跃 run 上，409 = 这一轮已经结束。
     */
    reorderSteers: (conversationId: string, ids: string[]) =>
      request<null>(API_ROUTES.chatSteer, {
        method: "PATCH",
        body: JSON.stringify({ conversationId, ids }),
      }),

    /** 撤回一条还没生效的插话（removed=false = 已被 agent 消费，撤不回了） */
    removeSteer: (conversationId: string, messageId: string) =>
      request<SteerRemoveResult>(
        `${API_ROUTES.chatSteer}?conversationId=${encodeURIComponent(conversationId)}&messageId=${encodeURIComponent(messageId)}`,
        { method: "DELETE" },
      ),

    /** 会话分叉（从此签出）：以某条消息（含）为终点复制出新会话，返回新会话 Summary。
     *  `workspaceId` 传目标工作区（「签出 + 新建 worktree」时 = 刚建好的 worktree 项目），
     *  缺省 = 原会话的工作区。 */
    forkConversation: (
      id: string,
      upToMessageId: string,
      workspaceId?: string,
    ) =>
      request<ForkResult>(API_ROUTES.conversationFork.replace(":id", id), {
        method: "POST",
        body: JSON.stringify({
          upToMessageId,
          ...(workspaceId ? { workspaceId } : {}),
        }),
      }),

    /**
     * **兜底**上下文窗口（模型自己没配窗口时圆环的分母）：与自动压缩的兜底同一处解析
     * （环境变量 `FIZZ_CONTEXT_BUDGET` > 默认 200k）。模型配了窗口的不走这里 ——
     * 前端直接从 `ModelView.models` 里对应条目的 `contextWindow` 查（见 contracts 的 `resolveContextWindow`）。
     */
    defaultContextWindow: () =>
      request<{ defaultContextWindow: number }>(API_ROUTES.chatContext),

    /**
     * 手动触发上下文压缩（落摘要检查点，原始消息不动）。
     *
     * 走 SSE：压缩过程与自动压缩共用同一组 `context-compaction-*` 事件，界面显示同一个
     * 流式折叠块。返回值仍是最终结果；`ok: false` = 没压缩也没改动（如不足两轮），
     * `reason` 可直接展示。摘要失败抛 ApiError（从流里的 `error` 帧转来）。
     */
    async compressContext(
      conversationId: string,
      onEvent?: (event: AgentStreamEvent) => void,
    ): Promise<ChatCompressResult> {
      const res = await fetchImpl(endpoint(API_ROUTES.chatCompress), {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ conversationId }),
      });
      if (!res.ok) {
        if (res.status === 401) fireUnauthorized();
        throw await toError(res);
      }
      // 老服务端不认识 Accept，仍回 JSON：直接吃下来，别把「没有 SSE 帧」当失败
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        return (await res.json()) as ChatCompressResult;
      }
      let result: ChatCompressResult | null = null;
      let failure: string | null = null;
      await readSseFrames<ChatCompressFrame>(res, (frame) => {
        if (frame.type === "event") onEvent?.(frame.event);
        else if (frame.type === "result") result = frame.result;
        else failure = frame.message;
      });
      if (failure) throw new ApiError(failure);
      return result ?? { ok: false, reason: "压缩未返回结果" };
    },

    /**
     * 答复一次命令执行审批（confirm 模式）。
     *
     * 走的是**另开的一条 HTTP 请求**：SSE 只有下行，而审批需要「服务端等用户点一下」，
     * 所以是 `confirm` 帧（下行）→ 这个 POST（上行）→ 服务端解开 await、流继续。
     * `resolved: false` = 这条审批已失效（超时 / 已在别处答复），不是错误。
     */
    resolveConfirm: (id: string, approved: boolean, optionId?: string) => {
      const body: ConfirmReplyInput = {
        id,
        approved,
        // ACP 权限选项：用户挑中的那个，原样回给 agent
        ...(optionId ? { optionId } : {}),
      };
      return request<{ resolved: boolean }>(API_ROUTES.chatConfirm, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /**
     * 回填一次客户端工具的执行结果（服务端推来 `client-tool-call` 帧之后）。
     *
     * 与 resolveConfirm 同一套反向通道：SSE 只有下行，客户端执行完要另开一条 HTTP
     * 把结果送回去。`ok: false` 表示**执行真的失败**；用户拒绝要用 `ok: true` + 文案。
     */
    resolveClientTool: (input: ClientToolResultInput) =>
      request<{ resolved: boolean }>(API_ROUTES.chatClientToolResult, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    /**
     * 答复一次 ask_followup_question 提问（同 confirm 的反向通道约定）。
     * `answer: null` = 用户跳过 / 未作答。
     */
    resolveFollowup: (id: string, answer: AskFollowupAnswer | null) => {
      return request<{ resolved: boolean }>(API_ROUTES.chatFollowup, {
        method: "POST",
        body: JSON.stringify({ id, answer } satisfies FollowupReplyInput),
      });
    },

    /**
     * 发一轮对话并逐帧回调；返回本轮的 requestId（中止时要用）。
     * AbortSignal 只断开这条 HTTP 连接，**服务端那条 Agent 循环要靠 abort()**。
     */
    async streamChat(
      input: ChatRequest,
      onFrame: (frame: ChatStreamFrame) => void,
      signal?: AbortSignal,
    ): Promise<string> {
      const res = await fetchImpl(endpoint(API_ROUTES.chat), {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        if (res.status === 401) fireUnauthorized();
        throw await toError(res);
      }

      let requestId = "";
      await readSseFrames<ChatStreamFrame>(res, (frame) => {
        if (frame.type === "start") requestId = frame.requestId;
        onFrame(frame);
      });
      return requestId;
    },

    /** 查某会话有没有正在跑的对话（`run: null` = 没在跑）；助手会话（asst- 前缀）同样适用 */
    activeRun: (conversationId: string) =>
      request<ChatActiveResult>(
        `${API_ROUTES.chatActive}?conversationId=${encodeURIComponent(conversationId)}`,
      ),

    // ---------- AI 助手 ----------
    //
    // ⚠️ 只有「发一句话」这一个端点：助手**没有多会话**（没有清单 / 新建 / 删除），
    // 服务端也**不落盘** —— 历史由客户端随请求带上（`AssistantSendInput.history`），
    // 每次打开面板就是一个新会话（客户端换 `sessionId` 即可）。

    /**
     * 给 AI 助手发一句话并逐帧回调（帧协议与 streamChat 完全一致，端点不同）。
     * 审批复用 resolveConfirm；历史由调用方随 input.history 带上。
     */
    async streamAssistant(
      input: AssistantSendInput,
      onFrame: (frame: ChatStreamFrame) => void,
      signal?: AbortSignal,
    ): Promise<string> {
      const res = await fetchImpl(endpoint(API_ROUTES.assistantSend), {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        if (res.status === 401) fireUnauthorized();
        throw await toError(res);
      }
      let requestId = "";
      await readSseFrames<ChatStreamFrame>(res, (frame) => {
        if (frame.type === "start") requestId = frame.requestId;
        onFrame(frame);
      });
      return requestId;
    },

    /**
     * 接回一条进行中的对话（刷新 / 断线重连后恢复现场）。
     *
     * 帧从**头**开始回放（含 start），所以拿到的就是完整现场；读到 end / 断开才 resolve。
     * 同一条 run 可以被多个标签页同时 attach（审批答复是共享的，任一端答完另一端撤卡）。
     */
    async attachRun(
      requestId: string,
      onFrame: (frame: ChatStreamFrame) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const res = await fetchImpl(
        endpoint(
          `${API_ROUTES.chatStream}?requestId=${encodeURIComponent(requestId)}`,
        ),
        {
          headers: { ...authHeaders(), accept: "text/event-stream" },
          ...(signal ? { signal } : {}),
        },
      );
      if (!res.ok) {
        if (res.status === 401) fireUnauthorized();
        throw await toError(res);
      }
      await readSseFrames<ChatStreamFrame>(res, onFrame);
    },

    // ---------- 应用日志 ----------

    /**
     * 全量拉取应用日志（含命名空间 Tab 列表）。
     *
     * 全量而非分页：日志是服务端内存环形缓冲（上限 1000 条），一次给完最简单。
     * 应答里的 `maxSeq` 要留着，作为 `streamAppLog` 的订阅起点。
     */
    listAppLog: () => request<AppLogResult>(API_ROUTES.appLog),

    /** 清空应用日志（内存 + 落盘），返回清空后的快照 */
    clearAppLog: () =>
      request<AppLogResult>(API_ROUTES.appLogClear, { method: "DELETE" }),

    /**
     * 订阅应用日志增量（SSE，永续流：函数在连接被 `signal` 断开或服务端收场时才 resolve）。
     *
     * `since` = 已经拿到的最大 seq，服务端只推它之后的条目 —— 重连不整段回放。
     * ⚠️ 调用方**必须**传 `signal` 并在卸载时 abort：这是永续流，没有 `end` 帧，
     * 不收就永远挂着（桌面端是长驻进程，反复开关面板会累积连接）。
     */
    async streamAppLog(
      since: number,
      onFrame: (frame: AppLogFrame) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const res = await fetchImpl(
        endpoint(`${API_ROUTES.appLogStream}?since=${since}`),
        {
          headers: { ...authHeaders(), accept: "text/event-stream" },
          ...(signal ? { signal } : {}),
        },
      );
      if (!res.ok) {
        if (res.status === 401) fireUnauthorized();
        throw await toError(res);
      }
      await readSseFrames<AppLogFrame>(res, onFrame);
    },

    // ---------- 文件管理器（服务端那台机器的整盘） ----------
    //
    // 与上面的 `*Workspace*` 那批**完全两套语义**：这里全是**绝对路径**、没有工作区
    // 围栏（用户要的就是「像 linux_web 那样的整盘文件管理器」）。所以刻意收在一个
    // `files` 子对象里，别和「工作区文件」的扁平方法混着看。
    //
    // 路径一律经 `pathQuery()` 编码：Windows 的 `C:\a b\x.txt` 里既有 `:` 又有空格，
    // 不编码会在 query 里被截断（`+`、`&`、`#` 同理）。
    files: {
      /** 列一个目录（`path` 缺省 = 服务端主目录） */
      list: (path?: string) =>
        request<FmListResult>(pathQuery(FILES_API.list, path)),

      /** 主目录 / 盘符 / 常用位置（界面打开时先拉它，确定默认落点） */
      roots: () => request<FmRootsResult>(FILES_API.roots),

      /** 单条属性 */
      stat: (path: string) => request<FmEntry>(pathQuery(FILES_API.stat, path)),

      /**
       * 读文件内容（文本 utf8 / 二进制 base64）。
       *
       * **有上限**（文本 2MB、二进制 8MB）：预览面板用的。要拿整份大文件走
       * `download`，要看视频走 `mediaUrl`。
       */
      read: (path: string) => request<FmReadResult>(pathQuery(FILES_API.read, path)),

      /** 所有改动动作的总线（新建 / 改名 / 复制 / 移动 / 删除 / 压缩 / 解压…） */
      op: (input: FmOpInput) =>
        request<FmOpResult>(FILES_API.op, {
          method: "POST",
          body: JSON.stringify(input),
        }),

      /**
       * 上传一个文件（**JSON + base64**，禁止 FormData —— desktop 的 IPC 桥只认字符串）。
       *
       * 同名默认 409（不静默覆盖）；`overwrite: true` 才是用户显式同意。
       */
      upload: (input: FmUploadInput) =>
        request<FmOpResult>(FILES_API.upload, {
          method: "POST",
          body: JSON.stringify(input),
        }),

      /** 回收站清单 */
      trash: () => request<FmTrashResult>(FILES_API.trash),

      /** 列压缩包里的条目（只读目录，不解压） */
      archive: (path: string) =>
        request<FmArchiveResult>(pathQuery(FILES_API.archive, path)),

      /**
       * 预览用的 URL：**带鉴权拉成 blob 再造 objectURL**。
       *
       * 为什么不直接把 `/api/files/content?path=…` 塞进 `<img src>`：
       * - web 上要带 token 只能拼 query（`extractTokenFromRequest` 认 `?token=`），
       *   而那里是**用户文件的绝对路径**，塞进 URL 会被历史记录 / 日志留下来；
       * - desktop 压根没有可访问的 HTTP 端口（服务端在进程内，走 IPC 桥）。
       *
       * 与工作区文件的 `fetchWorkspaceMedia` 同一条路（那里也是 blob）。
       * ⚠️ 调用方负责 `URL.revokeObjectURL`，否则每看一张图就漏一份内存。
       */
      async mediaUrl(path: string): Promise<string> {
        const res = await fetchImpl(pathQuery(FILES_API.content, path), {
          headers: authHeaders(),
        });
        if (!res.ok) {
          if (res.status === 401) fireUnauthorized();
          throw await toError(res);
        }
        return URL.createObjectURL(await res.blob());
      },

      /**
       * 下载到本机（浏览器另存为）。目录由服务端现场打 zip。
       *
       * ⚠️ 整块进内存（blob 没有 Range）：几百 MB 的目录包会让渲染进程吃满 ——
       * 这是现有 `downloadFile` 的共同限制，与工作区下载同一取舍。
       */
      async download(path: string, fileName: string): Promise<void> {
        await downloadFile(pathQuery(FILES_API.download, path), fileName, {
          fetchImpl,
          headers: authHeaders(),
        });
      },
    },
  };
}

export type AgentApi = ReturnType<typeof createApi>;
