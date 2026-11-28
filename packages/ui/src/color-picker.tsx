"use client"

import { Button } from "./button"
import { Input } from "./input"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "./select"
import { cn } from "cn"
import Color from "color"
import { PipetteIcon } from "lucide-react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import {
    type ComponentProps,
    createContext,
    type HTMLAttributes,
    memo,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react"

interface ColorPickerContextValue {
    hue: number
    saturation: number
    lightness: number
    alpha: number
    mode: string
    setHue: (hue: number) => void
    setSaturation: (saturation: number) => void
    setLightness: (lightness: number) => void
    setAlpha: (alpha: number) => void
    setColor: (hue: number, saturation: number, lightness: number, alpha: number) => void
    setMode: (mode: string) => void
}

const ColorPickerContext = createContext<ColorPickerContextValue | undefined>(undefined)

export const useColorPicker = () => {
    const context = useContext(ColorPickerContext)

    if (!context) {
        throw new Error("useColorPicker must be used within a ColorPickerProvider")
    }

    return context
}

export type ColorPickerProps = HTMLAttributes<HTMLDivElement> & {
    value?: Parameters<typeof Color>[0]
    defaultValue?: Parameters<typeof Color>[0]
    onChange?: (value: Parameters<typeof Color.rgb>[0]) => void
}

export const ColorPicker = ({
    value,
    defaultValue = "#000000",
    onChange,
    className,
    ...props
}: ColorPickerProps) => {
    const selectedColor = Color(value ?? defaultValue)

    // Lazy initializers. Achromatic colors (black/white/gray) return NaN for
    // hue -> coerce to 0; saturation/lightness of 0 are valid, so don't fall
    // back on a falsy check (that previously turned black into red).
    const [hue, setHueState] = useState(() => {
        const h = selectedColor.hue()
        return Number.isNaN(h) ? 0 : h
    })
    const [saturation, setSaturationState] = useState(() => selectedColor.saturationl())
    const [lightness, setLightnessState] = useState(() => selectedColor.lightness())
    const [alpha, setAlphaState] = useState(() => selectedColor.alpha() * 100)
    const [mode, setMode] = useState("hex")

    // Distinguishes an external `value` change from our own onChange echo, so
    // value-sync never re-triggers a change (which would loop forever).
    const lastEmittedRef = useRef<string | null>(null)

    // Sync internal HSL state when the controlled `value` changes from OUTSIDE
    // (preset buttons, typing in the hex field, parent state). This effect
    // NEVER calls onChange — that is the key to avoiding the render loop.
    useEffect(() => {
        if (!value) return
        const next = Color(value)
        const hex = next.hex().toLowerCase()
        if (hex === lastEmittedRef.current) return
        const hsl = next.hsl()
        setHueState(Number.isNaN(hsl.hue()) ? 0 : hsl.hue())
        setSaturationState(hsl.saturationl())
        setLightnessState(hsl.lightness())
        setAlphaState(next.alpha() * 100)
    }, [value])

    // Emit the new color to the parent. Called ONLY from user interactions
    // (sliders / selection drag / eye dropper), never from an effect.
    const emit = useCallback(
        (h: number, s: number, l: number, a: number) => {
            const color = Color.hsl(h, s, l).alpha(a / 100)
            lastEmittedRef.current = color.hex().toLowerCase()
            const rgba = color.rgb().array()
            onChange?.([rgba[0], rgba[1], rgba[2], a / 100])
        },
        [onChange],
    )

    const setColor = useCallback(
        (h: number, s: number, l: number, a: number) => {
            setHueState(h)
            setSaturationState(s)
            setLightnessState(l)
            setAlphaState(a)
            emit(h, s, l, a)
        },
        [emit],
    )

    const setHue = useCallback(
        (h: number) => setColor(h, saturation, lightness, alpha),
        [saturation, lightness, alpha, setColor],
    )
    const setSaturation = useCallback(
        (s: number) => setColor(hue, s, lightness, alpha),
        [hue, lightness, alpha, setColor],
    )
    const setLightness = useCallback(
        (l: number) => setColor(hue, saturation, l, alpha),
        [hue, saturation, alpha, setColor],
    )
    const setAlpha = useCallback(
        (a: number) => setColor(hue, saturation, lightness, a),
        [hue, saturation, lightness, setColor],
    )

    return (
        <ColorPickerContext.Provider
            value={{
                hue,
                saturation,
                lightness,
                alpha,
                mode,
                setHue,
                setSaturation,
                setLightness,
                setAlpha,
                setColor,
                setMode,
            }}
        >
            <div className={cn("flex size-full flex-col gap-4", className)} {...props} />
        </ColorPickerContext.Provider>
    )
}

