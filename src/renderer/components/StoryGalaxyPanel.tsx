import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import type { AppError, BookSnapshot, StudioApi } from '../../contracts/api'
import { AUTHOR_DECISIONS, KNOWLEDGE_KINDS, KNOWLEDGE_NATURES, type AuthorDecision, type KnowledgeItemDetail, type KnowledgeNature } from '../../contracts/knowledge'
import { STORY_KINDS, type StoryRecordDetail } from '../../contracts/story'
import { GALAXY_KINDS, GALAXY_PAGE_SIZE, GALAXY_ROLES, MAX_GALAXY_EDGES, galaxyKey, type GalaxyKind, type GalaxyRole, type GalaxyTarget, type StoryGalaxyInput, type StoryGalaxyPage } from '../../contracts/story-galaxy'
import { request } from '../request'
import { Dialog } from './Dialog'
import { blockText, StoryFieldsView } from './StoryFieldsEditor'
import { StoryGalaxyView } from './StoryGalaxyView'
import shared from '../App.module.css'
import styles from './StoryGalaxyPanel.module.css'

export interface StoryGalaxyPanelProps {
  api: StudioApi
  book: BookSnapshot
  busy: boolean
  error?: string | null
  onClose: () => void
  onOpenKnowledge: () => void | Promise<void>
  onOpenRecords: () => void | Promise<void>
}

interface Filters {
  search: string
  kind: GalaxyKind | ''
  nature: KnowledgeNature | ''
  authorDecision: AuthorDecision | ''
}
type Versions = Pick<StoryGalaxyPage, 'bookRevision' | 'knowledgeRevision'>
interface BookRequest { scope: 'book'; filters: Filters; offset: number; expected: Versions | null }
type PageRequest = BookRequest | { scope: 'focus'; target: GalaxyTarget; offset: number; expected: Versions }
type Detail = { source: 'knowledge'; value: KnowledgeItemDetail } | { source: 'story'; value: StoryRecordDetail }
interface PendingRead { requestId?: string; command: 'story.galaxy' | 'knowledge.get' | 'story.get' | 'revision.read' }
interface OriginalPreview {
  sourceId: string
  chapterId: string
  revisionId: string
  blockId: string
  quote: string
  quoteMatches: boolean
  blocks: { id: string; text: string; target: boolean; rule: boolean; clippedStart: boolean; clippedEnd: boolean }[]
}

const EMPTY_FILTERS: Filters = { search: '', kind: '', nature: '', authorDecision: '' }
const PREVIEW_CHARACTERS = 2000
const kindLabels: Record<GalaxyKind, string> = { person: '人物', place: '地点', organization: '组织', object: '物件', rule: '规则', theme: '主题', other: '其他知识', relation: '实体关系', event: '事件', foreshadow: '伏笔', cognition: '人物认知' }
const roleLabels: Record<GalaxyRole, string> = { relation_from: '关系起点', relation_to: '关系终点', participant: '参与者', mentioned: '提及对象', state_change: '状态变更对象', foreshadow_entity: '伏笔关联对象', cognition_subject: '认知主体', relation_start: '关系建立事件', relation_end: '关系结束事件', foreshadow_event: '伏笔关联事件', acquisition: '获知事件' }
const natureLabels = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
const decisionLabels = { unreviewed: '未处理', adopted: '已采纳', rejected: '已否决', review_later: '要求复核' }
const freshnessLabels = { current: '当前', affected: '受影响', updating: '更新中', failed: '更新失败' }
const conflictLabels = { unchecked: '未检查', clear: '未发现已知冲突', candidate: '候选冲突', explained: '作者已解释' }
const sourceLabels = { author_input: '作者输入', external: '外部资料说明', chapter_text: '固定正文引文' }
const validityLabels = { valid: '出处可查', partial: '出处部分缺失', missing: '出处缺失' }
const referenceLabels = { current: '当前稿登记', historical: '历史稿登记' }

function sameTarget(a: GalaxyTarget | null | undefined, b: GalaxyTarget | null | undefined): boolean {
  return a && b ? a.source === b.source && a.id === b.id : !a && !b
}

function versions(page: StoryGalaxyPage): Versions {
  return { bookRevision: page.bookRevision, knowledgeRevision: page.knowledgeRevision }
}

