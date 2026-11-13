import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { AppError, BookSnapshot, StudioApi } from '../../contracts/api'
import { AUTHOR_DECISIONS, KNOWLEDGE_NATURES, type AuthorDecision, type KnowledgeNature } from '../../contracts/knowledge'
import type { StoryKind, StoryRecordDetail } from '../../contracts/story'
import { MAX_TIMELINE_ITEMS, MAX_TIMELINE_PAGE_SIZE, TIMELINE_TRACKS, timelineItemId, type StoryTimelineInput, type StoryTimelineItem, type StoryTimelinePage, type TimelineDisclosure, type TimelineOrder, type TimelineTrack } from '../../contracts/story-timeline'
import { request } from '../request'
import { Dialog } from './Dialog'
import { blockText, StoryFieldsView, timeLabel } from './StoryFieldsEditor'
import { StudioIcon } from './StudioIcon'
import shared from '../StellarShared.module.css'
import styles from './StellarTimeline.module.css'

export interface StoryTimelinePanelProps {
  api: StudioApi
  book: BookSnapshot
  busy: boolean
  error?: string | null
  onClose: () => void
  onOpenRecords: (kind: StoryKind, create?: boolean) => void
}

interface Filters {
  order: TimelineOrder
  tracks: TimelineTrack[]
  search: string
  nature: KnowledgeNature | ''
  authorDecision: AuthorDecision | ''
}
interface PageRequest extends Filters {
  offset: number
  expected: Pick<StoryTimelinePage, 'bookRevision' | 'knowledgeRevision'> | null
}
interface OriginalTarget {
  bookId: string
  chapterId: string
  revisionId: string
  blockId: string
  label: '披露位置' | '记录来源'
  quote?: string
}
interface OriginalPreview {
  target: OriginalTarget
  blocks: { id: string; text: string; target: boolean }[]
  quoteMatches: boolean | null
}
interface PendingRead { requestId: string; command: 'story.timeline' | 'story.get' | 'revision.read' }

const natureLabels = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
const decisionLabels = { unreviewed: '未处理', adopted: '已采纳', rejected: '已否决', review_later: '要求复核' }
const freshnessLabels = { current: '当前', affected: '受影响', updating: '更新中', failed: '更新失败' }
const conflictLabels = { unchecked: '未检查', clear: '未发现已知冲突', candidate: '候选冲突', explained: '作者已解释' }
const referenceLabels = { current: '当前稿登记', historical: '历史稿登记', missing: '章节或版本登记缺失' }
const sourceLabels = { author_input: '作者输入', external: '外部资料说明', chapter_text: '固定正文引文' }
const validityLabels = { valid: '出处可查', partial: '出处部分缺失', missing: '出处缺失' }
const trackLabels: Record<TimelineTrack, string> = { event: '事件', cognition: '人物认知', relation: '关系变迁', foreshadow: '伏笔' }
const stageLabels = { planned: '计划', planted: '埋设', advanced: '推进', revealed: '揭示', resolved: '回收', abandoned: '放弃' }
const cognitionChangeLabels = { formed: '形成', revised: '修正', refuted: '推翻', concealed: '隐瞒', forgotten: '遗忘' }

function pointLabel(item: StoryTimelineItem): string {
  if (item.point === 'relation_start') return '关系生效登记'
  if (item.point === 'relation_end') return '关系结束登记'
  if (item.point === 'foreshadow_milestone') return `里程碑 · ${item.stage ? stageLabels[item.stage] : '阶段未知'}`
  if (item.kind === 'foreshadow') return `伏笔登记 · 当前阶段：${item.stage ? stageLabels[item.stage] : '未知'}`
  if (item.kind === 'cognition') return item.cognitionChange ? `认知${cognitionChangeLabels[item.cognitionChange]}` : '认知登记 · 变化类型未记录'
  return '事件登记'
}

function detailMatchesItem(detail: StoryRecordDetail, item: StoryTimelineItem): boolean {
  const fields = detail.fields
  if (detail.id !== item.sourceRecordId || fields.kind !== item.kind || fields.title !== item.title ||
      fields.nature !== item.nature || fields.authorDecision !== item.authorDecision ||
      fields.freshness !== item.freshness || fields.conflictState !== item.conflictState) return false
  let time = fields.kind === 'relation' ? fields.validFrom : fields.storyTime
  let disclosure = fields.disclosure
  let description = fields.description
  let stage = fields.kind === 'foreshadow' ? fields.stage : undefined
  if (item.point === 'relation_start' || item.point === 'relation_end') {
    if (fields.kind !== 'relation' || item.milestoneId !== null) return false
    if (item.point === 'relation_end') { time = fields.validUntil; disclosure = { state: 'unknown' } }
  } else if (item.point === 'foreshadow_milestone') {
    if (fields.kind !== 'foreshadow') return false
    const milestone = fields.milestones.find((entry) => entry.id === item.milestoneId)
    if (!milestone) return false
    time = milestone.storyTime; disclosure = milestone.disclosure; description = milestone.note; stage = milestone.stage
  } else if (item.point !== 'record' || fields.kind === 'relation' || item.milestoneId !== null) return false
  const cognitionChange = fields.kind === 'cognition' ? fields.evolution?.kind : undefined
  return Array.from(description).slice(0, 240).join('') === item.description && stage === item.stage && cognitionChange === item.cognitionChange &&
    time.kind === item.time.kind && (time.kind === 'unknown' || item.time.kind !== 'unknown' && time.order === item.time.order && time.label === item.time.label) &&
    disclosure.state === item.disclosure.state && (disclosure.state !== 'located' || item.disclosure.state === 'located' &&
      disclosure.chapterId === item.disclosure.chapterId && disclosure.revisionId === item.disclosure.revisionId && disclosure.blockId === item.disclosure.blockId)
}

