import { useEffect, useRef, useState } from 'react'
import type { BookSnapshot, StudioApi } from '../../contracts/api'
import { KNOWLEDGE_KINDS, type KnowledgeKind, type KnowledgeSourceInput } from '../../contracts/knowledge'
import type { CreativeResourceRef } from '../../contracts/creative-resources'
import { parseManuscript } from '../../contracts/manuscript'
import { appearanceState, APPEARANCE_CHAPTER_PAGE, APPEARANCE_ENTITY_PAGE, FORESHADOW_RADAR_PAGE,
  type AppearanceMatrixInput, type AppearanceMatrixPage, type ControlVersions,
  type ForeshadowRadarInput, type ForeshadowRadarItem, type ForeshadowRadarPage, type RadarDue, type RadarScope } from '../../contracts/story-control'
import type { StoryKind, StoryRecordDetail } from '../../contracts/story'
import { request } from '../request'
import { blockText, plannedPayoffLabel, stageLabels, StoryFieldsView } from './StoryFieldsEditor'
import type { CompanionNavigateTarget } from './CompanionPanel'
import shared from '../App.module.css'
import styles from './StoryControlPanel.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot
  disabled: boolean
  asOfChapterId?: string
  onOpenRecord: (kind: StoryKind, id?: string) => void
  onNavigate: (target: CompanionNavigateTarget) => void | Promise<void>
  onUseForeshadow?: (ref: CreativeResourceRef) => void
}
type ChapterSource = Extract<KnowledgeSourceInput, { sourceType: 'chapter_text' }>
const entityLabels: Record<KnowledgeKind, string> = { person: '人物', place: '地点', organization: '势力', object: '物品', rule: '规则', theme: '主题', other: '其他' }
const cellLabels = { present: '登场行动', mentioned: '被提及', absent: '已核对缺席', conflict: '登记有冲突', stale: '旧稿／待复核', unknown: '未知' }
const cellMarks = { present: '●', mentioned: '○', absent: '—', conflict: '!', stale: '↺', unknown: '?' }
export const radarDueLabels: Record<RadarDue, string> = { overdue: '已过计划位置', due: '本章／本卷到期', upcoming: '尚未到期', unplaced: '范围待定位', unconfirmed: '待作者复核', closed: '已经结束' }
const snapshot = (value: ControlVersions) => ({ expectedBookRevision: value.bookRevision, expectedKnowledgeRevision: value.knowledgeRevision })
function matchesVersions(page: ControlVersions, input: { expectedBookRevision?: number; expectedKnowledgeRevision?: number }): boolean {
  return Number.isSafeInteger(page.bookRevision) && Number.isSafeInteger(page.knowledgeRevision) &&
    (input.expectedBookRevision === undefined || page.bookRevision === input.expectedBookRevision && page.knowledgeRevision === input.expectedKnowledgeRevision)
}

