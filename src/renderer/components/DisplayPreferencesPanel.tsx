import { useId, useState, type CSSProperties } from 'react'
import {
  DISPLAY_FONT_SIZES, DISPLAY_LINE_HEIGHTS, PAPER_TONE_LABELS,
  STUDIO_THEMES, STUDIO_THEME_META,
  displayPreferenceStyle, type DisplayPreferences, type StudioTheme,
} from '../display-preferences'
import { Dialog } from './Dialog'
import { StudioIcon } from './StudioIcon'
import { STELLAR_GENRES } from './stellar/Genres'
import shared from '../StellarShared.module.css'
import paperStyles from './PaperSurface.module.css'
import styles from './StellarSettings.module.css'

export interface DisplayPreferencesPanelProps {
  preferences: DisplayPreferences
  warning: string | null
  busy: boolean
  onChange: (change: Partial<DisplayPreferences>) => void
  onReset: () => void
  onRetrySave: () => void
  onClose: () => void
  workspacePath?: string | null
  onChooseWorkspace?: () => void
  onBackup?: () => void
  onRecovery?: () => void
  onModels?: () => void
  focused?: boolean
  onFocusChange?: (focused: boolean) => void
  saveStatus?: string
}

export function DisplayPreferencesPanel({ preferences, warning, busy, onChange, onReset, onRetrySave, onClose, workspacePath, onChooseWorkspace, onBackup, onRecovery, onModels, focused = false, onFocusChange, saveStatus }: DisplayPreferencesPanelProps) {
  const helpId = useId()
  const themeId = useId()
  const previewId = useId()
  const [section, setSection] = useState<'appearance' | 'storage'>('appearance')
  const primaryThemes: readonly StudioTheme[] = ['stellar', 'night', 'paper']

  function themeChoice(theme: StudioTheme) {
    const meta = STUDIO_THEME_META[theme]
    const active = preferences.studioTheme === theme
    return <button key={theme} type="button" aria-pressed={active} aria-label={meta.label} title={theme === 'stellar' ? meta.description : '旧主题 · 暂未适配'}
      disabled={busy} className={`${styles.themeCard} ${active ? styles.themeCardActive : ''}`}
      style={{ '--theme-preview-base': meta.swatches[0], '--theme-preview-accent': meta.swatches[1], '--theme-preview-ink': meta.swatches[2] } as CSSProperties}
      onClick={() => onChange({ studioTheme: theme })}>
      <span className={styles.themeMini} aria-hidden="true"><span className={styles.themeMiniRail}><i /><i /><i /><i /></span><span className={styles.themeMiniBody}><i /><i /><i /><i /></span></span>
      {active && <span className={styles.themeCheck}><StudioIcon name="check" size={16} /></span>}
      <strong>{meta.label}</strong><span>{theme === 'stellar' ? '星穹' : '旧主题 · 暂未适配'}</span>
    </button>
  }

  // 设置始终由父层即时应用；面板没有独立草稿，保存失败也不阻止关闭。
  return <Dialog title="设置" wide busy={busy} onClose={onClose}>
    <div className={styles.panel}>
      <nav className={styles.navigation} aria-label="设置分组"><button type="button" aria-pressed={section === 'appearance'} onClick={() => setSection('appearance')}><StudioIcon name="palette" size={20} />外观与排版</button><button type="button" aria-pressed={section === 'storage'} onClick={() => setSection('storage')}><StudioIcon name="archive" size={20} />本地存储</button>{onModels && <button type="button" onClick={onModels} disabled={busy}><StudioIcon name="workflow" size={20} />模型连接</button>}</nav>
      <div className={styles.content} hidden={section !== 'appearance'}>
      <section className={styles.themeSection} aria-labelledby={themeId}>
        <h3 id={themeId} className={styles.sectionTitle}>工作室主题</h3>
        <div className={styles.themeGrid} role="group" aria-labelledby={themeId}>
          {primaryThemes.map(themeChoice)}
        </div>
        <details className={styles.legacyThemes} open={!primaryThemes.includes(preferences.studioTheme)}><summary>更多旧主题{!primaryThemes.includes(preferences.studioTheme) ? ` · 当前：${STUDIO_THEME_META[preferences.studioTheme].label}` : ''}</summary><div className={styles.themeGrid}>{STUDIO_THEMES.filter((theme) => !primaryThemes.includes(theme)).map(themeChoice)}</div></details>
      </section>
      <section className={styles.themeSection}><h3 className={styles.sectionTitle}>题材强调色</h3><div className={styles.genreColors} role="group" aria-label="题材强调色">{STELLAR_GENRES.map((genre) => <button key={genre.id} type="button" data-genre={genre.id} aria-pressed={(preferences.genreAccent ?? 'stellar') === genre.id} disabled={busy} onClick={() => onChange({ genreAccent: genre.id })}><span className={styles.genreSwatch}>{(preferences.genreAccent ?? 'stellar') === genre.id && <StudioIcon name="check" size={20} />}</span>{genre.label}</button>)}</div></section>
      <div className={styles.controls} role="group" aria-label="纸面显示设置" aria-describedby={helpId}>
        <h3 className={styles.sectionTitle}>排版设置</h3>
        <label>正文字号<input type="range" min={DISPLAY_FONT_SIZES[0]} max={DISPLAY_FONT_SIZES[DISPLAY_FONT_SIZES.length - 1]} step={1} value={preferences.fontSize} disabled={busy} onChange={(event) => onChange({ fontSize: Number(event.target.value) })} /><output>{preferences.fontSize} px</output></label>
        <label>段落行距<input type="range" min={0} max={DISPLAY_LINE_HEIGHTS.length - 1} step={1} value={DISPLAY_LINE_HEIGHTS.findIndex((height) => height === preferences.lineHeight)} disabled={busy} onChange={(event) => onChange({ lineHeight: DISPLAY_LINE_HEIGHTS[Number(event.target.value)] })} /><output>{preferences.lineHeight}</output></label>
        <label className={styles.toggleRow}>段首缩进<input type="checkbox" role="switch" checked={preferences.paragraphIndent !== false} disabled={busy} onChange={(event) => onChange({ paragraphIndent: event.target.checked })} /><span className={styles.toggleTrack} aria-hidden="true" /></label>
        <label className={styles.toggleRow} title={!onFocusChange ? '打开章节后可设置专注模式' : '仅在写作台生效'}>专注模式<input type="checkbox" role="switch" checked={focused} disabled={busy || !onFocusChange} onChange={(event) => onFocusChange?.(event.target.checked)} /><span className={styles.toggleTrack} aria-hidden="true" /><small>{onFocusChange ? '写作台' : '尚未打开章节'}</small></label>
        <label>正文稿纸底色<select value={preferences.paperTone} disabled={busy} onChange={(event) => onChange({ paperTone: event.target.value as DisplayPreferences['paperTone'] })}>
          {Object.entries(PAPER_TONE_LABELS).map(([tone, label]) => <option key={tone} value={tone}>{label}</option>)}
        </select></label>
      </div>
      <div className={styles.storageSummary}>
        <div className={styles.storageRow}><StudioIcon name="check" size={20} /><strong>正文自动保存</strong><span>{saveStatus ?? '未打开章节'}</span></div>
        <div className={styles.storageRow}><StudioIcon name="folder" size={20} /><strong>作品库位置</strong><span className={styles.storagePath}>{workspacePath ?? '尚未选择'}</span>{onBackup && <button className={shared.button} type="button" disabled={busy} onClick={onBackup}>备份与恢复</button>}</div>
      </div>
      {warning && <section className={styles.warning} aria-label="显示偏好保存提示">
        <p role="alert">{warning}</p>
        <button type="button" className={shared.button} disabled={busy} onClick={onRetrySave}>保存当前显示偏好</button>
      </section>}
      <p id={helpId} className={styles.help}>{warning ? '当前显示仍可使用，可重新保存偏好。' : '更改即时应用，自动保存到本机。'}</p>
      <div className={styles.actions}>
        <button type="button" className={shared.button} disabled={busy} onClick={onReset}>恢复默认</button>
        <button type="button" className={shared.primaryButton} disabled={busy} onClick={onClose}>完成设置</button>
      </div>
      </div>
      <section className={styles.storage} hidden={section !== 'storage'}><h3 className={styles.sectionTitle}>本地作品库</h3><p>{workspacePath ?? '尚未选择作品库'}</p><div className={styles.actions}>{onChooseWorkspace && <button type="button" className={shared.button} disabled={busy} onClick={onChooseWorkspace}>切换目录</button>}{onBackup && <button type="button" className={shared.button} disabled={busy} onClick={onBackup}>作品备份与恢复</button>}{onRecovery && <button type="button" className={shared.button} disabled={busy} onClick={onRecovery}>草稿与服务恢复</button>}</div><div className={styles.storageRow}><StudioIcon name="check" size={20} /><strong>正文自动保存</strong><span>{saveStatus ?? '未打开章节'}</span></div></section>
      <section className={styles.previewSection} aria-labelledby={previewId}>
        <h3 id={previewId} className={styles.previewHeading}><StudioIcon name="spark" size={20} />实时预览</h3>
        <div className={`${paperStyles.surface} ${styles.preview}`} data-paper-tone={preferences.paperTone} style={displayPreferenceStyle(preferences)}>
          <h4>第 1 章 · 灯火初上</h4>
          <p>暮色落到窗边时，她合上旧地图。远处的灯一盏盏亮起，像有人沿着河岸留下归途的记号。</p>
          <p>她在空白处写下<strong>出发</strong>二字，又轻轻添了一句：<em>等风停下，就去看看。</em></p>
        </div>
      </section>
    </div>
  </Dialog>
}
