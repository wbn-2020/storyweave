import type { ReactNode } from 'react'
import { StudioIcon, type StudioIconName } from '../StudioIcon'
import styles from './StellarEmpty.module.css'

interface Props {
  icon: StudioIconName
  title: string
  description?: string
  hint?: string
  tone?: 'default' | 'warning' | 'model'
  heading?: 'h2' | 'h3'
  label?: string
  children: ReactNode
}

export function StellarEmpty({ icon, title, description, hint, tone = 'default', heading: Heading = 'h3', label, children }: Props) {
  return <section className={styles.empty} data-tone={tone} aria-label={label ?? title}>
    <span className={styles.symbol}><StudioIcon name={icon} size={64} /></span>
    <Heading className={styles.title}>{title}</Heading>
    {description && <p className={styles.description}>{description}</p>}
    <div className={styles.actions}>{children}</div>
    {hint && <p className={styles.hint}><StudioIcon name="bulb" size={20} /><span>{hint}</span></p>}
  </section>
}