function RecordEvidence({ api, book, disabled, id, onOpenRecord, onNavigate }: Pick<Props, 'api' | 'book' | 'disabled' | 'onOpenRecord' | 'onNavigate'> & { id: string }) {
  const [detail, setDetail] = useState<StoryRecordDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [original, setOriginal] = useState<{ source: ChapterSource; text: string; matches: boolean } | null>(null)
  const [reading, setReading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const ticket = useRef(0), lock = useRef(false)
  useEffect(() => {
    let active = true
    ticket.current += 1; lock.current = false; setReading(false)
    setLoading(true); setDetail(null); setError(null); setOriginal(null)
    void request(() => api.getStoryRecord({ bookId: book.book.id, id })).then((result) => {
      if (!active) return
      setLoading(false)
      if (!result.ok) { setError(result.error.message); return }
      if (result.data.id !== id || result.data.bookId !== book.book.id || result.data.bookRevision !== book.book.revision ||
          result.data.sources.some((source) => source.bookId !== book.book.id || source.recordId !== id)) { setError('作品或来源版本已变化，请刷新星图后重新选择。'); return }
      setDetail(result.data)
    })
    return () => { active = false; ticket.current += 1 }
  }, [api, book.book.id, book.book.revision, id, refresh])

  async function read(source: ChapterSource) {
    if (disabled || lock.current) return
    lock.current = true; setReading(true); setError(null); setOriginal(null)
    const current = ++ticket.current
    try {
      const result = await request(() => api.readRevision({ bookId: book.book.id, chapterId: source.chapterId, revisionId: source.revisionId }))
      if (current !== ticket.current) return
      if (!result.ok) { setError(result.error.message); return }
      if (result.data.bookId !== book.book.id || result.data.chapterId !== source.chapterId || result.data.id !== source.revisionId) throw new Error('固定原稿身份不符。')
      const document = parseManuscript(result.data.document), block = document.content.find((item) => item.attrs.id === source.blockId)
      if (!block) throw new Error('固定原稿中未找到登记段落。')
      const text = blockText(block), index = text.indexOf(source.quote), start = index < 0 ? 0 : Math.max(0, index - 200)
      setOriginal({ source, text: `${start > 0 ? '…' : ''}${text.slice(start, start + 4000)}${text.length > start + 4000 ? '…' : ''}`, matches: source.quote.length > 0 && index >= 0 })
    } catch (cause) { if (current === ticket.current) setError(cause instanceof Error ? cause.message : '原稿核对失败。') }
    finally { if (current === ticket.current) { lock.current = false; setReading(false) } }
  }
  async function navigate(source: ChapterSource) {
    if (disabled || lock.current) return
    lock.current = true; setReading(true); setError(null)
    const current = ++ticket.current
    try {
      const result = await request(() => api.readChapter({ bookId: book.book.id, chapterId: source.chapterId }))
      if (current !== ticket.current) return
      if (!result.ok) { setError(result.error.message); return }
      if (result.data.id !== source.chapterId || result.data.bookId !== book.book.id || !result.data.document.content.some((block) => block.attrs.id === source.blockId)) throw new Error('当前稿中已找不到原段落，请先核对固定历史稿。')
      await onNavigate({ bookId: book.book.id, chapterId: source.chapterId, blockId: source.blockId, expectedRevisionId: result.data.revisionId, sourceRevisionId: source.revisionId })
    } catch (cause) { if (current === ticket.current) setError(cause instanceof Error ? cause.message : '正文跳转未完成。') }
    finally { if (current === ticket.current) { lock.current = false; setReading(false) } }
  }
  return <section className={styles.detail} aria-label="出场或伏笔的来源与历史" aria-busy={loading || reading}>
    {loading && <p role="status">正在读取记录与来源…</p>}
    {error && <><p className={styles.error} role="alert">{error}</p>{!detail && <button type="button" className={shared.button} disabled={disabled || loading} onClick={() => setRefresh((value) => value + 1)}>重读记录</button>}</>}
    {detail && <><div className={styles.recordHeading}><h3>{detail.fields.title}</h3><button type="button" className={shared.button} disabled={disabled || reading} onClick={() => onOpenRecord(detail.fields.kind, detail.id)}>编辑记录与历程</button></div>
      <StoryFieldsView fields={detail.fields} book={book} names={detail.labels} />
      <p className={styles.help}>登记引文用于追溯出处，陈述本身仍需作者判断。跳转定位当前稿；固定原稿保留引用时的版本。</p>
      <ul className={styles.sourceList}>{detail.sources.map((source) => <li key={source.id}><p className={styles.help}>{source.sourceType === 'chapter_text' ? `固定正文 · ${source.referenceState === 'current' ? '当前稿登记' : '历史稿登记'}` : '作者／外部来源说明'}</p><blockquote>{source.quote}</blockquote>{source.sourceType === 'chapter_text' && <div className={styles.actions}><button type="button" className={shared.button} disabled={disabled || reading} onClick={() => void read(source)}>核对固定原文</button><button type="button" className={shared.button} disabled={disabled || reading} onClick={() => void navigate(source)}>跳到当前稿段落</button></div>}</li>)}</ul>
      {!detail.sources.length && <p className={styles.help}>尚无登记引文；整章缺席只代表作者对固定稿的明确核对。</p>}
    </>}
    {original && <div><p className={styles.ids}>固定版本 {original.source.revisionId} · 段落 {original.source.blockId}</p><p className={styles.help} role="status">{original.matches ? '登记引文逐字匹配该固定段落。' : '引文没有逐字匹配，请复核登记。'}</p><blockquote>{original.text}</blockquote></div>}
  </section>
}

export function AppearanceMatrix(props: Props) {
  const { api, book, disabled } = props
  const [query, setQuery] = useState('')
  const [input, setInput] = useState<AppearanceMatrixInput>({ bookId: book.book.id, kind: 'person' })
  const [page, setPage] = useState<AppearanceMatrixPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ entityId: string; chapterId: string } | null>(null)
  const [recordId, setRecordId] = useState<string | null>(null)
  const [gap, setGap] = useState(10)
  useEffect(() => {
    if (disabled) return
    let active = true
    setLoading(true); setPage(null); setSelected(null); setRecordId(null); setError(null)
    void request(() => api.readAppearanceMatrix(input)).then((result) => {
      if (!active) return
      setLoading(false)
      if (!result.ok) { setError(result.error.message); return }
      const value = result.data
      if (value.bookId !== book.book.id || value.bookRevision !== book.book.revision || !matchesVersions(value, input) || value.entityOffset !== (input.entityOffset ?? 0) || value.chapterOffset !== (input.chapterOffset ?? 0) ||
          value.entities.length > APPEARANCE_ENTITY_PAGE || value.chapters.length > APPEARANCE_CHAPTER_PAGE ||
          value.cells.some((cell) => !value.entities.some((entity) => entity.id === cell.entityId) || !value.chapters.some((chapter) => chapter.id === cell.chapterId))) { setError('矩阵版本、分页范围或实体归属不符，请刷新目录后重新打开。'); return }
      setPage(value)
    })
    return () => { active = false }
  }, [api, book.book.id, book.book.revision, input, disabled])
  const cells = new Map(page?.cells.map((cell) => [`${cell.entityId}:${cell.chapterId}`, cell] as const))
  const cellFor = (entityId: string, chapterId: string) => cells.get(`${entityId}:${chapterId}`)
  const chosen = selected ? cellFor(selected.entityId, selected.chapterId) : undefined
  function change(changes: Partial<AppearanceMatrixInput>, paging = false) {
    if (disabled || loading) return
    setInput(paging && page ? { ...input, ...snapshot(page), ...changes } : { bookId: book.book.id, kind: input.kind, search: input.search, ...changes })
  }
  function tail(entityId: string) {
    let confirmed = 0
    for (const chapter of [...(page?.chapters ?? [])].reverse()) {
      const cell = cellFor(entityId, chapter.id)
      if (appearanceState(cell) !== 'absent') break
      confirmed += 1
    }
    return confirmed
  }
  return <div className={styles.panel}>
    <div className={styles.toolbar}><label>实体名称<input type="search" maxLength={200} value={query} disabled={disabled || loading} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); change({ search: query.trim() }) } }} /></label><button className={shared.button} type="button" disabled={disabled || loading} onClick={() => change({ search: query.trim() })}>查找</button>
      <label>实体类型<select value={input.kind ?? ''} disabled={disabled || loading} onChange={(event) => change({ kind: event.target.value ? event.target.value as KnowledgeKind : undefined })}><option value="">全部类型</option>{KNOWLEDGE_KINDS.map((kind) => <option key={kind} value={kind}>{entityLabels[kind]}</option>)}</select></label>
      <label>缺席提醒阈值<input type="number" min="1" max="24" value={gap} disabled={disabled} onChange={(event) => setGap(Math.min(24, Math.max(1, Number(event.target.value) || 1)))} /></label><button className={shared.button} type="button" disabled={disabled || loading} onClick={() => change({})}>刷新矩阵</button>
    </div>
    <p className={styles.help}>只汇总已采纳事件及其正文来源。整章核对由作者单独登记；未索引、未采纳或没有证据都保持未知。提醒仅覆盖当前章节窗口，不推断全书缺席。</p>
    <div className={styles.legend}>{Object.entries(cellLabels).map(([key, label]) => <span key={key}>{cellMarks[key as keyof typeof cellMarks]} {label}</span>)}</div>
    {loading && <p role="status">正在读取章节与实体矩阵…</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    {page && <><div className={styles.scroll}><table className={styles.matrix}><caption>实体 {page.entityOffset + (page.entities.length ? 1 : 0)}–{page.entityOffset + page.entities.length} / {page.entityTotal} · 章节 {page.chapterOffset + (page.chapters.length ? 1 : 0)}–{page.chapterOffset + page.chapters.length} / {page.chapterTotal}</caption><thead><tr><th className={styles.rowHeading} scope="col">实体 / 章节</th>{page.chapters.map((chapter) => <th scope="col" key={chapter.id} title={chapter.title}><span className={styles.columnHeading}>第 {chapter.position + 1} 章</span></th>)}</tr></thead><tbody>{page.entities.map((entity) => {
      const absent = tail(entity.id)
      return <tr key={entity.id}><th className={styles.rowHeading} scope="row">{entity.name}<small>{entityLabels[entity.kind]}{absent >= gap ? ` · 窗口末连续 ${absent} 章已核对缺席` : ''}</small></th>{page.chapters.map((chapter) => {
        const cell = cellFor(entity.id, chapter.id), state = appearanceState(cell)
        return <td key={chapter.id}><button type="button" className={styles.cell} data-state={state} disabled={disabled} aria-label={`${entity.name}，第 ${chapter.position + 1} 章，${cellLabels[state]}${cell?.stale ? '，另有旧稿登记' : ''}`} aria-pressed={selected?.entityId === entity.id && selected.chapterId === chapter.id} onClick={() => { setSelected({ entityId: entity.id, chapterId: chapter.id }); setRecordId(cell?.recordIds[0] ?? null) }}>{cellMarks[state]}{cell?.stale && state !== 'stale' ? <sup>↺</sup> : null}</button></td>
      })}</tr>
    })}</tbody></table></div>
      {!page.entities.length && <p className={styles.help}>还没有匹配的实体，可先建立人物或调整筛选。</p>}
      <div className={styles.paging}><button className={shared.button} type="button" disabled={disabled || page.entityOffset === 0} onClick={() => change({ entityOffset: Math.max(0, page.entityOffset - APPEARANCE_ENTITY_PAGE) }, true)}>上一组实体</button><button className={shared.button} type="button" disabled={disabled || page.nextEntityOffset === null} onClick={() => change({ entityOffset: page.nextEntityOffset! }, true)}>下一组实体</button><button className={shared.button} type="button" disabled={disabled || page.chapterOffset === 0} onClick={() => change({ chapterOffset: Math.max(0, page.chapterOffset - APPEARANCE_CHAPTER_PAGE) }, true)}>前 {APPEARANCE_CHAPTER_PAGE} 章</button><button className={shared.button} type="button" disabled={disabled || page.nextChapterOffset === null} onClick={() => change({ chapterOffset: page.nextChapterOffset! }, true)}>后 {APPEARANCE_CHAPTER_PAGE} 章</button></div>
    </>}
    {selected && <section className={styles.selection}><h3>{page?.entities.find((entity) => entity.id === selected.entityId)?.name} · {page?.chapters.find((chapter) => chapter.id === selected.chapterId)?.title}</h3><p className={styles.help}>{cellLabels[appearanceState(chosen)]}。当前登场 {chosen?.present ?? 0}，提及 {chosen?.mentioned ?? 0}，明确缺席 {chosen?.absent ?? 0}，旧稿／待复核 {chosen?.stale ?? 0}。</p><div className={styles.actions}>{chosen?.recordIds.map((id, index) => <button key={id} type="button" className={shared.button} disabled={disabled} aria-pressed={recordId === id} onClick={() => setRecordId(id)}>代表记录 {index + 1}</button>)}<button className={shared.button} type="button" disabled={disabled} onClick={() => props.onOpenRecord('event')}>登记或复核事件</button></div></section>}
    {recordId && <RecordEvidence key={recordId} {...props} id={recordId} />}
  </div>
}

