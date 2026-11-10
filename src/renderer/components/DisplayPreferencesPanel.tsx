import { useId } from 'react'
import {
  DISPLAY_FONT_SIZES, DISPLAY_LINE_HEIGHTS, PAPER_TONE_LABELS,
  STUDIO_THEMES, STUDIO_THEME_META,
  displayPreferenceStyle, type DisplayPreferences,
} from '../display-preferences'
import { Dialog } from './Dialog'
import { StudioIcon } from './StudioIcon'
import shared from '../App.module.css'
import paperStyles from './PaperSurface.module.css'
import styles from './DisplayPreferencesPanel.module.css'

export interface DisplayPreferencesPanelProps {
  preferences: DisplayPreferences
  warning: string | null
  busy: boolean
  onChange: (change: Partial<DisplayPreferences>) => void
  onReset: () => void
  onRetrySave: () => void
  onClose: () => void
}

export function DisplayPreferencesPanel({ preferences, warning, busy, onChange, onReset, onRetrySave, onClose }: DisplayPreferencesPanelProps) {
  const helpId = useId()
  const themeId = useId()
  const previewId = useId()

  // 设置始终由父层即时应用；面板没有独立草稿，保存失败也不阻止关闭。
  return <Dialog title="工作室配色与稿纸偏好" className={shared.lightDialog} busy={busy} onClose={onClose}>
    <div className={styles.panel}>
      <p id={helpId} className={styles.help}>打造属于你的创作书房：可随时切换全站工作室氛围配色，并独立调节正文稿纸的字号、行距与纸色。</p>

      <section className={styles.themeSection} aria-labelledby={themeId}>
        <h3 id={themeId} className={styles.sectionTitle}><StudioIcon name="palette" size={16} />工作室氛围配色</h3>
        <div className={styles.themeGrid} role="radiogroup" aria-labelledby={themeId}>
          {STUDIO_THEMES.map((theme) => {
            const meta = STUDIO_THEME_META[theme]
            const active = preferences.studioTheme === theme
            return <button
              key={theme}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              className={`${styles.themeCard} ${active ? styles.themeCardActive : ''}`}
              onClick={() => onChange({ studioTheme: theme })}
            >
              <div className={styles.themeCardTop}>
                <span className={styles.swatches} aria-hidden="true">
                  {meta.swatches.map((color, index) => <i key={index} style={{ background: color }} />)}
                </span>
                {active && <span className={styles.themeCheck}><StudioIcon name="check" size={13} /></span>}
              </div>
              <strong>{meta.label}</strong>
              <span>{meta.description}</span>
            </button>
          })}
        </div>
      </section>

      <div className={styles.controls} role="group" aria-label="纸面显示设置" aria-describedby={helpId}>
        <label>正文字号<select value={preferences.fontSize} disabled={busy} onChange={(event) => onChange({ fontSize: Number(event.target.value) })}>
          {DISPLAY_FONT_SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
        </select></label>
        <label>段落行距<select value={preferences.lineHeight} disabled={busy} onChange={(event) => onChange({ lineHeight: Number(event.target.value) })}>
          {DISPLAY_LINE_HEIGHTS.map((height) => <option key={height} value={height}>{height} 倍</option>)}
        </select></label>
        <label>正文稿纸底色<select value={preferences.paperTone} disabled={busy} onChange={(event) => onChange({ paperTone: event.target.value as DisplayPreferences['paperTone'] })}>
          {Object.entries(PAPER_TONE_LABELS).map(([tone, label]) => <option key={tone} value={tone}>{label}</option>)}
        </select></label>
      </div>
      {warning && <section className={styles.warning} aria-label="显示偏好保存提示">
        <p role="alert">{warning}</p>
        <button type="button" className={shared.button} disabled={busy} onClick={onRetrySave}>保存当前显示偏好</button>
      </section>}
      <section className={styles.previewSection} aria-labelledby={previewId}>
        <h3 id={previewId} className={styles.previewHeading}>稿纸排版实时预览</h3>
        <div className={`${paperStyles.surface} ${styles.preview}`} data-paper-tone={preferences.paperTone} style={displayPreferenceStyle(preferences)}>
          <h4>第 1 章 · 灯火初上</h4>
          <p>暮色落到窗边时，她合上旧地图。远处的灯一盏盏亮起，像有人沿着河岸留下归途的记号。</p>
          <p>她在空白处写下<strong>出发</strong>二字，又轻轻添了一句：<em>等风停下，就去看看。</em></p>
        </div>
      </section>
      <p className={styles.help}>{warning ? '当前显示仍可使用，可重新保存偏好。' : '更改即时应用，自动保存到本机。'}</p>
      <div className={styles.actions}>
        <button type="button" className={shared.button} disabled={busy} onClick={onReset}>恢复默认</button>
        <button type="button" className={shared.primaryButton} disabled={busy} onClick={onClose}>完成设置</button>
      </div>
    </div>
  </Dialog>
}