function disclosureText(disclosure: TimelineDisclosure): string {
  if (disclosure.state !== 'located') return disclosure.state === 'unknown' ? '披露位置未知' : '尚未披露'
  const chapter = disclosure.chapterPosition === null ? `章节 ${disclosure.chapterId}` : `第 ${disclosure.chapterPosition + 1} 章`
  return `${chapter}${disclosure.chapterTitle ? ` · ${disclosure.chapterTitle}` : ''} · ${referenceLabels[disclosure.referenceState]}`
}

function groupFor(item: StoryTimelineItem, order: TimelineOrder): { key: string; label: string } {
  if (order === 'story') {
    return item.time.kind === 'unknown' || item.time.order === null
      ? { key: 'unknown', label: '故事顺序未知 · 未指定排序值' }
      : { key: 'ordered', label: '已指定故事顺序' }
  }
  const disclosure = item.disclosure
  if (disclosure.state === 'located') return { key: disclosure.referenceState, label: referenceLabels[disclosure.referenceState] }
  return { key: disclosure.state, label: disclosure.state === 'undisclosed' ? '尚未披露' : '披露位置未知' }
}

function columnFor(item: StoryTimelineItem, order: TimelineOrder) {
  if (order === 'story') {
    return item.time.kind !== 'unknown' && item.time.order !== null
      ? { key: `story:${item.time.order}`, label: `排序值 ${item.time.order}`, unknown: false }
      : { key: 'unknown', label: '故事顺序未知', unknown: true }
  }
  const disclosure = item.disclosure
  if (disclosure.state === 'located' && disclosure.chapterPosition !== null) {
    return { key: `${disclosure.referenceState}:${disclosure.chapterId}`,
      label: `第 ${disclosure.chapterPosition + 1} 章 · ${referenceLabels[disclosure.referenceState]}`, unknown: false }
  }
  return { key: `unknown:${disclosure.state}`, label: disclosureText(disclosure), unknown: true }
}

export function StoryTimelinePanel(props: StoryTimelinePanelProps) {
  // 切换作品时独立卸载读取会话，不把上一部作品的列表、原稿或请求带入新作品。
  return <TimelineContent key={props.book.book.id} {...props} />
}

