/**
 * 沙箱提供方的内部契约（只在本包内流转，不进 `@fizz/contracts`）。
 *
 * 与 harness 的 `ConfinedArgv` 同形：除了替换后的 argv，还带两样**正交**的判定依据 ——
 * `denialSignatures` 认「沙箱正常工作、命令被挡了」，`runnerFailureRules` 认
 * 「沙箱自己没起来、命令根本没跑」。两者混在一起会把「被拒绝」误报成「沙箱坏了」，
 * 模型拿到的下一步建议就完全相反。
 */

/** 判定「runner 在执行命令前就失败了」的证据规则 */
export interface RunnerFailureRule {
  /** 只有这些退出码才允许命中；缺省 = 任意非零码 */
  allowedExitCodes?: readonly number[]
  /** 不区分大小写的致命诊断子串（如 `bwrap: `） */
  fatalSignatures: readonly string[]
  /**
   * 命中前先按**整行精确匹配**（不区分大小写）剔除的无害行。
   * 典型是 Landlock launcher 每次都会打印的 `partial enforcement` 通知 ——
   * 它不是失败，不能拿来当证据。
   */
  informationalLines?: readonly string[]
}

/** 沙箱提供方 `confine()` 的返回：真正要 spawn 的 argv + 判定事实 */
export interface ConfinedArgv {
  /** 包装后的完整 argv（runner、profile、`--`、调用方 argv） */
  argv: string[]
  /** 所选后端对该策略文件效果的管控完整度（Windows ACL 只能报 `partial`） */
  enforcement: 'full' | 'partial'
  /** **本后端**的拒绝方言（不是跨后端的并集） */
  denialSignatures: readonly string[]
  /** 本后端的 runner 失败证据规则 */
  runnerFailureRules: readonly RunnerFailureRule[]
  /**
   * 需要额外注入给 runner 进程的环境变量（会覆盖同名项）。
   *
   * 目前只有 Windows 用得上：runner 是一个 Node 脚本，Electron 打包态必须用
   * `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 才能把它当 node 跑。
   * 子进程（真正的命令）会继承 runner 的环境，这对 bash/cmd 是无害的。
   */
  env?: Record<string, string>
}
