import { useCallback, useRef, useState } from 'react'
import { DEFAULT_DISPLAY_PREFERENCES, parseDisplayPreferences, type DisplayPreferences } from '../display-preferences'

const STORAGE_KEY = 'storyweave.display-preferences.v1'
interface PreferenceState { preferences: DisplayPreferences; warning: string | null }

function readPreferences(): PreferenceState {
  const defaults = { ...DEFAULT_DISPLAY_PREFERENCES }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { preferences: defaults, warning: null }
    if (raw.length > 1024) return { preferences: defaults, warning: '本机显示偏好无法识别，当前使用默认显示。保存当前偏好后可替换这份记录。' }
    const stored: unknown = JSON.parse(raw)
    const record = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : null
    const preferences = record?.version === 1 ? parseDisplayPreferences(record.preferences) : null
    if (preferences) return { preferences, warning: null }
    return { preferences: defaults, warning: '本机显示偏好无法识别，当前使用默认显示。保存当前偏好后可替换这份记录。' }
  } catch {
    return { preferences: defaults, warning: '本机显示偏好读取失败，当前使用默认显示。可重新保存当前偏好；作品内容不受影响。' }
  }
}

export function useDisplayPreferences() {
  const [state, setState] = useState<PreferenceState>(readPreferences)
  const current = useRef(state.preferences)

  const save = useCallback((preferences: DisplayPreferences) => {
    let warning: string | null = null
    try {
      // 仅由作者调整或重试时写入；初始化失败不能自动覆盖原有记录。
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, preferences }))
    } catch {
      warning = '显示已在当前窗口生效，但未能保存到本机。下次打开可能还原，请重新保存当前偏好。'
    }
    current.current = preferences
    setState({ preferences, warning })
  }, [])

  const update = useCallback((change: Partial<DisplayPreferences>) => {
    const preferences = parseDisplayPreferences({ ...current.current, ...change })
    if (!preferences) return
    save(preferences)
  }, [save])

  const reset = useCallback(() => save({ ...DEFAULT_DISPLAY_PREFERENCES }), [save])
  const retrySave = useCallback(() => save(current.current), [save])

  return { preferences: state.preferences, warning: state.warning, update, reset, retrySave }
}