function storyDetailNames(detail: StoryRecordDetail): { names: Record<string, string>; ambiguous: boolean } {
  const fields = detail.fields
  const entities = fields.kind === 'relation' ? [fields.fromEntityId, fields.toEntityId]
    : fields.kind === 'foreshadow' ? fields.entityIds : fields.kind === 'cognition' ? [fields.personId] : []
  const events = fields.kind === 'relation' ? [fields.startEventId, fields.endEventId]
    : fields.kind === 'foreshadow' ? fields.eventIds : fields.kind === 'cognition' ? [fields.acquisitionEventId] : []
  const entityIds = new Set(entities)
  const collisions = new Set(events.filter((id): id is string => id !== null && entityIds.has(id)))
  // 旧详情名称表仅以 ID 为键；跨知识/故事重号时不能猜测名称归属，回退显示固定身份。
  return { names: Object.fromEntries(Object.entries(detail.labels).filter(([id]) => !collisions.has(id))), ambiguous: collisions.size > 0 }
}

function validPage(page: StoryGalaxyPage, listing: PageRequest, bookId: string): boolean {
  const focus = listing.scope === 'focus' ? listing.target : null
  const keys = new Set(page.nodes.map(galaxyKey))
  const count = Math.min(GALAXY_PAGE_SIZE, Math.max(0, page.total - listing.offset))
  return page.bookId === bookId && page.offset === listing.offset && sameTarget(page.focus, focus) &&
    Number.isSafeInteger(page.total) && page.total >= 0 && Number.isSafeInteger(page.bookRevision) && page.bookRevision >= 0 &&
    Number.isSafeInteger(page.knowledgeRevision) && page.knowledgeRevision >= 0 &&
    (!listing.expected || (page.bookRevision === listing.expected.bookRevision && page.knowledgeRevision === listing.expected.knowledgeRevision)) &&
    page.nodes.length === count + (focus ? 1 : 0) && keys.size === page.nodes.length &&
    (!focus || keys.has(galaxyKey(focus))) && page.nodes.every((node) => node.bookId === bookId &&
      (node.source === 'knowledge' ? KNOWLEDGE_KINDS.some((kind) => kind === node.kind) : node.source === 'story' && STORY_KINDS.some((kind) => kind === node.kind))) &&
    page.nextOffset === (listing.offset + count < page.total ? listing.offset + count : null) &&
    page.edges.length <= MAX_GALAXY_EDGES && new Set(page.edges.map((edge) => edge.id)).size === page.edges.length &&
    page.edges.every((edge) => keys.has(galaxyKey(edge.from)) && keys.has(galaxyKey(edge.to)) && GALAXY_ROLES.includes(edge.role))
}

function excerpt(text: string, quote?: string): { text: string; clippedStart: boolean; clippedEnd: boolean } {
  const match = quote ? text.indexOf(quote) : -1
  let start = match < 0 ? 0 : Math.max(0, Math.min(match - Math.floor((PREVIEW_CHARACTERS - quote!.length) / 2), text.length - PREVIEW_CHARACTERS))
  // 截取边界避开代理对；匹配使用完整目标段落，状态只保留有上限的显示片段。
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start -= 1
  let end = Math.min(text.length, start + PREVIEW_CHARACTERS)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end -= 1
  return { text: text.slice(start, end), clippedStart: start > 0, clippedEnd: end < text.length }
}

export function StoryGalaxyPanel(props: StoryGalaxyPanelProps) {
  return <GalaxyContent key={props.book.book.id} {...props} />
}