export type ColorPickerSelectionProps = HTMLAttributes<HTMLDivElement>

export const ColorPickerSelection = memo(({ className, ...props }: ColorPickerSelectionProps) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const [isDragging, setIsDragging] = useState(false)
    const { hue, saturation, lightness, alpha, setColor } = useColorPicker()

    const backgroundGradient = useMemo(() => {
        return `linear-gradient(0deg, rgba(0,0,0,1), rgba(0,0,0,0)),
            linear-gradient(90deg, rgba(255,255,255,1), rgba(255,255,255,0)),
            hsl(${hue}, 100%, 50%)`
    }, [hue])

    // The 2D area is an HSV square (x = saturation, y = 1 - value), but the
    // component's model is HSL. Derive the thumb position from the current
    // HSL so it always matches the actual color (incl. on open / external change).
    const { positionX, positionY } = useMemo(() => {
        const hsv = Color.hsl(hue, saturation, lightness).hsv()
        return {
            positionX: (hsv.saturationv() || 0) / 100,
            positionY: 1 - (hsv.value() || 0) / 100,
        }
    }, [hue, saturation, lightness])

    const applyAt = useCallback(
        (clientX: number, clientY: number) => {
            if (!containerRef.current) return
            const rect = containerRef.current.getBoundingClientRect()
            const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
            const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
            // The color the user SEES at (x, y) is HSV(hue, x, 1 - y). Convert it
            // to HSL and store THAT, so the stored value equals the visual color.
            const hsl = Color.hsv(hue, x * 100, (1 - y) * 100).hsl()
            setColor(
                Number.isNaN(hsl.hue()) ? hue : hsl.hue(),
                hsl.saturationl(),
                hsl.lightness(),
                alpha,
            )
        },
        [hue, alpha, setColor],
    )

    const handlePointerMove = useCallback(
        (event: PointerEvent) => {
            if (!isDragging) return
            applyAt(event.clientX, event.clientY)
        },
        [isDragging, applyAt],
    )

    useEffect(() => {
        const handlePointerUp = () => setIsDragging(false)

        if (isDragging) {
            window.addEventListener("pointermove", handlePointerMove)
            window.addEventListener("pointerup", handlePointerUp)
        }

        return () => {
            window.removeEventListener("pointermove", handlePointerMove)
            window.removeEventListener("pointerup", handlePointerUp)
        }
    }, [isDragging, handlePointerMove])

    return (
        <div
            className={cn("relative size-full cursor-crosshair rounded", className)}
            onPointerDown={e => {
                e.preventDefault()
                setIsDragging(true)
                applyAt(e.clientX, e.clientY)
            }}
            ref={containerRef}
            style={{
                background: backgroundGradient,
            }}
            {...props}
        >
            <div
                className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute h-4 w-4 rounded-full border-2 border-white"
                style={{
                    left: `${positionX * 100}%`,
                    top: `${positionY * 100}%`,
                    boxShadow: "0 0 0 1px rgba(0,0,0,0.5)",
                }}
            />
        </div>
    )
})

ColorPickerSelection.displayName = "ColorPickerSelection"

