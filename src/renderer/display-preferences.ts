import type { CSSProperties } from 'react'

export const DISPLAY_FONT_SIZES = [16, 17, 18, 19, 20, 21, 22, 23, 24] as const
export const DISPLAY_LINE_HEIGHTS = [1.8, 2.05, 2.3] as const
export const PAPER_TONE_LABELS = { warm: '暖纸', light: '净白', dark: '夜间' } as const

export interface DisplayPreferences {
  fontSize: number
  lineHeight: number
  paperTone: keyof typeof PAPER_TONE_LABELS
}

export const DEFAULT_DISPLAY_PREFERENCES: Readonly<DisplayPreferences> = Object.freeze({
  fontSize: 18, lineHeight: 2.05, paperTone: 'warm',
})

export function parseDisplayPreferences(value: unknown): DisplayPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const { fontSize, lineHeight, paperTone } = candidate
  if (typeof fontSize !== 'number' || !DISPLAY_FONT_SIZES.some((size) => size === fontSize)
    || typeof lineHeight !== 'number' || !DISPLAY_LINE_HEIGHTS.some((height) => height === lineHeight)
    || (paperTone !== 'warm' && paperTone !== 'light' && paperTone !== 'dark')) return null
  // 只保留受限的显示选项，存储中的额外字段不能成为样式或作品数据。
  return { fontSize, lineHeight, paperTone }
}

export function displayPreferenceStyle(preferences: DisplayPreferences): CSSProperties {
  return {
    '--manuscript-font-size': `${preferences.fontSize}px`,
    '--manuscript-line-height': preferences.lineHeight,
  } as CSSProperties
}
