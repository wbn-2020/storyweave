import { useEffect, useId, useRef, useState } from 'react'
import type { BookSnapshot, ChapterSnapshot, StudioApi } from '../../contracts/api'
import { AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES, type KnowledgeItemDetail, type KnowledgeSourceInput } from '../../contracts/knowledge'
import { COGNITION_ATTITUDES, COGNITION_CHANGES, MAX_FORESHADOW_MILESTONES, MAX_STORY_LINKS, plannedPayoffText, type CognitionChangeKind, type CognitionFields, type Disclosure, type EventFields, type ForeshadowMilestone, type PlannedPayoff, type StoryKind, type StoryRecordFields, type StoryTime } from '../../contracts/story'
import type { ManuscriptBlock } from '../../contracts/manuscript'
import { request } from '../request'
import shared from '../StellarShared.module.css'
import styles from './StellarStory.module.css'

export const storyKindLabels: Record<StoryKind, string> = { relation: '实体关系', event: '事件时间线', foreshadow: '伏笔', cognition: '人物认知' }
export const stageLabels = { planned: '计划', planted: '已埋设', advanced: '推进', revealed: '已揭示', resolved: '已回收', abandoned: '放弃' }
const attitudeLabels = { knows: '知道', believes: '相信', misunderstands: '误解', suspects: '怀疑' }
export const cognitionChangeLabels = { formed: '形成', revised: '修正', refuted: '推翻', concealed: '隐瞒变化', forgotten: '遗忘' }
const natureLabels = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
const decisionLabels = { unreviewed: '未处理', adopted: '已采纳', rejected: '已否决', review_later: '要求复核' }
const freshnessLabels = { current: '当前', affected: '受影响', updating: '更新中', failed: '更新失败' }
const conflictLabels = { unchecked: '未检查', clear: '未发现已知冲突', candidate: '候选冲突', explained: '作者已解释' }
type ReadingChange = (id: string, reading: boolean) => void

export function initialStoryFields(kind: StoryKind): StoryRecordFields {
  const common = { title: '', description: '', nature: 'author_setting' as const, authorDecision: 'unreviewed' as const, freshness: 'current' as const, conflictState: 'unchecked' as const, disclosure: { state: 'unknown' as const } }
  if (kind === 'relation') return { ...common, kind, fromEntityId: '', toEntityId: '', relationType: '', direction: 'directed', validFrom: { kind: 'unknown' }, validUntil: { kind: 'unknown' }, startEventId: null, endEventId: null }
  if (kind === 'event') return { ...common, kind, storyTime: { kind: 'unknown' }, participantIds: [], mentionedEntityIds: [], stateChanges: [] }
  if (kind === 'foreshadow') return { ...common, kind, nature: 'future_plan', storyTime: { kind: 'unknown' }, stage: 'planned', entityIds: [], eventIds: [], milestones: [], plannedPayoff: { state: 'unknown' }, actualPayoff: { state: 'undisclosed' } }
  return { ...common, kind, nature: 'character_belief', storyTime: { kind: 'unknown' }, personId: '', attitude: 'knows', concealed: false, acquisitionEventId: null,
    evolution: { kind: 'formed', previousId: null, validUntil: { kind: 'unknown' } } }
}

export function blockText(block: ManuscriptBlock): string {
  return block.type === 'horizontalRule' ? '' : (block.content ?? []).map((node) => node.type === 'hardBreak' ? '\n' : node.text).join('')
}

export function timeLabel(value: StoryTime): string {
  return value.kind === 'unknown' ? '故事时间未知' : `${value.label || '时间标签待填'}${value.order === null ? ' · 未指定排序' : ` · 顺序 ${value.order}`}`
}

export function disclosureLabel(value: Disclosure, book: BookSnapshot): string {
  if (value.state !== 'located') return value.state === 'unknown' ? '披露位置未知' : '尚未披露'
  const chapter = book.chapters.find((item) => item.id === value.chapterId)
  return `${chapter ? `第 ${chapter.position + 1} 章 · ${chapter.title}` : `章节 ${value.chapterId}`} · 固定段落 ${value.blockId}`
}

export function plannedPayoffLabel(value: PlannedPayoff, book: BookSnapshot): string {
  if (value.state === 'unknown' || value.state === 'undisclosed') return '计划范围尚未决定'
  if (value.state === 'located') return disclosureLabel(value, book)
  if (value.state === 'volume' && value.volumeId) {
    const volume = book.volumes.find((item) => item.id === value.volumeId)
    return `${plannedPayoffText(value)}${volume ? ` · 关联 ${volume.title}` : ' · 原关联卷已不可用'}`
  }
  if ((value.state === 'chapter' || value.state === 'scene') && value.chapterId) {
    const chapter = book.chapters.find((item) => item.id === value.chapterId)
    return `${plannedPayoffText(value)}${chapter ? ` · 第 ${chapter.position + 1} 章 ${chapter.title}` : ' · 原关联章已不可用'}`
  }
  return plannedPayoffText(value)
}

interface PlannedPayoffEditorProps {
  value: PlannedPayoff; api: StudioApi; book: BookSnapshot; disabled: boolean
  onChange: (value: PlannedPayoff) => void; onReadingChange: ReadingChange
  scenes?: { id: string; title: string; chapterId: string | null }[]
}

