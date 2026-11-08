import { useCallback, useEffect, useRef, useState } from 'react'
import type { StudioApi } from '../../contracts/api'
import { parseManuscript } from '../../contracts/manuscript'
import type { useChapterSession } from './useChapterSession'
import { request } from '../request'

type ChapterSession = ReturnType<typeof useChapterSession>
interface ProtectionState { editorSessionId: string | null; editSequence: number; createdAt: string | null; error: string | null; warning: string | null }
const emptyState: ProtectionState = { editorSessionId: null, editSequence: -1, createdAt: null, error: null, warning: null }

export function useDraftProtection(api: StudioApi | undefined, scope: string | undefined, session: ChapterSession) {
  const [state, setState] = useState<ProtectionState>(emptyState)
  const latest = useRef({ scope, session, api })
  latest.current = { scope, session, api }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSince = useRef<number | null>(null)
  const inFlight = useRef(false)
  const attempted = useRef<string | null>(null)
  const mounted = useRef(true)
  const [wake, setWake] = useState(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const capture = useCallback(async () => {
    const origin = latest.current
    const current = origin.session.getCurrent()
    if (!origin.api || !origin.scope || !current.chapter || !current.editorSessionId || !current.dirty || current.composing || inFlight.current) return
    const identity = `${origin.scope}:${current.editorSessionId}:${current.editSequence}`
    if (attempted.current === identity) return
    attempted.current = identity
    inFlight.current = true
    pendingSince.current = null
    let createdAt: string | null = null
    let error: string | null = null
    let warning: string | null = null
    try {
      const document = parseManuscript(current.draft)
      const result = await request(() => origin.api!.checkpointDraft({
        scope: origin.scope!, editorSessionId: current.editorSessionId!, editSequence: current.editSequence,
        bookId: current.chapter!.bookId, chapterId: current.chapter!.id, baseRevisionId: current.chapter!.revisionId,
        title: current.chapter!.title, document,
      }))
      if (result.ok) { createdAt = result.data.createdAt; warning = result.data.warning ?? null }
      else error = result.error.message
    } catch { error = '当前草稿暂未生成恢复检查点，请保留窗口或另存草稿副本。' }
    finally {
      inFlight.current = false
      // 完成时只更新原编辑会话的提示；旧章与旧书库回执不能冒充当前草稿的保护状态。
      const active = latest.current
      if (mounted.current && active.scope === origin.scope && active.session.getCurrent().editorSessionId === current.editorSessionId) {
        setState({ editorSessionId: current.editorSessionId, editSequence: current.editSequence, createdAt, error, warning })
      }
      if (mounted.current) setWake((value) => value + 1)
    }
  }, [])

  const current = session.session
  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    if (!scope || !current.dirty) { pendingSince.current = null; return }
    if (current.composing || inFlight.current) return
    const identity = `${scope}:${current.editorSessionId}:${current.editSequence}`
    if (attempted.current === identity) return
    // 停笔 800ms 留一份；持续输入最多等待 5s。输入法组合期间等待最终文字落下。
    pendingSince.current ??= Date.now()
    const remaining = Math.max(0, 5000 - (Date.now() - pendingSince.current))
    timer.current = setTimeout(() => { void capture() }, Math.min(800, remaining))
    return () => { if (timer.current !== null) clearTimeout(timer.current) }
  }, [scope, current.editorSessionId, current.editSequence, current.dirty, current.composing, capture, wake])

  const retry = useCallback(() => {
    attempted.current = null
    setState((previous) => ({ ...previous, error: null, warning: null }))
    void capture()
  }, [capture])

  return { state: state.editorSessionId === current.editorSessionId ? state : emptyState, retry }
}
