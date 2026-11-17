/**
 * 容器型项目的生命周期：确保镜像 → 起容器 → 等 agent 就绪 → 手动停 / 重建。
 *
 * ## 运行态不落盘
 *
 * 「现在跑没跑」由 `docker ps` 现读（见下面的 `listProjectContainers`），
 * 「在哪个阶段 / 报了什么错」只在**本进程内存**里（`live`）——
 * **刻意不落盘**：容器型项目是「打开才要它跑」的东西，进程重启后没有人在等它，
 * 重新打开项目自然会再起一次。落盘只会多一份会过期的真相。
 *
 * ## 端口不落盘
 *
 * agent 端口（容器内 `:8080`）与预览端口都从 `allocateHostPort()`（41000-41999）现取，
 * 之后**每次都用 `docker ps` 的端口表现读**。理由：docker 是这份映射的唯一真源，
 * 我们记一份就会有「服务端重启后对不上」的第二种真相（冷启动走 `docker start`，
 * 端口是当初 `docker run` 时定下的，跟这次分配无关）。
 *
 * ## 容器名与归属
 *
 * `fizz-proj-<slug>` + label `fizz.container-project=<slug>`。**两道判据都带前缀**，
 * 所以容器型项目的容器不会被启动时的孤儿清理误收（见 `root.ts` 的说明）。
 *
 * ⚠️ **名字才是真相，label 只是索引**：读现状走 label 索引（一条请求拿全），但**建容器前**
 * 还要按名字探一次 —— 索引看不见的同名容器（老版本没 label / `docker ps` 抖了一下 / 别的进程
 * 刚建出来）会让 `docker run --name` 撞 `409 Conflict`，且每次启动都撞同一个。见 `containerByName`
 * 与 `createOrReplace`。
 */
import { createHash } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { request as httpRequest } from 'node:http'
import type {
  AgentWorkspace,
  ContainerProjectState,
  ContainerProjectUpdateInput,
  ContainerProjectsSnapshot,
  ContainerProjectConfig
} from '@fizz/contracts'
import { CONTAINER_ENV_IMAGES } from '@fizz/contracts'
import {
  containerLogs,
  createContainer,
  inspectContainer,
  removeContainer,
  dockerUnavailableReason,
  dockerVersion,
  findRepoRoot,
  isDockerConnectionError,
  listContainers,
  noteDockerFailure,
  startContainer,
  stopContainer,
  toDockerPath
} from '../lib/docker'
import type { CreateContainerSpec } from '../lib/docker'
import { allocateHostPort } from '../lib/ports'
import { domain, markDirty } from '../state'
import { invalidNameReason } from '../projects-pure'
import { ProjectServiceError } from '../projects'
import { CONTAINER_PROJECT_LABEL, CONTAINER_SPEC_LABEL, containerNameOf, projectDirOf } from './root'
import { skillMountKey, skillMountsOf } from './skill-mounts'
import { previewKeyError } from './preview-key'
import { normalizeCpus, normalizeMemoryLimitMb, resourceInputError } from './resources'
import {
  containerImageBuildLog,
  containerImageTag,
  ensureContainerImage,
  imageOutOfDate
} from './image'

/**
 * 启动阶段（快照里的 `phase`，界面上按它显示进度）。
 *
 * `prepare` = 「查 docker / 读现有容器 / 比对容器形状」这一段。它**只有在确实要启动时**
 * 才置上（`startContainerProject` 进来就置），不是探测本身在推阶段 —— 所以不会像以前那样
 * 每条消息都闪一下启动页。放在阶段列的第一行是因为它可能真的慢（dockerd 卡住 / 机器忙时
 * 一条 `docker ps` 要好几秒），而这期间界面必须有东西在动，否则就是「点了启动没反应」。
 */
type Phase = 'prepare' | 'image' | 'run' | 'health'

/** 某个项目在本进程内的瞬时启动态（成功/停止后清掉） */
interface LiveState {
  phase?: Phase
  /**
   * 正在停（`docker stop` 还没返回）。
   *
   * 这段时间容器在 `docker ps` 里**仍然是 Up**（它有 5s 优雅退出窗口），所以「看 docker」
   * 得出的结论是 `running` —— 但用户已经点了停止，界面必须立刻反映「停着呢」：
   * 主区域的门收起对话面板、侧栏显示「停止中」。只在 `stopContainerProject` 里置。
   */
  stopping?: boolean
  error?: string
}

/**
 * `/health` 里宿主关心的字段（与 `container-projects/turn.ts` 的 `ContainerHealth` 同形）。
 *
 * 由 `waitHealth` 顺手读回来：宿主起一轮之前本来就要核对 `protocolVersion`，让探测那一趟
 * 把 body 带回来，就不用为同一件事再发一次 HTTP（每条消息都省一趟往返）。
 */
export interface AgentHealth {
  ok?: boolean
  protocolVersion?: number
  envId?: string
}

/** `doStart` / `startContainerProject` 的产物：agent 端口 + 那一趟探测到的健康体 */
export interface StartResult {
  port?: number
  health?: AgentHealth
  /**
   * 这个容器**确实挂着**的用户级技能目录（容器内路径，见 `skill-mounts.ts`）。
   *
   * 空数组 = 没挂 / 不确定（老容器、形状过期的容器）：`containerSkillList` 据此**不把**
   * `~/.fizz/skills` 与 `~/.agents/skills` 的技能发下去 —— 发了模型也读不到。
   */
  skillMounts?: string[]
}

/** 按 slug 记的瞬时启动态（不落盘、进程重启即丢） */
const live = new Map<string, LiveState>()
/** 正在启动的那些（按 slug 合并，**并发调用只会真的起一次**） */
const starting = new Map<string, Promise<StartResult>>()
/** 正在停的那些（按 slug 合并：连点「停止容器」只发一条 `docker stop`） */
const stopping = new Map<string, Promise<void>>()

// ---------- 环境变量 ----------

/** 冷启动 / 首次启动等 agent 就绪的上限（毫秒），缺省 60000 */
function wakeTimeoutMs(): number {
  const raw = process.env.FIZZ_CONTAINER_WAKE_TIMEOUT_MS?.trim()
  const value = raw ? Number(raw) : NaN
  return Number.isFinite(value) && value > 0 ? value : 60_000
}

/**
 * 生效的公网域名清单：**只读设置**（`ContainerPublicSettings.domains`，可多个）。
 *
 * 读盘（`domain.getContainerPublicSettings()`）而不是缓存：设置页改完立刻生效，
 * 不必重启（判定是每个请求现读的，见 `public-gateway.ts`）。
 *
 * ⚠️ 以前这里还有 `FIZZ_CONTAINER_DOMAIN` 兜底，**已移除** —— 域名只有一个出处（设置页），
 * env 只管「端口」这类部署参数，不再掺「业务配置」，免得设置页显示的和实际生效的对不上。
 */
export function publicDomainNames(): string[] {
  return domain.getContainerPublicSettings().domains
}

/**
 * 独立公网端口监听器的**端口**（`FIZZ_PUBLIC_HTTP_PORT`，缺省 / `0` = 不启用）。
 *
 * 非法值（非整数 / 越界）一律当「不启用」—— 配错了不该让服务起不来。
 */
