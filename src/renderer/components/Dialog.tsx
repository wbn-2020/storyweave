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

  useEffect(() => {
    if (mode !== 'modal') return
    // 等待浏览器完成禁用控件的焦点回退，再保留忙态焦点或返回可用控件。
    const frame = requestAnimationFrame(() => {
      const element = dialog.current
      if (!element?.open || [...document.querySelectorAll('dialog:modal')].at(-1) !== element) return
      if (busy && !element.contains(document.activeElement)) element.focus({ preventScroll: true })
      else if (!busy && document.activeElement === element) element.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [busy, mode])

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

  return <dialog ref={dialog} tabIndex={-1} className={`${styles.inlineForm} ${wide ? styles.wideDialog : ''} ${className}`} aria-labelledby={heading}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // 连续 Esc 的原生 cancel 可能不可取消，先在按键阶段执行既有关闭门禁。
      event.preventDefault(); event.stopPropagation()
      if (!busy && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) onClose()
    }}
    onCancel={(event) => {
      if (event.target !== event.currentTarget) return
      event.preventDefault(); event.stopPropagation()
      if (!busy) onClose()
    }}
    onClose={(event) => {
      const element = event.currentTarget
      if (event.target !== element || element.open || !element.isConnected) return
      // 原生关闭不能替代作者确认；父级仍保留本组件时，先恢复模态再交回原保存门禁。
      element.showModal()
      if (!busy) onClose()
      requestAnimationFrame(() => {
        // 原生关闭的焦点回退可能晚于 showModal，且不能夺走后来打开的确认层焦点。
        if (!element.isConnected || !element.open || [...document.querySelectorAll('dialog:modal')].at(-1) !== element
          || element.contains(document.activeElement)) return
        const target = element.querySelector<HTMLElement>('[autofocus]:not(:disabled), button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? element
        target.focus({ preventScroll: true })
      })
    }}>
    <div className={styles.formHeading}><h2 id={heading}>{title}</h2><StellarTooltip><button type="button" onClick={onClose} disabled={busy} aria-label="关闭" title={busy ? '当前操作正在处理，请稍候再关闭' : '关闭'}><StudioIcon name="close" size={20} /></button></StellarTooltip></div>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {toolbar}
    {children}
  </dialog>
}