export function ForeshadowRadar(props: Props) {
  const { api, book, disabled } = props
  const [input, setInput] = useState<ForeshadowRadarInput>({ bookId: book.book.id, ...(props.asOfChapterId ? { asOfChapterId: props.asOfChapterId } : {}) })
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<ForeshadowRadarPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    if (disabled) return
    let active = true
    setLoading(true); setPage(null); setSelected(null); setError(null)
    void request(() => api.listForeshadowRadar(input)).then((result) => {
      if (!active) return
      setLoading(false)
      if (!result.ok) { setError(result.error.message); return }
      if (result.data.bookId !== book.book.id || result.data.bookRevision !== book.book.revision || !matchesVersions(result.data, input) ||
          result.data.asOfChapterId !== (input.asOfChapterId ?? null) || result.data.scope !== (input.scope ?? 'open') || result.data.offset !== (input.offset ?? 0)) { setError('雷达的进度、范围或作品版本不符，请刷新目录后重新打开。'); return }
      setPage(result.data)
    })
    return () => { active = false }
  }, [api, book.book.id, book.book.revision, input, disabled])
  function change(changes: Partial<ForeshadowRadarInput>, paging = false) {
    if (disabled || loading) return
    setInput(paging && page ? { ...input, ...snapshot(page), ...changes } : { bookId: book.book.id, asOfChapterId: input.asOfChapterId, scope: input.scope, search: input.search, ...changes })
  }
  return <div className={styles.panel}><div className={styles.toolbar}>
    <label>核对到哪一章<select value={input.asOfChapterId ?? ''} disabled={disabled || loading} onChange={(event) => change({ asOfChapterId: event.target.value || undefined })}><option value="">尚未指定进度</option>{book.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.position + 1} 章 · {chapter.title}</option>)}</select></label>
    <label>查看范围<select value={input.scope ?? 'open'} disabled={disabled || loading} onChange={(event) => change({ scope: event.target.value as RadarScope })}><option value="open">未结束</option><option value="due">本次到期及逾期</option><option value="closed">已经结束</option><option value="all">全部（含否决）</option></select></label>
    <label>伏笔名称<input type="search" value={query} maxLength={200} disabled={disabled || loading} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); change({ search: query.trim() }) } }} /></label><button type="button" className={shared.button} disabled={disabled || loading} onClick={() => change({ search: query.trim() })}>查找 / 刷新</button>
  </div><p className={styles.help}>到期比较使用所选章的叙述顺序；卷目标在本卷提醒，进入后卷才标逾期。未建卷章的明确序号可参与比较；纯文字范围不猜测到期，计划不作为实际回收证据。</p>
    {loading && <p role="status">正在读取伏笔雷达…</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    {page && <><p className={styles.help} role="status">当前范围共 {page.total} 条 · 逾期 {page.counts.overdue} · 本章／本卷到期 {page.counts.due} · 范围待定位 {page.counts.unplaced} · 待复核 {page.counts.unconfirmed}</p>
      <ul className={styles.records}>{page.items.map((item) => <li key={item.id}>
        <div className={styles.recordHeading}><h3>{item.title}</h3><span className={styles.due} data-due={item.due}>
          {radarDueLabels[item.due]}{item.overdueChapters === null ? '' : ` ${item.overdueChapters} 章`}
        </span></div>
        <p className={styles.help}>{stageLabels[item.stage]} · {item.description || '尚无补充说明'}</p>
        <dl className={styles.facts}>
          <dt>计划回收</dt><dd>{plannedPayoffLabel(item.plannedPayoff, book)}</dd>
          <dt>实际回收</dt><dd>{item.actualPayoff.state === 'located' ? '已登记固定段落；打开来源核对逐字引文' : '尚无固定段落证据'}</dd>
        </dl>
        <div className={styles.actions}>
          <button className={shared.button} type="button" disabled={disabled} aria-expanded={selected === item.id} onClick={() => setSelected(selected === item.id ? null : item.id)}>查看历程与原文证据</button>
          <button className={shared.button} type="button" disabled={disabled} onClick={() => props.onOpenRecord('foreshadow', item.id)}>编辑回收计划</button>
          {props.onUseForeshadow && <button className={shared.button} type="button"
            disabled={disabled || item.authorDecision !== 'adopted' || item.freshness !== 'current' || item.conflictState === 'candidate' || item.due === 'closed'}
            onClick={() => props.onUseForeshadow?.({ source: 'foreshadow', id: item.id, revision: item.revision })}>选入本章 AI 上下文</button>}
        </div>
      </li>)}</ul>
      {!page.items.length && <p className={styles.help}>当前范围没有伏笔，可调整核对进度或先登记伏笔计划。</p>}
      <div className={styles.paging}><button type="button" className={shared.button} disabled={disabled || page.offset === 0} onClick={() => change({ offset: Math.max(0, page.offset - FORESHADOW_RADAR_PAGE) }, true)}>上一页</button><span>{page.total} 条</span><button type="button" className={shared.button} disabled={disabled || page.nextOffset === null} onClick={() => change({ offset: page.nextOffset! }, true)}>下一页</button></div>
    </>}
    {selected && <RecordEvidence key={selected} {...props} id={selected} />}
  </div>
}

