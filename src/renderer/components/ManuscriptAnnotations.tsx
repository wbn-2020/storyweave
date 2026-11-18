import { useId, useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import type { StudioApi } from '../../contracts/api'
import type { ReviewIssue } from '../../contracts/workbench'
import { AnnotationMarker, useReaderAnnotations, type AnnotationAction } from './ReaderAnnotations'
import styles from './ManuscriptAnnotations.module.css'

export interface ManuscriptAnnotationContext {
  api: StudioApi
  bookId: string
  bookRevision: number
  chapterId: string
  revisionId: string
  dirty: boolean
  onReviewIssue: (issueId: string, action: AnnotationAction) => void
}
interface Props extends ManuscriptAnnotationContext {
  editor: Editor
  host: RefObject<HTMLDivElement | null>
  disabled: boolean
  readOnly: boolean
}
interface Position { id: string; top: number; left: number; height: number }

export function ManuscriptAnnotations({ api, bookId, chapterId, revisionId, dirty, onReviewIssue, editor, host, disabled, readOnly }: Props) {
  const group = useId()
  const annotations = useReaderAnnotations({ api, bookId, enabled: !disabled && !dirty, busy: disabled || dirty })
  const snapshot = annotations.state.kind === 'ready' ? annotations.state.snapshot : null
  const [positions, setPositions] = useState<Position[]>([])
  const issues = useMemo(() => {
    const indexed = new Map<string, ReviewIssue[]>()
    for (const issue of snapshot?.issues ?? []) {
      if (issue.anchor.chapterId !== chapterId || issue.anchor.revisionId !== revisionId) continue
      for (const id of issue.anchor.blockIds) indexed.set(id, [...(indexed.get(id) ?? []), issue])
    }
    return indexed
  }, [snapshot, chapterId, revisionId])

  useLayoutEffect(() => {
    if (disabled || dirty || !snapshot || !host.current || editor.isDestroyed) { setPositions([]); return }
    const root = host.current
    let frame = 0
    let active = true
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!active || editor.isDestroyed) return
        const origin = root.getBoundingClientRect()
        const gap = parseFloat(getComputedStyle(root).getPropertyValue('--space-2'))
        const next: Position[] = []
        // 标记在正文 DOM 外按固定 blockId 定位，不向 TipTap 注入节点或产生撤销记录。
        editor.state.doc.forEach((node, offset) => {
          if (!issues.has(node.attrs.id)) return
          const dom = editor.view.nodeDOM(offset)
          if (!(dom instanceof HTMLElement)) return
          const rect = dom.getBoundingClientRect()
          next.push({ id: node.attrs.id, top: rect.top - origin.top, left: rect.left - origin.left + gap, height: rect.height })
        })
        setPositions((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(editor.view.dom)
    if (editor.view.dom.parentElement) observer.observe(editor.view.dom.parentElement)
    editor.on('transaction', measure)
    window.addEventListener('resize', measure)
    return () => {
      active = false
      cancelAnimationFrame(frame)
      observer.disconnect()
      editor.off('transaction', measure)
      window.removeEventListener('resize', measure)
    }
  }, [editor, host, issues, snapshot, disabled, dirty])

  if (disabled || dirty) return null
  if (annotations.state.kind === 'loading') return <div className={styles.status} role="status" aria-busy="true">正在读取正文批注…</div>
  if (annotations.state.kind === 'unavailable') return <div className={styles.status} role="status">{annotations.state.message}</div>
  if (annotations.state.kind === 'failed' || annotations.state.kind === 'pending') return <div className={styles.status} role="status">
    <span>{annotations.state.message}</span>
    <button type="button" disabled={annotations.checking} aria-busy={annotations.checking} onClick={() => void (annotations.state.kind === 'pending' ? annotations.queryOriginal() : annotations.load())}>
      {annotations.checking ? '核对中…' : annotations.state.kind === 'pending' ? '核对原批注读取' : '重试读取批注'}
    </button>
  </div>
  if (!snapshot) return null
  return <div className={styles.layer} role="group" aria-label="正文页边批注">
    {positions.filter((position) => issues.has(position.id)).map((position) => <div key={position.id} className={styles.marker} data-editor-annotation={position.id}
      style={{ top: position.top, left: position.left, height: position.height }}>
      <AnnotationMarker issues={issues.get(position.id)!} label="本段批注" group={group} bookRevision={snapshot.bookRevision} schemaVersion={snapshot.schemaVersion}
        onReviewIssue={onReviewIssue} disabled={readOnly} />
    </div>)}
  </div>
}
