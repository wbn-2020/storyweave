import { useCallback, useEffect, useRef, useState } from 'react'
import { DomainError, type AppError, type ChapterSnapshot, type Result, type SaveChapterOutput, type StudioApi } from '../../contracts/api'
import { countCharacters, parseManuscript } from '../../contracts/manuscript'

interface Session {
  chapter: ChapterSnapshot | null
  draft: unknown
  editSequence: number
  dirty: boolean
  saving: boolean
  composing: boolean
  characterCount: number
  error: AppError | null
  loadEpoch: number
}

const initialSession: Session = {
  chapter: null, draft: null, editSequence: 0, dirty: false, saving: false,
  composing: false, characterCount: 0, error: null, loadEpoch: 0,
}

export function useChapterSession(api: StudioApi | undefined, onSaved: (chapter: ChapterSnapshot) => void) {
  const [session, setSession] = useState<Session>(initialSession)
  const current = useRef(session)
  const inFlight = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const uncertainSave = useRef<{ requestId?: string; captured: Session } | null>(null)
  const autoSavePaused = useRef(false)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const publish = useCallback((next: Session) => {
    current.current = next
    setSession(next)
  }, [])

  const stopTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const flush = useCallback(async (): Promise<boolean> => {
    stopTimer()
    if (inFlight.current) return inFlight.current
    const first = current.current
    if (first.composing) return false
    if (!first.chapter || !first.dirty) return true
    if (!api) return false
    if (first.error?.code === 'REVISION_CONFLICT') return false

    const operation = async (): Promise<boolean> => {
      // 保存串行执行。保存期间新增输入仍是草稿，回执只推进对应版本，不能覆盖编辑器。
      while (current.current.chapter && current.current.dirty) {
        const captured = uncertainSave.current?.captured ?? current.current
        if (captured.composing || !captured.chapter) return false
        publish({ ...current.current, saving: true, error: null })
        try {
          let result: Result<SaveChapterOutput>
          if (uncertainSave.current) {
            // 超时不等于写入失败：先查同一请求的回执，禁止用旧版本盲目重发。
            const requestId = uncertainSave.current.requestId
            if (!requestId) {
              publish({ ...current.current, saving: false, error: {
                code: 'SERVICE_UNAVAILABLE', message: '上次保存结果无法确认。请保留窗口并复制当前正文留存，勿重复提交。',
              } })
              return false
            }
            const receipt = await api.getRequestStatus({ requestId })
            if (!receipt.ok) { publish({ ...current.current, saving: false, error: receipt.error }); return false }
            if (receipt.data.state !== 'completed') {
              publish({ ...current.current, saving: false, error: {
                code: 'REQUEST_TIMEOUT', requestId,
                message: receipt.data.state === 'pending'
                  ? '上次保存仍在处理中。稍后点击保存可重新核对回执，当前草稿会保留。'
                  : '上次保存回执已不可用，无法确认磁盘版本。请保留窗口并复制正文留存。',
              } })
              return false
            }
            if (receipt.data.response.command !== 'chapter.save') {
              publish({ ...current.current, saving: false, error: {
                code: 'STORAGE_ERROR', message: '保存回执与当前操作不一致，未替换草稿。',
              } })
              return false
            }
            result = receipt.data.response.result
            uncertainSave.current = null
          } else {
            let document
            try { document = parseManuscript(captured.draft) } catch (error) {
              const detail: AppError = error instanceof DomainError ? error.detail : {
                code: 'INVALID_INPUT', message: '当前正文结构无法保存。草稿已留在编辑器中，请检查内容。',
              }
              publish({ ...current.current, saving: false, error: detail })
              return false
            }
            result = await api.saveChapter({
              bookId: captured.chapter.bookId,
              chapterId: captured.chapter.id,
              expectedRevisionId: captured.chapter.revisionId,
              document,
            })
          }
          const latest = current.current
          if (latest.chapter?.id !== captured.chapter.id || latest.chapter.bookId !== captured.chapter.bookId) {
            return false
          }
          if (!result.ok) {
            if (result.error.code === 'REQUEST_TIMEOUT' || result.error.code === 'SERVICE_UNAVAILABLE') {
              uncertainSave.current = { captured, requestId: result.error.requestId }
            }
            publish({ ...latest, saving: false, error: result.error })
            return false
          }
          if (result.data.chapter.id !== captured.chapter.id || result.data.chapter.bookId !== captured.chapter.bookId) {
            uncertainSave.current = { captured }
            publish({ ...latest, saving: false, error: { code: 'STORAGE_ERROR', message: '保存回执的作品或章节不匹配，当前草稿已保留。' } })
            return false
          }
          const dirty = latest.editSequence !== captured.editSequence
          publish({ ...latest, chapter: result.data.chapter, dirty, saving: false, error: null })
          onSavedRef.current(result.data.chapter)
        } catch {
          uncertainSave.current ??= { captured }
          publish({ ...current.current, saving: false, error: {
            code: 'SERVICE_UNAVAILABLE', message: '保存未获确认，草稿仍在当前窗口。请保留窗口并重试。',
          } })
          return false
        }
      }
      return !current.current.dirty
    }

    inFlight.current = operation()
    try { return await inFlight.current } finally { inFlight.current = null }
  }, [api, publish, stopTimer])

  const changed = useCallback((draft: unknown, text: string) => {
    const previous = current.current
    if (!previous.chapter) return
    publish({
      ...previous, draft, dirty: true, editSequence: previous.editSequence + 1,
      characterCount: countCharacters(text),
      error: previous.error?.code === 'REVISION_CONFLICT' || uncertainSave.current ? previous.error : null,
    })
  }, [publish])

  const setComposing = useCallback((composing: boolean) => {
    publish({ ...current.current, composing })
  }, [publish])

  const load = useCallback((chapter: ChapterSnapshot | null) => {
    if (current.current.dirty || current.current.saving || current.current.composing || uncertainSave.current) {
      throw new Error('Unflushed chapter transition')
    }
    stopTimer()
    const loadEpoch = current.current.loadEpoch + 1
    publish(chapter ? {
      ...initialSession, chapter, draft: chapter.document, characterCount: chapter.characterCount, loadEpoch,
    } : { ...initialSession, loadEpoch })
  }, [publish, stopTimer])

  const getCurrent = useCallback(() => current.current, [])

  const resetAfterRecovery = useCallback((chapter: ChapterSnapshot | null, expectedEditSequence: number) => {
    // 仅供“副本已落盘 + 作者明确重载 + 磁盘读取成功”的恢复流程调用。
    if (inFlight.current || current.current.saving || current.current.composing || current.current.editSequence !== expectedEditSequence) {
      throw new Error('Draft changed during recovery')
    }
    stopTimer()
    uncertainSave.current = null
    const loadEpoch = current.current.loadEpoch + 1
    publish(chapter ? {
      ...initialSession, chapter, draft: chapter.document, characterCount: chapter.characterCount, loadEpoch,
    } : { ...initialSession, loadEpoch })
  }, [publish, stopTimer])

  useEffect(() => {
    stopTimer()
    if (!autoSavePaused.current && session.dirty && !session.composing && !session.saving && !session.error) {
      timer.current = setTimeout(() => { void flush() }, 1200)
    }
    return stopTimer
  }, [session.editSequence, session.dirty, session.composing, session.saving, session.error, flush, stopTimer])

  const isComposing = useCallback(() => current.current.composing, [])

  const pauseAutoSave = useCallback((paused: boolean) => {
    autoSavePaused.current = paused
    stopTimer()
    const latest = current.current
    if (!paused && latest.dirty && !latest.composing && !latest.saving && !latest.error) {
      timer.current = setTimeout(() => { void flush() }, 1200)
    }
  }, [flush, stopTimer])

  return { session, changed, setComposing, load, flush, isComposing, getCurrent, resetAfterRecovery, pauseAutoSave }
}