export function ForeshadowDueNotice({ api, book, chapterId, disabled, onUse, onOpen }: {
  api: StudioApi; book: BookSnapshot; chapterId: string; disabled: boolean
  onUse?: (ref: CreativeResourceRef) => void; onOpen?: () => void
}) {
  const [page, setPage] = useState<ForeshadowRadarPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setPage(null); setError(null)
    void request(() => api.listForeshadowRadar({ bookId: book.book.id, asOfChapterId: chapterId, scope: 'due' })).then((result) => {
      if (!active) return
      if (!result.ok) { setError(result.error.message); return }
      if (result.data.bookId !== book.book.id || result.data.asOfChapterId !== chapterId || result.data.scope !== 'due' || result.data.bookRevision < book.book.revision) { setError('提醒版本与当前作品不符，请刷新目录后核对。'); return }
      setPage(result.data)
    })
    return () => { active = false }
    // 正文自动保存不重新扫描；章切换或作者显式刷新时读取，防止输入期间高频查询。
  }, [api, book.book.id, chapterId, refresh])
  if (!error && page?.total === 0) return null
  return <aside className={styles.dueStrip} aria-label="本章伏笔提醒"><p>{error ? `伏笔提醒未能读取：${error}` : page ? `按本章顺序核对，有 ${page.total} 条伏笔到期或逾期。` : '正在核对本章的待回收伏笔…'}</p>
    {page && page.bookRevision !== book.book.revision && <p role="status">以上为上次核对结果，作品已有更新；请刷新提醒后核对。</p>}
    {page && <ul>{page.items.slice(0, 3).map((item: ForeshadowRadarItem) => <li key={item.id}>{item.title} · {radarDueLabels[item.due]} {onUse && <button className={shared.button} type="button" disabled={disabled} onClick={() => onUse({ source: 'foreshadow', id: item.id, revision: item.revision })}>选入上下文</button>}</li>)}</ul>}
    <div className={styles.actions}>{onOpen && <button className={shared.button} type="button" disabled={disabled} onClick={onOpen}>查看伏笔雷达</button>}<button className={shared.button} type="button" disabled={disabled} onClick={() => setRefresh((value) => value + 1)}>刷新提醒</button></div>
  </aside>
}
