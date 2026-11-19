import type { ReactNode } from 'react'
import { StudioIcon, type StudioIconName } from '../StudioIcon'
import styles from './StellarEmpty.module.css'

interface Props {
  icon: StudioIconName
  title: string
  description?: string
  hint?: string
  hintIcon?: StudioIconName
  tone?: 'default' | 'warning' | 'model' | 'danger'
  heading?: 'h2' | 'h3'
  label?: string
  compact?: boolean
  role?: 'alert' | 'status'
  children: ReactNode
}

export function StellarEmpty({ icon, title, description, hint, hintIcon = 'bulb', tone = 'default', heading: Heading = 'h3', label, compact = false, role, children }: Props) {
  // 空态主符号按已有语义组合，搜索、错误和已选模型的草稿提示继续使用原图标。
  const symbol = icon === 'read' ? 'book' : icon === 'list' ? 'chapters' : icon === 'lock' ? tone === 'model' ? 'model' : 'archive' : undefined
  return <section className={styles.empty} data-tone={tone} data-compact={compact} aria-label={label ?? title} role={role} tabIndex={compact ? 0 : undefined}>
    <span className={styles.symbol} data-symbol={symbol} aria-hidden="true">
      <StudioIcon name={symbol === 'book' ? 'openBook' : symbol === 'chapters' ? 'chapterLines' : icon} size={64} />
      {(symbol === 'book' || symbol === 'model') && <span className={styles.sparkles}><StudioIcon name="spark" size={12} /><StudioIcon name="spark" size={16} /><StudioIcon name="spark" size={10} /></span>}
      {symbol === 'chapters' && <span className={styles.addChapter}><StudioIcon name="plus" size={20} /></span>}
      {symbol === 'model' && <span className={styles.orbit}><StudioIcon name="orbit" size={64} /></span>}
      {symbol === 'archive' && <span className={styles.document}><StudioIcon name="notes" size={24} /></span>}
    </span>
    <Heading className={styles.title}>{title}</Heading>
    {description && <p className={styles.description}>{description}</p>}
    <div className={styles.actions}>{children}</div>
    {hint && <p className={styles.hint}><StudioIcon name={hintIcon} size={20} /><span>{hint}</span></p>}
  </section>
}
