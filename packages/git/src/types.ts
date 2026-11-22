/**
 * @fizz/git 的领域类型：git 面板 HTTP 契约（status / branches / log / diff / action）
 * 与 git 可用性探测。类型真源在本包，前端一律 `import type` 引用（类型会被编译期擦除，
 * 不会把 simple-git 拖进浏览器产物）。
 */

/**
 * 一个改动文件（就是 `git status --porcelain=v2` 的 XY 两位状态码）。
 *
 * `index` = 暂存区相对 HEAD 的状态，`worktree` = 工作区相对暂存区的状态；
 * 取值同 git：`M` 改 / `A` 增 / `D` 删 / `R` 重命名 / `C` 复制 / `U` 冲突 /
 * `?` 未跟踪 / `.` 无变化。于是：
 * - `index === '?'` → **未跟踪**（新文件，还没 `git add`）
 * - `index !== '.' && index !== '?'` → 有**已暂存**的改动
 * - `worktree !== '.'` → 有**未暂存**的改动（同一文件可以两组都在，各自看各自的 diff）
 */
export interface GitChange {
  /** 仓库根相对路径（统一 `/`） */
  path: string
  /** 重命名 / 复制前的路径（`R` / `C` 才有） */
  origPath?: string
  index: string
  worktree: string
}

/** 一条贮藏（`git stash list` 里的一行） */
export interface GitStashEntry {
  /** 引用名，形如 `stash@{0}`（git 命令直接用；0 = 最近一次） */
  ref: string
  /** 同上，只是拆出来的序号，方便界面按「最近一次」做文案 */
  index: number
  /** 贮藏说明（`git stash push -m` 给的那句，或 git 自动生成的 `WIP on <分支>: ...`） */
  message: string
}

/** `GET .../git/status` 应答 */
export interface GitStatusResult {
  /** 工作区目录不在 git 仓库里时 false，其余字段为空 */
  isRepo: boolean
  /** 仓库根绝对路径（工作区可能是它的子目录）；不是仓库 = null */
  root: string | null
  /** 当前分支名；分离头指针时为 null（看 `detached`） */
  branch: string | null
  /** 处于分离头指针（检出到某次提交，而不是分支） */
  detached: boolean
  /** 上游分支（如 `origin/main`）；没设 = null */
  upstream: string | null
  /** 相对上游领先 / 落后几个提交（没有上游时都是 0） */
  ahead: number
  behind: number
  changes: GitChange[]
  /**
   * 改动过多、列表被服务端截断过（只给了前若干项）时为 true。
   *
   * 典型场景：刚 `git init` 的目录还没有 `.gitignore`，未跟踪文件成千上万。
   * 界面上要据此**停用「全部暂存」这类按列表批量操作**，否则会静默漏掉文件。
   */
  truncated: boolean
  /**
   * 已配置的远端（`git remote -v` 里的 fetch 地址）。
   *
   * 界面据此判断「能不能推送」：没有远端时点推送不是注定失败一次，而是直接让用户填地址
   * （见 `set-remote` 动作）。
   */
  remotes: { name: string; url: string }[]
  /**
   * 贮藏栈（`git stash list`，最近一次在前）。
   *
   * 放在 status 里而不是单开一个接口：它跟改动列表一样是「每次刷新都该是最新的」，
   * 而贮藏 / 弹出 / 删除都会改工作区，本来就要跟着刷新。
   */
  stashes: GitStashEntry[]
}

/** `GET .../git/branches` 应答：本地分支 + 远端分支（都用来检出） */
export interface GitBranchesResult {
  current: string | null
  branches: string[]
  remotes: string[]
}

/** 一条提交（历史列表用；不返回父提交链，够「看历史 + 检出某次提交」） */
export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  /** 提交时间（ISO 8601） */
  date: string
}

/** `GET .../git/log` 应答 */
export interface GitLogResult {
  commits: GitCommit[]
}