function PlannedPayoffEditor({ value, api, book, disabled, onChange, onReadingChange, scenes = [] }: PlannedPayoffEditorProps) {
  const [availableScenes, setAvailableScenes] = useState(scenes)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ticket = useRef(0)
  const key = useId()
  const latest = useRef(onReadingChange)
  latest.current = onReadingChange
  useEffect(() => () => { ticket.current += 1; latest.current(key, false) }, [key])
  async function loadScenes() {
    if (disabled || loading) return
    const currentTicket = ++ticket.current
    setLoading(true); setError(null); onReadingChange(key, true)
    const result = await request(() => api.getWorkbench({ bookId: book.book.id }))
    if (currentTicket !== ticket.current) return
    setLoading(false); latest.current(key, false)
    if (!result.ok) { setError(result.error.message); return }
    if (result.data.bookId !== book.book.id) { setError('场景列表的作品身份不符。'); return }
    if (result.data.requiresUpgrade) { setError('本书需先在创作工具中备份升级，才能读取场景卡；仍可填写场景计划名称。'); return }
    setAvailableScenes(result.data.scenes.filter((scene) => !scene.archived))
  }
  const choice = value.state === 'undisclosed' ? 'unknown' : value.state
  function selectScope(state: PlannedPayoff['state']) {
    const label = 'label' in value ? value.label : ''
    if (state === 'volume') onChange({ state, volumeId: null, label })
    else if (state === 'chapter') onChange({ state, chapterId: null, label })
    else if (state === 'scene') onChange({ state, sceneId: null, chapterId: null, label })
    else if (state === 'text') onChange({ state, label })
    else if (state === 'unknown') onChange({ state })
    else if (state === 'located') onChange({ state, chapterId: '', revisionId: '', blockId: '' })
  }
  return <fieldset><legend>计划回收范围</legend><div className={styles.stack}>
    <label>计划目标<select value={choice} disabled={disabled} onChange={(event) => selectScope(event.target.value as PlannedPayoff['state'])}>
      <option value="unknown">尚未决定</option><option value="volume">某一卷</option><option value="chapter">某一章</option><option value="scene">某个场景</option><option value="text">文字描述范围</option><option value="located">已有固定正文位置</option>
    </select></label>
    {'label' in value && <label>范围说明<input value={value.label} maxLength={500} disabled={disabled} onChange={(event) => onChange({ ...value, label: event.target.value })} placeholder={value.state === 'volume' ? '例如：尚未建立的第三卷末尾' : value.state === 'scene' ? '例如：主角第二次进入旧宅的场景' : '例如：终局前两章，身份揭晓之后'} /></label>}
    {value.state === 'volume' && <label>关联已有卷（可不选）<select disabled={disabled} value={value.volumeId ?? ''} onChange={(event) => { const volume = book.volumes.find((item) => item.id === event.target.value); onChange({ state: 'volume', volumeId: volume?.id ?? null, label: value.label || volume?.title || '' }) }}><option value="">只保存计划名称</option>{book.volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}</select></label>}
    {(value.state === 'chapter' || value.state === 'scene') && <label>关联已有章节（可不选）<select disabled={disabled} value={value.chapterId ?? ''} onChange={(event) => { const chapter = book.chapters.find((item) => item.id === event.target.value); onChange(value.state === 'chapter' ? { state: 'chapter', chapterId: chapter?.id ?? null, label: value.label || chapter?.title || '' } : { ...value, chapterId: chapter?.id ?? null, sceneId: null, label: value.label || chapter?.title || '' }) }}><option value="">尚未建章 / 暂不关联</option>{book.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.position + 1} 章 · {chapter.title}</option>)}</select></label>}
    {(value.state === 'chapter' && !value.chapterId || value.state === 'volume' && !value.volumeId) && <label>未建{value.state === 'volume' ? '卷' : '章'}的计划序号（可空）<input type="number" min="1" max="200000" step="1" disabled={disabled} value={value.targetNumber ?? ''} onChange={(event) => {
      const { targetNumber: _number, ...base } = value
      onChange(event.target.value === '' ? base : { ...base, targetNumber: Number(event.target.value) })
    }} /><span className={styles.help}>从 1 开始；用于按当前卷章顺序提醒。留空的文字计划保持“范围待定位”，不会猜测到期时间。</span></label>}
    {value.state === 'scene' && <><button type="button" className={shared.button} disabled={disabled || loading} onClick={() => void loadScenes()}>{loading ? '正在读取场景…' : '读取 / 刷新场景卡'}</button><label>关联已有场景卡（可不选）<select disabled={disabled || loading} value={value.sceneId ?? ''} onChange={(event) => { const scene = availableScenes.find((item) => item.id === event.target.value); onChange({ ...value, sceneId: scene?.id ?? null, chapterId: scene ? scene.chapterId : value.chapterId, label: value.label || scene?.title || '' }) }}><option value="">只保存场景计划名称</option>{value.sceneId && !availableScenes.some((scene) => scene.id === value.sceneId) && <option value={value.sceneId}>已关联场景 {value.sceneId}</option>}{availableScenes.filter((scene) => !value.chapterId || scene.chapterId === value.chapterId).map((scene) => <option key={scene.id} value={scene.id}>{scene.title}</option>)}</select></label>{error && <p className={styles.error} role="alert">{error}</p>}</>}
    {value.state === 'located' && <DisclosureEditor label="已有计划位置" value={value} api={api} book={book} disabled={disabled} onReadingChange={onReadingChange} onChange={onChange} />}
    <p className={styles.help}>计划可先于卷、章和正文建立。实际回收另行选择固定版本与段落；计划位置不表示事情已经发生，也不推导故事时间。</p>
  </div></fieldset>
}