export type ColorPickerHueProps = ComponentProps<typeof SliderPrimitive.Root>

export const ColorPickerHue = ({ className, ...props }: ColorPickerHueProps) => {
    const { hue, setHue } = useColorPicker()

    return (
        <SliderPrimitive.Root
            className={cn("relative flex h-4 w-full touch-none", className)}
            max={360}
            onValueChange={(next) =>
                setHue(Array.isArray(next) ? (next[0] ?? 0) : next)
            }
            step={1}
            value={[hue]}
            {...props}
        >
            <SliderPrimitive.Control className="relative flex h-4 w-full touch-none items-center">
                <SliderPrimitive.Track className="relative my-0.5 h-3 w-full grow rounded-full bg-[linear-gradient(90deg,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)]">
                    <SliderPrimitive.Indicator className="h-full" />
                    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
                </SliderPrimitive.Track>
            </SliderPrimitive.Control>
        </SliderPrimitive.Root>
    )
}

export type ColorPickerAlphaProps = ComponentProps<typeof SliderPrimitive.Root>

export const ColorPickerAlpha = ({ className, ...props }: ColorPickerAlphaProps) => {
    const { alpha, setAlpha } = useColorPicker()

    return (
        <SliderPrimitive.Root
            className={cn("relative flex h-4 w-full touch-none", className)}
            max={100}
            onValueChange={(next) =>
                setAlpha(Array.isArray(next) ? (next[0] ?? 0) : next)
            }
            step={1}
            value={[alpha]}
            {...props}
        >
            <SliderPrimitive.Control className="relative flex h-4 w-full touch-none items-center">
                <SliderPrimitive.Track
                    className="relative my-0.5 h-3 w-full grow rounded-full"
                    style={{
                        background:
                            'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGAQYcAP3uCTZhw1gGGYhAGBZIA/nYDCgBDAm9BGDWAAJyRCgLaBCAAgXwixzAS0pgAAAABJRU5ErkJggg==") left center',
                    }}
                >
                    <div className="absolute inset-0 rounded-full bg-gradient-to-r from-transparent to-black/50" />
                    <SliderPrimitive.Indicator className="h-full rounded-full bg-transparent" />
                    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
                </SliderPrimitive.Track>
            </SliderPrimitive.Control>
        </SliderPrimitive.Root>
    )
}

export type ColorPickerEyeDropperProps = ComponentProps<typeof Button>

export const ColorPickerEyeDropper = ({ className, ...props }: ColorPickerEyeDropperProps) => {
    const { setColor } = useColorPicker()

    const handleEyeDropper = async () => {
        try {
            // @ts-expect-error - EyeDropper API is experimental
            const eyeDropper = new EyeDropper()
            const result = await eyeDropper.open()
            const color = Color(result.sRGBHex)
            const [h, s, l] = color.hsl().array()

            setColor(Number.isNaN(h) ? 0 : h, s, l, 100)
        } catch (error) {
            console.error("EyeDropper failed:", error)
        }
    }

    return (
        <Button
            className={cn("shrink-0 text-muted-foreground", className)}
            onClick={handleEyeDropper}
            size="icon"
            type="button"
            variant="outline"
            {...props}
        >
            <PipetteIcon size={16} />
        </Button>
    )
}

export type ColorPickerOutputProps = ComponentProps<typeof SelectTrigger>

/**
 * 输出格式的选项标题（`items` 与选项共用同一份，避免两处字面量漂移）。
 * Base UI 不给 `items` 时触发器里显示的是原始 value（`hex` / `rgb` …）。
 */
const formatLabels: Record<string, string> = {
    hex: "HEX",
    rgb: "RGB",
    css: "CSS",
    hsl: "HSL",
}

