import { useEffect, useId, useRef, type ReactNode } from 'react'
import styles from '../App.module.css'

interface Props {
  title: string
  children: ReactNode
  onClose: () => void
  busy?: boolean
  wide?: boolean
  error?: string | null
}

export function Dialog({ title, children, onClose, busy = false, wide = false, error }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    const previousFocus = document.activeElement
    dialog.current?.showModal()
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus() }
  }, [])
  return <dialog ref={dialog} className={`${styles.inlineForm} ${wide ? styles.wideDialog : ''}`} aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <div className={styles.formHeading}><h2 id={heading}>{title}</h2><button type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button></div>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {children}
  </dialog>
}