function ChapterAbsenceEditor({ value, api, book, disabled, onChange, onReadingChange, names }: {
  value: NonNullable<EventFields['appearanceCheck']>; api: StudioApi; book: BookSnapshot; disabled: boolean
  onChange: (value: NonNullable<EventFields['appearanceCheck']>) => void; onReadingChange: ReadingChange; names: Record<string, string>
}) {
  const [chapter, setChapter] = useState<ChapterSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useId(), ticket = useRef(0)
  const latest = useRef(onReadingChange)
  latest.current = onReadingChange
  useEffect(() => () => { ticket.current += 1; latest.current(key, false) }, [key])
  async function readChapter(chapterId: string) {
    if (disabled || loading || !chapterId) return
    const current = ++ticket.current
    setLoading(true); setError(null); setChapter(null); onReadingChange(key, true)
    const result = await request(() => api.readChapter({ bookId: book.book.id, chapterId }))
    if (current !== ticket.current) return
    setLoading(false); latest.current(key, false)
    if (!result.ok) { setError(result.error.message); return }
    if (result.data.bookId !== book.book.id || result.data.id !== chapterId) { setError('整章核对的作品或章节身份不符。'); return }
    // 读取另一章或新稿只供核对；明确确认前，旧缺席名单仍绑定原修订。
    setChapter(result.data)
  }
  const pendingRevision = chapter !== null && (chapter.id !== value.chapterId || chapter.revisionId !== value.revisionId)
  return <fieldset><legend>整章缺席核对</legend><div className={styles.stack}>
    <p className={styles.help}>仅在核对整章后填写；某场事件没有参与某实体，不足以证明整章缺席。此核对随固定正文版本保存，改稿后不再算作当前缺席。</p>
    <label>读取需要核对的章节<select value={chapter?.id ?? value.chapterId} disabled={disabled || loading} onChange={(event) => void readChapter(event.target.value)}><option value="">选择章节</option>{book.chapters.map((item) => <option key={item.id} value={item.id}>第 {item.position + 1} 章 · {item.title}</option>)}</select></label>
    {value.revisionId && <p className={styles.help}>固定正文版本 {value.revisionId} <button type="button" className={shared.button} disabled={disabled || loading} onClick={() => void readChapter(value.chapterId)}>重新读取核对稿</button></p>}
    {chapter && <details><summary>核对整章已保存原文 · {chapter.characterCount} 字</summary><div className={styles.blockPreview}>{chapter.document.content.map((block) => block.type === 'horizontalRule' ? <hr key={block.attrs.id} /> : <p key={block.attrs.id}>{blockText(block)}</p>)}</div></details>}
    {pendingRevision && <div><p className={styles.help}>刚读取的章节或稿件与当前核对不同。当前缺席名单和说明仍属于原版本；核对全文后，明确确认是否沿用。</p><button type="button" className={shared.button} disabled={disabled || loading} onClick={() => {
      if (chapter) onChange({ ...value, chapterId: chapter.id, revisionId: chapter.revisionId })
    }}>{value.absentEntityIds.length ? '已核对全文，确认缺席名单与说明适用于此稿' : '已核对全文，使用此稿登记缺席'}</button>
      {(value.absentEntityIds.length > 0 || value.note) && <button type="button" className={shared.button} disabled={disabled || loading} onClick={() => {
        if (chapter) onChange({ chapterId: chapter.id, revisionId: chapter.revisionId, absentEntityIds: [], note: '' })
      }}>以此稿重新登记（清空本次名单与说明）</button>}</div>}
    <ReferencePicker label="我已核对以上固定整章，明确缺席且未被提及的实体" api={api} bookId={book.book.id} value={value.absentEntityIds} names={names} disabled={disabled || loading || pendingRevision || !value.revisionId} onChange={(absentEntityIds) => onChange({ ...value, absentEntityIds })} />
    <label>整章核对说明<textarea rows={2} maxLength={2000} disabled={disabled || loading || pendingRevision} value={value.note} onChange={(event) => onChange({ ...value, note: event.target.value })} placeholder="记录核对范围、易混淆的别名和明确缺席的判断。作者采纳本记录后才显示在矩阵。" /></label>
    {loading && <p role="status">正在读取整章核对稿…</p>}{error && <p className={styles.error} role="alert">{error}</p>}
  </div></fieldset>
}

export function TimeEditor({ label, value, disabled, onChange }: { label: string; value: StoryTime; disabled: boolean; onChange: (value: StoryTime) => void }) {
  return <fieldset><legend>{label}</legend><div className={styles.time}>
    <label>时间表达<select value={value.kind} disabled={disabled} onChange={(event) => { const kind = event.target.value as StoryTime['kind']; onChange(kind === 'unknown' ? { kind } : { kind, label: value.kind === 'unknown' ? '' : value.label, order: value.kind === 'unknown' ? null : value.order }) }}><option value="unknown">未知</option><option value="date">日期标签</option><option value="relative">相对时间</option></select></label>
    {value.kind !== 'unknown' && <><label>时间标签<input value={value.label} maxLength={200} disabled={disabled} onChange={(event) => onChange({ ...value, label: event.target.value })} placeholder={value.kind === 'date' ? '如：景历三年冬月' : '如：抵达王城三日前'} /></label><label>明确排序值（可空，支持负数）<input type="number" step="1" min="-1000000000" max="1000000000" value={value.order ?? ''} disabled={disabled} onChange={(event) => onChange({ ...value, order: event.target.value === '' ? null : Number(event.target.value) })} /></label></>}
  </div><p className={styles.help}>排序由作者明确指定；日期文字、相对标签和章节顺序不会自动换算成故事先后。</p></fieldset>
}

export function DisclosureEditor({ label, value, api, book, disabled, onChange, onReadingChange }: { label: string; value: Disclosure; api: StudioApi; book: BookSnapshot; disabled: boolean; onChange: (value: Disclosure) => void; onReadingChange: ReadingChange }) {
  const [chapter, setChapter] = useState<ChapterSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ticket = useRef(0)
  const key = useId()
  const latest = useRef({ onChange, onReadingChange, value })
  latest.current = { onChange, onReadingChange, value }
  useEffect(() => () => { ticket.current += 1; latest.current.onReadingChange(key, false) }, [key])
  async function chooseChapter(id: string) {
    if (disabled || loading) return
    setChapter(null); setError(null)
    const currentTicket = ++ticket.current
    onChange({ state: 'located', chapterId: id, revisionId: '', blockId: '' })
    if (!id) return
    setLoading(true); onReadingChange(key, true)
    const result = await request(() => api.readChapter({ bookId: book.book.id, chapterId: id }))
    if (currentTicket !== ticket.current) return
    setLoading(false); latest.current.onReadingChange(key, false)
    if (result.ok && result.data.bookId === book.book.id && result.data.id === id) {
      setChapter(result.data)
      // 异步读取结束后使用最新回调，避免覆盖同一表单中随后填写的其他字段。
      if (latest.current.value.state === 'located' && latest.current.value.chapterId === id) latest.current.onChange({ state: 'located', chapterId: id, revisionId: result.data.revisionId, blockId: '' })
    } else setError(result.ok ? '所读取章节的身份不符，请重新选择。' : result.error.message)
  }
  const selectedBlock = value.state === 'located' ? chapter?.document.content.find((block) => block.attrs.id === value.blockId) : undefined
  return <fieldset><legend>{label}</legend><div className={styles.stack}>
    <label>披露状态<select value={value.state} disabled={disabled || loading} onChange={(event) => { setChapter(null); setError(null); const state = event.target.value as Disclosure['state']; onChange(state === 'located' ? { state, chapterId: '', revisionId: '', blockId: '' } : { state }) }}><option value="unknown">位置未知</option><option value="undisclosed">尚未披露</option><option value="located">明确章节与段落</option></select></label>
    {value.state === 'located' && <><p className={styles.help}>{disclosureLabel(value, book)}{value.revisionId && <>；固定版本 {value.revisionId}</>}</p><label>选择章节（读取已保存的当前稿）<select value={chapter?.id ?? ''} disabled={disabled || loading} onChange={(event) => void chooseChapter(event.target.value)}><option value="">选择或重新选择章节</option>{book.chapters.map((item) => <option key={item.id} value={item.id}>第 {item.position + 1} 章 · {item.title}</option>)}</select></label>{chapter && <label>固定段落<select value={value.blockId} disabled={disabled || loading} onChange={(event) => onChange({ state: 'located', chapterId: chapter.id, revisionId: chapter.revisionId, blockId: event.target.value })}><option value="">选择段落</option>{chapter.document.content.map((block, index) => <option key={block.attrs.id} value={block.attrs.id}>段落 {index + 1} · {blockText(block).slice(0, 65) || '分场线 / 空段落'}</option>)}</select></label>}{selectedBlock && <blockquote className={styles.blockPreview}>{blockText(selectedBlock) || '分场线 / 空段落'}</blockquote>}</>}
    {loading && <p className={styles.help} role="status">正在读取固定版本…</p>}{error && <p className={styles.error} role="alert">{error}</p>}
  </div></fieldset>
}

