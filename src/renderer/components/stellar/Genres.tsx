import { useId } from 'react'
import { StudioIcon, type StudioIconName } from '../StudioIcon'
import styles from './stellar.module.css'

export const STELLAR_GENRES = [
  { id: 'fantasy', label: '玄幻', icon: 'sword', description: '踏破虚空，\n问道长生' },
  { id: 'stellar', label: '星空', icon: 'planet', description: '探索无垠，\n邂逅奇迹' },
  { id: 'urban', label: '都市高武', icon: 'city', description: '强者归来，\n逆转乾坤' },
  { id: 'galaxy', label: '银河', icon: 'orbit', description: '星河璀璨，\n追寻永恒' },
  { id: 'system', label: '系统', icon: 'chip', description: '激活系统，\n开启新篇' },
] as const satisfies readonly { id: string; label: string; icon: StudioIconName; description: string }[]

export function genreTone(genre: string) {
  return STELLAR_GENRES.find((item) => genre.includes(item.label))?.id ?? 'stellar'
}

export function GenrePicker({ value, disabled, onSelect, compact = false }: {
  value?: string; disabled: boolean; onSelect: (genre: string) => void; compact?: boolean
}) {
  return <div className={styles.genres} role="group" aria-label="故事题材">
    {STELLAR_GENRES.map((genre) => <button key={genre.id} type="button" className={styles.genre} data-genre={genre.id}
      aria-pressed={value === undefined ? undefined : value === genre.label} disabled={disabled} onClick={() => onSelect(genre.label)}>
      <StudioIcon name={genre.icon} size={24} /><strong>{genre.label}</strong>{!compact && <small>{genre.description}</small>}
    </button>)}
  </div>
}

export function ProgressRing({ value, label }: { value: number; label: string }) {
  const gradient = useId()
  const percent = Math.min(100, Math.max(0, value))
  return <div className={styles.ring} role="img" aria-label={`${label} ${percent}%`}>
    <svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1"><stop className={styles.progressStart} offset="0" /><stop className={styles.progressEnd} offset="1" /></linearGradient></defs>
      <circle cx="50" cy="50" r="43" /><circle cx="50" cy="50" r="43" pathLength="100" strokeDasharray={`${percent} 100`} style={{ stroke: `url(#${gradient})` }} /></svg>
    <strong>{percent}%</strong>
  </div>
}
