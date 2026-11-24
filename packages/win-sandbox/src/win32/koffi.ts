/**
 * Koffi（FFI）的懒加载入口。
 *
 * 只有真要创建受限令牌时才 `require('koffi')`：koffi 会 dlopen 原生 .node，
 * 在非 Windows 或没装原生包的机器上直接 require 会把整条 import 链拖崩，而
 * 上层（探针 / 主进程）只想知道「这个后端能不能用」。
 */
import { createRequire } from 'node:module'

import type koffi from 'koffi'

/** Koffi runtime export type. */
export type Koffi = typeof koffi

const requireFromHere = createRequire(import.meta.url)

let cached: Koffi | undefined

/** 第一次调用时加载 Koffi；失败照常抛出（调用方按「后端不可用」处理）。 */
export function requireKoffi(): Koffi {
  cached ??= requireFromHere('koffi') as Koffi
  return cached
}