export function SourceEditor({ value, api, book, disabled, onChange, onReadingChange }: { value: KnowledgeSourceInput | undefined; api: StudioApi; book: BookSnapshot; disabled: boolean; onChange: (value: KnowledgeSourceInput | undefined) => void; onReadingChange: ReadingChange }) {
  const location: Disclosure = value?.sourceType === 'chapter_text' ? { state: 'located', chapterId: value.chapterId, revisionId: value.revisionId, blockId: value.blockId } : { state: 'unknown' }
  return <fieldset><legend>追加来源（原来源保留）</legend><div className={styles.stack}><label>来源类型<select value={value?.sourceType ?? ''} disabled={disabled} onChange={(event) => { const type = event.target.value as KnowledgeSourceInput['sourceType'] | ''; onChange(!type ? undefined : type === 'chapter_text' ? { sourceType: type, bookId: book.book.id, chapterId: '', revisionId: '', blockId: '', quote: '' } : { sourceType: type, bookId: book.book.id, quote: '' }) }}><option value="">暂不追加</option><option value="author_input">作者输入</option><option value="external">外部资料说明</option><option value="chapter_text">本书正文引文</option></select></label>
    {value?.sourceType === 'chapter_text' && <DisclosureEditor label="固定正文出处" value={location} api={api} book={book} disabled={disabled} onReadingChange={onReadingChange} onChange={(next) => onChange({ ...value, chapterId: next.state === 'located' ? next.chapterId : '', revisionId: next.state === 'located' ? next.revisionId : '', blockId: next.state === 'located' ? next.blockId : '' })} />}
    {value && <label>{value.sourceType === 'chapter_text' ? '连续原文引文（保留原始空白）' : '来源说明'}<textarea rows={3} maxLength={2000} value={value.quote} disabled={disabled} onChange={(event) => onChange({ ...value, quote: event.target.value })} /></label>}
    {value?.sourceType === 'chapter_text' && <p className={styles.help}>引文必须是该固定段落中连续的原文，保存时会核对。补充同章较新稿的引文，会推进本条对该章的索引复核基线，请先核对内容；历史来源仍保留。</p>}
  </div></fieldset>
}

interface PickerProps { label: string; api: StudioApi; bookId: string; value: string[]; onChange: (value: string[]) => void; disabled: boolean; names: Record<string, string>; type?: 'entity' | 'event' | 'person'; single?: boolean; maximum?: number }
export function ReferencePicker({ label, api, bookId, value, onChange, disabled, names, type = 'entity', single = false, maximum = MAX_STORY_LINKS }: PickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [items, setItems] = useState<{ id: string; label: string }[]>([])
  const [known, setKnown] = useState<Record<string, string>>({})
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open || disabled) return
    let active = true
    setLoading(true); setItems([]); setError(null)
    async function load() {
      if (type === 'event') {
        const result = await request(() => api.listStoryRecords({ bookId, kind: 'event', search, offset, limit: 20 }))
        if (!active) return
        setLoading(false)
        if (!result.ok) { setError(result.error.message); return }
        if (result.data.bookId !== bookId) { setError('关联事件列表身份不符。'); return }
        const list = result.data.items.map((item) => ({ id: item.id, label: item.title }))
        setItems(list); setKnown((current) => ({ ...current, ...Object.fromEntries(list.map((item) => [item.id, item.label])) })); setTotal(result.data.total); setNext(result.data.nextOffset)
      } else {
        const result = await request(() => api.listKnowledgeItems({ bookId, ...(type === 'person' ? { kind: 'person' as const } : {}), search, offset, limit: 20 }))
        if (!active) return
        setLoading(false)
        if (!result.ok) { setError(result.error.message); return }
        if (result.data.bookId !== bookId) { setError('关联实体列表身份不符。'); return }
        const list = result.data.items.map((item) => ({ id: item.id, label: item.name }))
        setItems(list); setKnown((current) => ({ ...current, ...Object.fromEntries(list.map((item) => [item.id, item.label])) })); setTotal(result.data.total); setNext(result.data.nextOffset)
      }
    }
    void load()
    return () => { active = false }
  }, [api, bookId, disabled, offset, open, refresh, search, type])
  function toggle(id: string) { if (!disabled) onChange(value.includes(id) ? value.filter((item) => item !== id) : single ? [id] : value.length < maximum ? [...value, id] : value) }
  function searchReferences() {
    if (disabled || loading) return
    setSearch(query); setOffset(0); setRefresh((number) => number + 1)
  }
  return <fieldset className={styles.picker}><legend>{label}</legend><div className={styles.selected}>{value.length ? value.map((id) => <button key={id} type="button" disabled={disabled} title={`取消关联：${id}`} onClick={() => toggle(id)}>{names[id] ?? known[id] ?? `条目 ${id.slice(0, 8)}`} ×</button>) : <span className={styles.help}>尚未关联</span>}</div>
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{single ? '选择 / 更换关联' : '查找并追加关联'}</summary><div className={styles.pickerSearch}><label>搜索本书{type === 'event' ? '事件' : type === 'person' ? '人物' : '知识实体'}<input value={query} maxLength={200} disabled={disabled} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); searchReferences() } }} /></label><button type="button" className={shared.button} disabled={disabled || loading} onClick={searchReferences}>搜索</button></div>
      {loading && <p className={styles.help} role="status">正在读取关联候选…</p>}{error && <p className={styles.error} role="alert">{error}</p>}
      <ul className={styles.pickerResults}>{items.map((item) => <li key={item.id}><button type="button" disabled={disabled || (!single && value.length >= maximum && !value.includes(item.id))} aria-pressed={value.includes(item.id)} onClick={() => toggle(item.id)}>{item.label}<small>{value.includes(item.id) ? '已关联' : '选择关联'} · {item.id.slice(0, 8)}</small></button></li>)}</ul>
      {!loading && !error && items.length === 0 && <p className={styles.help}>没有匹配项；可先在本书知识库建立实体，或在事件页建立事件。</p>}
      <div className={styles.paging}><button type="button" className={shared.button} disabled={disabled || loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>共 {total} 项</span><button type="button" className={shared.button} disabled={disabled || loading || next === null} onClick={() => { if (next !== null) setOffset(next) }}>下一页</button></div>
    </details>
  </fieldset>
}

