import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import styles from './StellarTooltip.module.css'

const openingEvent = 'storyweave:tooltip-open'

export function StellarTooltip({ children, placement = 'top' }: {
  children: ReactElement<HTMLAttributes<HTMLElement> & { disabled?: boolean }>
  placement?: 'top' | 'right'
}) {
  const content = children.props.title ?? children.props['aria-label']
  const id = useId()
  const tooltip = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const hovered = useRef(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const close = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    openTimer.current = null; closeTimer.current = null
    setAnchor(null)
  }, [])

  function keepOpen() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  function scheduleOpen(element: HTMLElement) {
    keepOpen()
    trigger.current = element
    if (!content || anchor || openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      if (!element.isConnected || element.closest('[inert]') || !element.checkVisibility({ visibilityProperty: true })
        || document.querySelector('dialog[open]') && !element.closest('dialog[open]')) return
      window.dispatchEvent(new Event(openingEvent))
      setAnchor(element)
    }, 300)
  }
  function scheduleClose() {
    if (hovered.current || trigger.current && !trigger.current.matches(':disabled') && document.activeElement === trigger.current) return
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    openTimer.current = null
    keepOpen()
    // 留出跨越按钮与提示间隙的时间，指针移入提示后可继续阅读。
    closeTimer.current = window.setTimeout(close, 100)
  }

  useEffect(() => {
    close()
  }, [content, children.props.disabled, close])
  useEffect(() => () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  useLayoutEffect(() => {
    const node = tooltip.current
    if (!anchor || !node) return
    // 提示进入原按钮所在的模态与顶层，避免抽屉裁切或被原生 dialog 遮住。
    node.showPopover()
    function position() {
      if (!anchor!.isConnected || anchor!.closest('[inert]') || !anchor!.checkVisibility({ visibilityProperty: true })) { close(); return }
      const rect = anchor!.getBoundingClientRect(), box = node!.getBoundingClientRect()
      const gap = Number.parseFloat(getComputedStyle(node!).getPropertyValue('--space-2'))
      let left = rect.left + (rect.width - box.width) / 2, top = rect.top - box.height - gap
      if (placement === 'right') {
        left = rect.right + gap; top = rect.top + (rect.height - box.height) / 2
        if (left + box.width > window.innerWidth - gap) left = rect.left - box.width - gap
      } else if (top < gap) top = rect.bottom + gap
      node!.style.left = `${Math.max(gap, Math.min(left, window.innerWidth - box.width - gap))}px`
      node!.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - box.height - gap))}px`
    }
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
      // 只消费当前提示的 Esc；提示收起后，后续 Esc 仍由原抽屉与关闭守卫处理。
      event.preventDefault(); event.stopImmediatePropagation(); close()
    }
    function scroll(event: Event) { if (!(event.target instanceof Node) || !node!.contains(event.target)) close() }
    function visibility() { if (document.hidden) close() }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor); observer.observe(node)
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener(openingEvent, close)
    document.addEventListener('scroll', scroll, true)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      observer.disconnect()
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener(openingEvent, close)
      document.removeEventListener('scroll', scroll, true)
      document.removeEventListener('visibilitychange', visibility)
      if (node.matches(':popover-open')) node.hidePopover()
    }
  }, [anchor, placement, close])

  if (!content) return children
  const describedBy = [children.props['aria-describedby'], anchor ? id : undefined].filter(Boolean).join(' ') || undefined
  return <>
    {cloneElement(children, {
      title: undefined,
      'aria-describedby': describedBy,
      onPointerEnter: (event) => {
        children.props.onPointerEnter?.(event)
        if (event.pointerType !== 'touch') { hovered.current = true; scheduleOpen(event.currentTarget) }
      },
      onPointerLeave: (event) => { children.props.onPointerLeave?.(event); hovered.current = false; scheduleClose() },
      onFocus: (event) => { children.props.onFocus?.(event); scheduleOpen(event.currentTarget) },
      onBlur: (event) => { children.props.onBlur?.(event); scheduleClose() },
      onClick: (event) => { close(); children.props.onClick?.(event) },
    })}
    {anchor && createPortal(<div ref={tooltip} id={id} role="tooltip" popover="manual" data-stellar-tooltip=""
      className={styles.tooltip} onPointerEnter={() => { hovered.current = true; keepOpen() }}
      onPointerLeave={() => { hovered.current = false; scheduleClose() }}>{content}</div>, anchor.closest('dialog[open]') ?? document.body)}
  </>
}
