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
  return <section className={styles.empty} data-tone={tone} data-compact={compact} aria-label={label ?? title} role={role} tabIndex={compact ? 0 : undefined}>
    <span className={styles.symbol}><StudioIcon name={icon} size={64} /></span>
    <Heading className={styles.title}>{title}</Heading>
    {description && <p className={styles.description}>{description}</p>}
    <div className={styles.actions}>{children}</div>
    {hint && <p className={styles.hint}><StudioIcon name={hintIcon} size={20} /><span>{hint}</span></p>}
  </section>
}