function KnowledgeCognitionImport({ fields, onChange, api, book, disabled, names, onReadingChange }: {
  fields: CognitionFields; onChange: (fields: CognitionFields) => void; api: StudioApi; book: BookSnapshot
  disabled: boolean; names: Record<string, string>; onReadingChange: ReadingChange
}) {
  const [selectedId, setSelectedId] = useState('')
  const [preview, setPreview] = useState<KnowledgeItemDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ticket = useRef(0)
  const key = useId()
  const latest = useRef(onReadingChange)
  latest.current = onReadingChange
  useEffect(() => () => { ticket.current += 1; latest.current(key, false) }, [key])
  async function readOrigin() {
    if (disabled || loading || !selectedId) return
    const id = selectedId
    const currentTicket = ++ticket.current
    setLoading(true); setPreview(null); setError(null); onReadingChange(key, true)
    const result = await request(() => api.getKnowledgeItem({ bookId: book.book.id, id }))
    if (currentTicket !== ticket.current) return
    setLoading(false); latest.current(key, false)
    if (!result.ok) { setError(result.error.message); return }
    const revision = result.data.revisions[0]
    if (result.data.bookId !== book.book.id || result.data.id !== id || !revision || revision.itemId !== id || revision.fields.summary !== result.data.summary) {
      setError('知识条目身份或固定修订不符，请重新读取。'); return
    }
    setPreview(result.data)
  }
  function useOrigin() {
    const revision = preview?.revisions[0]
    if (disabled || !preview || !revision || !fields.evolution) return
    onChange({ ...fields, title: fields.title || preview.name, description: revision.fields.summary, nature: 'character_belief',
      authorDecision: 'unreviewed', conflictState: 'unchecked',
      evolution: { ...fields.evolution, knowledgeOrigin: { itemId: preview.id, revisionId: revision.id } } })
    setPreview(null)
  }
  return <fieldset><legend>从普通知识建立人物认知（可选）</legend><div className={styles.stack}>
    <ReferencePicker label="选择本书知识条目" api={api} bookId={book.book.id} value={selectedId ? [selectedId] : []} single names={names} disabled={disabled || loading} onChange={(ids) => { setSelectedId(ids[0] ?? ''); setPreview(null); setError(null) }} />
    <button type="button" className={shared.button} disabled={disabled || loading || !selectedId} onClick={() => void readOrigin()}>{loading ? '正在读取…' : '读取固定知识版本'}</button>
    {preview && <><strong>{preview.name}</strong><blockquote className={styles.blockPreview}>{preview.revisions[0]?.fields.summary || '该知识条目没有说明。'}</blockquote><button type="button" className={shared.button} disabled={disabled} onClick={useOrigin}>用此说明填写认知（替换本次草稿内容）</button></>}
    {fields.evolution?.knowledgeOrigin && <p className={styles.help}>已关联知识 {fields.evolution.knowledgeOrigin.itemId} · 固定版本 {fields.evolution.knowledgeOrigin.revisionId}</p>}
    <p className={styles.help}>转换后须明确选择人物、获知时间和态度，并审阅改写内容。知识出处不等于人物已经获知；原知识条目保持其原有性质。</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div></fieldset>
}

