import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BookSnapshot, StudioApi } from '../../contracts/api'
import { KNOWLEDGE_KINDS, type KnowledgeKind, type KnowledgeSourceInput } from '../../contracts/knowledge'
import type { CreativeResourceRef } from '../../contracts/creative-resources'
import { parseManuscript } from '../../contracts/manuscript'
import { appearanceState, APPEARANCE_CHAPTER_PAGE, APPEARANCE_ENTITY_PAGE, FORESHADOW_RADAR_PAGE,
  type AppearanceMatrixInput, type AppearanceMatrixPage, type ControlVersions,
  type ForeshadowRadarInput, type ForeshadowRadarItem, type ForeshadowRadarPage, type RadarDue, type RadarScope } from '../../contracts/story-control'
import type { StoryKind, StoryRecordDetail } from '../../contracts/story'
import { parseForeshadowThumbnailMetadata } from '../../contracts/foreshadow-thumbnail'
import { request } from '../request'
import { blockText, plannedPayoffLabel, stageLabels, StoryFieldsView } from './StoryFieldsEditor'
import type { CompanionNavigateTarget } from './CompanionPanel'
import { StudioIcon } from './StudioIcon'
import { ForeshadowThumbnail } from './ForeshadowThumbnail'
import shared from '../StellarShared.module.css'
import styles from './StellarControl.module.css'

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
function radarThumbnailValid(item: ForeshadowRadarItem): boolean {
  if (item.thumbnail === null) return true
  try {
    const thumbnail = parseForeshadowThumbnailMetadata(item.thumbnail)
    return thumbnail.recordId === item.id && thumbnail.knowledgeRevision <= item.revision
  } catch { return false }
}

