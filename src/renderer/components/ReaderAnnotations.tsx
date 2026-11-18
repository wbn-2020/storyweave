import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { StudioApi } from '../../contracts/api'
import type { ReviewIssue, WorkbenchSnapshot } from '../../contracts/workbench'
import { MAX_REVIEW_REPLIES, REVIEW_DISCUSSION_SCHEMA_VERSION } from '../../contracts/workbench'
import { request } from '../request'
import type { ReaderBlock, ReaderPage } from './reader-pages'
import { ReviewDiscussion } from './ReviewDiscussion'
import styles from './StellarReader.module.css'

export type AnnotationAction = 'reply' | 'resolve' | 'reopen'
interface Props {
  snapshot: Pick<WorkbenchSnapshot, 'bookRevision' | 'schemaVersion' | 'issues'> | null
  chapterId: string
  revisionId: string
  pages: ReaderPage[]
  pageIndex: number
  renderBlock: (block: ReaderBlock) => ReactNode
  onReviewIssue?: (issueId: string, action: AnnotationAction) => void
  disabled?: boolean
}
interface AnnotationIndex {
  bookRevision: number
  schemaVersion: number
  total: number
  chapter: ReviewIssue[]
  blocks: Map<string, ReviewIssue[]>
}
type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: Pick<WorkbenchSnapshot, 'bookRevision' | 'schemaVersion' | 'issues'> }
  | { kind: 'failed' | 'unavailable'; message: string }
  | { kind: 'pending'; requestId: string; message: string }

const kindLabels: Record<ReviewIssue['kind'], string> = { structure: '结构', causality: '因果', cognition: '人物知情', foreshadow: '伏笔', language: '语言', dialogue: '对话' }
const stateLabels: Record<ReviewIssue['status'], string> = { open: '待处理', recheck: '待复核', resolved: '已解决', intentional: '有意安排', dismissed: '已忽略' }
const ANNOTATIONS_PAGE_SIZE = 20

function indexAnnotations(snapshot: Pick<WorkbenchSnapshot, 'bookRevision' | 'schemaVersion' | 'issues'>, chapterId: string, revisionId: string, blockIds: Set<string>): AnnotationIndex | null {
  const chapter: ReviewIssue[] = [], blocks = new Map<string, ReviewIssue[]>()
  const matching = snapshot.issues.filter((issue) => issue.anchor.chapterId === chapterId && issue.anchor.revisionId === revisionId)
  // 只认当前批注锚点的完整固定身份；不把首次依据、其他修订或整章意见猜成当前段落批注。
  for (const issue of matching) {
    if (issue.anchor.blockIds.some((id) => !blockIds.has(id))) return null
    if (!issue.anchor.blockIds.length) { chapter.push(issue); continue }
    for (const id of issue.anchor.blockIds) {
      const issues = blocks.get(id)
      if (issues) issues.push(issue)
      else blocks.set(id, [issue])
    }
  }
  return { bookRevision: snapshot.bookRevision, schemaVersion: snapshot.schemaVersion, total: matching.length, chapter, blocks }
}