interface EditorProps {
  fields: StoryRecordFields; onChange: (value: StoryRecordFields) => void; api: StudioApi; book: BookSnapshot
  disabled: boolean; names: Record<string, string>; savedMilestones: number; onReadingChange: ReadingChange
  savedCognition?: CognitionFields; previousCognition?: CognitionFields
  scenes?: PlannedPayoffEditorProps['scenes']
}
export function StoryFieldsEditor({ fields, onChange, api, book, disabled, names, savedMilestones, onReadingChange, savedCognition, previousCognition, scenes }: EditorProps) {
  const relationTypesId = useId()
  const picker = { api, bookId: book.book.id, disabled, names }
  const location = { api, book, disabled, onReadingChange }
  const cognitionLocked = fields.kind === 'cognition' && Boolean(savedCognition)
  const cognitionContentLocked = cognitionLocked || fields.kind === 'cognition' && fields.evolution?.kind === 'concealed'
  function addMilestone() {
    if (fields.kind !== 'foreshadow' || disabled || fields.milestones.length >= MAX_FORESHADOW_MILESTONES || fields.stage === 'resolved' || fields.stage === 'abandoned') return
    const milestone: ForeshadowMilestone = { id: crypto.randomUUID(), stage: fields.milestones.length ? 'advanced' : 'planted', note: '', storyTime: { kind: 'unknown' }, disclosure: { state: 'unknown' } }
    onChange({ ...fields, stage: milestone.stage, milestones: [...fields.milestones, milestone] })
  }
  function updateMilestone(index: number, next: ForeshadowMilestone) {
    if (fields.kind !== 'foreshadow' || index < savedMilestones) return
    const milestones = fields.milestones.map((item, itemIndex) => itemIndex === index ? next : item)
    onChange({ ...fields, stage: milestones[milestones.length - 1]?.stage ?? 'planned', milestones })
  }
  return <>
    {cognitionLocked && <p className={styles.help}>本状态已保存，内容固定。可补充来源、更新采用与复核标记；人物在故事中改变认识时，请返回详情使用“记录认知变化”。</p>}
    <label>记录名称<input value={fields.title} maxLength={120} disabled={disabled || cognitionLocked} required onChange={(event) => onChange({ ...fields, title: event.target.value })} autoFocus /></label>
    <label>{fields.kind === 'cognition' ? '人物所知、所信或误解的具体内容（推翻 / 遗忘时填写变化说明）' : '内容、条件与适用范围'}<textarea rows={5} value={fields.description} maxLength={20000} disabled={disabled || cognitionContentLocked} onChange={(event) => onChange({ ...fields, description: event.target.value })} /></label>
    {fields.kind === 'cognition' && !cognitionContentLocked && <KnowledgeCognitionImport fields={fields} onChange={onChange} api={api} book={book} disabled={disabled} names={names} onReadingChange={onReadingChange} />}
    {fields.kind === 'relation' && <>
      <ReferencePicker {...picker} label="关系起点" single value={fields.fromEntityId ? [fields.fromEntityId] : []} onChange={(value) => onChange({ ...fields, fromEntityId: value[0] ?? '' })} />
      <ReferencePicker {...picker} label="关系终点" single value={fields.toEntityId ? [fields.toEntityId] : []} onChange={(value) => onChange({ ...fields, toEntityId: value[0] ?? '' })} />
      <div className={styles.columns}><label>关系类型<input value={fields.relationType} list={relationTypesId} maxLength={120} disabled={disabled} onChange={(event) => onChange({ ...fields, relationType: event.target.value })} placeholder="如：师徒、敌对、航道、领属" /></label>
        <datalist id={relationTypesId}>{['师承', '血亲', '死敌', '同盟', '暗恋', '挚友', '航道', '领属'].map((type) => <option key={type} value={type} />)}</datalist>
        <label>方向<select value={fields.direction} disabled={disabled} onChange={(event) => onChange({ ...fields, direction: event.target.value as 'directed' | 'mutual' })}><option value="directed">起点 → 终点</option><option value="mutual">双向关系</option></select></label></div>
      {fields.relationType === '航道' && <p className={styles.help}>航道连接两个地点。选择起点、终点和通行方向，保存后可在世界地图查看。</p>}
      {fields.relationType === '领属' && <p className={styles.help}>领属从地点指向所属势力。明确采用并完成复核后，世界地图才显示该势力的地点范围。</p>}
      <label>关系层次 · 需作品 v17<select value={fields.layer ?? ''} disabled={disabled} onChange={(event) => {
        const { layer: _layer, ...base } = fields
        onChange(event.target.value ? { ...base, layer: event.target.value as 'surface' | 'hidden' } : base)
      }}><option value="">未标注</option><option value="surface">表面关系</option><option value="hidden">隐藏关系</option></select></label>
      <TimeEditor label="关系生效时间" value={fields.validFrom} disabled={disabled} onChange={(value) => onChange({ ...fields, validFrom: value })} /><TimeEditor label="关系结束时间" value={fields.validUntil} disabled={disabled} onChange={(value) => onChange({ ...fields, validUntil: value })} />
      <ReferencePicker {...picker} type="event" label="建立关系的事件（可空）" single value={fields.startEventId ? [fields.startEventId] : []} onChange={(value) => onChange({ ...fields, startEventId: value[0] ?? null })} /><ReferencePicker {...picker} type="event" label="结束关系的事件（可空）" single value={fields.endEventId ? [fields.endEventId] : []} onChange={(value) => onChange({ ...fields, endEventId: value[0] ?? null })} />
    </>}
    {fields.kind !== 'relation' && <TimeEditor label={fields.kind === 'cognition' ? '人物获知 / 本次认知变化的时间' : '故事内时间'} value={fields.storyTime} disabled={disabled || Boolean(savedCognition && savedCognition.storyTime.kind !== 'unknown' && savedCognition.storyTime.order !== null)} onChange={(value) => onChange({ ...fields, storyTime: value })} />}
    {fields.kind === 'event' && <>
      <ReferencePicker {...picker} label="实际参与者" value={fields.participantIds} onChange={(value) => onChange({ ...fields, participantIds: value })} /><ReferencePicker {...picker} label="仅被提及的对象" value={fields.mentionedEntityIds} onChange={(value) => onChange({ ...fields, mentionedEntityIds: value })} /><p className={styles.help}>参与、在场或被提及均不会自动生成知情记录。人物认知需要单独记录。</p>
      {fields.appearanceCheck ? <><ChapterAbsenceEditor {...location} value={fields.appearanceCheck} names={names} onChange={(appearanceCheck) => onChange({ ...fields, appearanceCheck })} /><button type="button" className={shared.button} disabled={disabled} onClick={() => { const { appearanceCheck: _check, ...base } = fields; onChange(base) }}>移除本次整章核对（历史快照保留）</button></> : <button type="button" className={shared.button} disabled={disabled} onClick={() => onChange({ ...fields, appearanceCheck: { chapterId: '', revisionId: '', absentEntityIds: [], note: '' } })}>补充整章缺席核对</button>}
      <fieldset><legend>事件造成的状态变化</legend><div className={styles.stack}>{fields.stateChanges.map((change, index) => <fieldset key={change.id}><legend>状态变化 {index + 1}</legend><div className={styles.stack}><ReferencePicker {...picker} label="变化对象" single value={change.entityId ? [change.entityId] : []} onChange={(value) => onChange({ ...fields, stateChanges: fields.stateChanges.map((item) => item.id === change.id ? { ...item, entityId: value[0] ?? '' } : item) })} /><label>属性<input value={change.attribute} maxLength={120} disabled={disabled} onChange={(event) => onChange({ ...fields, stateChanges: fields.stateChanges.map((item) => item.id === change.id ? { ...item, attribute: event.target.value } : item) })} /></label><div className={styles.columns}><label>变化前<textarea rows={2} value={change.before} maxLength={2000} disabled={disabled} onChange={(event) => onChange({ ...fields, stateChanges: fields.stateChanges.map((item) => item.id === change.id ? { ...item, before: event.target.value } : item) })} /></label><label>变化后<textarea rows={2} value={change.after} maxLength={2000} disabled={disabled} onChange={(event) => onChange({ ...fields, stateChanges: fields.stateChanges.map((item) => item.id === change.id ? { ...item, after: event.target.value } : item) })} /></label></div><button type="button" className={shared.button} disabled={disabled} onClick={() => onChange({ ...fields, stateChanges: fields.stateChanges.filter((item) => item.id !== change.id) })}>移除此变化项</button></div></fieldset>)}<button type="button" className={shared.button} disabled={disabled || fields.stateChanges.length >= MAX_STORY_LINKS} onClick={() => onChange({ ...fields, stateChanges: [...fields.stateChanges, { id: crypto.randomUUID(), entityId: '', attribute: '', before: '', after: '' }] })}>添加状态变化</button></div><p className={styles.help}>每次保存留存不可变快照，修改变化项后仍可在历史中核对旧记录。</p></fieldset>
    </>}
    {fields.kind === 'cognition' && <>
      <ReferencePicker {...picker} disabled={disabled || cognitionLocked || Boolean(fields.evolution?.previousId)} type="person" label="认知主体（人物）" single value={fields.personId ? [fields.personId] : []} onChange={(value) => onChange({ ...fields, personId: value[0] ?? '' })} />
      {fields.evolution && <><label>本次认知变化<select value={fields.evolution.kind} disabled={disabled || cognitionLocked || !fields.evolution.previousId} onChange={(event) => {
        const kind = event.target.value as CognitionChangeKind
        onChange({ ...fields, ...(kind === 'concealed' && previousCognition ? { description: previousCognition.description, attitude: previousCognition.attitude, concealed: !previousCognition.concealed } : {}), evolution: { ...fields.evolution!, kind } })
      }}>{COGNITION_CHANGES.filter((kind) => fields.evolution?.previousId ? kind !== 'formed' : kind === 'formed').map((kind) => <option key={kind} value={kind}>{cognitionChangeLabels[kind]}</option>)}</select></label>
      {fields.evolution.previousId && <p className={styles.help}>前态：{previousCognition?.title ?? fields.evolution.previousId}。保存后，前态在本次变化时点结束；旧内容继续用于此前时点。</p>}
      <TimeEditor label="有效截止（可未知；不含截止时点）" value={fields.evolution.validUntil} disabled={disabled || Boolean(savedCognition?.evolution)} onChange={(value) => onChange({ ...fields, evolution: { ...fields.evolution!, validUntil: value } })} /></>}
      {!fields.evolution && <button type="button" className={shared.button} disabled={disabled} onClick={() => onChange({ ...fields, evolution: { kind: 'formed', previousId: null, validUntil: { kind: 'unknown' } } })}>为此旧记录补充有效期</button>}
      <label>认知态度<select value={fields.attitude} disabled={disabled || cognitionContentLocked} onChange={(event) => onChange({ ...fields, attitude: event.target.value as typeof fields.attitude })}>{COGNITION_ATTITUDES.map((value) => <option key={value} value={value}>{attitudeLabels[value]}</option>)}</select></label><label className={shared.checkLabel}><input type="checkbox" checked={fields.concealed} disabled={disabled || cognitionLocked} onChange={(event) => onChange({ ...fields, concealed: event.target.checked })} />人物正在隐瞒这一认知（独立于是否相信及读者是否知道）</label><ReferencePicker {...picker} disabled={disabled || cognitionLocked} type="event" label="获知 / 形成认知的事件（可空）" single value={fields.acquisitionEventId ? [fields.acquisitionEventId] : []} onChange={(value) => onChange({ ...fields, acquisitionEventId: value[0] ?? null })} />
      {(fields.evolution?.kind === 'refuted' || fields.evolution?.kind === 'forgotten') && <p className={styles.help}>此状态会结束前一认知，并从人物 AI 附加资料中排除。人物形成新的认识时，请在此状态之后继续追加修正。</p>}
    </>}
    {fields.kind === 'foreshadow' && <>
      <ReferencePicker {...picker} label="伏笔关联实体" value={fields.entityIds} onChange={(value) => onChange({ ...fields, entityIds: value })} /><ReferencePicker {...picker} type="event" label="伏笔关联事件" value={fields.eventIds} onChange={(value) => onChange({ ...fields, eventIds: value })} />
      <fieldset><legend>伏笔进展 · {stageLabels[fields.stage]}</legend><p className={styles.help}>按顺序追加埋设、推进、揭示和回收。已保存里程碑保留原内容；揭示与回收分别记录。</p>
        {fields.milestones.map((milestone, index) => <div key={milestone.id} className={styles.milestone}>{index < savedMilestones ? <><strong>{index + 1} · {stageLabels[milestone.stage]}（已保存）</strong><p>{milestone.note}</p><small>{timeLabel(milestone.storyTime)}；{disclosureLabel(milestone.disclosure, book)}</small>{milestone.source && <small>来源：{milestone.source.sourceType === 'chapter_text' ? '固定正文' : milestone.source.sourceType === 'external' ? '外部说明' : '作者输入'} · {milestone.source.quote}</small>}</> : <div className={styles.stack}><strong>新增里程碑 {index + 1}</strong><label>阶段<select value={milestone.stage} disabled={disabled} onChange={(event) => updateMilestone(index, { ...milestone, stage: event.target.value as ForeshadowMilestone['stage'] })}>{(['planted', 'advanced', 'revealed', 'resolved', 'abandoned'] as const).map((value) => <option key={value} value={value}>{stageLabels[value]}</option>)}</select></label><label>本次进展说明<textarea rows={3} value={milestone.note} maxLength={2000} disabled={disabled} onChange={(event) => updateMilestone(index, { ...milestone, note: event.target.value })} /></label><TimeEditor label="里程碑故事时间" value={milestone.storyTime} disabled={disabled} onChange={(value) => updateMilestone(index, { ...milestone, storyTime: value })} /><DisclosureEditor {...location} label="里程碑读者披露位置" value={milestone.disclosure} onChange={(value) => updateMilestone(index, { ...milestone, disclosure: value })} /><SourceEditor {...location} value={milestone.source} onChange={(value) => { const { source: previousSource, ...rest } = milestone; void previousSource; updateMilestone(index, { ...rest, ...(value ? { source: value } : {}) }) }} />{index === fields.milestones.length - 1 && <button type="button" className={shared.button} disabled={disabled} onClick={() => { const milestones = fields.milestones.slice(0, -1); onChange({ ...fields, stage: milestones[milestones.length - 1]?.stage ?? 'planned', milestones }) }}>撤销本条未保存进展</button>}</div>}</div>)}
        <button type="button" className={shared.button} disabled={disabled || fields.milestones.length >= MAX_FORESHADOW_MILESTONES || fields.stage === 'resolved' || fields.stage === 'abandoned'} onClick={addMilestone}>追加伏笔进展</button>
      </fieldset><PlannedPayoffEditor {...location} scenes={scenes} value={fields.plannedPayoff} onChange={(value) => onChange({ ...fields, plannedPayoff: value })} /><DisclosureEditor {...location} label="实际回收证据 · 固定正文版本与段落" value={fields.actualPayoff} onChange={(value) => onChange({ ...fields, actualPayoff: value })} /><p className={styles.help}>新确认回收还需在回收里程碑或追加来源中，登记同一版本、同一段落的逐字引文。计划位置和回收位置分别保存。</p>
    </>}
    <DisclosureEditor {...location} label="读者首次披露位置" value={fields.disclosure} onChange={(value) => onChange({ ...fields, disclosure: value })} />
    <div className={styles.columns}><label>知识性质<select value={fields.nature} disabled={disabled} onChange={(event) => onChange({ ...fields, nature: event.target.value as StoryRecordFields['nature'] })}>{KNOWLEDGE_NATURES.map((value) => <option key={value} value={value}>{natureLabels[value]}</option>)}</select></label><label>作者决定<select value={fields.authorDecision} disabled={disabled} onChange={(event) => onChange({ ...fields, authorDecision: event.target.value as StoryRecordFields['authorDecision'] })}>{AUTHOR_DECISIONS.map((value) => <option key={value} value={value}>{decisionLabels[value]}</option>)}</select></label><label>新鲜度标注<select value={fields.freshness} disabled={disabled} onChange={(event) => onChange({ ...fields, freshness: event.target.value as StoryRecordFields['freshness'] })}>{KNOWLEDGE_FRESHNESS.map((value) => <option key={value} value={value}>{freshnessLabels[value]}</option>)}</select></label><label>冲突标注<select value={fields.conflictState} disabled={disabled} onChange={(event) => onChange({ ...fields, conflictState: event.target.value as StoryRecordFields['conflictState'] })}>{CONFLICT_STATES.map((value) => <option key={value} value={value}>{conflictLabels[value]}</option>)}</select></label></div>
    <p className={styles.help}>以上状态由作者维护；出处可查、作者采纳、内容真伪与自动一致性检查分别表达。</p>
  </>
}