function GalaxyContent({ api, book, busy, error, onClose, onOpenKnowledge, onOpenRecords }: StoryGalaxyPanelProps) {
  const bookId = book.book.id
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<PageRequest>({ scope: 'book', filters: EMPTY_FILTERS, offset: 0, expected: null })
  const [page, setPage] = useState<StoryGalaxyPage | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [selected, setSelected] = useState<GalaxyTarget | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const storyNames = useMemo(() => detail?.source === 'story' ? storyDetailNames(detail.value) : null, [detail])
  const [reading, setReading] = useState<'detail' | 'original' | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [original, setOriginal] = useState<OriginalPreview | null>(null)
  const [originalSourceId, setOriginalSourceId] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingRead | null>(null)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [checkingRequest, setCheckingRequest] = useState(false)
  const [detailJump, setDetailJump] = useState(0)
  const mounted = useRef(false)
  const leaving = useRef(false)
  const listLock = useRef(true)
  const readLock = useRef(false)
  const statusLock = useRef(false)
  const listTicket = useRef(0)
  const readTicket = useRef(0)
  const statusTicket = useRef(0)
  const pendingRead = useRef<PendingRead | null>(null)
  const startedListing = useRef<PageRequest | null>(null)
  const bookBaseline = useRef<BookRequest | null>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const detailId = useId()
  const originalId = useId()
  const disabled = busy || listLoading || reading !== null || pending !== null

  const clearReading = useCallback(() => {
    readTicket.current += 1; readLock.current = false
    setSelected(null); setDetail(null); setOriginal(null); setOriginalSourceId(null); setReading(null); setReadError(null)
  }, [])

  const invalidateSnapshot = useCallback((message: string) => {
    listTicket.current += 1; listLock.current = false
    clearReading(); setPage(null); setListLoading(false); setNeedsRefresh(true)
    setListError(`${message} 旧图、详情与原文已清除，请显式刷新全书。`)
  }, [clearReading])

  const retainTimeout = useCallback((failure: AppError, command: PendingRead['command']): boolean => {
    if (failure.code !== 'REQUEST_TIMEOUT') return false
    const next = { requestId: failure.requestId, command }
    pendingRead.current = next; setPending(next)
    setPendingMessage(failure.requestId
      ? '只读请求已超时，服务可能仍在处理。请查询原请求；等待期间可以关闭面板。'
      : '只读请求已超时，但未返回请求标识，暂时不能继续读取。请关闭面板后恢复服务。')
    listTicket.current += 1; listLock.current = false
    clearReading(); setPage(null); setListLoading(false); setListError(null); setNeedsRefresh(true)
    return true
  }, [clearReading])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false; listTicket.current += 1; readTicket.current += 1; statusTicket.current += 1
      startedListing.current = null
    }
  }, [])

  useEffect(() => {
    // 外部忙碌时延后首次读取；忙碌标记变化不取消已经发出的请求，避免丢失超时回执。
    if (busy || leaving.current || pendingRead.current || startedListing.current === listing) return
    startedListing.current = listing
    const ticket = ++listTicket.current
    listLock.current = true
    setListLoading(true); setPage(null); setListError(null); clearReading()
    const input: StoryGalaxyInput = {
      bookId, offset: listing.offset,
      ...(listing.scope === 'focus' ? { focus: listing.target } : {
        ...(listing.filters.search ? { search: listing.filters.search } : {}),
        ...(listing.filters.kind ? { kind: listing.filters.kind } : {}),
        ...(listing.filters.nature ? { nature: listing.filters.nature } : {}),
        ...(listing.filters.authorDecision ? { authorDecision: listing.filters.authorDecision } : {}),
      }),
      ...(listing.expected ? { expectedBookRevision: listing.expected.bookRevision, expectedKnowledgeRevision: listing.expected.knowledgeRevision } : {}),
    }
    void request(() => api.listStoryGalaxy(input)).then((result) => {
      if (!mounted.current || leaving.current || ticket !== listTicket.current) return
      listLock.current = false; setListLoading(false)
      if (!result.ok) {
        if (retainTimeout(result.error, 'story.galaxy')) return
        if (result.error.code === 'REVISION_CONFLICT' || result.error.code === 'NOT_FOUND') invalidateSnapshot(result.error.message)
        else setListError(result.error.message)
        return
      }
      if (!validPage(result.data, listing, bookId)) { invalidateSnapshot('星海返回的身份、类型、分页范围或双版本不符。'); return }
      setPage(result.data)
    })
  }, [api, bookId, busy, clearReading, invalidateSnapshot, listing, retainTimeout])

  useEffect(() => {
    // 主动选择提交后才聚焦新标题；异步详情回包不改变焦点。
    if (detailJump > 0) detailHeading.current?.focus()
  }, [detailJump])

  function canRead(): boolean {
    return mounted.current && !leaving.current && !busy && !listLock.current && !readLock.current && !pendingRead.current && !statusLock.current
  }

  function changePage(next: PageRequest): boolean {
    if (!canRead()) return false
    // 同步撤销旧回包资格，再更新视图；锁覆盖状态尚未提交的同一事件周期。
    listTicket.current += 1; listLock.current = true
    clearReading(); setPage(null); setListError(null); setNeedsRefresh(false); setListLoading(true); setListing(next)
    return true
  }

  const filters = listing.scope === 'book' ? listing.filters : bookBaseline.current?.filters ?? EMPTY_FILTERS

  function refreshBook(changes: Partial<Filters> = {}) {
    if (changePage({ scope: 'book', filters: { ...filters, ...changes }, offset: 0, expected: null })) bookBaseline.current = null
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (listing.scope === 'book') refreshBook({ search: query.trim() })
  }

  function movePage(offset: number) {
    if (page) changePage({ ...listing, offset, expected: versions(page) })
  }

  function focusSelected() {
    if (!page || !detail || !selected || !page.nodes.some((node) => sameTarget(node, selected))) return
    const baseline: BookRequest | null = listing.scope === 'book' ? { ...listing, expected: versions(page) } : null
    if (changePage({ scope: 'focus', target: { ...selected }, offset: 0, expected: versions(page) }) && baseline) bookBaseline.current = baseline
  }

  function returnToBook() {
    if (!needsRefresh && bookBaseline.current) changePage({ ...bookBaseline.current })
  }

  async function leave(action: () => void | Promise<void>, close = false) {
    if (busy || (!close && !canRead())) return
    leaving.current = true
    listTicket.current += 1; readTicket.current += 1; statusTicket.current += 1
    try { await action() } finally {
      // 父级保存门禁可能拒绝切换；仍挂载时恢复交互，不能永久停留在离开状态。
      if (mounted.current) leaving.current = false
    }
  }

  async function queryOriginalRequest() {
    const saved = pendingRead.current
    const requestId = saved?.requestId
    if (!saved || !requestId || busy || statusLock.current || !mounted.current || leaving.current) return
    const ticket = ++statusTicket.current
    statusLock.current = true; setCheckingRequest(true)
    const result = await request(() => api.getRequestStatus({ requestId }))
    if (!mounted.current || leaving.current || ticket !== statusTicket.current || pendingRead.current !== saved) return
    statusLock.current = false; setCheckingRequest(false)
    if (!result.ok) { setPendingMessage(`原请求状态查询失败：${result.error.message} 请稍后查询，或关闭面板后恢复服务。`); return }
    const status = result.data
    if (status.state === 'pending') { setPendingMessage('原读取仍在执行，请稍后再次查询。等待期间可以关闭面板。'); return }
    if (status.state === 'completed' && status.response.command !== saved.command) {
      setPendingMessage('原请求返回的命令身份不符，尚未解除读取等待；请关闭面板后核对或恢复服务。'); return
    }
    pendingRead.current = null; setPending(null); setPendingMessage(null)
    // 迟到结果仅用于解除等待，必须由作者显式刷新才能建立新的阅读快照。
    invalidateSnapshot(status.state === 'unknown' ? '原请求已无法查询，可重新读取只读快照。' : '原读取已结束，已核对请求命令。')
  }

  async function selectNode(target: GalaxyTarget) {
    if (!canRead() || !page) return
    const node = page.nodes.find((item) => sameTarget(item, target))
    if (!node) return
    const ticket = ++readTicket.current
    readLock.current = true
    setSelected({ source: node.source, id: node.id }); setDetail(null); setOriginal(null); setOriginalSourceId(null); setReadError(null); setReading('detail')
    setDetailJump((value) => value + 1)
    const result = await request<Detail>(async () => {
      if (node.source === 'knowledge') {
        const response = await api.getKnowledgeItem({ bookId, id: node.id })
        return response.ok ? { ok: true, data: { source: 'knowledge', value: response.data } } : response
      }
      const response = await api.getStoryRecord({ bookId, id: node.id })
      return response.ok ? { ok: true, data: { source: 'story', value: response.data } } : response
    })
    if (!mounted.current || leaving.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(null)
    if (!result.ok) {
      if (retainTimeout(result.error, node.source === 'knowledge' ? 'knowledge.get' : 'story.get')) return
      if (result.error.code === 'REVISION_CONFLICT' || result.error.code === 'NOT_FOUND') invalidateSnapshot(result.error.message)
      else setReadError(result.error.message)
      return
    }
    const next = result.data
    const fields = next.source === 'knowledge' ? next.value : next.value.fields
    const wrongSources = next.source === 'knowledge'
      ? next.value.sources.some((source) => source.bookId !== bookId || source.itemId !== node.id)
      : next.value.sources.some((source) => source.bookId !== bookId || source.recordId !== node.id)
    if (next.source !== node.source || next.value.bookId !== bookId || next.value.id !== node.id || fields.kind !== node.kind ||
        next.value.bookRevision !== page.bookRevision || next.value.knowledgeRevision !== page.knowledgeRevision || wrongSources) {
      invalidateSnapshot('详情身份、类型、来源归属或双版本与本页不符。'); return
    }
    setDetail(next)
  }

  async function showOriginal(sourceId: string) {
    if (!canRead() || !page || !detail || !selected) return
    // 来源必须重新从当前详情中取出，不能用旧按钮闭包中的引用或跳到当前工作稿。
    const source = detail.value.sources.find((item) => item.id === sourceId)
    if (!source || source.sourceType !== 'chapter_text' || source.bookId !== bookId ||
        !sameTarget(selected, { source: detail.source, id: detail.value.id }) ||
        detail.value.bookRevision !== page.bookRevision || detail.value.knowledgeRevision !== page.knowledgeRevision) {
      invalidateSnapshot('来源已不属于当前详情或页面版本。'); return
    }
    const ticket = ++readTicket.current
    readLock.current = true
    setOriginal(null); setOriginalSourceId(sourceId); setReadError(null); setReading('original')
    const result = await request(() => api.readRevision({ bookId, chapterId: source.chapterId, revisionId: source.revisionId }))
    if (!mounted.current || leaving.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(null)
    if (!result.ok) {
      if (retainTimeout(result.error, 'revision.read')) return
      if (result.error.code === 'REVISION_CONFLICT') invalidateSnapshot(result.error.message)
      else setReadError(`无法读取来源的固定版本：${result.error.message}`)
      return
    }
    const revision = result.data
    if (revision.bookId !== bookId || revision.chapterId !== source.chapterId || revision.id !== source.revisionId) {
      invalidateSnapshot('原文返回的作品、章节或版本身份不符。'); return
    }
    const index = revision.document.content.findIndex((block) => block.attrs.id === source.blockId)
    if (index < 0) { setReadError('指定固定版本中未找到来源段落，请到对应记录中核对引用。'); return }
    const targetText = blockText(revision.document.content[index]!)
    // 整章仅用于本次定位与逐字核对，不进入状态或缓存；预览最多三块，每块不超过 2,000 字符。
    setOriginal({
      sourceId, chapterId: source.chapterId, revisionId: source.revisionId, blockId: source.blockId, quote: source.quote,
      quoteMatches: source.quote.length > 0 && targetText.includes(source.quote),
      blocks: revision.document.content.slice(Math.max(0, index - 1), index + 2).map((block) => ({
        id: block.attrs.id, target: block.attrs.id === source.blockId, rule: block.type === 'horizontalRule',
        ...excerpt(block.attrs.id === source.blockId ? targetText : blockText(block), block.attrs.id === source.blockId ? source.quote : undefined),
      })),
    })
  }

  function closeOriginal() {
    if (!canRead()) return
    readTicket.current += 1; setOriginal(null); setOriginalSourceId(null); setReadError(null)
  }

  const selectedNode = page?.nodes.find((node) => sameTarget(node, selected))
  const center = page?.focus ? page.nodes.find((node) => sameTarget(node, page.focus)) : undefined
  const nodes = page ? (center ? [center, ...page.nodes.filter((node) => !sameTarget(node, center))] : page.nodes) : []
  const adjacent = selected ? page?.edges.filter((edge) => sameTarget(edge.from, selected) || sameTarget(edge.to, selected)) ?? [] : []
  const detailFields = detail?.source === 'knowledge' ? detail.value : detail?.value.fields
  const detailBook = page && page.bookRevision !== book.book.revision ? { ...book, chapters: [], volumes: [] } : book
  const filtered = Boolean(filters.search || filters.kind || filters.nature || filters.authorDecision)
  const filterDisabled = disabled || listing.scope === 'focus'
  const pageCount = page ? page.nodes.length - (page.focus ? 1 : 0) : 0

  return <Dialog title="故事星海" wide busy={busy} onClose={() => leave(onClose, true)} error={error}>
    <div className={styles.panel}>
      <div className={styles.intro}>
        <div><p>《{book.book.title}》的故事对象</p><span>作者全知视图 · 只读查阅</span></div>
        <div className={styles.actions}>
          <button type="button" className={shared.button} disabled={disabled} onClick={() => leave(onOpenKnowledge)}>知识条目</button>
          <button type="button" className={shared.button} disabled={disabled} onClick={() => leave(onOpenRecords)}>故事记录</button>
        </div>
      </div>
      <p className={styles.help}>展示已登记的对象与引用，包含未来计划、人物认知及未采纳记录。作者采纳不等于事实核实；本视图包含剧透，不按读者进度隐藏内容。</p>
      <div className={styles.filters}>
        <form className={styles.search} onSubmit={search}>
          <label>搜索名称与说明<input type="search" value={query} maxLength={200} disabled={filterDisabled} placeholder="输入后提交搜索" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }} /></label>
          <button type="submit" className={shared.button} disabled={filterDisabled}>搜索</button>
        </form>
        <label>对象类型<select value={filters.kind} disabled={filterDisabled} onChange={(event) => refreshBook({ kind: event.target.value as Filters['kind'] })}><option value="">全部类型</option>{GALAXY_KINDS.map((value) => <option key={value} value={value}>{kindLabels[value]}</option>)}</select></label>
        <label>性质<select value={filters.nature} disabled={filterDisabled} onChange={(event) => refreshBook({ nature: event.target.value as Filters['nature'] })}><option value="">全部性质</option>{KNOWLEDGE_NATURES.map((value) => <option key={value} value={value}>{natureLabels[value]}</option>)}</select></label>
        <label>作者决定<select value={filters.authorDecision} disabled={filterDisabled} onChange={(event) => refreshBook({ authorDecision: event.target.value as Filters['authorDecision'] })}><option value="">全部（含否决）</option>{AUTHOR_DECISIONS.map((value) => <option key={value} value={value}>{decisionLabels[value]}</option>)}</select></label>
      </div>
      {filters.search && <p className={styles.help}>已提交全书搜索：{filters.search}</p>}
      <div className={styles.toolbar}>
        <h3>{listing.scope === 'focus' ? `直接关联${center ? ` · ${center.title}` : ''}` : '全书对象'}</h3>
        <div className={styles.actions}>
          {listing.scope === 'focus' && <button type="button" className={shared.button} disabled={disabled || needsRefresh || !bookBaseline.current} onClick={returnToBook}>返回全书原页</button>}
          <button type="button" className={shared.button} disabled={disabled} onClick={() => refreshBook()} title="按已提交的全书条件，从第一页建立新的版本快照">刷新全书</button>
        </div>
      </div>
      {listing.scope === 'focus' && <p className={styles.help}>仅查看中心对象的直接关联，全书搜索与筛选已保留。中心始终显示，分页总数不含中心。</p>}
      {pending && <section className={styles.pending} aria-label="查询超时的只读请求">
        <h3>等待读取结果</h3><p role="status">{pendingMessage}</p>
        <p className={styles.ids}>{pending.requestId ? `请求 ${pending.requestId}` : '请求标识未返回'} · {pending.command}</p>
        <button type="button" className={shared.button} disabled={busy || checkingRequest || !pending.requestId} onClick={() => void queryOriginalRequest()}>{checkingRequest ? '正在查询原请求…' : '查询原请求'}</button>
      </section>}
      {listError && <div className={styles.notice}>
        <p className={shared.formError} role="alert">{listError}</p>
        {!needsRefresh && <button type="button" className={shared.button} disabled={disabled} onClick={() => changePage({ ...listing })}>重试本次读取</button>}
        <p className={styles.help}>若提示旧库或结构未启用，可按错误提示进入「知识条目」或「故事记录」，查看备份与升级入口。</p>
      </div>}
      <section className={styles.overview} aria-label="星海本页概览" aria-busy={listLoading}>
        {listLoading && <div className={styles.loading} role="status"><p>{busy ? '等待当前操作结束后读取星海…' : '正在读取故事星海…'}</p><div className={styles.skeleton} aria-hidden="true" /></div>}
        {page && <>
          <p className={styles.snapshot}>{page.focus ? `直接关联共 ${page.total} 个（不含中心）` : `匹配对象共 ${page.total} 个`} · 每页 {GALAXY_PAGE_SIZE} 个<br />作品版本 {page.bookRevision} · 知识版本 {page.knowledgeRevision}</p>
          {page.nodes.length > 0 && <StoryGalaxyView nodes={page.nodes} edges={page.edges} focus={page.focus} selected={selected} disabled={disabled} onSelect={(target) => void selectNode(target)} />}
          {page.total === 0 && <div className={styles.empty}>
            <h3>{page.focus ? '中心暂无直接关联' : filtered ? '没有匹配的对象' : '还没有故事对象'}</h3>
            <p>{page.focus ? '中心对象仍可选中查看。可在知识条目和故事记录中维护明确的引用。' : filtered ? '可清空搜索与筛选，查看全书已登记的对象。' : '从知识条目建立人物、地点等对象，并在故事记录中登记关系、事件、伏笔和认知。'}</p>
            {!page.focus && filtered && <button type="button" className={shared.button} disabled={disabled} onClick={() => { if (canRead()) { setQuery(''); refreshBook(EMPTY_FILTERS) } }}>清空搜索与筛选</button>}
          </div>}
          {page.nodes.length > 0 && <p className={styles.scopeNote}>图仅包含本页 {page.nodes.length} 个对象与它们之间的已登记引用。{page.focus ? '跨页关联请翻页查看。' : '页外对象及其连线未显示，可选中对象后聚焦直接关联。'} 连线不推断因果、人物知情或关系是否有效。</p>}
          {page.edgesTruncated && <p className={styles.caution} role="status">本页引用超过显示上限，仅展示前 {MAX_GALAXY_EDGES} 条；图和下方引用列表均已截取，不能据此判断其他关联不存在。</p>}
          <nav className={styles.paging} aria-label={page.focus ? '直接关联分页' : '全书对象分页'}>
            <button type="button" className={shared.button} disabled={disabled || page.offset === 0} onClick={() => movePage(Math.max(0, page.offset - GALAXY_PAGE_SIZE))}>上一页</button>
            <span role="status">{page.total === 0 ? '0 个' : pageCount === 0 ? '本页没有对象' : `第 ${page.offset + 1}–${page.offset + pageCount} 个 / ${page.total} 个`}{page.focus && ' · 中心另列'}</span>
            <button type="button" className={shared.button} disabled={disabled || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) movePage(page.nextOffset) }}>下一页</button>
          </nav>
        </>}
      </section>
      <div className={styles.layout}>
        <section className={styles.listPane} aria-label="本页完整对象列表">
          <h3 className={styles.sectionTitle}>本页对象</h3>
          {nodes.length > 0 ? <ul className={styles.nodes}>{nodes.map((node) => <li key={galaxyKey(node)}>
            <button type="button" className={styles.node} disabled={disabled} aria-pressed={sameTarget(node, selected)} aria-controls={detailId} onClick={() => void selectNode(node)}>
              <strong>{node.title}</strong>
              <span className={styles.nodeType}>{sameTarget(node, page?.focus) ? '中心 · ' : ''}{node.source === 'knowledge' ? '知识条目' : '故事记录'} · {kindLabels[node.kind]}</span>
              <span className={styles.badges}><span>性质：{natureLabels[node.nature]}</span><span className={node.authorDecision === 'rejected' ? styles.rejected : undefined}>作者：{decisionLabels[node.authorDecision]}</span><span>新鲜度：{freshnessLabels[node.freshness]}</span><span>冲突：{conflictLabels[node.conflictState]}</span></span>
              {node.excerpt && <span className={styles.excerpt}>{node.excerpt}</span>}
            </button>
          </li>)}</ul> : <p className={styles.help}>{listLoading ? '正在读取本页对象。' : page ? '当前范围没有对象。' : '读取完成后在此查看对象。'}</p>}
        </section>
        <section id={detailId} className={styles.detailPane} aria-labelledby={`${detailId}-heading`} aria-busy={reading !== null}>
          <h3 id={`${detailId}-heading`} ref={detailHeading} tabIndex={-1} className={styles.detailTitle}>{selectedNode ? selectedNode.title : '对象详情'}</h3>
          {reading === 'detail' && <p className={styles.help} role="status">正在核对对象详情与页面双版本…</p>}
          {readError && <div className={styles.readError}><p className={shared.formError} role="alert">{readError}</p>
            {selected && !detail && <button type="button" className={shared.button} disabled={disabled} onClick={() => void selectNode(selected)}>重试详情</button>}
            {detail && originalSourceId && <button type="button" className={shared.button} disabled={disabled} onClick={() => void showOriginal(originalSourceId)}>重新核对来源</button>}
          </div>}
          {!detail && !reading && !readError && <p className={styles.help}>从图或本页完整列表选择对象，查看说明、状态与登记来源。</p>}
          {detail && detailFields && <>
            <div className={styles.detailActions}><span>{kindLabels[detailFields.kind]}</span><button type="button" className={shared.button} disabled={disabled || sameTarget(selected, page?.focus)} onClick={focusSelected}>{sameTarget(selected, page?.focus) ? '当前聚焦对象' : '聚焦直接关联'}</button></div>
            {detailFields.authorDecision === 'rejected' && <p className={styles.rejected}>作者已否决此记录，保留登记内容供回查。</p>}
            {detailFields.nature === 'future_plan' && <p className={styles.caution}>未来计划尚不表示已经发生。</p>}
            {detailFields.nature === 'ai_inference' && <p className={styles.caution}>AI 推断需要核对，不能视为既成事实。</p>}
            {detail.source === 'knowledge' ? <div className={styles.knowledge}>
              <p>{detail.value.summary || '暂无补充说明。'}</p>
              <dl><dt>别名</dt><dd>{detail.value.aliases.length ? detail.value.aliases.join('、') : '未登记'}</dd><dt>性质</dt><dd>{natureLabels[detail.value.nature]}</dd><dt>作者决定</dt><dd>{decisionLabels[detail.value.authorDecision]}</dd><dt>新鲜度</dt><dd>{freshnessLabels[detail.value.freshness]}</dd><dt>冲突标注</dt><dd>{conflictLabels[detail.value.conflictState]}</dd></dl>
            </div> : <>
              {page?.bookRevision !== book.book.revision && <p className={styles.help}>入口目录与本页版本不同，披露位置以章节 ID 显示。</p>}
              {storyNames?.ambiguous && <p className={styles.help}>部分知识条目与事件使用相同标识，详情中的这些引用以标识显示。下方相邻引用按对象类型区分。</p>}
              <StoryFieldsView fields={detail.value.fields} book={detailBook} names={storyNames?.names ?? {}} />
            </>}
            <section className={styles.references} aria-label="本页相邻引用">
              <h4>本页相邻引用</h4><p className={styles.help}>角色按记录登记；关系和认知引用不代表客观因果或人物已经知情。</p>
              {adjacent.length === 0 ? <p className={styles.help}>本页未返回与该对象相邻的引用，可聚焦直接关联查看。</p> : <ul>{adjacent.map((edge) => {
                const outgoing = sameTarget(edge.from, selected)
                const peer = page?.nodes.find((node) => sameTarget(node, outgoing ? edge.to : edge.from))
                return peer ? <li key={edge.id}><span>{outgoing ? '本条记录引用' : '引用此对象的记录'} · {roleLabels[edge.role]}</span><button type="button" className={styles.referenceButton} disabled={disabled} aria-controls={detailId} onClick={() => void selectNode(peer)}>{peer.title}<small>{kindLabels[peer.kind]}</small></button></li> : null
              })}</ul>}
              {page?.edgesTruncated && <p className={styles.caution}>本页引用已截取，上方列表可能不完整。</p>}
            </section>
            <section className={styles.sources} aria-label="登记来源">
              <h4>登记来源</h4><p className={styles.help}>出处有效性与版本登记分别显示。引文需打开固定原稿逐字核对，出处可查不等于陈述已被证实。</p>
              {detail.value.sources.length === 0 ? <p className={styles.help}>尚未登记来源，可通过对应维护入口补充。</p> : <ul>{detail.value.sources.map((source) => <li key={source.id}>
                <strong>{sourceLabels[source.sourceType]}</strong>
                <p className={styles.help}>有效性：{validityLabels[source.validity]} · 版本登记：{source.sourceType === 'chapter_text' ? (source.referenceState ? referenceLabels[source.referenceState] : '未知') : '不适用'}</p>
                <blockquote>{source.quote}</blockquote>
                {source.sourceType === 'chapter_text' && <><p className={styles.ids}>章节 {source.chapterId}<br />版本 {source.revisionId}<br />段落 {source.blockId}</p><button type="button" className={shared.button} disabled={disabled} aria-controls={originalId} aria-expanded={original?.sourceId === source.id} onClick={() => void showOriginal(source.id)}>核对固定原文与引文</button></>}
              </li>)}</ul>}
            </section>
            <section id={originalId} className={styles.original} aria-label="固定原文核对">
              {(reading === 'original' || original) && <div className={styles.originalHeading}><h4>固定原文核对</h4>{original && <button type="button" className={shared.button} disabled={disabled} onClick={closeOriginal}>收起原文</button>}</div>}
              {reading === 'original' && <p className={styles.help} role="status">正在读取固定版本并核对段落与引文…</p>}
              {original && <div className={styles.paper}>
                <p className={styles.paperMeta}>章节 {original.chapterId}<br />固定版本 {original.revisionId}<br />目标段落 {original.blockId}</p>
                <p className={styles.paperStatus} role="status">{original.quoteMatches ? '登记引文在指定段落中逐字匹配；仅核对出处，不据此确认陈述真实性。' : '登记引文与指定段落不匹配，请在对应记录中核对引用。'}</p>
                <p className={styles.paperHelp}>最多展示目标及前后各一块；每块最多 2,000 字符，目标块优先截取引文附近。</p>
                <div className={styles.registeredQuote}><span>登记引文</span><blockquote>{original.quote || '引文为空，无法核对。'}</blockquote></div>
                {original.blocks.map((block) => <div key={block.id} className={block.target ? styles.targetBlock : styles.contextBlock}>
                  <span>{block.target ? '目标段落' : '相邻上下文'}{block.clippedStart ? ' · 已截去前文' : ''}{block.clippedEnd ? ' · 已截去后文' : ''}</span>
                  {block.rule ? <hr aria-label="分场线" /> : <p>{block.text || '（空段落）'}</p>}
                </div>)}
              </div>}
            </section>
          </>}
        </section>
      </div>
    </div>
  </Dialog>
}
