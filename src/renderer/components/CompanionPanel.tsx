import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { BookSnapshot, ChapterSnapshot, StudioApi } from '../../contracts/api'
import type { KnowledgeItemDetail, KnowledgeItemFields, KnowledgeSourceInput } from '../../contracts/knowledge'
import { documentToText, parseManuscript } from '../../contracts/manuscript'
import { paragraphText } from '../../contracts/paragraph-diff'
import type { StoryRecordDetail } from '../../contracts/story'
import { displayTime, request } from '../request'
import styles from './StellarCompanion.module.css'

export interface CompanionNavigateTarget {
  bookId: string
  chapterId: string
  blockId: string
  expectedRevisionId: string
  sourceRevisionId: string
}
export interface CompanionPanelProps {
  api: StudioApi
  book: BookSnapshot
  chapter: ChapterSnapshot | null
  /** 切换作品库或恢复会话时改变此值，隔离同名作品的迟到响应。 */
  scopeKey?: string
  busy: boolean
  /** App 负责保留原写作位置，并在保存当前草稿后重新核对目标段落。 */
  onNavigate: (target: CompanionNavigateTarget) => void | Promise<void>
  onReturn?: () => void | Promise<void>
  canReturn?: boolean
  onClose?: () => void
}

type Tab = 'goal' | 'person' | 'place' | 'foreshadow' | 'knowledge'
type Entry = { id: string; title: string; description: string; kind: 'knowledge' | 'story' }
type Detail = { kind: 'knowledge'; value: KnowledgeItemDetail } | { kind: 'story'; value: StoryRecordDetail }
type ChapterSource = Extract<KnowledgeSourceInput, { sourceType: 'chapter_text' }>
type Evidence = { source: ChapterSource; sequence: number; blocks: { id: string; text: string; target: boolean; clipped: boolean }[]; quoteMatches: boolean }
const tabs: { id: Tab; label: string }[] = [{ id: 'goal', label: '本章目标' }, { id: 'person', label: '人物' }, { id: 'place', label: '地点' }, { id: 'foreshadow', label: '伏笔' }, { id: 'knowledge', label: '全部知识' }]
const natureLabels = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
const decisionLabels = { unreviewed: '未处理', adopted: '已采纳', rejected: '已否决', review_later: '要求复核' }
const freshnessLabels = { current: '当前', affected: '受影响', updating: '更新中', failed: '更新失败' }
const conflictLabels = { unchecked: '未检查冲突', clear: '未发现已知冲突', candidate: '候选冲突', explained: '作者已解释' }
const stageLabels = { planned: '计划', planted: '已埋设', advanced: '推进中', revealed: '已揭示', resolved: '已回收', abandoned: '已放弃' }
const PAGE_SIZE = 20

export function CompanionPanel(props: CompanionPanelProps) {
  return <CompanionContent key={`${props.scopeKey ?? ''}:${props.book.book.id}`} {...props} />
}

