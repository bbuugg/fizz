"use client";

/**
 * 「添加 / 编辑主机」表单弹窗：**本地终端** 与 **SSH 主机** 共用一套表单，
 * 顶部用 Tab（`Tabs`）切换两种类型（参考 dogi 的 `SshProfileDialog`）。
 * 编辑已有条目时**不显示**类型 Tab —— 类型不可改。
 *
 * 主机管理现在归「主机」功能区：拆成「清单（`HostsSidebar`）+ 表单（本文件）」两半，
 * 清单常驻侧栏，表单只在点「添加 / 编辑」时出现。
 *
 * 配置存在**服务端**（`agent-core.json`）：
 * - SSH 条目的密码 / 私钥 / passphrase 由服务端加密落盘、**不再回传**（列表里只有 `has*`
 *   脱敏标记），所以编辑时凭据输入框一律留空，留空 = 保留原值（要清空得显式清掉）；
 * - 本机终端条目没有任何凭据，只记 shell / 启动参数 / 启动后自动执行的命令。
 *
 * 新增与编辑复用同一个表单：同一个 POST 路由，带 id 即更新、不带即新建
 * （服务端 `saveSshHost` 约定，见 packages/workspace/src/domain.ts）。
 *
 * ## 版式
 *
 * 弹窗**窄**（`sm:max-w-md`，只比默认真宽一档），字段一律**单列**：
 * 「宽」不是目的，宽度照最长的一条 placeholder 定就够了 —— 剩下的横向空间
 * 只会变成输入框里的空白，或者逼着字段两两配对（半列宽连主机地址都放不下）。
 * 类型 Tab 与表单字段同处一个带边框的面板里（`border` + 顶部 `border-b`），
 * 两者是一块「编辑面板」的两部分，而不是「弹窗标题下的第二个标题栏」。
 */
import { useEffect, useState } from 'react'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { Label } from '@fizz/ui/label'
import { Textarea } from '@fizz/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@fizz/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@fizz/ui/tabs'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { HostConfig, HostKind, SshAuthType, SshCharset, SshHostConfig } from '@fizz/contracts/types'
import {
  DEFAULT_SSH_PORT,
  hostSummary,
  parseKeepaliveInput,
  parsePortInput
} from '@fizz/agent-kit/features/hosts/host-format'

/** 缺省保活（与服务端归一化保持一致，表单留空时按它回填提示） */
const DEFAULT_KEEPALIVE = 30

/**
 * 跳板机下拉里「不使用跳板」那一项的值。
 *
 * Radix 的 `SelectItem` **不接受空串**（空串是「没选中」的保留值，传了会直接抛错），
 * 而我们的语义恰恰是「空串 = 不设跳板」，所以下拉内部用这个哨兵值、进表单时再换回空串。
 */
const NO_JUMP = '__none__'

/** 本机终端 shell 下拉里「跟随平台默认」那一项的值（同上：Radix 不接受空串） */
const NO_SHELL = '__default__'

/**
 * **新增**条目时默认选中的类型：本地终端。
 *
 * 与下面 Tab 的顺序对齐 —— 第一个 Tab（本地终端）就该是默认那个。原先默认 `'ssh'`，
 * 于是「默认选中的是第二个 Tab」，一眼看着像选错了。
 * ⚠️ 只影响**新增**：编辑时类型跟着条目走（历史条目没有 `kind` 字段，按 `'ssh'` 解释）。
 */
const DEFAULT_NEW_KIND: HostKind = 'local'

