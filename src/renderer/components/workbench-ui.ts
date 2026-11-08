import { useEffect, useRef, useState } from 'react'
import type { AppError, Result, ServiceCommand, StudioApi } from '../../contracts/api'
import { request } from '../request'

interface PendingWrite {
  error: AppError
  command: ServiceCommand
  accept: (value: unknown) => boolean
}

/** 两个创作工具共用写入门禁；回执不明时保留表单，并只查询原请求。 */
export function useToolSession({ api, disabled, onDirtyChange, onUnknown, isProtected }: {
  api: StudioApi
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onUnknown?: (error: AppError) => void
  isProtected?: () => boolean
}) {
  const [dirty, setDirtyState] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingWrite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  const epoch = useRef(0)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const pendingRef = useRef<PendingWrite | null>(null)
  const callbacks = useRef({ disabled, onDirtyChange, onUnknown, isProtected })
  callbacks.current = { disabled, onDirtyChange, onUnknown, isProtected }

  function report() { callbacks.current.onDirtyChange(dirtyRef.current || busyRef.current || pendingRef.current !== null || Boolean(callbacks.current.isProtected?.())) }
  useEffect(() => {
    mounted.current = true
    busyRef.current = false
    setBusy(false)
    return () => { mounted.current = false; epoch.current += 1; callbacks.current.onDirtyChange(false) }
  }, [])

  function setDirty(value: boolean) {
    dirtyRef.current = value
    setDirtyState(value)
    report()
  }
  function begin(clearNotice = false): number | null {
    // isProtected 只参与离开保护；同步目录的 read 仍须能开始，避免写入确认后互相等待。
    if (!mounted.current || busyRef.current || pendingRef.current || callbacks.current.disabled) return null
    busyRef.current = true
    setBusy(true)
    setError(null)
    if (clearNotice) setNotice(null)
    report()
    return ++epoch.current
  }
  function current(ticket: number) { return mounted.current && ticket === epoch.current }
  function end(ticket: number) {
    if (!current(ticket)) return
    busyRef.current = false
    setBusy(false)
    report()
  }
  function hold(failure: AppError, command: ServiceCommand, accept: PendingWrite['accept']) {
    const value = { error: failure, command, accept }
    pendingRef.current = value
    setPending(value)
    setError(`${failure.message} 当前输入已保留；确认原请求前暂停写入。`)
    report()
    callbacks.current.onUnknown?.(failure)
  }

  async function read<T>(operation: () => Promise<Result<T>>, receive: (value: T) => void): Promise<boolean> {
    const ticket = begin()
    if (ticket === null) return false
    const result = await request(operation)
    if (!current(ticket)) return false
    try {
      if (!result.ok) { setError(result.error.message); return false }
      receive(result.data)
      return true
    } catch {
      setError('读取的数据与当前对象不一致，请刷新后重试。')
      return false
    } finally { end(ticket) }
  }

  async function write<T>(command: ServiceCommand, operation: () => Promise<Result<T>>, verify: (value: T) => boolean,
    receive: (value: T) => void, success: string): Promise<boolean> {
    const ticket = begin(true)
    if (ticket === null) return false
    const accept = (value: unknown): boolean => {
      try {
        if (!verify(value as T)) return false
      } catch { return false }
      // 存储回执已确认后，界面同步错误不能变成“写入未知”并诱发重复提交。
      try { receive(value as T) }
      catch { setError('保存已经确认，但界面更新未完成，请重新读取资料。') }
      setDirty(false)
      setNotice(success)
      return true
    }
    const result = await request(operation)
    if (!current(ticket)) return false
    try {
      if (!result.ok) {
        if (result.error.code === 'REQUEST_TIMEOUT' || result.error.code === 'SERVICE_UNAVAILABLE') hold(result.error, command, accept)
        else setError(result.error.message)
        return false
      }
      if (!accept(result.data)) {
        hold({ code: 'SERVICE_UNAVAILABLE', message: '保存回执与本次提交不一致，尚不能确认保存结果。' }, command, accept)
        return false
      }
      return true
    } finally { end(ticket) }
  }

  async function checkReceipt(): Promise<boolean> {
    const waiting = pendingRef.current
    if (!waiting || !waiting.error.requestId || busyRef.current || !mounted.current) return false
    const requestId = waiting.error.requestId
    busyRef.current = true
    setBusy(true)
    report()
    const ticket = ++epoch.current
    const result = await request(() => api.getRequestStatus({ requestId }))
    if (!current(ticket)) return false
    try {
      if (!result.ok) { setError(result.error.message); return false }
      if (result.data.state === 'pending') { setError('原请求仍在处理中，请稍后再核对。'); return false }
      if (result.data.state === 'unknown') { setError('服务已无法查询原请求。请保留当前输入，通过主窗口恢复流程核对作品。'); return false }
      if (result.data.response.command !== waiting.command) { setError('原请求对应的操作不匹配，请保留输入并进入恢复流程。'); return false }
      const completed = result.data.response.result
      if (!completed.ok) {
        if (completed.error.code === 'REQUEST_TIMEOUT' || completed.error.code === 'SERVICE_UNAVAILABLE') {
          setError(completed.error.message)
          return false
        }
        pendingRef.current = null
        setPending(null)
        setError(`原请求未成功：${completed.error.message}。输入仍保留，可以修改后重试。`)
        return false
      }
      setError(null)
      if (!waiting.accept(completed.data)) { setError('原请求的回执仍不匹配，输入已保留，请进入恢复流程。'); return false }
      pendingRef.current = null
      setPending(null)
      return true
    } finally { end(ticket) }
  }

  return { dirty, busy, pending, error, notice, setDirty, setError, setNotice, read, write, checkReceipt,
    locked: disabled || busy || pending !== null,
    hasChanges: () => dirtyRef.current,
    hasPending: () => pendingRef.current !== null,
    canLeave: () => !dirtyRef.current && !busyRef.current && !pendingRef.current && !callbacks.current.disabled }
}

export function localDate(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

export function sameFields(actual: object, expected: object): boolean {
  return Object.keys(expected).every((key) => JSON.stringify((actual as Record<string, unknown>)[key]) === JSON.stringify((expected as Record<string, unknown>)[key]))
}
