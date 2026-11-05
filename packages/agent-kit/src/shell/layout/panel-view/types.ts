"use client";

import { type ReactNode } from 'react'
import type { TabStatus } from '@fizz/agent-kit/shared/lib/tab-decorations'

/** 一个标签在标签条上的展示信息 */
export interface TabMeta {
  /** 标签条上的短名 */
  label: string
  /** 悬停提示（更完整的描述） */
  title: string
  /** 类型图标：一列标签里混着「对话 / 主机 / 终端」三种东西，光看名字分不出来 */
  icon: ReactNode
  /**
   * 图标右上角的状态点（绿 = 活着 / 红 = 已退出 / 琥珀 = 等人 / 主色 = 在跑）。
   *
   * 由 `useTabMeta` 合成两份来源：内建（会话运行态、终端进程存活）+ 外部登记表
   * （`tab-decorations.ts`，优先级更高）。没有就不画。
   */
  status?: TabStatus
}

/** `useGroupActions` 的返回值：组外壳（标签条）与标签内容层共用这一份 */
export interface GroupActions {
  /** 把这组设为焦点，并把「当前会话」对齐到它的活动标签 */
  focusGroup: (groupId: string) => void
  /** 点标签：切过去，再同步「当前会话」 */
  activateAndSync: (key: string) => void
  /** 关一批标签，再把「当前会话」对齐到焦点组顺移后的活动标签 */
  closeAndSync: (keys: string[]) => void
  /** 关掉整组（组里全部标签），再把「当前会话」对齐到焦点组顺移后的活动标签 */
  closeGroupAndSync: (groupId: string) => void
  /** 重命名对话标签 / 改工具标签的显示名（两条路的语义见 `renameTab`） */
  renameTab: (key: string, title: string) => void
  /**
   * 刷新标签：**对话标签** = 重新加载这条会话（等同刷新页面后点开它）；
   * **工具标签** = 卸载重挂（接口页重发请求 / 插件面重 render）。
   */
  reloadTab: (key: string) => void
}

/** 一个标签内容在屏幕上的落位（相对内容层左上角；单位 px，就是量出来的值） */
export interface TabSlot {
  left: number
  top: number
  width: number
  height: number
}