export function publicPort(): number {
  const raw = process.env.FIZZ_PUBLIC_HTTP_PORT?.trim()
  const value = raw ? Number(raw) : NaN
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0
}

/**
 * 公网入口监听器**此刻在不在跑** —— 由真正 `listen()` 的那一处（`public-gateway.ts`）登记。
 *
 * 为什么用「登记事实」而不是读 `FIZZ_PUBLIC_HTTP_PORT`：端口配了但被别的进程占了、`listen`
 * 失败时，环境变量仍在，靠它猜就会给界面一个打不开的公网地址。登记事实只有 listen 成功才有。
 */
let publicGatewayPort: number | null = null

/** 登记公网入口的监听状态（`null` = 没在跑） */
export function notePublicGateway(port: number | null): void {
  publicGatewayPort = port
}

/** 公网入口监听器现在是否在跑 */
export function publicGatewayRunning(): boolean {
  return publicGatewayPort !== null
}

/**
 * 公网域名**现在是否真的能用**：配了至少一个域名 + 公网入口端口确实在监听。
 *
 * 只配域名、端口却没启用（`FIZZ_PUBLIC_HTTP_PORT` 没设）时，外面根本连不进来，界面给出
 * 一个打不开的公网地址反而误导 —— 快照里因此不给 `domains`
 * （`ContainerProjectsSnapshot.domains` 的既有语义），设置页也据此提示去配端口。
 */
export function publicGatewayEnabled(): boolean {
  return publicDomainNames().length > 0 && publicGatewayRunning()
}


// ---------- docker 小工具 ----------
//
// 所有 docker 交互都在 `lib/docker.ts`（dockerode 直连 socket）。本模块以前自己复制了
// 一份 `dockerRun`（spawn `docker.exe` + 解析 `{{json .}}`），现在统一走那边的语义方法 ——
// 少一个进程，也少一份要跟着 CLI 输出格式漂的解析代码。

/** 一眼看清的「项目容器现状」：跑没跑 + 容器内端口 → 宿主端口 */
interface ProjectContainerInfo {
  running: boolean
  /** 容器内端口 → 宿主端口（如 `8080` → `41234`）；`docker ps --format` 的 `Ports` 串解析而来 */
  ports: Map<number, number>
  /** 当初 `docker run` 时的运行参数指纹；升级前建的容器没有这个 label → 缺省 */
  spec?: string
}

/**
 * **一次请求**捞全部容器型项目容器的现状（按 label 过滤，不靠名字前缀猜）。
 *
 * 为什么是「一把捞」而不是「每个项目 inspect 一次」：这份快照要随 state ws 反复重算
 * （启动阶段还要更密），逐项目 `docker inspect` 是 N 次往返，项目一多就把每次推送的
 * 成本推成 O(N)。一条 `listContainers` 给全，N 无关 —— 而且走 dockerode 之后它不再
 * spawn 进程，稳态那 10s 一拍的代价从「一个子进程」降到「一次 socket 往返」。
 */
async function listProjectContainers(): Promise<Map<string, ProjectContainerInfo>> {
  const map = new Map<string, ProjectContainerInfo>()
  let list
  try {
    list = await listContainers({ all: true, label: CONTAINER_PROJECT_LABEL })
  } catch (err) {
    // docker 连不上：当「没有容器」，让调用方走「起一个新的」那条路（它会给出真实错误）。
    // 同时把这个错误记进 docker 的「不可用原因」—— 运行中 Docker Desktop 被关掉时，
    // `dockerVersion()` 还可能命中 30s 成功缓存，只有这里知道连接已经断了（见 `noteDockerFailure`）。
    noteDockerFailure(err)
    return map
  }
  for (const item of list) {
    const slug = item.labels[CONTAINER_PROJECT_LABEL]
    if (!slug) continue
    const spec = item.labels[CONTAINER_SPEC_LABEL]
    map.set(slug, {
      running: item.running,
      ports: item.ports,
      ...(spec ? { spec } : {})
    })
  }
  return map
}

/**
 * 按**名字**读一个容器型项目容器的现状；不存在（或 docker 连不上）返回 `undefined`。
 *
 * ⚠️ `listProjectContainers` 是按 label 索引的，而 label 只是**我们自己打的索引**，不是
 * docker 的唯一真相。下面三种情况都会让索引「看不见」一个**确实存在**的同名容器：
 *
 * 1. 老版本建的容器没有 label（label 是后来才加的）；
 * 2. 上一次 `docker ps` 抖了一下 —— 那边 `catch` 直接返回空表；
 * 3. 另一个进程（第二份 server / 用户自己 `docker run`）刚好在这两步之间把容器建出来。
 *
 * 这时候再去 `docker run --name` 就是 `409 Conflict`，而且是个**死循环**：每次启动都走到
 * 同一步、每次都撞同一个名字（用户报过 `(HTTP code 409) ... container name is already in use`）。
 * 所以建之前必须按名字再探一次。
 *
 * 用 `inspectContainer` 而不是 `docker ps`：它对**停着的**容器也给端口映射，冷启动那条路
 * 照样能拿到 8080 映射（`docker ps` 对未运行的容器 `Ports` 是空的）。
 */
async function containerByName(name: string): Promise<ProjectContainerInfo | undefined> {
  const state = await inspectContainer(name)
  if (!state) return undefined
  return { running: state.running, ports: state.ports }
}

/**
 * 「这个名字已经被占用了」—— dockerode 把 daemon 的 409 包成 error。
 *
 * 状态码优先、文案兜底：dockerode 不同版本有的只给 `statusCode`，message 里则一定带
 * `Conflict` / `already in use`。
 */
function isNameConflict(err: unknown): boolean {
  if ((err as { statusCode?: number } | null)?.statusCode === 409) return true
  const message = err instanceof Error ? err.message : String(err)
  return /conflict|already in use/i.test(message)
}

/**
 * 建容器，**撞名就删掉重建一次**（409 不能原样抛给用户：它是死循环，重试永远同一个结果）。
 *
 * 删的是**容器**不是项目文件（`/workspace` 在 bind mount 上），所以最坏情况只是「重建一次」，
 * 比让用户每次点启动都看到一句 docker 的英文 409 好得多。
 *
 * 第二次还撞名 = 那个容器删不掉（`Removal In Progress` / daemon 忙），这时给一句能照做的人话，
 * 别再抛 docker 的原文。
 */
async function createOrReplace(spec: CreateContainerSpec): Promise<void> {
  try {
    await createContainer(spec)
    return
  } catch (err) {
    if (!isNameConflict(err)) throw err
  }
  // `removeContainer` 自己吞错（收尾动作的约定，见 `lib/docker.ts`），所以下面再失败就直接报出去
  await removeContainer(spec.name)
  try {
    await createContainer(spec)
  } catch (err) {
    if (!isNameConflict(err)) throw err
    throw new Error(
      `容器名 ${spec.name} 已被另一个容器占用，而且删不掉 —— 请手动执行 \`docker rm -f ${spec.name}\` 后重试`,
      { cause: err }
    )
  }
}

// ---------- 记录读取 ----------