export function AnnotationMarker({ issues, label, group, bookRevision, schemaVersion, onReviewIssue, disabled }: {
  issues: ReviewIssue[]; label: string; group: string; bookRevision: number; schemaVersion: number; onReviewIssue?: (issueId: string, action: AnnotationAction) => void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const content = useRef<HTMLElement>(null)
  const marker = useRef<HTMLDetailsElement>(null)
  const caption = `${label}，${issues.length} 条`
  const pageCount = Math.max(1, Math.ceil(issues.length / ANNOTATIONS_PAGE_SIZE))
  const visiblePage = Math.min(page, pageCount - 1)
  useLayoutEffect(() => {
    const panel = content.current
    const details = marker.current
    const trigger = details?.querySelector('summary')
    if (!open || !panel || !details || !trigger) return
    // 原生浮层保留稿纸配色继承，同时越过阅读滚动区的裁切，不挤动固定正文。
    panel.showPopover()
    const spacing = getComputedStyle(panel)
    const edge = parseFloat(spacing.getPropertyValue('--space-4'))
    const gap = parseFloat(spacing.getPropertyValue('--space-2'))
    const position = () => {
      const anchor = trigger.getBoundingClientRect()
      const box = panel.getBoundingClientRect()
      panel.style.left = `${Math.max(edge, Math.min(anchor.right + gap, innerWidth - box.width - edge))}px`
      panel.style.top = `${Math.max(edge, Math.min(anchor.top, innerHeight - box.height - edge))}px`
    }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !details.contains(event.target)) details.open = false }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || !details.open
        || document.querySelector('dialog[open], [data-stellar-tooltip]:popover-open')) return
      event.preventDefault(); event.stopPropagation()
      const nested = panel.querySelector<HTMLDetailsElement>('details[open]')
      if (nested) { nested.open = false; nested.querySelector('summary')?.focus() }
      else { details.open = false; trigger.focus() }
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(panel)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
      if (panel.matches(':popover-open')) panel.hidePopover()
    }
  }, [open])
  function movePage(next: number) {
    setPage(next)
    if (content.current) { content.current.scrollTop = 0; content.current.focus({ preventScroll: true }) }
  }
  return <details ref={marker} className={styles.annotation} name={group} data-reader-annotation="" onToggle={(event) => {
    setOpen(event.currentTarget.open)
    if (!event.currentTarget.open) setPage(0)
  }}>
    <summary aria-label={caption} title={caption}><span className={styles.annotationDot} aria-hidden="true" /></summary>
    {/* 收起时不挂载详情；同一问题可关联多个段落，不能在每个圆点下重复渲染全部长文。 */}
    {open && <section ref={content} popover="manual" className={styles.annotationDetails} tabIndex={0} aria-label={caption}>
      <header><strong>{label}</strong><span>{issues.length} 条</span></header>
      {issues.slice(visiblePage * ANNOTATIONS_PAGE_SIZE, (visiblePage + 1) * ANNOTATIONS_PAGE_SIZE).map((issue) => <article key={issue.id}>
        {issue.title !== '正文批注' && <h4>{issue.title}</h4>}
        <ReviewDiscussion issue={issue} disabled={disabled} replyDisabled={schemaVersion < REVIEW_DISCUSSION_SCHEMA_VERSION || (issue.replies?.length ?? 0) >= MAX_REVIEW_REPLIES}
          replyReason={schemaVersion < REVIEW_DISCUSSION_SCHEMA_VERSION ? '请先在审稿与批注中备份并升级作品，以启用回复。'
            : (issue.replies?.length ?? 0) >= MAX_REVIEW_REPLIES ? '已达每条批注 100 条回复的上限，已有回复保留。' : undefined}
          onReply={onReviewIssue ? () => onReviewIssue(issue.id, 'reply') : undefined}
          onResolve={onReviewIssue && issue.status !== 'resolved' ? () => onReviewIssue(issue.id, 'resolve') : undefined}
          onReopen={onReviewIssue && issue.status === 'resolved' ? () => onReviewIssue(issue.id, 'reopen') : undefined} />
        <details><summary>依据与处理详情</summary>
          <p className={styles.annotationMeta}>{kindLabels[issue.kind]} · {stateLabels[issue.status]}{issue.stale ? ' · 来源待复核' : ''}</p>
          <dl>
          {([['evidence', '引文'], ['suggestion', '建议'], ['resolution', '处理说明']] as const).map(([key, title]) =>
            issue[key] ? <div key={key}><dt>{title}</dt><dd>{issue[key]}</dd></div> : null)}
          </dl>
        </details>
      </article>)}
      {pageCount > 1 && <nav className={styles.annotationPaging} aria-label="批注分页">
        <button type="button" disabled={visiblePage === 0} onClick={() => movePage(visiblePage - 1)}>上一页</button>
        <span role="status">第 {visiblePage + 1} / {pageCount} 页</span>
        <button type="button" disabled={visiblePage + 1 >= pageCount} onClick={() => movePage(visiblePage + 1)}>下一页</button>
      </nav>}
      <footer>固定正文 · 批注读取时作品版本 {bookRevision}{onReviewIssue ? ' · 回复将在审稿与批注中处理' : ' · 只读'}</footer>
    </section>}
  </details>
}