export function StoryFieldsView({ fields, book, names }: { fields: StoryRecordFields; book: BookSnapshot; names: Record<string, string> }) {
  const label = (id: string | null) => id ? names[id] ?? `条目 ${id}` : '未关联'
  const labels = (ids: string[]) => ids.length ? ids.map(label).join('、') : '未关联'
  return <div className={styles.view}><p style={{ whiteSpace: 'pre-wrap' }}>{fields.description || '暂无补充说明。'}</p><dl>
    <dt>知识性质</dt><dd>{natureLabels[fields.nature]}</dd><dt>作者决定</dt><dd>{decisionLabels[fields.authorDecision]}</dd><dt>状态标注</dt><dd>{freshnessLabels[fields.freshness]} · {conflictLabels[fields.conflictState]}</dd><dt>读者披露</dt><dd>{disclosureLabel(fields.disclosure, book)}{fields.disclosure.state === 'located' && <small>固定版本 {fields.disclosure.revisionId}</small>}</dd>
    {fields.kind === 'relation' && <><dt>关系两端</dt><dd>{label(fields.fromEntityId)} {fields.direction === 'directed' ? '→' : '↔'} {label(fields.toEntityId)}</dd><dt>关系类型</dt><dd>{fields.relationType}</dd><dt>关系层次</dt><dd>{fields.layer === 'hidden' ? '隐藏关系' : fields.layer === 'surface' ? '表面关系' : '未标注'}</dd><dt>生效时间</dt><dd>{timeLabel(fields.validFrom)}</dd><dt>结束时间</dt><dd>{timeLabel(fields.validUntil)}</dd><dt>建立事件</dt><dd>{label(fields.startEventId)}</dd><dt>结束事件</dt><dd>{label(fields.endEventId)}</dd></>}
    {fields.kind !== 'relation' && <><dt>{fields.kind === 'cognition' ? '获知时间' : '故事时间'}</dt><dd>{timeLabel(fields.storyTime)}</dd></>}
    {fields.kind === 'event' && <><dt>实际参与</dt><dd>{labels(fields.participantIds)}</dd><dt>被提及对象</dt><dd>{labels(fields.mentionedEntityIds)}</dd>{fields.appearanceCheck && <><dt>作者整章核对</dt><dd>章节 {fields.appearanceCheck.chapterId}<small>固定版本 {fields.appearanceCheck.revisionId}；仅适用于该稿</small></dd><dt>明确缺席</dt><dd>{labels(fields.appearanceCheck.absentEntityIds)}</dd><dt>核对说明</dt><dd>{fields.appearanceCheck.note}</dd></>}</>}
    {fields.kind === 'cognition' && <><dt>认知主体</dt><dd>{label(fields.personId)}</dd><dt>认知态度</dt><dd>{attitudeLabels[fields.attitude]} · {fields.concealed ? '正在隐瞒' : '未标记隐瞒'}</dd><dt>获知事件</dt><dd>{label(fields.acquisitionEventId)}</dd>{fields.evolution && <><dt>变化类型</dt><dd>{cognitionChangeLabels[fields.evolution.kind]}</dd><dt>设定有效截止</dt><dd>{timeLabel(fields.evolution.validUntil)} · 不含截止时点，后继状态可提前结束本状态</dd>{fields.evolution.knowledgeOrigin && <><dt>转换来源</dt><dd>知识 {fields.evolution.knowledgeOrigin.itemId}<small>固定版本 {fields.evolution.knowledgeOrigin.revisionId}；内容经作者转换为本人物的认知</small></dd></>}</>}</>}
    {fields.kind === 'foreshadow' && <><dt>当前进展</dt><dd>{stageLabels[fields.stage]}</dd><dt>关联实体</dt><dd>{labels(fields.entityIds)}</dd><dt>关联事件</dt><dd>{labels(fields.eventIds)}</dd><dt>计划回收</dt><dd>{plannedPayoffLabel(fields.plannedPayoff, book)}</dd><dt>实际回收</dt><dd>{disclosureLabel(fields.actualPayoff, book)}</dd></>}
  </dl>
    {fields.kind === 'event' && fields.stateChanges.length > 0 && <><h4>状态变化</h4><ol>{fields.stateChanges.map((change) => <li key={change.id}><p>{label(change.entityId)} · {change.attribute}</p><p>{change.before || '未记录变化前状态'} → {change.after || '未记录变化后状态'}</p></li>)}</ol></>}
    {fields.kind === 'foreshadow' && fields.milestones.length > 0 && <><h4>伏笔历程</h4><ol>{fields.milestones.map((milestone) => <li key={milestone.id}><p>{stageLabels[milestone.stage]} · {milestone.note}</p><small>{timeLabel(milestone.storyTime)}；{disclosureLabel(milestone.disclosure, book)}</small>{milestone.source && <small>来源说明 / 引文：{milestone.source.quote}{milestone.source.sourceType === 'chapter_text' && <> · 固定版本 {milestone.source.revisionId} · 段落 {milestone.source.blockId}</>}</small>}</li>)}</ol></>}
  </div>
}
