# DeepSeek Harness Sandbox 结论

## 结论：Agent 执行命令时 sandbox 能挡住

**是的，可以挡住。** Agent 通过 `shell` 工具执行命令时，命令不是裸跑的，而是先被 sandbox 包一层 wrapper 再执行。

## 执行流程

1. `execute()` 判断模式 —— `danger-full-access` 直接放行，不包 sandbox
2. 其他模式走 `confine()` → `ctx.sandbox.confine(['bash', '-c', command], policy, signal)` 把命令包一层
3. 包装后的 argv（如 `bwrap --ro-bind / / ... -- bash -c '...'`）再交给底层 spawn
4. 命令跑完后，`classifyDenial()` 用 exit code + stderr 比对当前后端的拒绝签名：
   - bwrap: `read-only file system`
   - Landlock: `permission denied`
   - Seatbelt: `operation not permitted`
   - Windows ACL: `access is denied` / `access to the path` / `permission denied` / `operation not permitted`
5. 命中就标记 `denied: true`
6. 如果 runner 自己挂了（如 bwrap 不存在），抛 `SandboxUnavailableError`

## 三种文件效果模式

| 模式 | 效果 |
|---|---|
| `read-only` | 只读，仅允许 `/dev/null` 等必需接收器 |
| `workspace-write` | 可写工作区根目录 + 平台临时目录 |
| `danger-full-access` | 绕过限制，原始 argv 直接执行 |

## 升级机制

被挡之后模型还能走 escalation——`sandbox_permissions` + `justification` 向用户申请提权，批准后这次调用用更宽的模式重跑。

## 局限

- sandbox **只管文件效果**（读写），不管网络、进程可见性、syscall、设备、凭据
- 所以 `curl` 这类命令 sandbox 挡不住——它只挡文件写入
- 同世界限制：容器/微 VM/远程执行需要替换整个能力实现，而不是加一个后端