function CompanionContent({ api, book, chapter, busy, onNavigate, onReturn, canReturn = false, onClose }: CompanionPanelProps) {
  const bookId = book.book.id
  const headingId = useId()
  const [tab, setTab] = useState<Tab>('goal')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<{ entries: Entry[]; total: number; nextOffset: number | null; bookRevision: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [evidenceError, setEvidenceError] = useState<string | null>(null)
  const [navigating, setNavigating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  const detailTicket = useRef(0)
  const evidenceTicket = useRef(0)
  const navigationTicket = useRef(0)
  const navigationLock = useRef(false)
  const latest = useRef({ busy, onNavigate, onReturn })
  latest.current = { busy, onNavigate, onReturn }
  const selected = useRef<Detail | null>(null)
  selected.current = detail

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; detailTicket.current += 1; evidenceTicket.current += 1; navigationTicket.current += 1 }
  }, [])

  useEffect(() => {
    if (tab === 'goal') { setPage(null); setLoading(false); return }
    let active = true
    setLoading(true); setListError(null); setPage(null)
    // 只读分页独立于编辑器保存；不在每次正文自动保存后重新取整份资料。
    async function read() {
      if (tab === 'foreshadow') {
        const result = await request(() => api.listStoryRecords({ bookId, kind: 'foreshadow', search: query, offset, limit: PAGE_SIZE }))
        if (!active) return
        setLoading(false)
        if (!result.ok) { setListError(result.error.message); return }
        if (result.data.bookId !== bookId || result.data.items.some((item) => item.bookId !== bookId || item.kind !== 'foreshadow')) {
          setListError('返回的伏笔不属于当前作品或分类，未展示。'); return
        }
        setPage({ entries: result.data.items.map((item) => ({ id: item.id, title: item.title, description: item.description, kind: 'story' })),
          total: result.data.total, nextOffset: result.data.nextOffset, bookRevision: result.data.bookRevision })
      } else {
        const result = await request(() => api.listKnowledgeItems({ bookId, ...(tab === 'person' || tab === 'place' ? { kind: tab } : {}), search: query, offset, limit: PAGE_SIZE }))
        if (!active) return
        setLoading(false)
        if (!result.ok) { setListError(result.error.message); return }
        if (result.data.bookId !== bookId || result.data.items.some((item) => item.bookId !== bookId || ((tab === 'person' || tab === 'place') && item.kind !== tab))) {
          setListError('返回的知识条目不属于当前作品或分类，未展示。'); return
        }
        setPage({ entries: result.data.items.map((item) => ({ id: item.id, title: item.name, description: item.summary, kind: 'knowledge' })),
          total: result.data.total, nextOffset: result.data.nextOffset, bookRevision: result.data.bookRevision })
      }
    }
    void read()
    return () => { active = false }
  }, [api, bookId, tab, query, offset, refresh])

  async function selectEntry(entry: Entry) {
    if (navigationLock.current) return
    const ticket = ++detailTicket.current
    evidenceTicket.current += 1
    setDetail(null); selected.current = null; setEvidence(null); setEvidenceLoading(false); setEvidenceError(null); setNotice(null)
    setDetailLoading(true); setDetailError(null)
    if (entry.kind === 'knowledge') {
      const result = await request(() => api.getKnowledgeItem({ bookId, id: entry.id }))
      if (!mounted.current || ticket !== detailTicket.current) return
      setDetailLoading(false)
      if (!result.ok) { setDetailError(result.error.message); return }
      if (result.data.bookId !== bookId || result.data.id !== entry.id || result.data.sources.some((source) => source.bookId !== bookId || source.itemId !== entry.id)) {
        setDetailError('条目或来源身份不符，请刷新后重试。'); return
      }
      setDetail({ kind: 'knowledge', value: result.data })
    } else {
      const result = await request(() => api.getStoryRecord({ bookId, id: entry.id }))
      if (!mounted.current || ticket !== detailTicket.current) return
      setDetailLoading(false)
      if (!result.ok) { setDetailError(result.error.message); return }
      if (result.data.bookId !== bookId || result.data.id !== entry.id || result.data.fields.kind !== 'foreshadow'
        || result.data.sources.some((source) => source.bookId !== bookId || source.recordId !== entry.id)) {
        setDetailError('伏笔或来源身份不符，请刷新后重试。'); return
      }
      setDetail({ kind: 'story', value: result.data })
    }
  }

  function fixedSource(sourceId: string): ChapterSource | null {
    const source = selected.current?.value.sources.find((item) => item.id === sourceId)
    return source?.sourceType === 'chapter_text' && source.bookId === bookId ? source : null
  }

  async function readEvidence(sourceId: string) {
    const source = fixedSource(sourceId)
    if (!source) return
    const ticket = ++evidenceTicket.current
    setEvidence(null); setEvidenceLoading(true); setEvidenceError(null)
    const result = await request(() => api.readRevision({ bookId, chapterId: source.chapterId, revisionId: source.revisionId }))
    if (!mounted.current || ticket !== evidenceTicket.current) return
    setEvidenceLoading(false)
    if (!result.ok) { setEvidenceError(result.error.message); return }
    if (result.data.bookId !== bookId || result.data.chapterId !== source.chapterId || result.data.id !== source.revisionId) {
      setEvidenceError('返回的历史原稿身份不符，未展示其他正文。'); return
    }
    try {
      const document = parseManuscript(result.data.document)
      if (documentToText(document) !== result.data.plainText) throw new Error('Revision text mismatch')
      const index = document.content.findIndex((block) => block.attrs.id === source.blockId)
      if (index < 0) { setEvidenceError('该固定版本中找不到来源段落，请在资料编辑中重新核对出处。'); return }
      const quoteMatches = Boolean(source.quote) && paragraphText(document.content[index]).includes(source.quote)
      const blocks = document.content.slice(Math.max(0, index - 1), index + 2).map((block) => {
        const text = paragraphText(block)
        const quoteIndex = block.attrs.id === source.blockId && quoteMatches ? text.indexOf(source.quote) : 0
        const start = Math.max(0, quoteIndex - 200)
        return { id: block.attrs.id, target: block.attrs.id === source.blockId, text: text.slice(start, start + 2000), clipped: start > 0 || text.length > start + 2000 }
      })
      setEvidence({ source, sequence: result.data.sequence, blocks, quoteMatches })
    } catch { setEvidenceError('历史原稿的结构无法核对，请保留当前资料并重试。') }
  }

  async function navigate(sourceId: string) {
    const source = fixedSource(sourceId)
    if (!source || latest.current.busy || navigationLock.current) return
    const ticket = ++navigationTicket.current
    navigationLock.current = true; setNavigating(true); setNotice(null)
    try {
      const result = await request(() => api.readChapter({ bookId, chapterId: source.chapterId }))
      if (!mounted.current || ticket !== navigationTicket.current) return
      if (!result.ok) { setNotice(result.error.message); return }
      if (result.data.bookId !== bookId || result.data.id !== source.chapterId) { setNotice('当前稿身份不符，未跳转。'); return }
      const document = parseManuscript(result.data.document)
      if (documentToText(document) !== result.data.plainText) throw new Error('Chapter text mismatch')
      const block = document.content.find((item) => item.attrs.id === source.blockId)
      if (!block) { setNotice('当前稿中已找不到原段落，未跳转。仍可查看引用时的原稿，或重新关联出处。'); return }
      if (latest.current.busy) { setNotice('当前正在保存或切换，请稍后再次打开当前稿。'); return }
      // 同 ID 的当前段落可能已改写；只用于定位，不冒充历史引文仍与当前正文一致。
      if (!source.quote || !paragraphText(block).includes(source.quote)) setNotice('当前段落已变化；将定位同一段落，历史引文仍以引用版本为准。')
      await latest.current.onNavigate({ bookId, chapterId: source.chapterId, blockId: source.blockId,
        expectedRevisionId: result.data.revisionId, sourceRevisionId: source.revisionId })
    } catch { if (mounted.current) setNotice('未能完成定位，当前稿保留。请核对保存状态后重试。') }
    finally { navigationLock.current = false; if (mounted.current) setNavigating(false) }
  }

  async function returnToWriting() {
    if (latest.current.busy || navigationLock.current || !latest.current.onReturn) return
    navigationLock.current = true; setNavigating(true)
    try { await latest.current.onReturn() }
    catch { if (mounted.current) setNotice('未能返回原写作位置，请先核对当前保存状态。') }
    finally { navigationLock.current = false; if (mounted.current) setNavigating(false) }
  }

  function submitSearch(event: FormEvent) { event.preventDefault(); setQuery(search.trim()); setOffset(0); setRefresh((value) => value + 1) }
  const fields: Pick<KnowledgeItemFields, 'nature' | 'authorDecision' | 'freshness' | 'conflictState'> | null = detail
    ? detail.kind === 'knowledge' ? detail.value : detail.value.fields : null
  const title = detail ? detail.kind === 'knowledge' ? detail.value.name : detail.value.fields.title : ''
  const description = detail ? detail.kind === 'knowledge' ? detail.value.summary : detail.value.fields.description : ''
  const activeChapter = chapter?.bookId === bookId ? chapter : null

  return <aside className={styles.panel} aria-labelledby={headingId}>
    <header className={styles.heading}><div><h2 id={headingId}>伴随资料</h2><p>只读查阅 · 可继续写作</p></div>{onClose && <button type="button" onClick={onClose} aria-label="收起伴随资料" disabled={navigating}>收起</button>}</header>
    {canReturn && onReturn && <button className={styles.returnButton} type="button" disabled={busy || navigating} onClick={() => void returnToWriting()}>返回原写作位置</button>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <nav className={styles.tabs} aria-label="伴随资料分类">{tabs.map((item) => <button type="button" key={item.id} aria-pressed={tab === item.id} onClick={() => { setTab(item.id); setSearch(''); setQuery(''); setOffset(0) }}>{item.label}</button>)}</nav>
    {tab === 'goal' ? <section className={styles.goal} aria-label="本章创作目标">
      {activeChapter ? <><h3>{activeChapter.title}</h3><p className={styles.prose}>{activeChapter.goal || '尚未设置本章目标，可在“本章资料”中补充。'}</p>
        {activeChapter.viewpoint && <p>叙事视角：{activeChapter.viewpoint}</p>}
        <p className={styles.meta}>已保存 {activeChapter.characterCount.toLocaleString()} 字符{activeChapter.targetCharacters !== null ? ` / 目标 ${activeChapter.targetCharacters.toLocaleString()}` : ''}</p>
        {activeChapter.notes && <details><summary>本章备注与规划</summary><p className={styles.prose}>{activeChapter.notes}</p></details>}
      </> : <p>打开章节后，这里显示本章目标；也可以先查阅人物与设定。</p>}
    </section> : <section aria-label="查找资料">
      <form className={styles.search} onSubmit={submitSearch}><label>搜索{tabs.find((item) => item.id === tab)?.label}<input type="search" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} /></label><button type="submit">查找</button></form>
      {loading && <p className={styles.meta} role="status">正在读取资料…</p>}
      {listError && <p className={styles.notice} role="alert">{listError}</p>}
      <div className={styles.actions}><span className={styles.meta}>{page ? `${page.total} 条` : ''}</span><button type="button" disabled={loading} onClick={() => { setOffset(0); setRefresh((value) => value + 1) }}>刷新资料</button></div>
      {page && <><ul className={styles.entries}>{page.entries.map((entry) => <li key={entry.id}><button type="button" aria-pressed={detail?.kind === entry.kind && detail.value.id === entry.id} disabled={navigating} onClick={() => void selectEntry(entry)}><strong>{entry.title}</strong><span>{entry.description || '暂无说明'}</span></button></li>)}</ul>
        {!page.entries.length && <p className={styles.meta}>没有匹配资料。可以调整关键词，或在故事设定／故事记录中补充。</p>}
        <nav className={styles.actions} aria-label="资料分页"><button type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button><span className={styles.meta}>{page.total ? offset + 1 : 0}–{offset + page.entries.length} / {page.total}</span><button type="button" disabled={loading || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffset(page.nextOffset) }}>下一页</button></nav>
      </>}
    </section>}
    <section className={styles.pinned} aria-label="固定查阅资料">
      {detailLoading && <p role="status">正在读取条目…</p>}{detailError && <p className={styles.notice} role="alert">{detailError}</p>}
      {detail && fields ? <><div className={styles.heading}><h3>{title}</h3><button type="button" disabled={navigating} onClick={() => { detailTicket.current += 1; evidenceTicket.current += 1; setDetail(null); selected.current = null; setEvidence(null); setEvidenceLoading(false); setEvidenceError(null) }}>取消固定</button></div>
        <p className={styles.meta}>{natureLabels[fields.nature]} · {decisionLabels[fields.authorDecision]}</p>
        <p className={styles.prose}>{description || '暂无说明。'}</p>
        {detail.kind === 'knowledge' && detail.value.aliases.length > 0 && <p className={styles.meta}>普通别名：{detail.value.aliases.join('、')}</p>}
        {detail.kind === 'story' && detail.value.fields.kind === 'foreshadow' && <p>当前进展：{stageLabels[detail.value.fields.stage]}</p>}
        {fields.nature === 'future_plan' && <p className={styles.notice}>未来计划尚不表示故事已经发生。</p>}
        {fields.nature === 'character_belief' && <p className={styles.notice}>人物认知不代表客观事实，也不表示读者已知。</p>}
        {fields.nature === 'ai_inference' && <p className={styles.notice}>这是待核对的 AI 推断。</p>}
        <details className={styles.sources}><summary>出处、状态与版本（{detail.value.sources.length} 条来源）</summary>
          <p className={styles.meta}>{freshnessLabels[fields.freshness]} · {conflictLabels[fields.conflictState]} · {displayTime(detail.value.updatedAt)} 更新</p>
          <p className={styles.meta}>资料快照：作品版本 {detail.value.bookRevision}；正文自动保存不会自动替换这份资料。重新点击条目可更新。</p>
          {!detail.value.sources.length && <p className={styles.meta}>尚无来源。当前条目是资料记录，不据此证明正文已有对应事实。</p>}
          {detail.value.sources.map((source) => <article key={source.id} className={styles.source}><strong>{source.sourceType === 'chapter_text' ? '固定正文引文' : source.sourceType === 'external' ? '外部资料说明（未核验）' : '作者输入'}</strong><blockquote>{source.quote}</blockquote>
            {source.sourceType === 'chapter_text' && <><p className={styles.meta}>{book.chapters.find((item) => item.id === source.chapterId)?.title || `章节 ${source.chapterId}`} · 引用版本 {source.revisionId}</p><div className={styles.actions}>
              <button type="button" disabled={evidenceLoading} onClick={() => void readEvidence(source.id)}>查看引用时的原稿</button>
              <button type="button" disabled={busy || navigating} onClick={() => void navigate(source.id)}>{navigating ? '正在定位…' : '打开当前稿'}</button>
            </div></>}
          </article>)}
        </details>
      </> : !detailLoading && !detailError && <p className={styles.meta}>选择人物、地点或伏笔后固定在这里；切换分类仍保留，可边查边写。</p>}
    </section>
    {(evidenceLoading || evidenceError || evidence) && <section className={styles.evidence} aria-label="固定历史证据预览"><h3>引用时的原稿</h3>
      {evidenceLoading && <p role="status">正在核对历史原稿…</p>}{evidenceError && <p className={styles.notice} role="alert">{evidenceError}</p>}
      {evidence && <><p className={styles.meta}>版本 {evidence.sequence} · {evidence.quoteMatches ? '原段落包含登记引文' : '段落存在，但登记引文不匹配，请重新核对'}</p>
        <p className={styles.meta}>展示目标及前后各一块，每块最多 2,000 字符；当前工作稿可能已有变化。</p>
        {evidence.blocks.map((block) => <div key={block.id} className={block.target ? styles.targetBlock : styles.contextBlock}><span className={styles.meta}>{block.target ? '引用段落' : '相邻上下文'}{block.clipped ? ' · 已截取' : ''}</span><p className={styles.prose}>{block.text || '（空段落或分场线）'}</p></div>)}
        <button type="button" onClick={() => setEvidence(null)}>收起历史原稿</button>
      </>}
    </section>}
  </aside>
}
