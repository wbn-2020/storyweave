import { useCallback, useEffect, useRef, useState } from 'react'

export type PanelLeaveGuard = (source: 'navigation' | 'window') => Promise<boolean>
export type RegisterPanelLeaveGuard = (guard: PanelLeaveGuard | null) => void
type PendingPanelLeave = { resolve: (allowed: boolean) => void; timer?: number }

export function usePanelLeave({ register, blockedReason, hasChanges, onBlocked, onDiscard }: {
  register: RegisterPanelLeaveGuard
  blockedReason: () => string | null
  hasChanges: () => boolean
  onBlocked: (message: string) => void
  onDiscard: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [source, setSource] = useState<'navigation' | 'window'>('navigation')
  const pending = useRef<PendingPanelLeave | null>(null)
  const callbacks = useRef({ blockedReason, hasChanges, onBlocked, onDiscard })
  callbacks.current = { blockedReason, hasChanges, onBlocked, onDiscard }

  const finish = useCallback((allowed: boolean) => {
    const waiting = pending.current
    if (!waiting) return
    pending.current = null
    window.clearTimeout(waiting.timer)
    setConfirming(false)
    waiting.resolve(allowed)
  }, [])

  const requestLeave = useCallback<PanelLeaveGuard>(async (source) => {
    const reason = callbacks.current.blockedReason()
    if (reason) { callbacks.current.onBlocked(reason); return false }
    if (!callbacks.current.hasChanges()) return true
    if (pending.current) return false
    // 原生关闭握手只允许正文保存；其他表单须先返回编辑再保存，不能绕过主进程写入限制。
    setSource(source)
    setConfirming(true)
    return new Promise<boolean>((resolve) => {
      const waiting: PendingPanelLeave = { resolve }
      pending.current = waiting
      // 主进程只等待 45 秒；超时取消本次关闭，不能留下随后误放行的确认回调。
      if (source === 'window') waiting.timer = window.setTimeout(() => finish(false), 40_000)
    })
  }, [finish])

  useEffect(() => {
    register(requestLeave)
    return () => {
      register(null)
      const waiting = pending.current
      pending.current = null
      window.clearTimeout(waiting?.timer)
      waiting?.resolve(false)
    }
  }, [register, requestLeave])

  function discardAndLeave() {
    const reason = callbacks.current.blockedReason()
    if (reason) { callbacks.current.onBlocked(reason); return }
    callbacks.current.onDiscard()
    finish(true)
  }

  return { confirming, source, keepEditing: () => finish(false), discardAndLeave, savedAndLeave: () => finish(true) }
}
