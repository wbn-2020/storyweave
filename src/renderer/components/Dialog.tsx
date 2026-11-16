import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { StudioIcon } from './StudioIcon'
import { StellarTooltip } from './stellar/StellarTooltip'
import styles from './Dialog.module.css'

export type DialogDisplayMode = 'modal' | 'canvas' | 'drawer'

export const DialogDisplayContext = createContext<DialogDisplayMode>('modal')

interface Props {
  title: ReactNode
  children: ReactNode
  onClose: () => void
  busy?: boolean
  wide?: boolean
  error?: string | null
  className?: string
  inline?: boolean
  toolbar?: ReactNode
}

export function Dialog({ title, children, onClose, busy = false, wide = false, error, className = '', inline = false, toolbar }: Props) {
  const contextMode = useContext(DialogDisplayContext)
  const mode: DialogDisplayMode = inline ? 'canvas' : contextMode
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()

  useEffect(() => {
    if (mode !== 'modal') return
    const previousFocus = document.activeElement
    dialog.current?.showModal()
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus() }
  }, [mode])

  if (mode === 'drawer') {
    return <section className={`${styles.drawerDialogSurface} ${className}`} aria-labelledby={heading}>
      <header className={styles.drawerDialogHeader}>
        <div className={styles.canvasDialogTitleGroup}>
          <h2 id={heading}>{title}</h2>
        </div>
        <StellarTooltip><button type="button" className={styles.canvasCloseButton} onClick={onClose} disabled={busy} aria-label="收起副驾驶面板" title={busy ? '当前操作正在处理，请稍候再收起' : '收起副驾驶面板'}>
          <StudioIcon name="close" size={20} />
        </button></StellarTooltip>
      </header>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      <div className={styles.drawerDialogBody}>{toolbar}{children}</div>
    </section>
  }

  if (mode === 'canvas') {
    return <section className={`${styles.canvasDialogSurface} ${className}`} aria-labelledby={heading}>
      <header className={`${styles.canvasDialogHeader} ${toolbar ? styles.canvasToolbarHeader : ''}`}>
        <div className={styles.canvasDialogTitleGroup}>
          <h2 id={heading}>{title}</h2>
        </div>
        {toolbar}
        <div className={styles.canvasHeaderActions}>
          <StellarTooltip><button type="button" className={styles.canvasCloseButton} onClick={onClose} disabled={busy} aria-label="返回书桌或写作" title={busy ? '当前操作正在处理，请稍候再返回' : '返回书桌或写作'}>
            <StudioIcon name="arrow" size={14} style={{ transform: 'rotate(180deg)' }} />
            <span>返回</span>
          </button></StellarTooltip>
        </div>
      </header>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      <div className={styles.canvasDialogBody}>{children}</div>
    </section>
  }

  return <dialog ref={dialog} className={`${styles.inlineForm} ${wide ? styles.wideDialog : ''} ${className}`} aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <div className={styles.formHeading}><h2 id={heading}>{title}</h2><StellarTooltip><button type="button" onClick={onClose} disabled={busy} aria-label="关闭" title={busy ? '当前操作正在处理，请稍候再关闭' : '关闭'}><StudioIcon name="close" size={20} /></button></StellarTooltip></div>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {toolbar}
    {children}
  </dialog>
}