export function useReaderAnnotations({ api, bookId, enabled, busy }: {
  api: StudioApi; bookId: string; enabled: boolean; busy: boolean
}) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' })
  const [checking, setChecking] = useState(false)
  const mounted = useRef(false)
  const lock = useRef(false)
  const pending = useRef<string | null>(null)
  const current = useRef({ api, busy })
  current.current = { api, busy }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async () => {
    if (!mounted.current || current.current.busy || lock.current || pending.current) return
    lock.current = true; setState({ kind: 'loading' })
    const result = await request(() => current.current.api.getWorkbench({ bookId }))
    if (!mounted.current) return
    lock.current = false
    if (!result.ok) {
      if (result.error.code === 'REQUEST_TIMEOUT' && result.error.requestId) {
        pending.current = result.error.requestId
        setState({ kind: 'pending', requestId: result.error.requestId, message: '批注读取超时，请核对原请求。正文仍可阅读。' })
      } else setState({ kind: 'failed', message: result.error.message })
      return
    }
    const snapshot = result.data
    if (!snapshot || snapshot.bookId !== bookId || !Number.isSafeInteger(snapshot.bookRevision) || snapshot.bookRevision < 0
      || !Number.isSafeInteger(snapshot.schemaVersion) || !Array.isArray(snapshot.issues) || typeof snapshot.requiresUpgrade !== 'boolean') {
      setState({ kind: 'failed', message: '批注返回的作品身份或资料无效。' }); return
    }
    if (snapshot.requiresUpgrade) {
      setState({ kind: 'unavailable', message: '此作品格式尚不支持审稿批注。' }); return
    }
    // 阅读会话仅保留本书已读取的批注快照；切章和切换工作稿/定稿不重复读取整份工作台。
    setState({ kind: 'ready', snapshot: { bookRevision: snapshot.bookRevision, schemaVersion: snapshot.schemaVersion, issues: snapshot.issues } })
  }, [bookId])

  useEffect(() => {
    if (enabled && !busy && state.kind === 'idle') void load()
  }, [enabled, busy, state.kind, load])

  async function queryOriginal() {
    const requestId = pending.current
    if (!mounted.current || current.current.busy || lock.current || !requestId) return
    lock.current = true; setChecking(true)
    const result = await request(() => current.current.api.getRequestStatus({ requestId }))
    if (!mounted.current) return
    lock.current = false; setChecking(false)
    if (!result.ok) {
      setState({ kind: 'pending', requestId, message: `批注状态查询失败：${result.error.message}` }); return
    }
    const status = result.data
    if (status.state === 'pending') {
      setState({ kind: 'pending', requestId, message: '原批注读取仍在处理，请稍后核对。' }); return
    }
    if (status.state === 'completed' && status.response.command !== 'workbench.get') {
      setState({ kind: 'pending', requestId, message: '返回的请求类型不符，请继续核对原请求。' }); return
    }
    // 迟到回包不直接覆盖已固定的阅读状态；核对结束后由作者明确重读批注。
    pending.current = null
    setState({ kind: 'failed', message: status.state === 'unknown' ? '原批注请求状态已不可查询，可重新读取。' : '原批注请求已结束，可重新读取。' })
  }

  return { state, checking, load, queryOriginal }
}

export function ReaderAnnotations({ snapshot, chapterId, revisionId, pages, pageIndex, renderBlock, onReviewIssue, disabled }: Props) {
  const group = useId()
  const index = useMemo(() => snapshot ? indexAnnotations(snapshot, chapterId, revisionId,
    new Set(pages.flatMap((page) => page.blocks.map((block) => block.id)))) : null, [snapshot, chapterId, revisionId, pages])
  return <>
    {snapshot && !index && <p className={styles.annotationWarning} role="alert">批注的段落与当前固定正文不符，未显示批注。</p>}
    <div className={styles.prose} data-annotations={Boolean(index?.total)}>
      {index && index.chapter.length > 0 && <div key={`chapter:${pageIndex}`} className={styles.chapterAnnotation}>
        <AnnotationMarker issues={index.chapter} label="本章批注" group={group} bookRevision={index.bookRevision} schemaVersion={index.schemaVersion} onReviewIssue={onReviewIssue} disabled={disabled} />
        <span>本章批注 · {index.chapter.length} 条</span>
      </div>}
      {pages[pageIndex]?.blocks.map((block) => {
        const issues = index?.blocks.get(block.id)
        // 分页片段沿用同一段落锚点；续页仍能打开该段批注，不按片段重复统计条数。
        return <div key={`${pageIndex}:${block.id}:${block.part}`} className={styles.annotatedBlock} data-annotated={Boolean(issues?.length)}>
          {issues && <AnnotationMarker issues={issues} label={block.continued ? '本段批注（接上页）' : '本段批注'} group={group} bookRevision={index!.bookRevision} schemaVersion={index!.schemaVersion} onReviewIssue={onReviewIssue} disabled={disabled} />}
          {renderBlock(block)}
        </div>
      })}
    </div>
  </>
}
