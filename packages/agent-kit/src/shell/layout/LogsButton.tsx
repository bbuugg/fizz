/**
 * 底部状态栏右端的「应用日志」入口。
 *
 * 全 App 的业务事件日志**横跨所有功能区**（对话 / 流程 / 终端…），不归属任何单个
 * 侧栏 —— 所以它的入口要放在一个「哪儿都能点到」的常驻位置。原先在**顶部标题栏**（基于
 * 「顶栏所有视图都在场」的理由，见 desktop `TitleBar` / web `WebTitleBar`），但顶栏左边
 * 已经挤着品牌与（手机的）侧栏开关，再挂一颗就偏左、且与「身份区」混在一起。
 *
 * 现在挪到**底部状态栏的右端**：状态栏本就是「全局、低频、与当前功能区无关」的入口带
 * （见 `StatusBar.tsx` 文件头），`app-shell` 的 `actions` 槽位天然就是它的家，右下角一眼可及。
 */
import { ScrollText } from 'lucide-react'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { openLogsTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function LogsButton() {
  const t = useT()
  return (
    <IconTip label={t("应用日志")} side="top">
      <button
        type="button"
        className={STATUS_ITEM_CLASS}
        aria-label={t("应用日志")}
        onClick={() => openLogsTab()}
      >
        <ScrollText className="size-4" />
      </button>
    </IconTip>
  )
}