/** 取容器型项目配置；普通项目 / 不存在的 id 一律抛 404（路由直接透出这句话） */
function containerConfigOf(workspaceId: string): { ws: AgentWorkspace; cfg: ContainerProjectConfig } {
  const ws = domain.getWorkspace(workspaceId)
  if (!ws || !ws.container) throw new ProjectServiceError(404, '容器型项目不存在')
  return { ws, cfg: ws.container }
}

// ---------- 启动 ----------

function setLive(slug: string, state: LiveState): void {
  live.set(slug, state)
  markDirty(['containerProjects'])
}

function clearLive(slug: string): void {
  if (live.delete(slug)) markDirty(['containerProjects'])
}

/**
 * `docker run` 形状的版本号：**改了 `createSpecOf` 里任何影响容器形状的开关就 +1**。
 *
 * 它进指纹（`specOf`），所以老容器会在下一次启动时按新形状重建 —— 否则新加的参数只对
 * 「之后新建的容器」生效，已有项目永远停在旧形状（而且没有任何报错）。
 *
 * 版本历史：
 * - 1：初始（镜像 / 预览端口 / 资源限额）；
 * - 2：多了用户级技能的只读挂载（`/fizz-skills/{user,agents}`，见 `skill-mounts.ts`）。
 */
const RUN_SPEC_VERSION = 2

/** 归一化后的资源限额（0 = 不限制），`createSpecOf` 与 `specOf` 共用同一套口径 */
function resourceOf(cfg: ContainerProjectConfig): { memoryMb: number; cpus: number } {
  return {
    memoryMb: cfg.memoryLimitMb ? normalizeMemoryLimitMb(cfg.memoryLimitMb) : 0,
    cpus: cfg.cpus ? normalizeCpus(cfg.cpus) : 0
  }
}

/**
 * 当前配置对应的 `docker run` 形状指纹（打在容器 label `fizz.container-spec` 上）。
 *
 * 只包含**只有重建才能改**的东西：镜像、预览端口、内存 / CPU 限额、参数版本、技能挂载集合。
 * `doStart` 拿容器上那个 label 与它比对，不一致就删容器重建 —— 这就是「暂不重启，
 * 下次重启自动生效」的落点，而且不依赖内存状态（服务端重启后依然成立）。
 *
 * ⚠️ 技能挂载集合也在这里：用户装出 `~/.agents/skills` 之后，指纹一变，下次启动就会
 * 按新形状重建容器，新目录自动挂上（否则那个容器永远只有当初挂的那几个）。
 */
function specOf(cfg: ContainerProjectConfig): string {
  const { memoryMb, cpus } = resourceOf(cfg)
  return createHash('sha1')
    .update(
      [RUN_SPEC_VERSION, cfg.image, cfg.previewPort ?? '', memoryMb, cpus, skillMountKey()].join('|')
    )
    .digest('hex')
    .slice(0, 12)
}

/** 当前该挂进容器的技能目录（容器内路径）；`doStart` 用它回答「这个容器挂了什么」 */
function mountedSkillDirs(): string[] {
  return skillMountsOf().map((mount) => mount.containerDir)
}

/**
 * 容器型项目容器的形状（交给 `lib/docker.ts` 的 `createContainer`）。
 *
 * 逐条对应原来的 `docker run` 参数，改之前先看这份清单：
 *
 * - `restartPolicy: 'unless-stopped'`：宿主机重启后容器自己回来（**不是** `always` ——
 *   用户手动停掉的就不该自己再爬起来，那会让人以为「停」没生效）；
 * - 两个端口都**只绑 `127.0.0.1`**：agent 控制面与预览服务都不该被局域网/公网直接看到
 *   （公网访问是独立监听器按 Host 反代，不是把端口暴露出去）；
 * - **不注入任何密钥**：模型 key 只走回环、由宿主把请求转进来，容器里不落一份；
 * - **技能目录只读挂载**：`~/.fizz/skills` 与 `~/.agents/skills` 挂到 `/fizz-skills/{user,agents}`
 *   （只挂存在的、只读，见 `skill-mounts.ts`）—— 不挂的话这两类技能在容器里根本不存在；
 * - 资源限额**只在给了正数时**才限制（0 / 缺省 = 不限制，留给 docker 默认）。
 */
async function createSpecOf(ws: AgentWorkspace): Promise<CreateContainerSpec> {
  const cfg = ws.container!
  const { memoryMb, cpus } = resourceOf(cfg)
  // ⚠️ 两个端口必须互不相同：`allocateHostPort` 每次都从 41000 重扫，而此时端口还没被
  // 真的绑上（容器尚未创建），第二次调用会把**同一个** 41000 再给一遍 —— docker 随即报
  // `Bind for 127.0.0.1:41000 failed: port is already allocated`。所以把已取走的传回去
  // 排除（见 `ports.ts` 的 `exclude` 说明）。
  const taken = new Set<number>()
  const agentHostPort = await allocateHostPort(taken)
  taken.add(agentHostPort)
  const ports = [{ containerPort: 8080, hostPort: agentHostPort, hostIp: '127.0.0.1' }]
  const env: Record<string, string> = {}
  if (cfg.previewPort !== undefined) {
    /*
     * 把「该监听哪个端口」交给容器**里面的**脚本：用户写 `.fizz/container/start.mjs`、或者
     * 镜像自带自动启动（`autostart.mjs`）时都要用，而端口是平台按镜像分配的、容器里别处
     * 拿不到。不注入的话脚本只能自己写死一个数 —— 写错成 5173 / 30000 就是「预览一片空白
     * 且没有任何报错」（用户报过）。
     */
    env.FIZZ_PREVIEW_PORT = String(cfg.previewPort)
    // 端口池是全局共用的（同一个 `allocateHostPort`），避免和别的容器抢同一个端口
    const previewHostPort = await allocateHostPort(taken)
    ports.push({
      containerPort: cfg.previewPort,
      hostPort: previewHostPort,
      hostIp: '127.0.0.1'
    })
  }
  return {
    name: containerNameOf(cfg.slug),
    image: containerImageTag(cfg.image),
    labels: {
      [CONTAINER_PROJECT_LABEL]: cfg.slug,
      [CONTAINER_SPEC_LABEL]: specOf(cfg)
    },
    restartPolicy: 'unless-stopped',
    // 容器里的 agent 会 spawn 子进程（执行命令 / 跑测试），init 负责收尸
    init: true,
    binds: [
      `${toDockerPath(projectDirOf(cfg.slug))}:/workspace`,
      // 用户级技能目录（只读）：容器内路径与 `skills.ts` 的 `CONTAINER_ROOT_OF` 必须一致
      ...skillMountsOf().map((mount) => `${toDockerPath(mount.hostDir)}:${mount.containerDir}:ro`)
    ],
    ports,
    ...(Object.keys(env).length ? { env } : {}),
    ...(memoryMb > 0 ? { memoryMb } : {}),
    ...(cpus > 0 ? { cpus } : {})
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * 轮询容器内 agent 的 `/health`；超时返回 null（**不抛错** —— 由调用方决定说什么）。
 *
 * 返回**响应体**而不只是「通没通」：宿主起一轮前还要核对 `protocolVersion`（见 `turn.ts`），
 * 这一趟顺手把 body 读回来，就不用为同一件事再发一次 HTTP。body 不是 JSON 说明回话的
 * 不是我们的 agent（docker 的 userland-proxy 会先 accept）—— 当作没就绪，继续等。
 */
async function waitHealth(
  port: number | undefined,
  timeoutMs = wakeTimeoutMs()
): Promise<AgentHealth | null> {
  if (port === undefined) return null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3_000)
      })
      if (res.ok) {
        try {
          return (await res.json()) as AgentHealth
        } catch {
          // 通了但不是我们的 agent（body 不是 JSON）：当作没就绪，继续等
        }
      }
    } catch {
      // 还没起来（进程刚起 / 端口还没通）：继续等
    }
    await sleep(500)
  }
  return null
}

