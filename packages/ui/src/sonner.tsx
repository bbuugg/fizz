import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      /*
       * 类型图标**按类型着色** —— 不写颜色时它们继承 `currentColor`（= toast 正文色，
       * 浅色主题下就是近黑），成功 / 失败 / 警告长一个样，只能靠读文字分辨。
       *
       * 几处约束：
       * - 用的是本仓库既有的语义色约定（`text-emerald-600 dark:text-emerald-400` 这套
        *   在 git 状态、插件块、消息面板里已统一），错误色走 `text-destructive` 主题 token
       *   （它在 `tokens.css` 的亮 / 暗两套里各有一个值，比写死 `text-red-600` 更跟主题）；
       * - **深色主题必须配 `dark:`**：toast 底色是 `--popover`，暗色下 600 档的绿 / 琥珀
       *   压在那块深底上几乎看不出颜色；
       * - `loading` 保持次要灰（`text-muted-foreground`）而不是彩色：它不是「结果」，
       *   给绿色 / 红色都会表达成「已经完成了」；
       * - 不要在别处再包一层 `<span>` 去上色：sonner 把 `icons` 的值直接放进
       *   `[data-icon]` 里，它自己的 CSS 只管尺寸与 margin、不设 color，
       *   类名挂在 svg 上就够（lucide 的 `stroke` 是 `currentColor`）。
       */
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
        ),
        info: <InfoIcon className="size-4 text-sky-600 dark:text-sky-400" />,
        warning: (
          <TriangleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" />
        ),
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
