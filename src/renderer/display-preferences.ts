import type { CSSProperties } from 'react'

export const DISPLAY_FONT_SIZES = [16, 17, 18, 19, 20, 21, 22, 23, 24] as const
export const DISPLAY_LINE_HEIGHTS = [1.6, 1.8, 2.05, 2.3] as const
export const PAPER_TONE_LABELS = { theme: '跟随书房主题', warm: '温润宣纸', light: '霜白书页', dark: '夜墨灯下' } as const
export const GENRE_ACCENTS = ['fantasy', 'stellar', 'urban', 'galaxy', 'system'] as const

export const STUDIO_THEMES = ['stellar', 'mirroric', 'paper', 'night', 'berry', 'sage'] as const
export type StudioTheme = (typeof STUDIO_THEMES)[number]

export const STUDIO_THEME_META: Readonly<Record<StudioTheme, {
  label: string
  description: string
  swatches: readonly [string, string, string]
}>> = Object.freeze({
  stellar: {
    label: '星穹深空',
    description: '深空底色、星辉青与能量紫',
    swatches: ['#070A14', '#4FD1C5', '#8B7CFF'],
  },
  mirroric: {
    label: '星河暖玉',
    description: 'Mirroric 现代智能体工作台：温润暖白、琥珀赤陶强调色，清晰舒适',
    swatches: ['#F7F6F2', '#BE5718', '#1C1917'],
  },
  paper: {
    label: '宣纸朱砂',
    description: '温润宣纸配松烟墨与朱砂印泥，古典雅致的书卷质感',
    swatches: ['#F1EBE1', '#B2462B', '#201F1B'],
  },
  night: {
    label: '夜墨星海',
    description: '深邃夜航黑底配暖铜流金，极具科技感的深夜沉浸模式',
    swatches: ['#121514', '#D77857', '#242A27'],
  },
  berry: {
    label: '莓果奶霜',
    description: '柔雾奶白配暗玫红与暮紫，温暖细腻的手账书房质感',
    swatches: ['#F6EFEF', '#C83E6B', '#3E2733'],
  },
  sage: {
    label: '松烟青黛',
    description: '宋画青绿底色配古铜金，沉静内敛，护眼耐看',
    swatches: ['#EAEFE9', '#3B6352', '#1E2823'],
  },
})

export interface DisplayPreferences {
  fontSize: number
  lineHeight: number
  paperTone: keyof typeof PAPER_TONE_LABELS
  studioTheme: StudioTheme
  genreAccent?: typeof GENRE_ACCENTS[number]
  paragraphIndent?: boolean
}

export const DEFAULT_DISPLAY_PREFERENCES: Readonly<DisplayPreferences> = Object.freeze({
  fontSize: 18,
  lineHeight: 2.05,
  paperTone: 'theme',
  studioTheme: 'stellar',
  genreAccent: 'stellar',
  paragraphIndent: true,
})

export function isStudioTheme(value: unknown): value is StudioTheme {
  return typeof value === 'string' && STUDIO_THEMES.some((theme) => theme === value)
}

export function parseDisplayPreferences(value: unknown): DisplayPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const { fontSize, lineHeight, paperTone, studioTheme } = candidate
  if (typeof fontSize !== 'number' || !DISPLAY_FONT_SIZES.some((size) => size === fontSize)
    || typeof lineHeight !== 'number' || !DISPLAY_LINE_HEIGHTS.some((height) => height === lineHeight)
    || (paperTone !== 'theme' && paperTone !== 'warm' && paperTone !== 'light' && paperTone !== 'dark')) return null
  const resolvedTheme = studioTheme === undefined ? 'stellar' : isStudioTheme(studioTheme) ? studioTheme : null
  if (!resolvedTheme) return null
  const genreAccent = candidate.genreAccent ?? 'stellar'
  if (!GENRE_ACCENTS.some((value) => value === genreAccent)) return null
  // 旧偏好没有缩进字段时保持原稿纸的两字缩进，不改变存储键或版本。
  const paragraphIndent = candidate.paragraphIndent ?? true
  if (typeof paragraphIndent !== 'boolean') return null
  return { fontSize, lineHeight, paperTone, studioTheme: resolvedTheme, genreAccent: genreAccent as typeof GENRE_ACCENTS[number], paragraphIndent }
}

export function displayPreferenceStyle(preferences: DisplayPreferences): CSSProperties {
  return {
    '--manuscript-font-size': `${preferences.fontSize}px`,
    '--manuscript-line-height': preferences.lineHeight,
    '--manuscript-indent': preferences.paragraphIndent === false ? '0' : '2em',
  } as CSSProperties
}