/**
 * 「docker 连不上」这类失败（引擎没起来 / socket 不通）的判据。
 *
 * 它们和「容器里那个服务没起来」不是一回事：前者用户唯一能做的是把 Docker Desktop
 * 起来再重试，后者多半要看日志改配置。界面据此只显示**重试**按钮（不再甩一屏日志）。
 *
 * 文案反查是妥协：`docker.ts` 把原始错误折成了一句人话（`dockerErrorMessage`），
 * 类型信息在那里就丢了。宁可漏判（退回「显示日志 + 重试」，行为不变）也不要误判。
 */
const DOCKER_CONNECTION_ERROR_HINT =
  /docker (daemon|引擎)|连不上 docker|pipeline|EPIPE|ECONNREFUSED|ENOENT|不可用/

function isDockerConnectionFailure(err: unknown, message: string): boolean {
  if (isDockerConnectionError(err)) return true
  return DOCKER_CONNECTION_ERROR_HINT.test(message)
}

/**
 * 失败了就把人话原因 + 容器日志尾部记进 `live`（界面直接显示，且可重试）。
 *
 * docker 连不上时**不附日志**：容器都没起来哪来的日志，`containerLogs` 也一定失败，
 * 拼出来只会多一段噪音。顺手记进 docker 的「不可用原因」—— 这是快照里
 * `dockerUnavailableReason` 唯一的运行期来源，卡片上那张「连不上 docker 引擎」靠它。
 */
async function recordFailure(slug: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  if (isDockerConnectionFailure(err, message)) {
    noteDockerFailure(err instanceof Error || typeof err === 'string' ? err : new Error(message))
    setLive(slug, { error: message })
    return
  }
  // 容器可能压根没建起来：`containerLogs` 取不到时返回空串，别把原始错误盖掉
  const tail = (await containerLogs(containerNameOf(slug), 50)).trim()
  setLive(slug, {
    error: tail ? `${message}\n\n容器日志（尾部 50 行）：\n${tail}` : message
  })
}

/**
 * docker 连不上时**别再让用户干等**：`doStart` 里那几套重试是给「镜像层 / 容器内服务」
 * 用的（`FIZZ_CONTAINER_WAKE_TIMEOUT_MS`，默认几十秒），引擎都不在的话每个 `docker` 调用
 * 都会先各撞一次超时，启动按钮就转上半分钟才报错。
 *
 * 所以第一次 `dockerVersion()` 判失败就**立刻**退出：用户够快看到「连不上 docker 引擎 +
 * 重试」，把 Docker Desktop 起来点一下重试就好（`retryDockerProbe` 会清缓存现问）。
 *
 * 提示文案直接取 `dockerUnavailableReason()`：那里记着 `docker.ts` 折叠后的原始错误
 * （`Cannot connect to the Docker daemon...` / `ENOENT: \\.\pipe\docker_engine`），
 * 是用户搜报错时唯一有用的东西。
 */
function dockerDownReason(): string {
  return `连不上 docker 引擎 —— 请确认 Docker Desktop 已启动后再重试。\n\n${dockerUnavailableReason() ?? 'docker 不可用'}`
}

/**
 * 真的去把容器弄起来（**内部用，不抛错**：失败写进 `live.error`，调用方读快照）。
 *
 * 三种情况分得很清楚：
 * 1. 容器已经在跑 → 只确认容器内 agent 服务真的活着（进程崩了但容器没退也见得到）；
 * 2. 容器存在但停着 → **`docker start`**（冷启动）：端口映射与挂载都还在，
 *    比 `docker run` 快得多，也不会重新分配端口；
 * 3. 容器不存在 → 确保镜像 → `docker run`（这一步才分配端口）。
 *
 * 返回值把**这一趟已经读到的东西**带出去（agent 端口 + `/health` 响应体）：调用方
 * （`ensureContainerAgentReady` → 对话链路）本来就要这两样，再各跑一次 `docker ps` /
 * HTTP 就是每条消息白付的两次往返。失败时返回空对象（原因在 `live.error` 里）。
 */