/**
 * `GET .../git/diff` 应答：**原始 unified diff 文本**（客户端解析成 hunks 渲染）。
 *
 * 返回文本而不是结构化 hunks：diff 是 git 的母语，服务端不用替客户端决定怎么切；
 * 未跟踪的新文件（git diff 默认不输出）由服务端补一份「空 → 全文」的 diff。
 */
export interface GitDiffResult {
  path: string
  /** 二进制 / 无差异 / 过大时为 ``（客户端按空 diff 提示） */
  diff: string
}

/**
 * `GET .../git/commit` 应答：**一次提交**的元信息 + 改了哪些文件 + 原始 unified diff。
 *
 * 历史列表原先只能看到 subject 一行字，用户想「这次提交到底改了什么」只能去敲
 * `git show` —— 现在面板里点开就有。diff 仍返回**文本**（客户端 `parseUnifiedDiff`），
 * 与单文件 diff 同一个契约形状，不另造一套结构。
 */
export interface GitCommitDiffResult {
  hash: string
  short: string
  author: string
  date: string
  subject: string
  /**
   * 这次提交改了哪些文件（按 `git show --numstat` 的顺序）。
   * 空提交 / 纯 merge（合并提交默认不产出 diff）可能是空数组 —— 那时 UI 明说「没有文件改动」，
   * 不要渲染一个空的 diff 区让人以为加载失败。
   */
  files: GitCommitFileStat[]
  /** 二进制文件 / 无差异 / 过大时为 ``（客户端按空 diff 提示） */
  diff: string
}

/** 一次提交里一个文件的改动统计 */
export interface GitCommitFileStat {
  path: string
  /** git 的状态字母：`A` 新增 / `M` 修改 / `D` 删除 / `R` 重命名 / `C` 复制 */
  status: string
  /** `R` / `C` 时的旧路径；其余情况没有 */
  oldPath?: string
  insertions: number
  deletions: number
  /** 二进制文件：numstat 那一行是 `-\t-\tpath`，两个计数都得是 0 而不是 NaN */
  binary: boolean
}

/**
 * `POST .../git/action` 请求体（一次一个动作）。
 *
 * 刻意**不提供 `--force` 推送、也不提供 `reset --hard` 这类丢改动的操作**：
 * 面板能改仓库状态，但不会悄悄毁掉用户手上的工作。
 *
 * `delete-branch` 的 `force`（= `-D`）是唯一一处显式的破坏性开关，因为删分支这个意图
 * 本身就是「扔掉这条线」，而「还没合并」恰恰是最常见的正当删除场景。它的边界在于：
 * 必须由用户在确认框里勾选，且文案写清「删完只剩 reflog（默认约 90 天）能找回」。
 */
