"use client";

import { useCallback } from "react";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  ColorPicker,
  ColorPickerAlpha,
  ColorPickerSelection,
  ColorPickerHue,
  ColorPickerEyeDropper,
  ColorPickerOutput,
  ColorPickerFormat,
  type ColorPickerProps,
} from "./color-picker";

// 带 alpha 的 8 位 hex 也算合法：字段允许透明时，切换/回填不能再把 alpha 丢掉。
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function toHexChannel(n: number): string {
  const h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
  return h.length === 1 ? "0" + h : h;
}

/**
 * `allowAlpha` = false 时只输出 `#rrggbb`。
 *
 * 这是 `ColorPickerField` 曾经「透明度拖了没反应」的根因：picker 通过
 * `onChange([r,g,b,a])` **单独**把 alpha 交出来，而这里只拼了 rgb，alpha 被直接丢掉 ——
 * 滑块在动、状态也在变，但父组件收到的 hex 永远不透明。
 */
function rgbToHex(c: ArrayLike<number>, allowAlpha: boolean): string {
  const base = `#${toHexChannel(c[0])}${toHexChannel(c[1])}${toHexChannel(c[2])}`;
  if (!allowAlpha || c.length < 4) return base;
  const alpha = Math.max(0, Math.min(1, Number(c[3])));
  if (!Number.isFinite(alpha) || alpha >= 1) return base;
  return `${base}${toHexChannel(alpha * 255)}`;
}

type ColorPickerChangeValue = NonNullable<ColorPickerProps["onChange"]> extends (
  value: infer V,
) => void
  ? V
  : never;

interface ColorPickerFieldProps {
  value: string;
  onChange: (hex: string) => void;
  /** Show an editable hex input next to the swatch (default: true). */
  showHexInput?: boolean;
  /**
   * 允许输出带 alpha 的 `#rrggbbaa`，并在弹层里给出 alpha 滑块（default: false）。
   *
   * 默认关是有原因的：主题变量这类 `hsl(var(--x))` 消费的槽位塞进 8 位 hex 会整条
   * 声明失效，所以只在「语义上就该半透明」的字段上开。
   */
  allowAlpha?: boolean;
  /** Extra classes for the swatch trigger button. */
  swatchClassName?: string;
}

/**
 * Compact color field: a swatch button that opens the full ColorPicker in a
 * popover, with an optional editable hex input. Wires two-way sync safely:
 *  - `pickerValue` is always a valid hex so `Color(invalid)` never throws.
 *  - the picker `onChange` handler is stable (useCallback) so the ColorPicker's
 *    internal effect does not loop on every render.
 */
export function ColorPickerField({
  value,
  onChange,
  showHexInput = true,
  allowAlpha = false,
  swatchClassName,
}: ColorPickerFieldProps) {
  const pickerValue = HEX_RE.test(value) ? value : "#000000";

  const handlePickerChange = useCallback(
    (c: ColorPickerChangeValue) =>
      onChange(rgbToHex(c as unknown as ArrayLike<number>, allowAlpha)),
    [onChange, allowAlpha],
  );

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="选择颜色"
            className={`size-9 shrink-0 cursor-pointer rounded-md border border-input ${swatchClassName ?? ""}`}
            style={{ background: value }}
          />
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          <ColorPicker value={pickerValue} onChange={handlePickerChange}>
            <ColorPickerSelection className="h-36 rounded-lg" />
            <ColorPickerHue />
            {allowAlpha && <ColorPickerAlpha />}
            <div className="flex items-center gap-2">
              <ColorPickerEyeDropper />
              <ColorPickerOutput />
              <ColorPickerFormat className="flex-1" />
            </div>
          </ColorPicker>
        </PopoverContent>
      </Popover>
      {showHexInput && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-24 font-mono text-xs"
          spellCheck={false}
        />
      )}
    </div>
  );
}