async function doStart(ws: AgentWorkspace): Promise<StartResult> {
  const cfg = ws.container!
  const slug = cfg.slug
  const name = containerNameOf(slug)
  try {
    const version = await dockerVersion()
    if (!version) throw new Error(dockerDownReason())

    let info = (await listProjectContainers()).get(slug)
    /*
     * label 索引里没有 ≠ 这个名字没被占用（三种成因见 `containerByName`）。再按名字探一次，
     * 否则下一步 `docker run --name` 会撞 409，而且每次都撞同一个。
     *
     * `adopted` 记住「它不是索引里的那个容器」：**停着的一律重建**，把 label 与形状都补齐；
     * **在跑的不动** —— 杀掉一个正在干活的容器，比它缺一个 label 糟得多。
     */
    let adopted = false
    if (!info) {
      info = await containerByName(name)
      adopted = info !== undefined
    }

    // ⚠️ 「已经在跑且容器内 agent 健康」是**每条消息都会走**的一条快路 —— `turn.ts`
    // 每轮都调 `ensureContainerAgentReady` → 这里。这条路上**不许换掉进入前就置好的阶段**：
    // 用户点「启动」时 `startContainerProject` 已经置了 `prepare`（界面据此立刻显示进度），
    // 这里探 docker 是它的延续，不是新阶段；而按需拉起那条路进来时本就没有阶段，探完
    // 直接清掉即可 —— 一碰 `live` 就会 `markDirty`，快照被推成 `starting`，前端于是每次
    // 发消息都闪出启动页那张卡，用户报过「每次发消息都先切到检查环境的页面」。
    if (info?.running) {
      const port = info.ports.get(8080)
      const health = await waitHealth(port, 5_000)
      if (health) {
        clearLive(slug)
        /**
         * 技能挂载：形状（`specOf`）与当前配置一致 ⇒ 当初就是按这套挂载建的，目录都在；
         * 形状过期的容器（升级前建的 / 后来才装出 `~/.agents/skills`）⇒ 当作没挂 ——
         * 发下去只会让模型拿到一条读不到的路径（见 `skill-mounts.ts` 第 3 条）。
         */
        const current = mountedSkillDirs()
        const shapeCurrent = info.spec === specOf(cfg)
        if (!shapeCurrent && current.length > 0) {
          // 不静默：技能清单会少一批，日志里得能对上账
          console.warn(
            `[container-skill] 容器 ${slug} 的形状与当前配置不一致（升级前建的 / 建好之后才装出 ` +
              '~/.agents/skills）：重启这个容器之后用户级技能才会挂进去，这一轮先不发给它'
          )
        }
        const skillMounts = shapeCurrent ? current : []
        return port === undefined ? { health, skillMounts } : { port, health, skillMounts }
      }
      throw new Error('容器在跑，但容器内 agent 服务没有响应（可点「停止」后再启动）')
    }

    // 到这里才确定**真的要做事了**（重建 / 冷启动），现在才置启动态给前端看进度
    // 停着的容器先看形状：`docker start` 只会把**当初 run 出来的那个容器**拉起来，
    // 镜像换了 / 内存 CPU 改了 / 参数版本升级了，它都还是旧形状 —— 删掉按当前配置重建。
    // 项目文件在 bind mount 上，删容器不丢代码。**在跑的不动**：用户在用，
    // 「改配置立刻生效」走的是「重启容器」（`rebuildContainerProject`）。
    if (info && !info.running) {
      let rebuild: boolean
      if (adopted) {
        // 名字在、label 不在：形状与配置都对不上账，按当前配置重建（文件在 bind mount 上）
        rebuild = true
      } else if (info.spec === undefined) {
        /*
         * 升级前建的容器没有指纹 label。**不能一律重建**：那会让所有老项目在升级后第一次
         * 打开时白等一次重建。只有「确实配了资源限额」时才重建（这种配置在旧容器里肯定
         * 没生效过）；没配就按老路 `docker start`，行为与升级前逐字一致。
         */
        const { memoryMb, cpus } = resourceOf(cfg)
        rebuild = memoryMb > 0 || cpus > 0
      } else {
        rebuild = info.spec !== specOf(cfg)
      }
      if (!rebuild) {
        try {
          rebuild = await imageOutOfDate(findRepoRoot(), cfg.image)
        } catch {
          // 指纹检测失败：按容器还在走老路，别把能 start 的拦在门外
        }
      }
      if (rebuild) {
        await removeContainer(name)
        info = undefined
      }
    }
    // 这一趟是否**真的按当前形状建了容器**（决定技能挂载是否可信，见下面的 `skillMounts`）
    let created = false
    if (info) {
      setLive(slug, { phase: 'run' })
      try {
        await startContainer(name)
      } catch {
        // 上一次创建 **半途失败**（两个 `-p` 撞了同一个宿主端口就会这样）会留下一个
        // Created 状态、端口绑定是坏的容器：`start` 每次都以同一个错误失败，用户点
        // 「重新唤醒」永远起不来。删掉按新参数重建，别把半成品卡在那儿。
        await removeContainer(name)
        setLive(slug, { phase: 'image' })
        await ensureContainerImage(cfg.image)
        setLive(slug, { phase: 'run' })
        await createOrReplace(await createSpecOf(ws))
        created = true
        await startContainer(name)
      }
    } else {
      setLive(slug, { phase: 'image' })
      await ensureContainerImage(cfg.image)
      setLive(slug, { phase: 'run' })
      await createOrReplace(await createSpecOf(ws))
      created = true
      await startContainer(name)
    }

    /*
     * 删除竞态：`doStart` 是长流程（拉镜像 + 建容器可能几十秒），这期间用户完全可能把项目
     * 删了 —— `removeProject` 那趟已经把这个 slug 的容器清过一遍，这里再 `docker run` 出来
     * 就是一个**没有记录、界面上看不见**的孤儿容器（只能靠下次启动的清扫）。所以建完立刻
     * 核对记录还在不在；不在就把刚起来的收掉，别留一份占端口的垃圾。
     */
    // 软删（用户移除了这个项目）同样算「记录不该再拉起容器」：记录还留在数据文件里
    // 是为了保住会话，不是为了让它在后台继续跑
    const live = domain.getWorkspace(ws.id)
    if (!live?.container || live.removedAt) {
      await stopContainer(name).catch(() => undefined)
      await removeContainer(name)
      clearLive(slug)
      return {}
    }

    setLive(slug, { phase: 'health' })
    // 端口**现读**（刚 run 出来的映射、或冷启动时当初定下的映射都走这里）；
    // 索引里没有就按名字再问一次 —— 同上，label 不是唯一真相
    const after = (await listProjectContainers()).get(slug) ?? (await containerByName(name))
    const port = after?.ports.get(8080)
    if (port === undefined) throw new Error('容器没有把 agent 端口（8080）映射到宿主')
    const health = await waitHealth(port)
    if (!health) {
      throw new Error(
        `等待容器内 agent 服务就绪超时（${Math.round(wakeTimeoutMs() / 1000)}s）—— 镜像可能没有正确启动`
      )
    }
    clearLive(slug)
    /**
     * 刚建的容器一定按当前形状建（挂载都在）；只是 `docker start` 起来的旧容器，
     * 只有指纹与当前配置一致时才敢说「挂了」。
     */
    const skillMounts = created || info?.spec === specOf(cfg) ? mountedSkillDirs() : []
    return { port, health, skillMounts }
  } catch (err) {
    await recordFailure(slug, err)
    return {}
  }
}

/**
 * 启动一个容器型项目（**幂等**：并发调用合并成一次，已在跑直接返回）。
 *
 * 起容器的入口都发生在**用户动作**上：项目菜单「容器状态 → 启动」、主区域启动卡片的
 * 「启动 / 重试」、以及对话链路 / 公网入口的按需拉起（`ensureContainerAgentReady`）。
 * **打开项目本身不启动** —— 前端以前会在挂载时自动调一次，用户要求改成手动。
 * **不抛错**：原因写在快照的 `error` 里，界面据此显示可重试的错误条
 * （与隧道启动同一个约定，见 `ssh/tunnels/[id]/start/route.ts`）。
 *
 * ⚠️ 一开始就置 `phase: 'prepare'`，**先 `markDirty` 再干活**：`doStart` 的前置动作
 * （探 docker / 读现有容器 / 形状比对）可能要几秒，不置阶段的话这段时间快照仍是 `stopped`，
 * 界面就停在「容器没有运行」上 —— 用户看到的正是「点了启动没反应」（虽然后台已经起了）。
 * 并发的第二个调用直接返回在跑的那个，不会覆盖已有的 `prepare`。
 *
 * ⚠️ `quiet` 只给**按需拉起**用（对话链路 / 公网入口）：那条路进来时容器**通常已经在跑**，
 * 置 `prepare` 会让快照短暂变成 `starting`，前端 `ContainerTabGate` 于是把标签内容换成
 * 「启动中 · 检测容器状态」那张卡 —— 用户报过「每发一条消息都要先闪一下检测容器状态的页面」。
 * 真需要冷启动时 `doStart` 自己会在动手那一刻置 `image` / `run` / `health`，进度不会丢。
 */