function RecordEvidence({ api, book, disabled, id, expected, onOpenRecord, onNavigate }: Pick<Props, 'api' | 'book' | 'disabled' | 'onOpenRecord' | 'onNavigate'> & {
  id: string; expected?: { knowledgeRevision: number; recordRevision: number }
}) {
  const [detail, setDetail] = useState<StoryRecordDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [original, setOriginal] = useState<{ source: ChapterSource; text: string; matches: boolean } | null>(null)
  const [reading, setReading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const ticket = useRef(0), lock = useRef(false)
  const detailRoot = useRef<HTMLElement>(null)
  useEffect(() => {
    let active = true
    ticket.current += 1; lock.current = false; setReading(false)
    setLoading(true); setDetail(null); setError(null); setOriginal(null)
    void request(() => api.getStoryRecord({ bookId: book.book.id, id })).then((result) => {
      if (!active) return
      setLoading(false)
      if (!result.ok) { setError(result.error.message); return }
      // 雷达详情须保持所选列表的双版本与记录修订，重读不能静默换成更新的内容。
      if (result.data.id !== id || result.data.bookId !== book.book.id || result.data.bookRevision !== book.book.revision ||
          (expected && (result.data.fields.kind !== 'foreshadow' || result.data.knowledgeRevision !== expected.knowledgeRevision ||
            result.data.revisions[0]?.recordId !== id || result.data.revisions[0]?.knowledgeRevision !== expected.recordRevision)) ||
          result.data.sources.some((source) => source.bookId !== book.book.id || source.recordId !== id)) { setError('作品或来源版本已变化，请刷新星图后重新选择。'); return }
      setDetail(result.data)
    })
    return () => { active = false; ticket.current += 1 }
  }, [api, book.book.id, book.book.revision, id, expected?.knowledgeRevision, expected?.recordRevision, refresh])

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
  return <section ref={detailRoot} className={styles.detail} tabIndex={-1} aria-label="出场或伏笔的来源与历史" aria-busy={loading || reading}>
    {loading && <p role="status">正在读取记录与来源…</p>}
    {error && <><p className={styles.error} role="alert">{error}</p>{!detail && <button type="button" className={shared.button} disabled={disabled || loading} onClick={() => { detailRoot.current?.focus({ preventScroll: true }); setRefresh((value) => value + 1) }}>重读记录</button>}</>}
    {detail && <><div className={styles.recordHeading}><h3>{detail.fields.title}</h3><button type="button" className={shared.button} disabled={disabled || reading} onClick={() => onOpenRecord(detail.fields.kind, detail.id)}>编辑记录与历程</button></div>
      {detail.fields.kind === 'foreshadow' && detail.thumbnail && <ForeshadowThumbnail api={api} bookId={book.book.id} recordId={detail.id} metadata={detail.thumbnail} name={detail.fields.title} className={styles.evidenceThumbnail} />}
      <StoryFieldsView fields={detail.fields} book={book} names={detail.labels} />
      <p className={styles.help}>登记引文用于追溯出处，陈述本身仍需作者判断。跳转定位当前稿；固定原稿保留引用时的版本。</p>
      {/* 读取锁拦截重复操作，保留按钮焦点，避免原生禁用后 Esc 无法送达证据区。 */}
      <ul className={styles.sourceList}>{detail.sources.map((source) => <li key={source.id}><p className={styles.help}>{source.sourceType === 'chapter_text' ? `固定正文 · ${source.referenceState === 'current' ? '当前稿登记' : '历史稿登记'}` : '作者／外部来源说明'}</p><blockquote>{source.quote}</blockquote>{source.sourceType === 'chapter_text' && <div className={styles.actions}><button type="button" className={shared.button} disabled={disabled} aria-disabled={reading || undefined} onClick={() => void read(source)}>核对固定原文</button><button type="button" className={shared.button} disabled={disabled} aria-disabled={reading || undefined} onClick={() => void navigate(source)}>跳到当前稿段落</button></div>}</li>)}</ul>
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
  const [hover, setHover] = useState<{ entityId: string; chapterId: string; recordId: string; x: number; y: number } | null>(null)
  const [preview, setPreview] = useState<{ title: string; quote: string; state: string } | null>(null)
  const previewId = useId()
  const previewCache = useRef(new Map<string, StoryRecordDetail>())
  useEffect(() => {
    if (disabled) return
    let active = true
    setLoading(true); setPage(null); setSelected(null); setRecordId(null); setError(null); setHover(null); previewCache.current.clear()
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
  useEffect(() => {
    setPreview(null)
    if (!hover || !page || disabled) return
    let active = true
    const timer = setTimeout(() => {
      // 悬停只读一个代表记录；双版本核对后展示该章来源，不把旧引文混入新矩阵。
      void (async () => {
        let detail = previewCache.current.get(hover.recordId)
        if (!detail) {
          const result = await request(() => api.getStoryRecord({ bookId: book.book.id, id: hover.recordId }))
          if (!active) return
          if (!result.ok) { setPreview({ title: '出处暂时无法读取', quote: result.error.message, state: '可点击单元格重读记录' }); return }
          detail = result.data
        }
        if (!active) return
        if (detail.id !== hover.recordId || detail.bookId !== page.bookId || detail.bookRevision !== page.bookRevision || detail.knowledgeRevision !== page.knowledgeRevision) {
          setPreview({ title: '出处版本已变化', quote: '请刷新矩阵后核对。', state: '当前预览未采用' }); return
        }
        previewCache.current.set(detail.id, detail)
        const source = detail.sources.find((item) => item.sourceType === 'chapter_text' && item.chapterId === hover.chapterId)
        const check = detail.fields.kind === 'event' && detail.fields.appearanceCheck?.chapterId === hover.chapterId ? detail.fields.appearanceCheck : null
        setPreview({ title: detail.fields.title, quote: source?.quote.slice(0, 240) || check?.note.slice(0, 240) || '未登记该章的段落引文。',
          state: source ? `固定正文 · ${source.referenceState === 'current' ? '当前稿登记' : '历史稿登记'}` : check ? '作者整章缺席核对' : '点击查看记录详情' })
      })()
    }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [api, book.book.id, disabled, hover, page])
  useEffect(() => {
    const close = () => setHover(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', escape) }
  }, [])
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
  const reminders = page?.entities.map((entity) => ({ ...entity, count: tail(entity.id) })) ?? []
  const reminder = reminders.find((entity) => entity.id === selected?.entityId) ?? reminders.find((entity) => entity.count >= gap) ?? reminders[0]
  function showPreview(element: HTMLButtonElement, entityId: string, chapterId: string, id?: string) {
    if (disabled || !id) { setHover(null); return }
    const rect = element.getBoundingClientRect()
    setHover({ entityId, chapterId, recordId: id, x: Math.min(Math.max(12, rect.left + rect.width / 2 - 150), Math.max(12, window.innerWidth - 312)), y: Math.min(window.innerHeight - 196, Math.max(12, rect.bottom + 8)) })
  }
  return <div className={styles.panel} data-control="matrix">
    <details className={styles.matrixSearch}><summary>搜索与筛选</summary>
    <div className={styles.toolbar}><label>实体名称<input type="search" maxLength={200} value={query} disabled={disabled || loading} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); change({ search: query.trim() }) } }} /></label><button className={shared.button} type="button" disabled={disabled || loading} onClick={() => change({ search: query.trim() })}>查找</button>
      <label>实体类型<select value={input.kind ?? ''} disabled={disabled || loading} onChange={(event) => change({ kind: event.target.value ? event.target.value as KnowledgeKind : undefined })}><option value="">全部类型</option>{KNOWLEDGE_KINDS.map((kind) => <option key={kind} value={kind}>{entityLabels[kind]}</option>)}</select></label>
      <button className={shared.button} type="button" disabled={disabled || loading} onClick={() => change({})}><StudioIcon name="refresh" />刷新矩阵</button>
    </div>
    <p className={styles.help}>只汇总已采纳事件及其正文来源。整章核对由作者单独登记；未索引、未采纳或没有证据都保持未知。提醒仅覆盖当前章节窗口，不推断全书缺席。</p>
    </details>
    <div className={styles.matrixHeading}><div className={styles.rangeSummary}>{page ? <><span>实体 {page.entityOffset + (page.entities.length ? 1 : 0)}–{page.entityOffset + page.entities.length} / {page.entityTotal}</span><span>章节 {page.chapterOffset + (page.chapters.length ? 1 : 0)}–{page.chapterOffset + page.chapters.length} / {page.chapterTotal}</span></> : <span>读取本页范围</span>}</div>
      <div className={styles.legend}>{Object.entries(cellLabels).map(([key, label]) => <span key={key} data-state={key}><i aria-hidden="true">{cellMarks[key as keyof typeof cellMarks]}</i>{label}</span>)}</div></div>
    {loading && <p role="status">正在读取章节与实体矩阵…</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    {page && <div className={styles.matrixLayout}><div className={styles.matrixMain}><div className={styles.scroll}><table className={styles.matrix}><caption>当前页实体与章节的已登记出场</caption><thead><tr><th className={styles.rowHeading} scope="col">实体 / 章节</th>{page.chapters.map((chapter) => <th scope="col" key={chapter.id} title={chapter.title}><span className={styles.columnHeading}>{String(chapter.position + 1).padStart(2, '0')}</span></th>)}</tr></thead><tbody>{page.entities.map((entity) => {
      const absent = tail(entity.id)
      return <tr key={entity.id}><th className={styles.rowHeading} scope="row">{entity.name}<small>{entityLabels[entity.kind]}{absent >= gap ? ` · 窗口末连续 ${absent} 章已核对缺席` : ''}</small></th>{page.chapters.map((chapter) => {
        const cell = cellFor(entity.id, chapter.id), state = appearanceState(cell)
        return <td key={chapter.id}><button type="button" className={styles.cell} data-state={state} data-heat={(cell?.present ?? 0) + (cell?.mentioned ?? 0) >= 3 ? 'high' : 'low'} disabled={disabled} aria-label={`${entity.name}，第 ${chapter.position + 1} 章，${cellLabels[state]}${cell?.stale ? '，另有旧稿登记' : ''}`} aria-pressed={selected?.entityId === entity.id && selected.chapterId === chapter.id}
          aria-describedby={hover?.entityId === entity.id && hover.chapterId === chapter.id && preview ? previewId : undefined}
          title={!cell?.recordIds.length ? `${entity.name} · 第 ${chapter.position + 1} 章：没有符合条件的登记` : undefined}
          onPointerEnter={(event) => showPreview(event.currentTarget, entity.id, chapter.id, cell?.recordIds[0])} onPointerLeave={() => setHover(null)}
          onFocus={(event) => showPreview(event.currentTarget, entity.id, chapter.id, cell?.recordIds[0])} onBlur={() => setHover(null)}
          onClick={() => { setHover(null); setSelected({ entityId: entity.id, chapterId: chapter.id }); setRecordId(cell?.recordIds[0] ?? null) }}>{cellMarks[state]}{cell?.stale && state !== 'stale' ? <sup>↺</sup> : null}</button></td>
      })}</tr>
    })}</tbody></table></div>
      {!page.entities.length && <p className={styles.help}>还没有匹配的实体，可先建立人物或调整筛选。</p>}
      <div className={styles.paging}><button className={shared.button} type="button" disabled={disabled || page.entityOffset === 0} onClick={() => change({ entityOffset: Math.max(0, page.entityOffset - APPEARANCE_ENTITY_PAGE) }, true)}>上一组实体</button><button className={shared.button} type="button" disabled={disabled || page.nextEntityOffset === null} onClick={() => change({ entityOffset: page.nextEntityOffset! }, true)}>下一组实体</button><button className={shared.button} type="button" disabled={disabled || page.chapterOffset === 0} onClick={() => change({ chapterOffset: Math.max(0, page.chapterOffset - APPEARANCE_CHAPTER_PAGE) }, true)}>前 {APPEARANCE_CHAPTER_PAGE} 章</button><button className={shared.button} type="button" disabled={disabled || page.nextChapterOffset === null} onClick={() => change({ chapterOffset: page.nextChapterOffset! }, true)}>后 {APPEARANCE_CHAPTER_PAGE} 章</button></div>
    </div><aside className={styles.matrixAside} aria-label="连续缺席提醒">
      <h3><StudioIcon name="spark" size={24} />{reminder?.name ?? '连续缺席提醒'}</h3>
      <div className={styles.absenceSummary} data-alert={Boolean(reminder && reminder.count >= gap)}><StudioIcon name="warning" size={28} /><p>{reminder?.count ? <>窗口末连续 <strong>{reminder.count}</strong> 章<br />明确核对缺席</> : '本页末尾尚未形成连续已核对缺席。'}</p></div>
      <label className={styles.threshold}>提醒阈值 <output>{gap} 章</output><input type="range" min="1" max="24" value={gap} disabled={disabled} aria-label="缺席提醒阈值" onChange={(event) => setGap(Number(event.target.value))} /></label>
      {reminders.filter((entity) => entity.count >= gap).length > 0 && <ul className={styles.absenceList}>{reminders.filter((entity) => entity.count >= gap).map((entity) => <li key={entity.id}>{entity.name}<span>{entity.count} 章</span></li>)}</ul>}
      <p className={styles.help}>仅核对当前章节窗口。未知、冲突或正向登记会中断连续缺席。</p>
    </aside></div>}
    {selected && <section className={styles.selection}><h3>{page?.entities.find((entity) => entity.id === selected.entityId)?.name} · {page?.chapters.find((chapter) => chapter.id === selected.chapterId)?.title}</h3><p className={styles.help}>{cellLabels[appearanceState(chosen)]}。当前登场 {chosen?.present ?? 0}，提及 {chosen?.mentioned ?? 0}，明确缺席 {chosen?.absent ?? 0}，旧稿／待复核 {chosen?.stale ?? 0}。</p><div className={styles.actions}>{chosen?.recordIds.map((id, index) => <button key={id} type="button" className={shared.button} disabled={disabled} aria-pressed={recordId === id} onClick={() => setRecordId(id)}>代表记录 {index + 1}</button>)}<button className={shared.button} type="button" disabled={disabled} onClick={() => props.onOpenRecord('event')}>登记或复核事件</button></div></section>}
    {recordId && <RecordEvidence key={recordId} {...props} id={recordId} />}
    {hover && preview && createPortal(<div id={previewId} role="tooltip" className={styles.cellPreview} style={{ left: hover.x, top: hover.y }}><strong>{preview.title}</strong><span>{preview.state}</span><p>{preview.quote}</p></div>, document.body)}
  </div>
}

const radarSegments = [
  { key: 'planned', label: '计划埋设', angle: -62 }, { key: 'planted', label: '已埋设', angle: -44 },
  { key: 'progress', label: '推进提及', angle: -24 }, { key: 'overdue', label: '逾期告警', angle: -4 },
  { key: 'closed', label: '已结束', angle: 32 },
] as const
const radarArcAngles = [-90,-53,-34,-14,14,90] as const
function radarSegment(item: ForeshadowRadarItem): typeof radarSegments[number]['key'] {
  return item.due === 'closed' ? 'closed' : item.due === 'overdue' ? 'overdue'
    : item.stage === 'planned' ? 'planned' : item.stage === 'planted' ? 'planted' : 'progress'
}
function radarSourceLabel(item: ForeshadowRadarItem): string {
  return !item.source ? '尚无登记引文' : item.source.sourceType === 'chapter_text'
    ? `固定正文节选 · ${item.source.referenceState === 'current' ? '当前稿登记' : '历史稿登记'}` : item.source.sourceType === 'author_input' ? '作者说明节选' : '外部资料节选'
}

export function ForeshadowRadar(props: Props) {
  const { api, book, disabled } = props
  const [input, setInput] = useState<ForeshadowRadarInput>({ bookId: book.book.id, ...(props.asOfChapterId ? { asOfChapterId: props.asOfChapterId } : {}) })
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<ForeshadowRadarPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const radarRoot = useRef<HTMLDivElement>(null)
  const evidence = useRef<HTMLDivElement>(null)
  const selectionTrigger = useRef<HTMLElement | SVGElement | null>(null)
  const dueJump = useRef(false)
  const evidenceId = useId(), arcId = useId()
  useEffect(() => {
    if (!selected) return
    evidence.current?.scrollIntoView({ block: 'nearest' })
    evidence.current?.focus({ preventScroll: true })
  }, [selected])
  useEffect(() => {
    if (disabled) return
    let active = true
    setLoading(true); setPage(null); setSelected(null); setHovered(null); setError(null)
    void request(() => api.listForeshadowRadar(input)).then((result) => {
      if (!active) return
      setLoading(false)
      if (!result.ok) { dueJump.current = false; setError(result.error.message); return }
      const value = result.data, counts = Object.keys(radarDueLabels).map((key) => value.counts[key as RadarDue])
      if (value.bookId !== book.book.id || value.bookRevision !== book.book.revision || !matchesVersions(value, input) ||
          value.asOfChapterId !== (input.asOfChapterId ?? null) || value.scope !== (input.scope ?? 'open') || value.offset !== (input.offset ?? 0) ||
          !Number.isSafeInteger(value.total) || value.total < 0 || counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
          counts.reduce((total, count) => total + count, 0) !== value.total ||
          value.items.length !== Math.min(FORESHADOW_RADAR_PAGE, Math.max(0, value.total - value.offset)) ||
          new Set(value.items.map((item) => item.id)).size !== value.items.length ||
          value.items.some((item) => !radarThumbnailValid(item)) ||
          value.nextOffset !== (value.offset + value.items.length < value.total ? value.offset + value.items.length : null)) {
        dueJump.current = false; setError('雷达的进度、范围、分页或作品版本不符，请刷新目录后重新打开。'); return
      }
      setPage(value)
      if (dueJump.current) {
        dueJump.current = false
        setSelected(value.items.find((item) => item.due === 'due' || item.due === 'overdue')?.id ?? null)
      }
    })
    return () => { active = false }
  }, [api, book.book.id, book.book.revision, input, disabled])
  function change(changes: Partial<ForeshadowRadarInput>, paging = false) {
    if (disabled || loading) return
    dueJump.current = false
    setInput(paging && page ? { ...input, ...snapshot(page), ...changes } : { bookId: book.book.id, asOfChapterId: input.asOfChapterId, scope: input.scope, search: input.search, ...changes })
  }
  const currentChapter = book.chapters.find((chapter) => chapter.id === input.asOfChapterId)
  const dueItems = page?.items.filter((item) => item.due === 'due' || item.due === 'overdue') ?? []
  const selectedItem = page?.items.find((item) => item.id === selected)
  function closeEvidence() {
    setSelected(null)
    const trigger = selectionTrigger.current
    const target = trigger?.isConnected && !trigger.matches(':disabled,[aria-disabled="true"]')
      ? trigger : radarRoot.current?.querySelector<HTMLElement>('summary')
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    target?.focus({ preventScroll: true })
    selectionTrigger.current = null
  }
  function openEvidence(id: string, trigger: Element) {
    if (disabled || loading || !page?.items.some((item) => item.id === id)) return
    if (trigger instanceof HTMLElement || trigger instanceof SVGElement) selectionTrigger.current = trigger
    setSelected(id)
    if (id === selected) {
      evidence.current?.scrollIntoView({ block: 'nearest' })
      evidence.current?.focus({ preventScroll: true })
    }
  }
  function select(id: string, trigger: Element) {
    if (disabled || loading) return
    if (selected === id) closeEvidence()
    else openEvidence(id, trigger)
  }
  function jumpToDue(trigger: HTMLButtonElement) {
    if (disabled || loading || !page || !currentChapter || page.counts.due + page.counts.overdue === 0) return
    if (dueItems[0]) { openEvidence(dueItems[0].id, trigger); return }
    selectionTrigger.current = trigger
    // 后续页也能定位到期记录；沿用当前搜索和双版本，不把别的快照混入提醒。
    dueJump.current = true
    setInput({ ...input, ...snapshot(page), scope: 'due', offset: 0 })
  }
  function aiReason(item: ForeshadowRadarItem): string | undefined {
    return disabled ? '请等待当前操作结束' : item.due === 'closed' ? '已结束的伏笔不可选入上下文'
      : item.authorDecision !== 'adopted' ? '请先采纳这条伏笔' : item.freshness !== 'current' || item.conflictState === 'candidate' ? '请先核对过时或冲突的伏笔' : undefined
  }
  function actualChapterTitle(item: ForeshadowRadarItem): string {
    const actual = item.actualPayoff
    return actual.state === 'located' ? book.chapters.find((chapter) => chapter.id === actual.chapterId)?.title ?? '固定正文位置' : ''
  }
  const scopeLabel = { open: '未结束', due: '本次到期及逾期', closed: '已经结束', all: '全部（含否决）' }[input.scope ?? 'open']
  return <div ref={radarRoot} className={styles.panel} data-control="radar"><details className={styles.radarFilters}>
    <summary>{currentChapter ? `第 ${currentChapter.position + 1} 章` : '尚未指定进度'} · {scopeLabel} · 进度与筛选</summary>
    <div className={styles.toolbar}>
    <label>核对到哪一章<select value={input.asOfChapterId ?? ''} disabled={disabled || loading} onChange={(event) => change({ asOfChapterId: event.target.value || undefined })}><option value="">尚未指定进度</option>{book.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.position + 1} 章 · {chapter.title}</option>)}</select></label>
    <label>查看范围<select value={input.scope ?? 'open'} disabled={disabled || loading} onChange={(event) => change({ scope: event.target.value as RadarScope })}><option value="open">未结束</option><option value="due">本次到期及逾期</option><option value="closed">已经结束</option><option value="all">全部（含否决）</option></select></label>
    <label>伏笔名称<input type="search" value={query} maxLength={200} disabled={disabled || loading} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); change({ search: query.trim() }) } }} /></label><button type="button" className={shared.button} disabled={disabled || loading} onClick={() => change({ search: query.trim() })}>查找 / 刷新</button>
    </div>
  </details>
    {loading && <p role="status">正在读取伏笔雷达…</p>}{error && <div><p className={styles.error} role="alert">{error}</p>
      <div className={styles.actions}><button type="button" className={shared.button} disabled={disabled || loading}
        onClick={() => { dueJump.current = false; setInput({ ...input }) }}>重试本次读取</button>
        <button type="button" className={shared.button} disabled={disabled || loading} onClick={() => change({ offset: 0 })}>重新核对第一页</button></div>
    </div>}
    {page && <><div className={styles.radarLayout}>
      <aside className={styles.radarOrbit} aria-label="本页伏笔历程分布">
        <h3>伏笔历程</h3>
        <div className={styles.radarCanvas}>
          <svg viewBox="0 0 530 735" role="group" aria-label={`本页 ${page.items.length} 条伏笔的历程分布`}>
            <defs><radialGradient id={`${arcId}-origin`}><stop offset="0" className={styles.radarGlowCore} /><stop offset=".15" className={styles.radarStop} /><stop offset="1" className={styles.radarGlowEdge} /></radialGradient></defs>
            <g className={styles.radarGrid} aria-hidden="true">{[80,110,140,170,200,230,260,290,330,370,410].map((radius) => <path key={radius} d={`M0 ${417 - radius} A${radius} ${radius} 0 0 1 0 ${417 + radius}`} />)}
              {[-90,-75,-60,-45,-30,-15,0,15,30,45,60,75,90].map((degrees) => <line key={degrees} x1={0} y1={417} x2={Math.cos(degrees * Math.PI / 180) * 410} y2={417 + Math.sin(degrees * Math.PI / 180) * 410} />)}</g>
            {radarSegments.map((segment, index) => {
              const start = radarArcAngles[index]! * Math.PI / 180, end = radarArcAngles[index + 1]! * Math.PI / 180
              const x1 = Math.cos(start) * 410, y1 = 417 + Math.sin(start) * 410
              const x2 = Math.cos(end) * 410, y2 = 417 + Math.sin(end) * 410
              return <g key={segment.key} aria-hidden="true"><defs><linearGradient id={`${arcId}-${segment.key}`} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
                <stop offset="0" className={styles.radarStop} data-segment={segment.key} />
                <stop offset="1" className={styles.radarStop} data-segment={radarSegments[Math.min(index + 1, radarSegments.length - 1)]!.key} />
              </linearGradient></defs><path className={styles.radarArc} stroke={`url(#${arcId}-${segment.key})`} d={`M${x1} ${y1} A410 410 0 0 1 ${x2} ${y2}`} /></g>
            })}
            <g aria-hidden="true"><circle cx={0} cy={417} r={64} fill={`url(#${arcId}-origin)`} /><path className={styles.radarOriginRay} d="M0 365V469M0 417H104M0 417L58 359M0 417L58 475" /><circle className={styles.radarOrigin} cx={0} cy={417} r={5} /></g>
            {radarSegments.map((segment) => {
              const matches = page.items.filter((item) => radarSegment(item) === segment.key), first = matches[0]
              const angle = segment.angle * Math.PI / 180, x = Math.cos(angle) * 410, y = 417 + Math.sin(angle) * 410
              return <g key={segment.key} className={styles.radarSegment} data-segment={segment.key} data-empty={!matches.length} data-highlighted={matches.some((item) => item.id === hovered || item.id === selected)} role="button"
                aria-label={`${segment.label}，本页 ${matches.length} 条`} aria-disabled={disabled || !first} aria-controls={evidenceId} aria-expanded={matches.some((item) => item.id === selected)} tabIndex={disabled || !first ? -1 : 0}
                onPointerEnter={() => setHovered(first?.id ?? null)} onPointerLeave={() => setHovered(null)}
                onFocus={() => setHovered(first?.id ?? null)} onBlur={() => setHovered(null)} onClick={(event) => first && select(first.id, event.currentTarget)}
                onKeyDown={(event) => { if (first && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(first.id, event.currentTarget) } }}>
                <title>{first ? `${segment.label} · 本页${matches.length}条` : `本页暂无${segment.label}记录`}</title>
                <circle className={styles.radarSegmentHalo} cx={x} cy={y} r={14} /><circle cx={x} cy={y} r={6} />
                <text x={x + 36} y={y + 5}>{segment.label} {matches.length}</text>
              </g>
            })}
          </svg>
          <div className={styles.radarCards}>{radarSegments.map((segment, index) => {
            const matches = page.items.filter((item) => radarSegment(item) === segment.key)
            const item = matches.find((entry) => entry.id === hovered) ?? matches.find((entry) => entry.id === selected) ?? matches[0]
            const targetChapterId = item && 'chapterId' in item.plannedPayoff ? item.plannedPayoff.chapterId : null
            const targetChapter = book.chapters.find((chapter) => chapter.id === targetChapterId)
            return item ? <button type="button" key={segment.key} data-position={index} data-due={item.due} data-stage={item.stage} data-hovered={hovered === item.id} disabled={disabled}
              aria-label={`查看伏笔：${item.title}`} aria-pressed={selected === item.id} aria-controls={evidenceId} title={`${item.title} · ${stageLabels[item.stage]} · ${radarDueLabels[item.due]}`}
              onPointerEnter={() => setHovered(item.id)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(item.id)} onBlur={() => setHovered(null)} onClick={(event) => select(item.id, event.currentTarget)}>
              <ForeshadowThumbnail api={api} bookId={book.book.id} recordId={item.id} metadata={item.thumbnail} name={item.title} className={styles.radarThumbnail} retryable={false} />
              <strong>{item.title}</strong><small title={plannedPayoffLabel(item.plannedPayoff, book)}>{targetChapter ? `第 ${targetChapter.position + 1} 章` : plannedPayoffLabel(item.plannedPayoff, book)}</small>
            </button> : null
          })}</div>
        </div>
        <p className={styles.help}>本页历程 · {page.items.length} 条 / 当前范围 {page.total} 条</p>
      </aside>
      <div className={styles.radarListPane}>
        <div className={styles.radarTableScroll}><table className={styles.radarTable}><thead><tr><th scope="col">伏笔标题</th><th scope="col">到期章节</th><th scope="col">回收位置</th><th scope="col">状态</th></tr></thead>
          <tbody>{page.items.map((item) => <tr key={item.id} data-due={item.due} data-selected={selected === item.id} data-hovered={hovered === item.id}
            onPointerEnter={() => setHovered(item.id)} onPointerLeave={() => setHovered(null)}
            onFocus={() => setHovered(item.id)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHovered(null) }}>
            <th scope="row"><div className={styles.radarTitleLine}><button type="button" className={styles.radarTitle} data-due={item.due} data-stage={item.stage} disabled={disabled} aria-controls={evidenceId} aria-expanded={selected === item.id} title={item.title} onClick={(event) => select(item.id, event.currentTarget)}><StudioIcon name="spark" size={20} /><span>{item.title}</span></button>
              <div className={styles.radarRowActions}>
                <button type="button" className={styles.radarIconButton} disabled={disabled} aria-label={`查看历程与原文证据：${item.title}`} aria-controls={evidenceId} aria-expanded={selected === item.id} title="查看历程与原文证据" onClick={(event) => select(item.id, event.currentTarget)}><StudioIcon name="read" size={16} /></button>
                <button type="button" className={styles.radarIconButton} disabled={disabled} aria-label={`编辑回收计划：${item.title}`} title="编辑回收计划" onClick={() => props.onOpenRecord('foreshadow', item.id)}><StudioIcon name="pen" size={16} /></button>
                {props.onUseForeshadow && <button type="button" className={styles.radarIconButton} disabled={Boolean(aiReason(item))} aria-label={`选入本章 AI 上下文：${item.title}`} title={aiReason(item) ?? '选入本章 AI 上下文'}
                  onClick={() => props.onUseForeshadow?.({ source: 'foreshadow', id: item.id, revision: item.revision })}><StudioIcon name="plus" size={16} /></button>}
              </div></div>
              <p className={styles.radarQuote} aria-label={radarSourceLabel(item)} title={radarSourceLabel(item)}>{item.source?.quote || '尚无登记引文'}</p>
            </th>
            <td><p>{plannedPayoffLabel(item.plannedPayoff, book)}</p>{item.overdueChapters !== null && <small className={styles.radarOverdue}>已过 {item.overdueChapters} 章</small>}</td>
            <td>{item.actualPayoff.state === 'located' ? <><p>{actualChapterTitle(item)}</p><small>已登记固定段落</small></> : <span className={styles.radarUnknown}>尚未登记</span>}</td>
            <td><span className={styles.radarStatus} data-due={item.due} data-stage={item.stage}><StudioIcon name={item.due === 'overdue' ? 'warning' : item.stage === 'resolved' ? 'check' : item.stage === 'abandoned' ? 'close' : item.due === 'due' ? 'clock' : 'orbit'} size={18} />
              {item.due === 'closed' ? stageLabels[item.stage] : item.due === 'overdue' ? '逾期' : item.due === 'unplaced' ? '待定位' : item.due === 'unconfirmed' ? '待复核' : item.due === 'due' ? '本次到期' : stageLabels[item.stage]}</span></td>
          </tr>)}</tbody></table></div>
        {!page.items.length && <div className={styles.radarEmpty}><StudioIcon name="timeline" size={36} /><p>当前范围没有伏笔</p><button type="button" className={shared.primaryButton} disabled={disabled || Boolean(book.book.archivedAt)} title={book.book.archivedAt ? '作品已归档，不能新建伏笔' : '登记伏笔计划'} onClick={() => props.onOpenRecord('foreshadow')}>登记伏笔计划</button></div>}
        <div className={styles.paging}><button type="button" className={shared.button} disabled={disabled || page.offset === 0} onClick={() => change({ offset: Math.max(0, page.offset - FORESHADOW_RADAR_PAGE) }, true)}>上一页</button><span>{page.items.length ? `${page.offset + 1}–${page.offset + page.items.length} / ${page.total}` : `本页 0 条 / ${page.total}`}</span><button type="button" className={shared.button} disabled={disabled || page.nextOffset === null} onClick={() => change({ offset: page.nextOffset! }, true)}>下一页</button></div>
        <aside className={styles.radarReminder} aria-label="本章伏笔提醒"><StudioIcon name="warning" size={28} /><div><strong>本章提醒</strong><p>{currentChapter ? `第 ${currentChapter.position + 1} 章有 ${page.counts.due} 条到期，${page.counts.overdue} 条逾期` : '尚未指定核对进度'}</p></div>
          <button type="button" className={styles.radarJump} disabled={disabled || !currentChapter || page.counts.due + page.counts.overdue === 0}
            title={!currentChapter ? '请先选择核对进度' : page.counts.due + page.counts.overdue === 0 ? '当前筛选范围没有到期或逾期伏笔' : '定位当前筛选范围的首条到期或逾期伏笔'}
            onClick={(event) => jumpToDue(event.currentTarget)}>跳转<StudioIcon name="chevron" /></button></aside>
        <details className={styles.radarNotes}><summary>核对口径 · 待定位 {page.counts.unplaced} · 待复核 {page.counts.unconfirmed}</summary><p className={styles.help}>到期比较使用所选章的叙述顺序；卷目标在本卷提醒，进入后卷才标逾期。纯文字范围不猜测到期，计划不作为实际回收证据。提醒计数限当前查询范围；左图只显示本页。</p></details>
      </div>
      </div>
      {selectedItem && <div ref={evidence} id={evidenceId} className={styles.radarEvidence} tabIndex={-1} role="region" aria-label={`${selectedItem.title}的历程与原文证据`}
        onKeyDown={(event) => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); closeEvidence() } }}>
        <div className={styles.radarEvidenceHeading}><h3>历程与原文证据</h3><button type="button" className={styles.radarIconButton} aria-label="收起伏笔证据" title="收起伏笔证据" onClick={closeEvidence}><StudioIcon name="close" size={20} /></button></div>
        <RecordEvidence key={selectedItem.id} {...props} id={selectedItem.id} expected={{ knowledgeRevision: page.knowledgeRevision, recordRevision: selectedItem.revision }} />
      </div>}
    </>}
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