function TimelineContent({ api, book, busy, error, onClose, onOpenRecords }: StoryTimelinePanelProps) {
  const bookId = book.book.id
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<PageRequest>({ order: 'story', tracks: ['event'], search: '', nature: '', authorDecision: '', offset: 0, expected: null })
  const [page, setPage] = useState<StoryTimelinePage | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<StoryRecordDetail | null>(null)
  const [reading, setReading] = useState<'detail' | 'original' | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [original, setOriginal] = useState<OriginalPreview | null>(null)
  const [pending, setPending] = useState<PendingRead | null>(null)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [checkingRequest, setCheckingRequest] = useState(false)
  const [layout, setLayout] = useState<'board' | 'list'>('board')
  const [columnWidth, setColumnWidth] = useState(240)
  const mounted = useRef(false)
  const listLock = useRef(true)
  const readLock = useRef(false)
  const listTicket = useRef(0)
  const readTicket = useRef(0)
  const statusTicket = useRef(0)
  const pendingRead = useRef<PendingRead | null>(null)
  const statusLock = useRef(false)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const originalHeading = useRef<HTMLHeadingElement>(null)
  const originalTrigger = useRef<HTMLButtonElement | null>(null)
  const readErrorElement = useRef<HTMLParagraphElement>(null)
  const pendingButton = useRef<HTMLButtonElement>(null)
  const detailId = useId()
  const originalId = useId()
  const disabled = busy || listLoading || reading !== null || pending !== null

  const clearReading = useCallback(() => {
    readTicket.current += 1; readLock.current = false
    originalTrigger.current = null
    setSelectedId(null); setDetail(null); setOriginal(null); setReadError(null); setReading(null)
  }, [])

  const invalidateSnapshot = useCallback((message: string) => {
    listTicket.current += 1; listLock.current = false
    clearReading(); setPage(null); setListLoading(false)
    setListError(`${message} 旧列表、详情与原稿已清除，请从第一页刷新。`)
  }, [clearReading])

  const retainTimeout = useCallback((failure: AppError, command: PendingRead['command']): boolean => {
    if (failure.code !== 'REQUEST_TIMEOUT' || !failure.requestId) return false
    const next = { requestId: failure.requestId, command }
    // 服务仍持有超时请求；查询原请求前暂停新读，不把通用的保存提示误用为本页写入。
    pendingRead.current = next; setPending(next)
    setPendingMessage('只读请求已超时，服务可能仍在处理。请查询原请求；等待期间可以关闭面板。')
    listTicket.current += 1; listLock.current = false
    clearReading(); setPage(null); setListLoading(false); setListError(null)
    return true
  }, [clearReading])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; listTicket.current += 1; readTicket.current += 1; statusTicket.current += 1 }
  }, [])

  useEffect(() => {
    if (pendingRead.current) return
    let cancelled = false
    const ticket = ++listTicket.current
    listLock.current = true
    setListLoading(true); setPage(null); setListError(null); clearReading()
    const input: StoryTimelineInput = {
      bookId, order: listing.order, tracks: listing.tracks, search: listing.search, limit: MAX_TIMELINE_PAGE_SIZE, offset: listing.offset,
      ...(listing.nature ? { nature: listing.nature } : {}),
      ...(listing.authorDecision ? { authorDecision: listing.authorDecision } : {}),
      ...(listing.expected ? { expectedBookRevision: listing.expected.bookRevision, expectedKnowledgeRevision: listing.expected.knowledgeRevision } : {}),
    }
    void request(() => api.listStoryTimeline(input)).then((result) => {
      if (cancelled || !mounted.current || ticket !== listTicket.current) return
      listLock.current = false; setListLoading(false)
      if (!result.ok) {
        if (retainTimeout(result.error, 'story.timeline')) return
        if (result.error.code === 'REVISION_CONFLICT') invalidateSnapshot(result.error.message)
        else setListError(result.error.message)
        return
      }
      const data = result.data
      if (data.bookId !== bookId || data.order !== listing.order || JSON.stringify(data.tracks) !== JSON.stringify(listing.tracks) ||
          data.items.some((item) => item.bookId !== bookId || !listing.tracks.includes(item.kind) ||
            item.id !== timelineItemId(item.sourceRecordId, item.point, item.milestoneId) ||
            !Array.isArray(item.people) || item.people.length > 200 ||
            new Set(item.people.map((person) => person.id)).size !== item.people.length ||
            item.people.some((person) => typeof person.id !== 'string' || typeof person.name !== 'string' || !person.name.trim())) ||
          new Set(data.items.map((item) => item.id)).size !== data.items.length) {
        invalidateSnapshot('时间线返回的作品、轨道、条目身份或排序方式不符。'); return
      }
      const expectedLength = Math.min(MAX_TIMELINE_PAGE_SIZE, Math.max(0, data.total - listing.offset))
      const nextOffset = listing.offset + data.items.length < data.total ? listing.offset + data.items.length : null
      if (!Number.isSafeInteger(data.total) || data.total < 0 || data.total > MAX_TIMELINE_ITEMS ||
          (listing.offset > 0 && listing.offset >= data.total) || data.items.length !== expectedLength || data.nextOffset !== nextOffset ||
          !Number.isSafeInteger(data.bookRevision) || data.bookRevision < 0 || !Number.isSafeInteger(data.knowledgeRevision) || data.knowledgeRevision < 0) {
        invalidateSnapshot('时间线分页数量、下一页位置或版本格式不符。'); return
      }
      if (listing.expected && (data.bookRevision !== listing.expected.bookRevision || data.knowledgeRevision !== listing.expected.knowledgeRevision)) {
        invalidateSnapshot('时间线作品版本或知识版本已变化。'); return
      }
      setPage(data)
    })
    return () => { cancelled = true }
  }, [api, bookId, clearReading, invalidateSnapshot, listing, retainTimeout])

  useEffect(() => { if (detail) detailHeading.current?.focus() }, [detail])
  useEffect(() => { if (original) originalHeading.current?.focus() }, [original])
  useEffect(() => { if (readError) readErrorElement.current?.focus() }, [readError])
  useEffect(() => { if (pending) pendingButton.current?.focus() }, [pending])

  function changePage(next: PageRequest) {
    if (busy || listLock.current || readLock.current || pendingRead.current || !mounted.current) return
    // 先撤销旧读取资格，再安排新状态，防止效果清理之前收到旧详情或原稿。
    listTicket.current += 1; listLock.current = true
    clearReading(); setPage(null); setListError(null); setListLoading(true); setListing(next)
  }

  function refreshSnapshot(filters: Partial<Filters> = {}) {
    changePage({ ...listing, ...filters, offset: 0, expected: null })
  }

  function movePage(offset: number) {
    if (!page) return
    // 上一页也携带双版本，包括回到 offset=0；只有显式刷新或更换条件才能建立新快照。
    changePage({ ...listing, offset, expected: { bookRevision: page.bookRevision, knowledgeRevision: page.knowledgeRevision } })
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    refreshSnapshot({ search: query.trim() })
  }

  function leave(action: () => void) {
    if (busy) return
    listTicket.current += 1; readTicket.current += 1; statusTicket.current += 1
    action()
  }

  async function queryOriginalRequest() {
    const saved = pendingRead.current
    if (!saved || busy || statusLock.current) return
    const ticket = ++statusTicket.current
    statusLock.current = true; setCheckingRequest(true)
    const result = await request(() => api.getRequestStatus({ requestId: saved.requestId }))
    if (!mounted.current || ticket !== statusTicket.current || pendingRead.current !== saved) return
    statusLock.current = false; setCheckingRequest(false)
    if (!result.ok) { setPendingMessage(`原请求状态查询失败：${result.error.message} 请稍后查询，或关闭面板后恢复服务。`); return }
    const status = result.data
    if (status.state === 'pending') { setPendingMessage('原读取仍在执行，请稍后再次查询。等待期间可以关闭面板。'); return }
    if (status.state === 'completed' && status.response.command !== saved.command) {
      setPendingMessage('原请求返回的命令身份不符，尚未解除读取等待；请关闭面板后核对或恢复服务。'); return
    }
    pendingRead.current = null; setPending(null); setPendingMessage(null)
    // 迟到回包只用于解除读取等待，不应用其中的列表、详情或整章原稿。
    invalidateSnapshot(status.state === 'unknown'
      ? '原请求不可查询。可刷新只读列表，或关闭面板后恢复服务。'
      : '原读取已结束，已核对请求命令。请重新读取列表。')
  }

  async function selectRecord(id: string) {
    if (busy || listLock.current || readLock.current || pendingRead.current || !page) return
    const item = page.items.find((entry) => entry.id === id)
    if (!item) return
    const ticket = ++readTicket.current
    readLock.current = true
    setSelectedId(id); setDetail(null); setOriginal(null); setReadError(null); setReading('detail')
    // 展开条目的身份用于选择；通用详情始终回到父故事记录，再核对具体里程碑和双版本。
    const result = await request(() => api.getStoryRecord({ bookId, id: item.sourceRecordId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(null)
    if (!result.ok) {
      if (retainTimeout(result.error, 'story.get')) return
      if (result.error.code === 'REVISION_CONFLICT' || result.error.code === 'NOT_FOUND') invalidateSnapshot(result.error.message)
      else setReadError(result.error.message)
      return
    }
    const data = result.data
    if (data.bookId !== bookId || !detailMatchesItem(data, item) ||
        data.bookRevision !== page.bookRevision || data.knowledgeRevision !== page.knowledgeRevision ||
        data.sources.some((source) => source.bookId !== bookId || source.recordId !== item.sourceRecordId)) {
      invalidateSnapshot('记录详情的身份、里程碑、登记内容或双版本与当前页不符。'); return
    }
    setDetail(data)
  }

  async function showOriginal(target: OriginalTarget, trigger: HTMLButtonElement) {
    if (busy || listLock.current || readLock.current || pendingRead.current || !page || !detail) return
    if (target.bookId !== bookId) { invalidateSnapshot('原稿引用的作品身份不符。'); return }
    originalTrigger.current = trigger
    const ticket = ++readTicket.current
    readLock.current = true
    setOriginal(null); setReadError(null); setReading('original')
    const result = await request(() => api.readRevision({ bookId: target.bookId, chapterId: target.chapterId, revisionId: target.revisionId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(null)
    if (!result.ok) {
      if (retainTimeout(result.error, 'revision.read')) return
      if (result.error.code === 'REVISION_CONFLICT') invalidateSnapshot(result.error.message)
      else setReadError(`无法读取${target.label}的固定版本：${result.error.message}`)
      return
    }
    const revision = result.data
    if (revision.bookId !== target.bookId || revision.chapterId !== target.chapterId || revision.id !== target.revisionId) {
      invalidateSnapshot('原稿返回的作品、章节或版本身份不符。'); return
    }
    const index = revision.document.content.findIndex((block) => block.attrs.id === target.blockId)
    if (index < 0) {
      setReadError(`${target.label}的固定版本中未找到段落 ${target.blockId}，未展示其他正文。请到故事记录管理核对引用。`); return
    }
    const text = blockText(revision.document.content[index])
    // 先定位目标段落，再截取前后一段；来源引文保留空白逐字核对，披露位置只核对段落存在。
    setOriginal({
      target,
      blocks: revision.document.content.slice(Math.max(0, index - 1), index + 2).map((block) => ({ id: block.attrs.id, text: blockText(block), target: block.attrs.id === target.blockId })),
      quoteMatches: target.quote === undefined ? null : target.quote.length > 0 && text.includes(target.quote),
    })
  }

  function closeOriginal() {
    if (busy || readLock.current || pendingRead.current) return
    readTicket.current += 1; setOriginal(null); setReading(null); setReadError(null)
    // 同一条记录可从来源、披露或里程碑打开原稿，收起时回到实际入口，避免焦点随按钮卸载丢失。
    const trigger = originalTrigger.current
    originalTrigger.current = null
    if (trigger?.isConnected && !trigger.disabled) trigger.focus()
    else detailHeading.current?.focus()
  }

  const selected = detail ? page?.items.find((item) => item.id === selectedId && item.sourceRecordId === detail.id) : undefined
  const milestone = selected?.milestoneId && detail?.fields.kind === 'foreshadow'
    ? detail.fields.milestones.find((entry) => entry.id === selected.milestoneId) : undefined
  const manageKind = selected?.kind ?? listing.tracks[0] ?? 'event'
  const disclosure = selected?.disclosure
  // 页面刷新可能取得比入口目录更新的快照；共享详情退回章节 ID，专用披露区使用本页元数据。
  const detailBook = page && page.bookRevision !== book.book.revision ? { ...book, chapters: [] } : book
  const filtered = Boolean(listing.search || listing.nature || listing.authorDecision)
  const groups: { key: string; label: string; items: StoryTimelineItem[] }[] = []
  for (const item of page?.items ?? []) {
    const group = groupFor(item, listing.order)
    const last = groups[groups.length - 1]
    if (last?.key === group.key) last.items.push(item)
    else groups.push({ ...group, items: [item] })
  }
  const people = [...new Map((page?.items ?? []).flatMap((item) => item.people.map((person) => [person.id, person] as const))).values()]
  const conflicts = (page?.items ?? []).filter((item) => item.conflictState === 'candidate')
  const laneTone = (item: StoryTimelineItem) => {
    const personIndex = people.findIndex((person) => item.people.some((entry) => entry.id === person.id))
    return personIndex < 0 ? 'unknown' : String(personIndex % 3)
  }
  const inverted = new Set((page?.items ?? []).filter((item) => item.time.kind !== 'unknown' && item.time.order !== null &&
    item.disclosure.state === 'located' && item.disclosure.referenceState === 'current' &&
    page?.items.some((earlier) => earlier.time.kind !== 'unknown' && earlier.time.order !== null &&
      item.time.kind !== 'unknown' && item.time.order !== null && earlier.time.order > item.time.order &&
      earlier.disclosure.state === 'located' && earlier.disclosure.referenceState === 'current' &&
      item.disclosure.state === 'located' && earlier.disclosure.chapterPosition !== null && item.disclosure.chapterPosition !== null &&
      earlier.disclosure.chapterPosition < item.disclosure.chapterPosition)).map((item) => item.id))
  // 等距列仅表达后端给定的排序；不将相对时间推成日期，也不按间距推断时长。
  const columns = new Map<string, { label: string; unknown: boolean; items: StoryTimelineItem[] }>()
  for (const item of page?.items ?? []) {
    const position = columnFor(item, listing.order)
    const column = columns.get(position.key)
    if (column) column.items.push(item)
    else columns.set(position.key, { ...position, items: [item] })
  }

  return <Dialog title="故事年表" wide busy={busy} onClose={() => leave(onClose)} error={error}>
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.orders} role="group" aria-label="时间线排序方式">
          <button type="button" disabled={disabled} aria-pressed={listing.order === 'story'} onClick={() => refreshSnapshot({ order: 'story' })}>故事时间</button>
          <button type="button" disabled={disabled} aria-pressed={listing.order === 'disclosure'} onClick={() => refreshSnapshot({ order: 'disclosure' })}>章节顺序</button>
        </div>
        {layout === 'board' && <div className={styles.zoom}>
          <button type="button" className={styles.iconButton} aria-label="缩小年表" title="缩小" disabled={columnWidth <= 160} onClick={() => setColumnWidth((value) => Math.max(160, value - 40))}><StudioIcon name="minus" size={20} /></button>
          <input aria-label="年表缩放" type="range" min={160} max={320} step={40} value={columnWidth} onChange={(event) => setColumnWidth(Number(event.target.value))} />
          <output>{Math.round(columnWidth / 240 * 100)}%</output>
          <button type="button" className={styles.iconButton} aria-label="放大年表" title="放大" disabled={columnWidth >= 320} onClick={() => setColumnWidth((value) => Math.min(320, value + 40))}><StudioIcon name="plus" size={20} /></button>
        </div>}
        <div className={styles.viewModes} role="group" aria-label="年表显示方式">
          <button type="button" className={styles.iconButton} aria-label="轨道年表" title="轨道年表" aria-pressed={layout === 'board'} onClick={() => setLayout('board')}><StudioIcon name="timeline" size={20} /></button>
          <button type="button" className={styles.iconButton} aria-label="详细清单" title="详细清单" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><StudioIcon name="list" size={20} /></button>
        </div>
        <button type="button" className={styles.newEvent} disabled={disabled || Boolean(book.book.archivedAt)} onClick={() => leave(() => onOpenRecords('event', true))}><StudioIcon name="spark" size={20} />新增事件</button>
      </div>
      <details className={styles.advanced}><summary>筛选与资料范围</summary>
      <div className={styles.intro}>
        <div><p>《{book.book.title}》的故事时间线</p><span>作者全知视图 · 只读查阅</span></div>
        <button type="button" className={shared.button} disabled={disabled} onClick={() => leave(() => onOpenRecords(manageKind))}>管理{trackLabels[manageKind]}记录</button>
      </div>
      <p className={shared.helpText}>性质与作者决定分别标注，全部筛选包含已否决记录。未来计划、AI 推断与人物认知不能视为既成事实，作者采纳也不等于事实核实。</p>
      <fieldset className={styles.tracks} disabled={disabled}>
        <legend>显示轨道（可多选）</legend>
        <div>{TIMELINE_TRACKS.map((track) => <label key={track}>
          <input type="checkbox" checked={listing.tracks.includes(track)} disabled={listing.tracks.length === 1 && listing.tracks[0] === track}
            onChange={(event) => refreshSnapshot({ tracks: TIMELINE_TRACKS.filter((value) => value === track ? event.target.checked : listing.tracks.includes(value)) })} />
          {trackLabels[track]}
        </label>)}</div>
        <p className={styles.help}>至少保留一条轨道；所选轨道合并排序，条目仍保留各自的来源记录。</p>
      </fieldset>
      <button type="button" className={shared.button} disabled={disabled} onClick={() => refreshSnapshot()} title="按已提交的搜索与筛选重新读取第一页"><StudioIcon name="refresh" size={16} />从第一页刷新</button>
      <details><summary>排序与资料范围</summary><p className={styles.sortNote}>{listing.order === 'story'
        ? '按作者填写的故事排序值排列；排序值未知的条目单独列出，日期和相对时间标签不推导顺序，同值不推断先后。'
        : '依次分为当前稿登记、历史稿登记、登记缺失、尚未披露、位置未知；有目录位置的组内按章节目录位置排列，同章不推断段落顺序。'} 分组可跨页延续。</p>
      <p className={styles.help}>披露位置只核对章节与版本登记；原文待核对。打开固定版本后才检查目标段落，来源引文另行逐字匹配。</p>
      {listing.tracks.includes('relation') && <p className={styles.help}>关系按生效登记及显式结束时间／结束事件登记展开；未知结束时间不代表仍然有效或已经结束。结束变化没有独立披露登记，保持未知，不沿用关系首次披露。</p>}
      {listing.tracks.includes('foreshadow') && <p className={styles.help}>伏笔登记和每条里程碑独立计数；里程碑只使用自身故事时间与披露位置，登记条目的当前阶段不代表该阶段发生时间。</p>}
      </details><div className={styles.filters}>
        <form className={styles.search} onSubmit={search}>
          <label>搜索记录名称、说明与里程碑<input type="search" value={query} maxLength={200} disabled={disabled} placeholder="输入后提交搜索" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }} /></label>
          <button type="submit" className={shared.button} disabled={disabled}>搜索</button>
        </form>
        <label>性质<select value={listing.nature} disabled={disabled} onChange={(event) => refreshSnapshot({ nature: event.target.value as Filters['nature'] })}><option value="">全部性质</option>{KNOWLEDGE_NATURES.map((value) => <option key={value} value={value}>{natureLabels[value]}</option>)}</select></label>
        <label>作者决定<select value={listing.authorDecision} disabled={disabled} onChange={(event) => refreshSnapshot({ authorDecision: event.target.value as Filters['authorDecision'] })}><option value="">全部决定（含否决）</option>{AUTHOR_DECISIONS.map((value) => <option key={value} value={value}>{decisionLabels[value]}</option>)}</select></label>
      </div>
      {listing.search && <p className={styles.help}>已提交搜索：{listing.search}</p>}
      </details>
      {pending && <section className={styles.pending} aria-label="查询超时的只读请求"><h3>等待读取结果</h3><p role="status">{pendingMessage}</p><p className={styles.ids}>请求 {pending.requestId} · {pending.command}</p><button ref={pendingButton} type="button" className={shared.button} disabled={busy || checkingRequest} onClick={() => void queryOriginalRequest()}>{checkingRequest ? '正在查询原请求…' : '查询原请求'}</button></section>}
      {listError && <div className={styles.notice}><p className={shared.formError} role="alert">{listError}</p><p className={styles.help}>若提示旧库或结构未启用，可通过上方管理入口进入故事记录升级或维护。</p></div>}
      <div className={styles.layout}>
        <section className={styles.listPane} aria-label="时间线条目列表" aria-busy={listLoading}>
          {listLoading && <div className={styles.loading} role="status"><p>正在读取时间线…</p><div className={styles.skeleton} aria-hidden="true" /><div className={styles.skeleton} aria-hidden="true" /><div className={styles.skeleton} aria-hidden="true" /></div>}
          {page && <>
            {layout === 'board' && page.items.length > 0 && <>
              <div className={styles.boardScroll} role="region" aria-label="故事轨道年表" tabIndex={0}>
                <div className={styles.chronicle} style={{ width: 104 + columns.size * columnWidth }}>
                  <div className={styles.swimlanes} aria-label="本页人物关联泳道">
                    {people.map((person, index) => <div className={styles.swimlane} data-tone={index % 3} key={person.id}>
                      <div className={styles.personLabel}><StudioIcon name={index % 3 === 0 ? 'bolt' : index % 3 === 1 ? 'orbit' : 'sword'} size={20} /><span>{person.name}</span></div>
                      <div className={styles.lanePoints} style={{ gridTemplateColumns: `repeat(${columns.size}, minmax(0, 1fr))` }}>
                        {[...columns].map(([key, column]) => <div key={key}>{column.items.filter((item) => item.people.some((entry) => entry.id === person.id)).map((item) =>
                          <button key={item.id} type="button" className={styles.lanePoint} disabled={disabled} aria-label={`${person.name} · ${item.title}`} title={item.title} onClick={() => void selectRecord(item.id)}><StudioIcon name="spark" size={16} /></button>)}</div>)}
                      </div>
                    </div>)}
                    {!people.length && <p className={styles.help}>本页记录尚未关联人物；事件卡仍按已登记顺序显示。</p>}
                  </div>
                  <div className={styles.timeColumns} style={{ gridTemplateColumns: `repeat(${columns.size}, minmax(0, 1fr))` }}>
                    {[...columns].map(([key, column], columnIndex) => <section key={key} className={styles.timeColumn} data-unknown={column.unknown}>
                      <h3>{listing.order === 'story' && !column.unknown ? [...new Set(column.items.map((item) => timeLabel(item.time)))].join(' · ') : column.label}<small>{column.unknown ? '未确定顺序' : listing.order === 'story' ? column.label : '已登记披露位置'}</small></h3>
                      <div className={styles.timeAxis} aria-hidden="true"><span /></div>
                      <div className={styles.eventStack} data-stagger={columnIndex % 2}>
                        {column.items.map((item) => <button type="button" key={item.id} className={styles.eventCard} data-tone={laneTone(item)} data-unknown={column.unknown}
                          disabled={disabled} aria-pressed={selectedId === item.id} aria-controls={detailId} data-conflict={item.conflictState === 'candidate'} data-inverted={inverted.has(item.id)}
                          onClick={() => void selectRecord(item.id)}>
                          <span className={styles.eventHeading}><StudioIcon name={item.kind === 'event' ? 'spark' : item.kind === 'cognition' ? 'bulb' : item.kind === 'relation' ? 'workflow' : 'notes'} size={24} /><strong>{item.title}</strong></span>
                          {inverted.has(item.id) && <span className={styles.invertedTag} title="同页较早披露的条目具有更大的故事排序值">章序倒置</span>}
                          <span className={styles.description}>{item.description || pointLabel(item)}</span>
                          <span className={styles.peopleTags}>{item.people.map((person) => <span key={person.id}>{person.name}</span>)}</span>
                          <span className={styles.eventFooter}>{item.disclosure.state === 'located' && item.disclosure.chapterPosition !== null ? `第 ${item.disclosure.chapterPosition + 1} 章` : disclosureText(item.disclosure)}</span>
                          <small>{natureLabels[item.nature]} · {decisionLabels[item.authorDecision]}{item.freshness !== 'current' ? ` · ${freshnessLabels[item.freshness]}` : ''}</small>
                        </button>)}
                      </div>
                    </section>)}
                  </div>
                </div>
              </div>
              <p className={styles.help}>本页最多 {MAX_TIMELINE_PAGE_SIZE} 条，等距仅表示排序；人物泳道来自登记关联，事件只取参与者。虚线表示同页已登记章序与故事顺序倒置，不推断未知时间。</p>
            </>}
            {layout === 'list' && groups.map((group) => <section key={group.key} className={styles.group} aria-label={group.label}><h3>{group.label}</h3><ul className={styles.records}>{group.items.map((item) => <li key={item.id}>
              <button type="button" className={styles.record} disabled={disabled} aria-pressed={selectedId === item.id} aria-controls={detailId} onClick={() => void selectRecord(item.id)}>
                <strong>{item.title}</strong>
                <span className={styles.trackLine}><span className={styles.trackBadge}>{trackLabels[item.kind]}</span>{pointLabel(item)}</span>
                <span className={styles.time}>{timeLabel(item.time)}</span>
                <span className={styles.disclosure}>读者披露：{disclosureText(item.disclosure)}</span>
                <span className={styles.badges}>
                  <span className={item.nature === 'future_plan' || item.nature === 'ai_inference' ? styles.caution : undefined}>性质：{natureLabels[item.nature]}</span>
                  <span className={item.authorDecision === 'rejected' ? styles.rejected : undefined}>作者：{decisionLabels[item.authorDecision]}</span>
                  <span>新鲜度：{freshnessLabels[item.freshness]}</span>
                  <span>冲突：{conflictLabels[item.conflictState]}</span>
                </span>
                {item.description && <span className={styles.description}>{item.description}</span>}
              </button>
            </li>)}</ul></section>)}
            {page.items.length === 0 && <div className={styles.empty}><h3>{filtered ? '所选轨道没有匹配的条目' : '所选轨道还没有记录'}</h3><p>{filtered ? '可清空搜索与筛选，或选择其他轨道。' : '通过上方管理入口建立故事记录，分别填写故事时间与读者披露位置。'}</p>{filtered && <button type="button" className={shared.button} disabled={disabled} onClick={() => { setQuery(''); refreshSnapshot({ search: '', nature: '', authorDecision: '' }) }}>清空搜索与筛选</button>}</div>}
            <nav className={styles.paging} aria-label="时间线分页">
              <button type="button" className={shared.button} disabled={disabled || listing.offset === 0} onClick={() => movePage(Math.max(0, listing.offset - MAX_TIMELINE_PAGE_SIZE))}>上一页</button>
              <span role="status">{page.total === 0 ? '0 条' : `第 ${listing.offset + 1}–${listing.offset + page.items.length} 条 / ${page.total} 条`}</span>
              <button type="button" className={shared.button} disabled={disabled || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) movePage(page.nextOffset) }}>下一页</button>
            </nav>
            <p className={styles.snapshot}>{page.tracks.map((track) => trackLabels[track]).join(' · ')} · 作品版本 {page.bookRevision} · 知识版本 {page.knowledgeRevision}</p>
          </>}
        </section>
        <section id={detailId} className={styles.detailPane} aria-label="故事记录详情">
          <section className={styles.conflictPanel} aria-label="时间冲突提醒"><h3><span>时间冲突</span><StudioIcon name="bolt" size={20} /></h3>
            {conflicts.length ? <ul>{conflicts.map((item, index) => <li key={item.id}><h4><StudioIcon name="spark" size={20} />候选冲突 {index + 1}</h4><strong>{item.title}</strong><p>{item.description || '已有候选冲突标记，请核对来源记录。'}</p><button type="button" className={styles.conflictJump} disabled={disabled} onClick={() => void selectRecord(item.id)}>跳转</button></li>)}</ul> : <p className={styles.help}>本页没有标记为候选冲突的记录。</p>}
            <button type="button" className={styles.allConflicts} disabled={disabled} onClick={() => leave(() => onOpenRecords(manageKind))}>管理故事记录<StudioIcon name="chevron" size={20} /></button>
          </section>
          {reading === 'detail' && <p className={styles.help} role="status">正在核对来源记录、选中条目与页面双版本…</p>}
          {readError && <p ref={readErrorElement} tabIndex={-1} className={shared.formError} role="alert">{readError}</p>}
          {page && !detail && !reading && !readError && <p className={styles.help}>选择事件卡查看同版本详情与固定原稿。</p>}
          {detail && <>
            <h3 ref={detailHeading} tabIndex={-1} className={styles.detailTitle}>{detail.fields.title}</h3>
            {selected && <div className={styles.selectedEntry}>
              <p><strong>{trackLabels[selected.kind]} · {pointLabel(selected)}</strong></p>
              <p>{timeLabel(selected.time)}</p>
              <p>读者披露：{disclosureText(selected.disclosure)}</p>
              <p className={styles.ids}>来源记录 {selected.sourceRecordId}{selected.milestoneId && <><br />里程碑 {selected.milestoneId}</>}</p>
              {milestone && <p className={styles.milestoneNote}>{milestone.note}</p>}
              {milestone?.source && <div className={styles.registeredQuote}>
                <span>里程碑来源 · {sourceLabels[milestone.source.sourceType]} · 登记内容待核对</span>
                <blockquote>{milestone.source.quote}</blockquote>
                {milestone.source.sourceType === 'chapter_text' && <button type="button" className={shared.button} disabled={disabled} aria-controls={originalId}
                  onClick={(event) => { const source = milestone.source; if (source?.sourceType === 'chapter_text') void showOriginal({ bookId: source.bookId, chapterId: source.chapterId, revisionId: source.revisionId, blockId: source.blockId, quote: source.quote, label: '记录来源' }, event.currentTarget) }}>核对里程碑原稿与引文</button>}
              </div>}
              <button type="button" className={shared.button} disabled={disabled} onClick={() => leave(() => onOpenRecords(selected.kind))}>在故事记录中管理{trackLabels[selected.kind]}</button>
            </div>}
            {detail.fields.authorDecision === 'rejected' && <p className={styles.rejected}>作者已否决此记录；保留登记内容供回查。</p>}
            {detail.fields.nature === 'future_plan' && <p className={styles.caution}>未来计划：不表示登记内容已经发生。</p>}
            {detail.fields.nature === 'ai_inference' && <p className={styles.caution}>AI 推断：需要核对，不能视为既成事实。</p>}
            {page?.bookRevision !== book.book.revision && <p className={styles.help}>入口目录与本页版本不同，详情以章节 ID 显示；下方披露登记使用本页目录信息。</p>}
            <StoryFieldsView fields={detail.fields} book={detailBook} names={detail.labels} />
            {disclosure && <section className={styles.disclosureDetail} aria-label="读者披露登记">
              <h4>选中条目的读者披露登记</h4><p>{disclosureText(disclosure)}</p>
              {disclosure.state === 'located' && <><p className={styles.help}>仅章节与版本登记，原文待核对；披露位置不包含来源引文。</p><p className={styles.ids}>章节 {disclosure.chapterId}<br />版本 {disclosure.revisionId}<br />段落 {disclosure.blockId}</p><button type="button" className={shared.button} disabled={disabled} aria-controls={originalId} onClick={(event) => void showOriginal({ bookId, chapterId: disclosure.chapterId, revisionId: disclosure.revisionId, blockId: disclosure.blockId, label: '披露位置' }, event.currentTarget)}>查看披露位置原稿</button></>}
            </section>}
            <section className={styles.sources} aria-label="故事记录来源"><h4>记录来源</h4><p className={styles.help}>有效性与版本登记分别显示；出处可查不代表陈述已被证实，登记引文需要打开原稿核对。</p>
              {detail.sources.length === 0 ? <p className={styles.help}>尚未登记来源，可在故事记录中维护。</p> : <ul>{detail.sources.map((source) => <li key={source.id}>
                <strong>{sourceLabels[source.sourceType]}</strong>
                <p className={styles.help}>有效性：{validityLabels[source.validity]} · 版本登记：{source.sourceType === 'chapter_text' ? (source.referenceState ? referenceLabels[source.referenceState] : '未知（未返回登记状态）') : '不适用（非正文来源）'}</p>
                <blockquote>{source.quote}</blockquote>
                {source.sourceType === 'chapter_text' && <><p className={styles.ids}>章节 {source.chapterId}<br />版本 {source.revisionId}<br />段落 {source.blockId}</p><button type="button" className={shared.button} disabled={disabled} aria-controls={originalId} onClick={(event) => void showOriginal({ bookId: source.bookId, chapterId: source.chapterId, revisionId: source.revisionId, blockId: source.blockId, quote: source.quote, label: '记录来源' }, event.currentTarget)}>核对来源原稿与引文</button></>}
              </li>)}</ul>}
            </section>
            <section id={originalId} className={styles.original} aria-label="固定原稿核对">
              {(reading === 'original' || original) && <div className={styles.originalHeading}><h4 ref={originalHeading} tabIndex={-1}>固定原稿核对</h4>{original && <button type="button" className={shared.button} disabled={disabled} onClick={closeOriginal}>收起原稿</button>}</div>}
              {reading === 'original' && <p className={styles.help} role="status">正在读取固定版本并定位指定段落…</p>}
              {original && <>
                <p className={styles.ids}>{original.target.label} · 章节 {original.target.chapterId}<br />版本 {original.target.revisionId}<br />段落 {original.target.blockId}</p>
                <p className={styles.help}>已在固定版本中找到指定段落；仅展示目标及前后一段上下文。</p>
                {original.target.label === '披露位置' && <p className={styles.help}>本次只核对披露段落存在，未进行来源引文匹配，也未据此确认登记内容真实性。</p>}
                {original.quoteMatches === true && <p className={styles.help}>登记引文在指定段落中逐字匹配；这不等于登记内容已被证实。</p>}
                {original.quoteMatches === false && <p className={styles.rejected} role="alert">登记引文与指定段落不匹配，请在故事记录中核对引用。</p>}
                {original.target.quote !== undefined && <div className={styles.registeredQuote}><span>登记引文</span><blockquote>{original.target.quote || '引文为空，无法核对。'}</blockquote></div>}
                {original.blocks.map((block) => <div key={block.id} className={block.target ? styles.targetBlock : styles.contextBlock}><span>{block.target ? '目标段落' : '相邻上下文'}</span><p>{block.text || '分场线 / 空段落'}</p></div>)}
              </>}
            </section>
          </>}
        </section>
      </div>
    </div>
  </Dialog>
}