export async function startContainerProject(
  workspaceId: string,
  options?: { quiet?: boolean }
): Promise<StartResult> {
  const { ws, cfg } = containerConfigOf(workspaceId)
  const running = starting.get(cfg.slug)
  if (running) return running
  // 停止还在路上时先等它退干净：`docker start` 撞上正在退出的同名容器会直接失败
  // （`stopContainerProject` 那边已经把 `stopping` 推给前端了，界面这段时间显示「停止中」）
  const stoppingNow = stopping.get(cfg.slug)
  if (stoppingNow) {
    await stoppingNow
    // 等的那一下里可能已经有人起了（连点 / 另一条按需拉起的路）：让它说了算
    const started = starting.get(cfg.slug)
    if (started) return started
  }
  // quiet：不为「探 docker / 读现有容器」这一下改快照（见上面的注释）
  if (!options?.quiet) setLive(cfg.slug, { phase: 'prepare' })
  const promise = doStart(ws).finally(() => starting.delete(cfg.slug))
  starting.set(cfg.slug, promise)
  return promise
}

/**
 * 确保容器型项目跑起来，并给出**容器内 agent 控制面**（8080）在宿主上映射到的端口。
 *
 * 对话链路（`container-projects/turn.ts`）与公网入口的冷启动都要「先起容器、再拿到一个
 * 能连的端口」—— 两处各写一遍必然漂：漏掉 `live` 里的失败原因就只剩一句「端口没有了」。
 * **不抛错**，失败给一句可直接展示的原因。
 *
 * 端口**不缓存**：容器被重建（换镜像）后映射就换了，缓存下来等于连到一个没人监听的端口。
 * 它是 `doStart` 那一趟**现读**完带出来的（不是我们记的第二份真相），所以每轮都是新的。
 *
 * ⚠️ 走 `quiet`：这是**每条消息都会经过**的路，容器通常已经在跑，不能为「确认一下」把快照
 * 推成 `starting`（否则每发一条消息界面都要先闪一次「检测容器状态」，用户报过）。
 */
export async function ensureContainerAgentReady(
  workspaceId: string
): Promise<{ port: number; health?: AgentHealth; skillMounts?: string[] } | { reason: string }> {
  const { cfg } = containerConfigOf(workspaceId)
  const started = await startContainerProject(workspaceId, { quiet: true })
  // 端口与 `/health` 响应体都由 `doStart` 带出来了（快路就是它刚探过的那个）——
  // 这里不再为同一件事重跑一条 `docker ps`，那是每条消息都白付的一次子进程。
  if (started.port !== undefined) {
    return {
      port: started.port,
      ...(started.health ? { health: started.health } : {}),
      // 技能挂载也由 `doStart` 带出来（它知道这一趟是新建还是捡了个旧容器）
      ...(started.skillMounts ? { skillMounts: started.skillMounts } : {})
    }
  }
  // 兜底：`doStart` 没给出端口（失败 / 并发合并拿到的是别人的结果）时现读一次
  const info = (await listProjectContainers()).get(cfg.slug)
  // 8080 = 容器内 agent 控制面端口（`createSpecOf` 里那个 `127.0.0.1:<随机>` 映射）
  const port = info?.ports.get(8080)
  // 这条路上不知道那个容器是什么形状 → 技能挂载一律按「没挂」处理（`containerSkillList` 会裁掉）
  if (port) return { port, skillMounts: [] }
  return {
    reason:
      live.get(cfg.slug)?.error ??
      `容器还没有把 agent 端口（8080）映射到宿主，可能仍在启动 —— 稍后再试`
  }
}

/**
 * 公网入口用：按 slug 找一个「**配了预览端口**」的容器型项目。找不到 → `undefined`。
 *
 * 这里**不再只认已发布**：未发布的项目也能通过预览 key 访问（`?fizz_key=<key>`），
 * 所以把 `exposed` 与 `previewKey` 一起交给调用方（`public-gateway.ts`）裁决 ——
 * 已发布直接放行，未发布校验 key。
 *
 * ⚠️ **每次请求现算**（`listWorkspaces()` 直接扫）：项目增删是低频动作、量级是几十条，
 * 为它维护一份带失效逻辑的缓存不划算（spec §4.7）。这样就永远不会有「缓存里还留着、
 * 盘上已经删了」的第二种真相。
 *
 * ⚠️ 「不存在 / 没有预览端口」**统一返回 undefined**：调用方一律 404、不区分原因 ——
 * 区分就等于给了一个可枚举的探子（哪些 slug 存在）。
 */
export function previewProjectBySlug(slug: string):
  | { workspaceId: string; previewPort: number; exposed: boolean; previewKey?: string }
  | undefined {
  for (const ws of domain.listWorkspaces()) {
    const cfg = ws.container
    if (!cfg || cfg.slug !== slug || cfg.previewPort === undefined) continue
    return {
      workspaceId: ws.id,
      previewPort: cfg.previewPort,
      exposed: cfg.exposed === true,
      ...(cfg.previewKey ? { previewKey: cfg.previewKey } : {})
    }
  }
  return undefined
}

/**
 * 探测 `127.0.0.1:<port>` 上有没有人在监听（1000ms 超时）—— 公网入口的**快路**用它校验
 * 缓存里的端口还活着（判据只是「连得上」，所以最快）。
 *
 * ⚠️ **不要拿它当「预览服务就绪」的判据** —— docker 默认开着 `userland-proxy`，宿主端口上
 * 的连接是它**先接受**、再去连容器里那个端口的：容器里根本没人在听时裸 connect 照样
 * 「成功」。判就绪要用 `canServeHttp`（见它头上那段）。
 */
export function canConnect(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    const settle = (ok: boolean): void => {
      socket.destroy()
      resolvePromise(ok)
    }
    socket.setTimeout(timeoutMs, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * 探测 `127.0.0.1:<port>` 上**有没有人在讲 HTTP**（只看有没有响应头回来）。
 *
 * ⚠️ **`canConnect` 在这里会撒谎**：docker 的 `userland-proxy`（默认开）在宿主端口上先
 * `accept` 再去连容器内端口 —— 容器里没人在听时，裸 connect 也「成功」，真实失败要等
 * HTTP 请求真打过去才暴露。结果就是公网入口**跳过了那张「容器正在启动、每 3 秒自动重试」
 * 的页面**、直接甩一个裸 `502 Bad Gateway`（用户报过「netstat 明明有监听、访问域名却 502」）。
 * 所以「就绪」必须按**讲不讲 HTTP** 判，而不是「连不连得上」。
 *
 * 拿到响应头就立刻掐断（不读 body）：探测只关心这个端口讲不讲 HTTP，读完整个页面
 * 等于白跑一次渲染。状态码不挑 —— 能回 404 / 500 也说明「服务在」。
 */
export function canServeHttp(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let done = false
    const settle = (ok: boolean): void => {
      if (done) return
      done = true
      probe.destroy()
      resolvePromise(ok)
    }
    const probe = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
      settle(true)
      res.destroy()
    })
    probe.setTimeout(timeoutMs, () => settle(false))
    probe.on('error', () => settle(false))
    probe.end()
  })
}

/**
 * 确保容器型项目跑起来，并给出**容器内预览服务**在宿主上映射到的端口（公网入口冷启动用）。
 *
 * 与 `ensureContainerAgentReady` 同一形状，但等的是**预览端口**：容器起来了不代表用户那个
 * 服务在 listening（它是容器内 entrypoint / 用户项目里起的），所以要轮询到真能连上为止。
 * 超时上限同一份 `FIZZ_CONTAINER_WAKE_TIMEOUT_MS`。**不抛错**，失败给一句可直接展示的原因。
 */
