import { useEffect, useRef, type RefObject } from 'react'

/** 布局由 CSS 决定；这里只在抽屉成为覆盖层时约束焦点，不重新挂载编辑器。 */
export function useDrawerFocus(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void, identity = '', fallback?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const panel = ref.current
    if (!active || !panel) return
    let previous: Element | null = null
    let overlay = false
    let enteredOverlay = false
    const targets = () => [...panel.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
      .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.checkVisibility({ visibilityProperty: true }))
    function focusFirst() { (targets()[0] ?? panel!).focus({ preventScroll: true }) }
    function sync() {
      const next = getComputedStyle(panel!).position === 'absolute' && panel!.getClientRects().length > 0
      if (next === overlay) return
      overlay = next
      if (overlay) {
        enteredOverlay = true
        previous = document.activeElement
        panel!.setAttribute('role', 'dialog')
        panel!.setAttribute('aria-modal', 'true')
        if (!panel!.contains(document.activeElement)) focusFirst()
      } else {
        panel!.removeAttribute('role')
        panel!.removeAttribute('aria-modal')
      }
    }
    function keydown(event: KeyboardEvent) {
      if (!overlay || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open]')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const focusable = targets(), first = focusable[0], last = focusable.at(-1)
      if (!first) { event.preventDefault(); panel!.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !panel!.contains(document.activeElement))) { event.preventDefault(); last!.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel!.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    function focusin(event: FocusEvent) {
      if (overlay && event.target instanceof Node && !panel!.contains(event.target) && !document.querySelector('dialog[open]')) focusFirst()
    }
    const observer = new ResizeObserver(sync)
    observer.observe(panel)
    observer.observe(document.documentElement)
    sync()
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      panel.removeAttribute('role'); panel.removeAttribute('aria-modal')
      // 隐藏布局的 ResizeObserver 可能先于 effect 清理执行，恢复资格不能依赖当前可见状态。
      if (enteredOverlay) {
        const visible = (element: Element | null): element is HTMLElement => element instanceof HTMLElement
          && element !== document.body && element !== document.documentElement && element.isConnected
          && !element.closest('[inert]') && element.checkVisibility({ visibilityProperty: true }) && !panel.contains(element)
        // 入口可能位于已收起的菜单中，此时将焦点还给仍可见的菜单开关。
        const target = visible(previous) ? previous : visible(fallback?.current ?? null) ? fallback!.current : null
        target?.focus({ preventScroll: true })
      }
    }
  }, [ref, active, identity, fallback])
}