export type GitActionInput =
  /** 在**还不是仓库**的工作区目录里 `git init`（唯一不要求已是仓库的动作） */
  | { action: 'init' }
  /**
   * `git init` + 把目录里现有的内容**全部提交一次**（=「初始化仓库并做第一次提交」）。
   *
   * 给这条路径用：要在这个目录里开 **worktree**，但它还不是 git 仓库 —— 没有仓库
   * 无从下手。界面上先问用户要不要初始化，选「是」才发这个动作，然后继续建 worktree。
   *
   * 与 `init` 并列，是**少数不要求「已经是仓库」**的动作。目录本来就有仓库时不该走到这里
   * （界面上先用 `gitStatus.isRepo` 判过），服务端也会挡一下。
   */
  | { action: 'init-commit'; message?: string }
  | { action: 'stage'; paths: string[] }
  | { action: 'unstage'; paths: string[] }
  | { action: 'commit'; message: string }
  | { action: 'checkout'; ref: string }
  /** 新建分支并切过去；`from` 不给 = 从当前 HEAD 切（可以是分支名、远端分支或提交 hash） */
  | { action: 'create-branch'; name: string; from?: string }
  /**
   * **重命名本地分支**（`git branch -m <from> <to>`）：只改引用名，提交与工作区内容都不动；
   * 当前所在分支也能改名（HEAD 会跟着指向新名字，不会切走）。
   *
   * 与 `create-branch` 同一套名字校验（非空、不以 `-` 开头、不含空白）；目标名已存在时
   * 由服务端直接拒（`git branch -m` 报「already exists」的原话不够清楚）。
   */
  | { action: 'rename-branch'; from: string; to: string }
  /**
   * **删除本地分支**（`git branch --delete`）。破坏性，界面必须二次确认。
   *
   * 默认只删**已合并**的分支（判定交给 git 做，不自己算 merge-base）：分支上还有没并进
   * 任何本地分支的提交时 git 会拒绝，并把原话带回前端。要连未合并的一起删得显式
   * `force: true`（= `git branch -D`）。
   *
   * 刻意没有「顺手删掉远端同名分支」的开关：那是另一条不可逆路径，要删让用户显式走
   * `delete-remote-branch`。
   */
  | { action: 'delete-branch'; name: string; force?: boolean }
  /**
   * **删除远端分支**（`git push <remote> --delete <branch>`）。破坏性，界面必须二次确认。
   *
   * `remote` 与 `branch` 分开传、而不是给一个 `origin/feature/x`：分支名里允许带 `/`，
   * 从右边切不回去，只能按「第一段是远端名」拆（远端名本身不允许含 `/`）。
   * 与 `push` 一样要网络与凭据（`GIT_TERMINAL_PROMPT=0`，缺凭据立刻失败而不是挂住）。
   */
  | { action: 'delete-remote-branch'; remote: string; branch: string }
  /** 添加 / 修改远端地址（同名已存在就改它的 URL），填完就能推送 —— 省得用户去终端敲 */
  | { action: 'set-remote'; name: string; url: string }
  /**
   * **删除一个远端**（`git remote remove <name>`）。
   *
   * 只删「这个远端配在哪」，不动本地分支 / 提交，也不影响远端仓库本身 ——
   * 但它的远端跟踪分支（`refs/remotes/<name>/*`）与当前分支对它的上游配置会一起消失，
   * 所以界面上仍要给一次确认（与删分支同一个路子）。
   */
  | { action: 'remove-remote'; name: string }
  /**
   * **回退一个文件**（丢掉未提交的改动，界面上必须二次确认 —— 内容不可恢复）：
   * - `mode: 'worktree'`：只丢工作区那一份改动，已暂存的部分留着；未跟踪文件直接删除；
   * - `mode: 'all'`：连已暂存的一起丢，回到 HEAD（仓库还没提交过则只取消暂存、内容保留）。
   */
  | { action: 'rollback'; path: string; mode: 'worktree' | 'all' }
  /**
   * **批量回滚**：把这些文件回到上次提交。
   *
   * `mode` 与单文件 `rollback` 同一套语义（缺省 `all`，也就是「连已暂存的也一起丢」）：
   * - `mode: 'all'`：索引 + 工作区一起回到上次提交；仓库还没有任何提交（unborn HEAD）
   *   时回落成「只取消暂存、内容保留」，见服务端实现；
   * - `mode: 'worktree'`：只丢工作区那一份改动，已暂存的留着（界面上「更改」组的目录级回滚用它）。
   *
   * 刻意收 `paths` 而不是「整仓一把梭」：
   * - 只影响**界面上列出来的那些文件**（也就只在工作区范围内），仓库里别的改动不动 ——
   *   工作区只是仓库的一个子目录时，这一点很重要；
   * - 未跟踪的文件（以及只存在于暂存区的新文件）没有「上次提交」可回，回滚 = 把文件删掉；
   *   两种 mode 都一样，未跟踪文件不存在「保留工作区」这回事。
   *
   * 服务端对 ls-files / restore / rm --cached 一律**按命令行长度分块**执行，几千个文件
   * 也不会撞上系统命令长度上限（Windows ~32K 字符）。
   */
  | { action: 'rollback-all'; paths: string[]; mode?: 'worktree' | 'all' }
  /**
   * **回滚一个目录**（整棵子树，界面上目录行的回退按钮用它）。
   *
   * 收**目录路径**而不是枚举里面的文件 —— 目录作为 pathspec 交给 git 递归，几千个文件
   * 也只是一条命令（枚举会把命令行撑爆，Windows 上限约 32K 字符）。`mode` 语义与
   * `rollback` / `rollback-all` 同一套（缺省 `all`）：
   * - 未跟踪的文件 / 目录先清掉（`git clean -fd`，不碰 ignored）：两种 mode 都一样，
   *   未跟踪文件没有「上次提交」可回，回滚就是删。**必须赶在 unborn 回落的「取消暂存」
   *   之前** —— 取消暂存后那些文件会变成未跟踪，再 clean 就把内容误删了；
   * - `mode: 'worktree'`：只丢工作区那份改动（`git restore --worktree -- <dir>`），已暂存的留着；
   * - `mode: 'all'`：索引 + 工作区一起回到上次提交；仓库还没有任何提交（unborn HEAD）
   *   时回落成「只取消暂存、内容保留」（`git rm --cached -r`），见服务端实现。
   */
  | { action: 'rollback-dir'; path: string; mode: 'worktree' | 'all' }
  /**
   * 推送当前分支（不做强推）。
   *
   * - 不给 `remote`：按上游推（没有上游就 `--set-upstream origin`，没有 origin 则报错让用户先配远端）；
   * - 给了 `remote`：推到指定远端（界面上「推送到…」挑的那个）。没有上游时顺带 `--set-upstream`，
   *   已有上游时只推这一趟、**不改上游配置**。
   */
  | { action: 'push'; remote?: string }
  /** 拉取：从当前分支的上游拉取（`git pull`）。没有上游时会报错 —— 先推送一次设好上游，或先配置远端。 */
  | { action: 'pull' }
  /**
   * 贮藏当前改动（`git stash push`）：把工作区（和暂存区）的改动收进 stash 栈，工作区回到干净状态。
   *
   * `message` 给这次贮藏一个说明（git 会自动加上 `WIP on <分支>` 前缀）；
   * `includeUntracked` 连未跟踪文件一起收（= `-u`）—— 不收的话新文件会留在工作区。
   */
  | { action: 'stash-push'; message?: string; includeUntracked?: boolean }
  /** 弹出一次贮藏（`git stash pop [<ref>]`，不给 ref 就取最近一次）：应用**并**从栈里删掉 */
  | { action: 'stash-pop'; ref?: string }
  /** 应用一次贮藏但留在栈里（`git stash apply [<ref>]`） */
  | { action: 'stash-apply'; ref?: string }
  /** 删除一次贮藏（`git stash drop [<ref>]`，不给 ref 就删最近一次）。**破坏性**，界面要确认 */
  | { action: 'stash-drop'; ref?: string }

/** `POST .../git/action` 应答：git 的输出（推送这类成功也往 stderr 写，服务端已合并） */
export interface GitActionResult {
  output: string
}

/**
 * git 可用性探测（侧栏「项目」分组标题旁的告警、git 面板 / 建 worktree 的前置检查用）。
 *
 * 探测的是**服务端**机器上能不能跑 `git`（不是浏览器侧）：Fizz 的 git 操作、
 * 建 worktree 都发生在服务端，所以缺 git 要在服务端装。
 */
export interface GitStatus {
  /** git 可执行文件在 PATH 中（服务端能用） */
  available: boolean
  /** git 版本（探到才有，如 `git version 2.54.0.windows.1`） */
  version?: string
  /** 不可用时的原因（给用户看的一句话） */
  error?: string
}