export async function ensureContainerPreviewReady(
  workspaceId: string
): Promise<{ port: number } | { reason: string }> {
  const { cfg } = containerConfigOf(workspaceId)
  if (cfg.previewPort === undefined) {
    return { reason: '这个项目没有配预览端口，预览入口不可用' }
  }
  await startContainerProject(workspaceId)
  const deadline = Date.now() + wakeTimeoutMs()
  while (Date.now() < deadline) {
    const info = (await listProjectContainers()).get(cfg.slug)
    const port = info?.ports.get(cfg.previewPort)
    // ⚠️ 判据是「**讲不讲 HTTP**」而不是「连不连得上」：宿主端口前面站着 docker 的
    //    userland-proxy（先 accept 再连容器），裸 connect 会把「容器里没人在听」当成就绪，
    //    于是这里立刻返回端口、请求转发出去才失败 —— 用户看到的是裸 502 而不是下面那张
    //    可重试的启动页。见 `canServeHttp` 头上那段。
    if (port !== undefined && (await canServeHttp(port))) return { port }
    await sleep(500)
  }
  return {
    reason:
      live.get(cfg.slug)?.error ??
      `容器内预览服务（${cfg.previewPort}）在超时内没有就绪，可能启动中或没在监听 —— 稍后再试`
  }
}

/**
 * 停容器（**停而不删**）：端口映射与挂载都留着，下次 `docker start` 就够。
 *
 * ⚠️ **先置 `stopping` 再干活**：`docker stop` 有 5s 优雅退出窗口（容器里那个服务不理会
 * SIGTERM 时会走满），这期间 `docker ps` 仍把它算作 Up —— 不置这个标记的话快照一直报
 * `running`，主区域的门就继续放行对话面板，用户点了「停止容器」却还停在对话里，看着像
 * 没停成（用户报过）。置了之后快照立刻变成 `stopping`，门收起、侧栏写「停止中」。
 *
 * 顺带清掉本进程的启动态（上一次的 error 是「上一次」的）；并发调用合并成一条 `docker stop`。
 */
export async function stopContainerProject(workspaceId: string): Promise<void> {
  const { cfg } = containerConfigOf(workspaceId)
  const pending = stopping.get(cfg.slug)
  if (pending) return pending
  setLive(cfg.slug, { stopping: true })
  const promise = (async () => {
    await stopContainer(containerNameOf(cfg.slug)).catch(() => undefined)
    // 清掉 `stopping`（`clearLive` 自己会 markDirty），再推一次让快照按 `docker ps` 现读
    clearLive(cfg.slug)
    markDirty(['containerProjects'])
  })().finally(() => stopping.delete(cfg.slug))
  stopping.set(cfg.slug, promise)
  return promise
}

/**
 * 强制重建容器（同镜像也重建）：停 → 删 → 起。
 *
 * 两个用途，都不是「换配置」：
 * 1. **镜像重新构建后让它真正生效** —— 容器是 `docker run` 那一刻的镜像快照，
 *    重建镜像不会影响已在跑的容器（设置页点完「重新构建」必须能接上这一步）；
 * 2. 容器被弄脏（依赖装坏 / 系统目录被改）时重置到干净状态。
 *
 * ⚠️ 删的是**容器**，不是 `/workspace` 里挂载的项目文件 —— 代码与提交都还在。
 * 启动失败与 `startContainerProject` 同约定：原因落在快照的 `error` 里，不抛错。
 */
export async function rebuildContainerProject(workspaceId: string): Promise<void> {
  const { cfg } = containerConfigOf(workspaceId)
  await stopContainerProject(workspaceId)
  await removeContainer(containerNameOf(cfg.slug))
  clearLive(cfg.slug)
  markDirty(['containerProjects'])
  await startContainerProject(workspaceId)
}

// ---------- 修改（改名 / 换镜像 / 公网访问开关 / 资源限额） ----------

/**
 * 改一个容器型项目。
 *
 * - `name`：走 `domain.addWorkspace`（逐字段重建，那边**保留了 `container`**，见 Task 2）；
 * - `image`：**改了就得销毁重建** —— 镜像 tag 与端口映射都是 `docker run` 那一刻定下的，
 *   改配置而不重建 = 界面上一套、容器里另一套。预览端口跟着镜像走（用户不填，见 create.ts）；
 * - `exposed`：只影响公网入口的判定，不动容器；
 * - `memoryLimitMb` / `cpus`：只落盘，**这里不动容器** —— 它们是「下次 `docker run` 才生效」
 *   的东西。运行中的容器按旧参数继续跑（用户选了「暂不重启」就该真的不被打断），下一次
 *   启动时 `doStart` 用指纹（`specOf`）发现对不上，自动删容器按新参数重建。
 *   想立刻生效由前端接着调 `POST /:id/rebuild`（停 → 删 → 起）。
 *
 * ⚠️ 故意**不**自动重启：改完由用户自己决定何时重启（项目菜单的「重启容器」）。
 * 资源限额靠指纹在下次启动时补上。
 */
export async function updateContainerProject(
  workspaceId: string,
  input: ContainerProjectUpdateInput
): Promise<AgentWorkspace> {
  const { ws, cfg } = containerConfigOf(workspaceId)
  const name = input.name?.trim()
  if (input.name !== undefined) {
    if (!name) throw new ProjectServiceError(400, '名称不能为空')
    const reason = invalidNameReason(name)
    if (reason) throw new ProjectServiceError(400, reason)
  }
  if (input.image !== undefined && !CONTAINER_ENV_IMAGES.some((img) => img.id === input.image)) {
    throw new ProjectServiceError(400, `不支持的运行环境镜像：${input.image}`)
  }
  const resourceReason = resourceInputError(input)
  if (resourceReason) throw new ProjectServiceError(400, resourceReason)
  if (input.previewKey !== undefined) {
    const keyReason = previewKeyError(input.previewKey)
    if (keyReason) throw new ProjectServiceError(400, keyReason)
  }
  // 预览端口**跟着镜像走**（用户不填、也改不了）：换镜像时容器侧 `-p` 的目标端口要一起变，
  // 否则 `docker run` 还按旧镜像的端口映射，预览永远是空的
  const nextPreviewPort =
    input.image !== undefined
      ? CONTAINER_ENV_IMAGES.find((img) => img.id === input.image)?.suggestedPreviewPort
      : cfg.previewPort

  const nextCfg: ContainerProjectConfig = {
    ...cfg,
    ...(input.image !== undefined ? { image: input.image } : {}),
    ...(nextPreviewPort !== undefined ? { previewPort: nextPreviewPort } : {}),
    ...(input.exposed !== undefined ? { exposed: input.exposed } : {}),
    // 换 key = 换锁：已经拿着旧链接的人立刻失效（cookie 里存的旧值也对不上）
    ...(input.previewKey !== undefined ? { previewKey: input.previewKey } : {}),
    // `0` 是**显式取消限制**（不能靠 `undefined` 表达，否则清空输入框永远改不掉旧值）
    ...(input.memoryLimitMb !== undefined
      ? { memoryLimitMb: normalizeMemoryLimitMb(input.memoryLimitMb) }
      : {}),
    ...(input.cpus !== undefined ? { cpus: normalizeCpus(input.cpus) } : {})
  }
  // 发布开关只在「这个项目确实有预览端口」时可开（没端口就没有可发布的东西）
  if (nextCfg.exposed === true && nextCfg.previewPort === undefined) {
    throw new ProjectServiceError(400, '该项目没有预览端口，不能对外发布')
  }

  const recreate = nextCfg.image !== cfg.image || nextCfg.previewPort !== cfg.previewPort
  if (recreate) {
    // 先停再删：`docker rm` 会强杀，先 stop 让容器有机会自己收尾
    await stopContainerProject(workspaceId)
    await removeContainer(containerNameOf(cfg.slug))
  }

  return domain.addWorkspace({
    id: ws.id,
    path: ws.path,
    // ⚠️ **必须带上现有名字**：`addWorkspace` 在没给 `name` 时回落到**目录 basename**，
    // 而容器型项目的目录是一串随机 slug —— 只改发布开关 / 换镜像时若不带名字，
    // 显示名会被悄悄换成那串 slug（`...(name ? { name } : {})` 正是这个坑）
    name: name || ws.name,
    container: nextCfg
  })
}