export const ColorPickerOutput = ({ className, ...props }: ColorPickerOutputProps) => {
    const { mode, setMode } = useColorPicker()

    return (
        <Select items={formatLabels} onValueChange={(next) => next && setMode(next)} value={mode}>
            <SelectTrigger className={cn("h-8 w-20 shrink-0 text-xs", className)} {...props}>
                <SelectValue placeholder="Mode" />
            </SelectTrigger>
            <SelectContent>
                {Object.entries(formatLabels).map(([value, label]) => (
                    <SelectItem className="text-xs" key={value} value={value}>
                        {label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

type PercentageInputProps = ComponentProps<typeof Input>

const PercentageInput = ({ className, ...props }: PercentageInputProps) => {
    return (
        <div className="relative">
            <Input
                readOnly
                type="text"
                {...props}
                className={cn(
                    "h-8 w-[3.25rem] rounded-l-none bg-secondary px-2 text-xs shadow-none",
                    className,
                )}
            />
            <span className="-translate-y-1/2 absolute top-1/2 right-2 text-muted-foreground text-xs">
                %
            </span>
        </div>
    )
}

export type ColorPickerFormatProps = HTMLAttributes<HTMLDivElement>

export const ColorPickerFormat = ({ className, ...props }: ColorPickerFormatProps) => {
    const { hue, saturation, lightness, alpha, mode } = useColorPicker()
    const color = Color.hsl(hue, saturation, lightness, alpha / 100)

    if (mode === "hex") {
        const hex = color.hex()

        return (
            <div
                className={cn(
                    "-space-x-px relative flex w-full items-center rounded-md shadow-sm",
                    className,
                )}
                {...props}
            >
                <Input
                    className="h-8 rounded-r-none bg-secondary px-2 text-xs shadow-none"
                    readOnly
                    type="text"
                    value={hex}
                />
                <PercentageInput value={alpha} />
            </div>
        )
    }

    if (mode === "rgb") {
        const rgb = color
            .rgb()
            .array()
            .map(value => Math.round(value))

        return (
            <div
                className={cn("-space-x-px flex items-center rounded-md shadow-sm", className)}
                {...props}
            >
                {rgb.map((value, index) => (
                    <Input
                        className={cn(
                            "h-8 rounded-r-none bg-secondary px-2 text-xs shadow-none",
                            index && "rounded-l-none",
                            className,
                        )}
                        key={index}
                        readOnly
                        type="text"
                        value={value}
                    />
                ))}
                <PercentageInput value={alpha} />
            </div>
        )
    }

    if (mode === "css") {
        const rgb = color
            .rgb()
            .array()
            .map(value => Math.round(value))

        return (
            <div className={cn("w-full rounded-md shadow-sm", className)} {...props}>
                <Input
                    className="h-8 w-full bg-secondary px-2 text-xs shadow-none"
                    readOnly
                    type="text"
                    value={`rgba(${rgb.join(", ")}, ${alpha}%)`}
                    {...props}
                />
            </div>
        )
    }

    if (mode === "hsl") {
        const hsl = color
            .hsl()
            .array()
            .map(value => Math.round(value))

        return (
            <div
                className={cn("-space-x-px flex items-center rounded-md shadow-sm", className)}
                {...props}
            >
                {hsl.map((value, index) => (
                    <Input
                        className={cn(
                            "h-8 rounded-r-none bg-secondary px-2 text-xs shadow-none",
                            index && "rounded-l-none",
                            className,
                        )}
                        key={index}
                        readOnly
                        type="text"
                        value={value}
                    />
                ))}
                <PercentageInput value={alpha} />
            </div>
        )
    }

    return null
}

// Demo
export function Demo() {
    return (
        <div className="fixed inset-0 flex items-center justify-center p-8">
            <ColorPicker defaultValue="#6366f1" className="h-auto w-64">
                <ColorPickerSelection className="h-40 rounded-lg" />
                <ColorPickerHue />
                <ColorPickerAlpha />
                <div className="flex items-center gap-2">
                    <ColorPickerEyeDropper />
                    <ColorPickerOutput />
                    <ColorPickerFormat />
                </div>
            </ColorPicker>
        </div>
    )
}