export function HostDialog({
  app,
  open,
  editing,
  defaultGroupId,
  onOpenChange
}: {
  app: AgentApp
  open: boolean
  /** 正在编辑的条目；`null` = 新增 */
  editing: HostConfig | null
  /**
   * 新增时的归属分组（分组行的「在此分组添加」传进来）。
   * **只用于新增**：编辑已有条目时改归属走拖拽 / `arrangeHosts`，不在这张表单里改
   * （不然「改个端口」这类编辑会顺手动归属，与 `SshHostConfig.groupId` 的约定相悖）。
   */
  defaultGroupId?: string
  onOpenChange: (open: boolean) => void
}) {
  const { terminalShells } = useAppContext()
  const t = useT()

  /** 条目类型：本地终端 / SSH 主机（Tab 切换）；新增时的默认见 `DEFAULT_NEW_KIND` */
  const [kind, setKind] = useState<HostKind>(DEFAULT_NEW_KIND)

  // ---- 共用 ----
  const [name, setName] = useState('')

  // ---- 本机终端 ----
  const [shellId, setShellId] = useState('')
  /** 打开时的工作目录：**这条终端自己的配置**（空 = 主目录），与当前项目无关 */
  const [cwd, setCwd] = useState('')
  /** 启动参数：**每行一个**（不做引号解析，省掉「空格还是引号」的歧义） */
  const [argsText, setArgsText] = useState('')
  const [autoCommand, setAutoCommand] = useState('')

  // ---- SSH ----
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [authType, setAuthType] = useState<SshAuthType>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [jumpHostId, setJumpHostId] = useState('')
  const [charset, setCharset] = useState<SshCharset>('utf-8')
  const [keepalive, setKeepalive] = useState('')

  /**
   * 每次**打开**时按目标预填一遍。
   *
   * 预填放在 effect 而不是 `useState` 初始值：弹窗本体常挂载（Radix 只卸载内容），
   * 而编辑目标会变 —— 用初始值就永远是第一次那条条目的数据。
   * SSH 凭据一律留空：服务端只回 `has*` 标记，明文拿不回来；留空 = 保留原值。
   */
  useEffect(() => {
    if (!open) return
    // 编辑：类型跟着条目（历史条目没有 kind 字段 → 按 ssh）；新增：默认本地终端
    setKind(editing ? (editing.kind ?? 'ssh') : DEFAULT_NEW_KIND)
    setName(editing?.name ?? '')
    setShellId(editing?.kind === 'local' ? (editing.shellId ?? '') : '')
    setCwd(editing?.kind === 'local' ? (editing.cwd ?? '') : '')
    setArgsText(editing?.kind === 'local' ? (editing.args ?? []).join('\n') : '')
    setAutoCommand(editing?.kind === 'local' ? (editing.autoCommand ?? '') : '')
    setHost(editing?.kind === 'local' ? '' : (editing?.host ?? ''))
    setPort(editing?.kind === 'local' ? '' : editing ? String(editing.port) : '')
    setUsername(editing?.kind === 'local' ? '' : (editing?.username ?? ''))
    setAuthType(editing?.kind === 'local' ? 'password' : (editing?.authType ?? 'password'))
    setPassword('')
    setPrivateKey('')
    setPassphrase('')
    setJumpHostId(editing?.kind === 'local' ? '' : (editing?.jumpHostId ?? ''))
    setCharset(editing?.kind === 'local' ? 'utf-8' : (editing?.charset ?? 'utf-8'))
    setKeepalive(
      editing?.kind === 'local' ? '' : editing ? String(editing.keepaliveInterval ?? DEFAULT_KEEPALIVE) : ''
    )
  }, [open, editing])

  /** 切换类型时把**名称**留空不是好体验，但也别把 SSH 的名称带进本地终端 —— 各自独立输入 */
  const switchKind = (next: HostKind): void => setKind(next)

  /**
   * 按类型收窄编辑目标：`editing` 是联合类型，而 `kind` 是运行时状态、TS 不会把它们关联起来，
   * 所以 SSH 分支要读 `hasPassword` 这类字段时得先自己收窄一次。
   */
  const sshEditing = editing && editing.kind !== 'local' ? editing : null

  /** 保存本机终端条目：名称必填；参数按行拆（空行丢掉），shellId 空 = 平台默认 */
  const saveLocal = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName) return
    const args = argsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const shell = shellId && terminalShells?.shells.find((s) => s.id === shellId)
    const ok = await app.saveSshHost({
      kind: 'local',
      ...(editing ? { id: editing.id } : {}),
      ...(editing || !defaultGroupId ? {} : { groupId: defaultGroupId }),
      name: trimmedName,
      // 空串 = 不传（服务端归一成「平台默认」）；Select 的空值哨兵在这里换回来
      ...(shellId ? { shellId } : {}),
      ...(shell ? { shellName: shell.name } : {}),
      // 工作目录**始终传**（可能是空串）：空串 = 清掉、回落主目录。
      // 不传会被服务端当成「保留原值」，那样编辑时把目录清空反而清不掉。
      cwd: cwd.trim(),
      // args 始终传（可能是空数组）：空数组 = 清掉原参数。
      // 传 undefined 会被服务端当成「保留原值」，那样编辑时删光参数反而清不掉。
      args,
      autoCommand: autoCommand.trim()
    })
    if (ok) onOpenChange(false)
  }

  /** 保存 SSH 主机条目：凭据字段按需传（不填就不带，服务端保留原值） */
  const saveSsh = async (): Promise<void> => {
    if (!host.trim() || !username.trim()) return
    // 端口留空 = 默认 22，且**必须显式提交**：省略在服务端是「保留原值」，
    // 编辑时把端口清空就永远清不掉
    const parsedPort = parsePortInput(port)
    const parsedKeepalive = parseKeepaliveInput(keepalive)
    const ok = await app.saveSshHost({
      ...(editing ? { id: editing.id } : {}),
      ...(editing || !defaultGroupId ? {} : { groupId: defaultGroupId }),
      name: name.trim(),
      host: host.trim(),
      port: parsedPort,
      username: username.trim(),
      authType,
      ...(authType === 'password'
        ? password
          ? { password }
          : {}
        : privateKey
          ? { privateKey }
          : {}),
      ...(authType === 'privateKey' && passphrase ? { passphrase } : {}),
      // 空串 = 清掉跳板（服务端把空串归一成「不设跳板」）
      jumpHostId: jumpHostId,
      charset,
      // 0 = 关闭保活，必须显式传：省略这个字段服务端会保留上一次的值
      ...(parsedKeepalive !== undefined ? { keepaliveInterval: parsedKeepalive } : {})
    })
    if (ok) onOpenChange(false)
  }

  const save = (): Promise<void> => (kind === 'local' ? saveLocal() : saveSsh())

  /** 可选的跳板机：除自己以外的所有 **SSH** 主机（本机终端不能当跳板） */
  const jumpOptions = app.sshHosts.filter(
    (h): h is SshHostConfig => h.kind !== 'local' && h.id !== editing?.id
  )

  const canSave = kind === 'local' ? name.trim().length > 0 : host.trim().length > 0 && username.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        宽度：`sm:max-w-md`（448px）—— 只比 Dialog 默认的 `sm:max-w-sm` 宽一档。
        曾经是 `2xl`（672px）并因此把 SSH 字段排成两列：那是**为了填满横向空间**在摊
        字段，不是字段本身需要那么宽，看着又空又散。现在按内容定宽（最长的一条
        placeholder「主机地址，如 10.0.0.8」够放下就行），字段全部单列 ——
        弹窗窄了，行数多了一两行，换来的是扫一眼就能读完的表单。
        限高 75vh：表单区自己滚、头尾常驻，弹窗不再顶满视口。
      */}
      <DialogContent className="flex max-h-[75vh] flex-col gap-3 overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {kind === 'local'
              ? (editing ? t('编辑本地终端') : t('添加本地终端'))
              : (editing ? t('编辑 SSH 主机') : t('添加 SSH 主机'))}
          </DialogTitle>
        </DialogHeader>

        {/*
          min-h-0 别删：DialogContent 是 grid，而 grid 子项默认 `min-height: auto` ——
          不给 0 的话这个 `flex-1` 容器宁可把弹窗顶破（超出 max-h-[75vh]），
          也不会交出高度、让下面的表单区滚起来。min-h-0 才让表单区真正成为滚动容器。
        */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 类型选择 Tab：本地终端 / SSH（两种写法的字段完全不同，一眼看清当前是哪种）。
              编辑已有条目时不显示 —— 类型不可改（要换类型就删了重建）。
              紧贴表单区的顶边：它和下面的字段是同一块「编辑面板」的两个部分 */}
          {!editing && (
            <Tabs
              value={kind}
              onValueChange={(value) => switchKind(value as HostKind)}
              className="w-full shrink-0"
            >
              <TabsList className="w-full">
                <TabsTrigger value="local">{t('本地终端')}</TabsTrigger>
                <TabsTrigger value="ssh">SSH</TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          {/* min-w-0 别删：本层是 flex 子项，默认 `min-width: auto`，
              而 Textarea 带 `field-sizing-content`（按内容定尺寸）—— 私钥里的一行长文本
              会把这一列顶得比弹窗还宽，输入框直接溢出去 */}
          <form
            className="min-w-0 flex-1 space-y-3 overflow-y-auto py-3 no-scrollbar"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            {kind === 'local' ? (
              <>
                <Input
                  placeholder={t('名称，如「项目终端」「Git Bash」')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />

                <div className="flex flex-col gap-1.5">
                  <Label>Shell</Label>
                  <Select
                    value={shellId || NO_SHELL}
                    onValueChange={(value) => setShellId(value === NO_SHELL ? '' : value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_SHELL}>{t('跟随平台默认')}</SelectItem>
                      {terminalShells?.shells.map((shell) => (
                        <SelectItem key={shell.id} value={shell.id}>
                          {shell.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {terminalShells && terminalShells.shells.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t('这台机器上没检测到可选的终端。')}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="local-cwd">{t('工作目录')}</Label>
                  <Input
                    id="local-cwd"
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder={t('留空 = 主目录，如 D:\\code\\demo')}
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                  />
                  {/*
                    这条提示是必要的：本机终端与项目**无关**，不会跟着当前打开的项目跑。
                    不写清的话用户会以为「我在项目里点它，就该在这个项目目录」。
                  */}
                  <p className="text-xs text-muted-foreground">
                    {t('这条终端固定从这个目录打开，与当前打开的项目无关；留空 = 主目录。')}
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="local-args">{t('启动参数')}</Label>
                  <Textarea
                    id="local-args"
                    rows={2}
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder={`${t('每行一个参数，如')}\n--login`}
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('追加在 shell 自带参数之后；不做引号解析，所以一行就是一个参数。')}
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="local-auto">{t('启动后自动执行')}</Label>
                  <Input
                    id="local-auto"
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder={t('如 npm run dev（留空 = 不执行）')}
                    value={autoCommand}
                    onChange={(e) => setAutoCommand(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t('终端起来后自动敲这一条命令。')}</p>
                </div>
              </>
            ) : (
              /*
                SSH 字段多：窄弹窗里排不下两列，所以**全部单列**，
                用「短字段两两配对」换来的高度优势让位给一个不挤的宽度。
                ⚠️ 别为了省高度把这里改回两列 —— 弹窗一窄，半列宽连 `10.0.0.8`
                这样的地址都快放不下，placeholder 全被截断。
              */
              <div className="flex flex-col gap-3">
                <Input
                  placeholder={t('名称（可留空）')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Input
                  placeholder={t('主机地址，如 10.0.0.8')}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
                {/* 端口与用户名一行：一个 5 位数、一个通常十来个字符，
                    1:2 分栏两边都不挤，是这里唯一还划算的配对 */}
                <div className="grid grid-cols-[minmax(5.5rem,1fr)_2fr] gap-3">
                  <Input
                    inputMode="numeric"
                    placeholder={t('端口 {port}', { port: DEFAULT_SSH_PORT })}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                  <Input
                    placeholder={t('用户名，如 root')}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>

                {/* 认证方式 Tab：两种写法字段完全不同，一眼看清当前是哪种 */}
                <Tabs value={authType} onValueChange={(value) => setAuthType(value as SshAuthType)} className="w-full">
                  <TabsList className="w-full">
                    <TabsTrigger value="password">{t('密码')}</TabsTrigger>
                    <TabsTrigger value="privateKey">{t('私钥')}</TabsTrigger>
                  </TabsList>
                </Tabs>

                {authType === 'password' ? (
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder={sshEditing?.hasPassword ? t('密码（留空 = 不修改）') : t('密码')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                ) : (
                  <>
                    <Textarea
                      // 3 行够看个开头，私钥本体没必要在这里全展开（弹窗要矮）
                      rows={3}
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder={t('私钥内容，如 -----BEGIN OPENSSH PRIVATE KEY-----')}
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                    />
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder={t('私钥口令（没有就留空）')}
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                  </>
                )}

                {/* 跳板机：连目标前先连它，支持多级串联（成环由服务端拒绝）。
                    值在「空串 = 不设跳板」与哨兵值之间转一次 —— Radix 不允许 SelectItem 用空串。
                    独占整行：选项文案是「名称（user@host:port）」，半行会被截得看不出是哪台 */}
                <div className="flex flex-col gap-1.5">
                  <Label>{t('跳板机')}</Label>
                  <Select
                    value={jumpHostId || NO_JUMP}
                    onValueChange={(value) => setJumpHostId(value === NO_JUMP ? '' : value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_JUMP}>{t('不使用跳板')}</SelectItem>
                      {jumpOptions.map((h) => (
                        <SelectItem key={h.id} value={h.id}>
                          {t('{name}（{summary}）', { name: h.name, summary: hostSummary(h) })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* 字符集与保活一行：一个两选 Tab、一个短数字，配在一起不挤 */}
                <div className="grid grid-cols-2 gap-3">
                  {/* 字符集：中文 Windows 服务器（代码页 936）上的老程序输出 GBK，显示乱码时切过来 */}
                  <div className="flex flex-col gap-1.5">
                    <Label>{t('字符集')}</Label>
                    <Tabs
                      value={charset}
                      onValueChange={(value) => setCharset(value as SshCharset)}
                      className="w-full"
                    >
                      <TabsList className="w-full">
                        <TabsTrigger value="utf-8">utf-8</TabsTrigger>
                        <TabsTrigger value="gbk">gbk</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ssh-keepalive">{t('保活（秒）')}</Label>
                    <Input
                      id="ssh-keepalive"
                      inputMode="numeric"
                      placeholder={String(DEFAULT_KEEPALIVE)}
                      value={keepalive}
                      onChange={(e) => setKeepalive(e.target.value)}
                    />
                    {/* 提示压成一行：半列宽里再写长句会折成三四行，把这一行撑得比旁边高 */}
                    <p className="text-xs text-muted-foreground">
                      {t('留空 = {n}；0 = 关。', { n: DEFAULT_KEEPALIVE })}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </form>
        </div>

        <DialogFooter className="shrink-0">
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button type="button" size="sm" disabled={!canSave} onClick={() => void save()}>
            {editing ? t('保存') : t('添加')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}