// ---------- 快照 ----------

/**
 * docker 「不可用」判定的缓存：**只缓存坏消息**，60s 后自动重探。
 *
 * - 好消息（可用）**不缓存** —— 名字会骗人：`dockerVersion()` 自己有 30s 成功缓存，
 *   这里再叠一层就像把「刚才能用」锁死一分钟；而它内部只是一次 socket 往返（1–3ms）。
 * - 坏消息 60s：这条判定会随每次推送重算，没必要反复去撞一个连不上的 socket。到期后
 *   下一拍自动重探，所以「Docker Desktop 起来了」最多等 60s 界面自己就恢复 —— 这也是
 *   卡片上「重试」按钮能生效的前提（重试会先清掉这份缓存，见 `retryDockerProbe`）。
 */
let dockerProbe: { at: number; reason?: string } | null = null

async function dockerReason(): Promise<string | undefined> {
  const now = Date.now()
  if (dockerProbe && dockerProbe.reason && now - dockerProbe.at < 60_000) return dockerProbe.reason
  const version = await dockerVersion()
  const reason = version ? undefined : (dockerUnavailableReason() ?? 'docker 不可用')
  dockerProbe = reason ? { at: now, reason } : null
  return reason
}

/**
 * 丢掉 docker 探测的两层缓存并立刻重算快照 —— 启动卡片 / 容器菜单上的「重试」走这里。
 *
 * 不这么做的话，用户把 Docker Desktop 起来后点重试，**最多要等 60s 才可能变好**（甚至
 * 因为 `dockerVersion()` 那层缓存还要更久），看起来就是「重试没用」。清缓存只会让下一次
 * 探测真的去问一次 daemon，探测本身很便宜。
 *
 * 返回最新的原因（`undefined` = 现在可用了）。
 */
export async function retryDockerProbe(): Promise<string | undefined> {
  dockerProbe = null
  const reason = await dockerReason()
  markDirty(['containerProjects'])
  return reason
}

/** 容器是不是「旧形状」：落盘配置与它 `docker run` 时的指纹对不上（没有容器 = 不算） */
function isStaleShape(cfg: ContainerProjectConfig, info: ProjectContainerInfo | undefined): boolean {
  if (!info) return false
  if (info.spec === undefined) {
    // 升级前建的容器没有指纹：只有「确实配了资源限额」才算待生效（与 `doStart` 同一口径）
    const { memoryMb, cpus } = resourceOf(cfg)
    return memoryMb > 0 || cpus > 0
  }
  return info.spec !== specOf(cfg)
}

function stateOf(
  ws: AgentWorkspace,
  cfg: ContainerProjectConfig,
  info: ProjectContainerInfo | undefined,
  liveState: LiveState | undefined
): ContainerProjectState {
  const agentPort = info?.ports.get(8080)
  const previewPort =
    cfg.previewPort !== undefined ? info?.ports.get(cfg.previewPort) : undefined
  const base = {
    workspaceId: ws.id,
    slug: cfg.slug,
    image: cfg.image,
    ...(agentPort !== undefined ? { agentPort } : {}),
    ...(previewPort !== undefined ? { previewPort } : {}),
    // 「改了但还没重启」：界面据此提示待生效，不必自己再算一遍
    ...(isStaleShape(cfg, info) ? { pendingRestart: true } : {})
  }
  if (liveState?.error) return { ...base, state: 'error', error: liveState.error }
  // 停的途中容器还在 `docker ps` 里（优雅退出窗口），**不能**报成 `running`：见 `LiveState.stopping`
  if (liveState?.stopping) return { ...base, state: 'stopping' }
  if (liveState?.phase) {
    // ⚠️ 只有 `image` 带构建日志：`prepare` / `run` / `health` 期间那份日志是**上一次**
    // 构建留下的旧内容，带上它会让人以为「现在正在构建」。
    const log =
      liveState.phase === 'image' ? containerImageBuildLog(cfg.image).join('\n') : ''
    return {
      ...base,
      state: 'starting',
      phase: liveState.phase,
      ...(log ? { buildLog: log } : {})
    }
  }
  return { ...base, state: info?.running ? 'running' : 'stopped' }
}

/**
 * 容器型项目的整体快照（state ws 的一个域 / `GET /api/container-projects`）。
 *
 * `available === false`（docker 不可用）时前端整块不渲染 —— 这是「服务端专属能力」的
 * 门控之一（桌面端没有 docker 就自然看不到这个功能，不需要任何专属代码）。
 *
 * ⚠️ 引擎连不上时**仍然带上 `projects`**（以及各自 `state: 'error'` + 那句连接错误）：
 * 前后端如果只给 `available: false`，前端 `ContainerTabGate` 会把用户手上的容器项目
 * 直接从侧栏摘掉，看起来像「项目没了」；而这里给出项目与原因，界面就能显示一张
 * 「连不上 docker 引擎 · 重试」的卡片，容器起来后原地恢复。
 */
export async function containerProjectsSnapshot(): Promise<ContainerProjectsSnapshot> {
  // `domains` 只在公网入口**确实能用**时才给 —— 配了域名但公网端口没在监听 = 外面连不进来，
  // 界面上却给出一个打不开的公网地址（见 `publicGatewayEnabled` 的注释）
  const domains = publicGatewayEnabled() ? publicDomainNames() : []
  const workspaces = domain.listWorkspaces().filter((ws) => ws.container)
  const reason = await dockerReason()
  if (reason) {
    return {
      available: false,
      reason,
      ...(domains.length ? { domains } : {}),
      projects: workspaces.map((ws) => {
        const cfg = ws.container!
        // 预览端口此时读不到（`docker ps` 都连不上）：只保留配置里那几个静态字段
        return {
          workspaceId: ws.id,
          slug: cfg.slug,
          image: cfg.image,
          state: 'error' as const,
          error: dockerDownReason()
        }
      })
    }
  }
  const containers = await listProjectContainers()
  return {
    available: true,
    ...(domains.length ? { domains } : {}),
    projects: workspaces.map((ws) =>
      stateOf(ws, ws.container!, containers.get(ws.container!.slug), live.get(ws.container!.slug))
    )
  }
}
