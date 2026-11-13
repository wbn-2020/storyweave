import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { DomainError, type BookSnapshot, type RevisionSnapshot, type StudioApi } from '../../contracts/api'
import { parseKnowledgeSource, type KnowledgeSourceInput, type KnowledgeStatus } from '../../contracts/knowledge'
import { MAX_COGNITION_STATES, STORY_EVOLUTION_SCHEMA_VERSION, STORY_KINDS, cognitionStateAt, parseStoryFields, type CognitionState, type CreateStoryRecordInput, type StoryKind, type StoryRecordDetail, type StoryRecordFields, type StoryRecordPage, type StoryRevision, type UpdateStoryRecordInput } from '../../contracts/story'
import { FORESHADOW_THUMBNAIL_SCHEMA_VERSION, matchesForeshadowThumbnail, parseForeshadowThumbnailMetadata, sameForeshadowThumbnail, type ForeshadowThumbnailFields } from '../../contracts/foreshadow-thumbnail'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import { ForeshadowThumbnail } from './ForeshadowThumbnail'
import { readNoteThumbnailFile } from './NoteThumbnail'
import { blockText, cognitionChangeLabels, initialStoryFields, SourceEditor, stageLabels, StoryFieldsEditor, StoryFieldsView, storyKindLabels, timeLabel } from './StoryFieldsEditor'
import shared from '../StellarShared.module.css'
import layout from './StellarKnowledge.module.css'
import styles from './StellarStory.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot
  initialKind?: StoryKind
  initialId?: string
  initialCreate?: boolean
  busy: boolean
  error?: string | null
  pendingMessage?: string | null
  checkingReceipt: boolean
  onCheckReceipt: () => void
  onRecover: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  onUpgrade: (accept: (status: KnowledgeStatus) => void) => Promise<void>
  onCreate: (input: CreateStoryRecordInput, accept: (saved: StoryRecordDetail) => boolean) => Promise<void>
  onUpdate: (input: UpdateStoryRecordInput, accept: (saved: StoryRecordDetail) => boolean) => Promise<void>
  scenes?: { id: string; title: string; chapterId: string | null }[]
}

const PAGE_SIZE = 50
const sourceLabels = { author_input: '作者输入', external: '外部资料说明', chapter_text: '固定正文引文' }
const validityLabels = { valid: '出处可查', partial: '出处部分缺失', missing: '出处缺失' }

function CognitionHistoryView({ states, currentId, disabled, onSelect }: {
  states: CognitionState[]; currentId: string; disabled: boolean; onSelect: (id: string) => void
}) {
  const [order, setOrder] = useState('')
  const number = order === '' ? null : Number(order)
  const valid = number !== null && Number.isSafeInteger(number) && Math.abs(number) <= 1_000_000_000
  const selected = valid && number !== null ? cognitionStateAt(states, number) : null
  const ended = selected?.fields.evolution?.kind === 'forgotten' || selected?.fields.evolution?.kind === 'refuted'
  return <section className={styles.history} aria-label="人物认知历程">
    <h4>按故事时间查看认知</h4>
    <p className={styles.help}>此处是作者视图。每个状态的内容固定，有效期从形成时点开始，到设定截止或下一变化前结束；日期文字、章序和编辑时间不用于推断先后。</p>
    <label>故事排序值<input type="number" min="-1000000000" max="1000000000" step="1" value={order} disabled={disabled} onChange={(event) => setOrder(event.target.value)} placeholder="输入与认知记录相同尺度的排序值" /></label>
    {order !== '' && <div role="status">{!valid ? <p className={styles.help}>请输入绝对值不超过 10 亿的整数。</p> : selected ? <><p><strong>{selected.fields.title}</strong> · {ended ? '该时点已推翻或遗忘，不能作为仍持有的认知' : selected.fields.concealed ? '该时点持有认知并隐瞒' : '该时点持有的认知'}</p><blockquote className={styles.blockPreview}>{selected.fields.description}</blockquote><button type="button" className={shared.button} disabled={disabled || selected.id === currentId} onClick={() => onSelect(selected.id)}>查看此状态及来源</button></> : <p className={styles.help}>此时点没有有效且排序明确的已记录状态；不能据此推断人物知道或不知道。</p>}</div>}
    <ol className={styles.historyList}>{states.map((state) => <li key={state.id}><button type="button" className={styles.historyButton} disabled={disabled || state.id === currentId} onClick={() => onSelect(state.id)}><strong>{state.fields.title} · {cognitionChangeLabels[state.fields.evolution?.kind ?? 'formed']}</strong><span>{timeLabel(state.fields.storyTime)} → {state.effectiveUntil.kind === 'unknown' ? '截止未定' : `${timeLabel(state.effectiveUntil)}（不含）`}</span></button></li>)}</ol>
    {states.some((state) => !state.fields.evolution) && <p className={styles.help}>旧记录未单独记录故事变迁。此前编辑历史不自动推断为故事时间；请核对原内容，再追加明确时点的变化。</p>}
  </section>
}

export function StoryPanel({ api, book, initialKind = 'relation', initialId, initialCreate = false, busy, error, pendingMessage, checkingReceipt, onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onCreate, onUpdate, scenes }: Props) {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusRefresh, setStatusRefresh] = useState(0)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const [kind, setKind] = useState<StoryKind>(initialKind)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<StoryRecordPage | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [detail, setDetail] = useState<StoryRecordDetail | null>(null)
  const [historyDetail, setHistoryDetail] = useState<StoryRevision | null>(null)
  const [mode, setMode] = useState<'view' | 'create' | 'edit'>('view')
  const [fields, setFields] = useState<StoryRecordFields>(() => initialStoryFields(initialKind))
  const [source, setSource] = useState<KnowledgeSourceInput | undefined>()
  const [thumbnail, setThumbnail] = useState<ForeshadowThumbnailFields | null | undefined>()
  const [expectedRevision, setExpectedRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [reading, setReading] = useState(false)
  const [writing, setWriting] = useState(false)
  const [childReading, setChildReading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<{ source: Extract<KnowledgeSourceInput, { sourceType: 'chapter_text' }>; revision: RevisionSnapshot } | null>(null)
  const mounted = useRef(false)
  const dirtyRef = useRef(false)
  const readLock = useRef(false)
  const writeLock = useRef(false)
  const readTicket = useRef(0)
  const imageInput = useRef<HTMLInputElement>(null)
  const imageEditor = useRef<HTMLFieldSetElement>(null)
  const initialOpened = useRef(false)
  const callback = useRef(onDirtyChange)
  callback.current = onDirtyChange
  const childReads = useRef(new Set<string>())
  const archived = Boolean(book.book.archivedAt)
  const ready = status !== null && status.schemaVersion >= 4
  const evolutionReady = status !== null && status.schemaVersion >= STORY_EVOLUTION_SCHEMA_VERSION
  const thumbnailsReady = status !== null && status.schemaVersion >= FORESHADOW_THUMBNAIL_SCHEMA_VERSION
  const upgradeRequired = status !== null && (!evolutionReady || kind === 'foreshadow' && !thumbnailsReady)
  const unavailable = busy || reading || writing || childReading || Boolean(pendingMessage)
  const names = detail?.labels ?? {}

  function setDirtyState(value: boolean) { dirtyRef.current = value; setDirty(value); callback.current(value) }
  function changeFields(value: StoryRecordFields) { setFields(value); setDirtyState(true); setMessage(null) }
  const onReadingChange = useCallback((id: string, value: boolean) => {
    if (value) childReads.current.add(id)
    else childReads.current.delete(id)
    if (mounted.current) setChildReading(childReads.current.size > 0)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; readTicket.current += 1; callback.current(false) }
  }, [])
  useEffect(() => { setRecoveryConfirmed(false) }, [pendingMessage])
  useEffect(() => {
    let active = true
    setStatusLoading(true); setStatus(null)
    void request(() => api.getKnowledgeStatus({ bookId: book.book.id })).then((result) => {
      if (!active) return
      setStatusLoading(false)
      if (result.ok && result.data.bookId === book.book.id) setStatus(result.data)
      else setMessage(result.ok ? '作品结构状态的身份不符，请重新打开。' : result.error.message)
    })
    return () => { active = false }
  }, [api, book.book.id, statusRefresh])
  useEffect(() => {
    if (!ready) { setPage(null); setListLoading(false); return }
    let active = true
    setListLoading(true); setPage(null)
    void request(() => api.listStoryRecords({ bookId: book.book.id, kind, search, limit: PAGE_SIZE, offset })).then((result) => {
      if (!active) return
      setListLoading(false)
      if (result.ok && result.data.bookId === book.book.id) setPage(result.data)
      else setMessage(result.ok ? '故事记录列表的作品身份不符。' : result.error.message)
    })
    return () => { active = false }
  }, [api, book.book.id, kind, offset, ready, refresh, search])
  function mayLeave(): boolean {
    if (busy || pendingMessage || readLock.current || writeLock.current || childReads.current.size > 0) return false
    if (dirtyRef.current) { setMessage('这条记录有未保存修改，请先保存或明确放弃本次修改。'); return false }
    return true
  }
  async function upgrade() {
    if (!upgradeConfirmed || !status || !upgradeRequired || archived || unavailable || writeLock.current || dirtyRef.current) return
    writeLock.current = true; setWriting(true); setMessage(null)
    try {
      await onUpgrade((saved) => {
        if (!mounted.current) return
        if (saved.bookId !== book.book.id || saved.schemaVersion < (kind === 'foreshadow' ? FORESHADOW_THUMBNAIL_SCHEMA_VERSION : STORY_EVOLUTION_SCHEMA_VERSION)) { setMessage('升级回执尚未确认新故事记录格式可用，请保留窗口并核对。'); return }
        setStatus(saved); setUpgradeConfirmed(false)
      })
    } catch { if (mounted.current) setMessage('升级结果尚未确认，请保留窗口并核对回执。') }
    finally { writeLock.current = false; if (mounted.current) setWriting(false) }
  }
  function switchKind(value: StoryKind) {
    if (!mayLeave()) return
    setKind(value); setOffset(0); setSearch(''); setQuery(''); setDetail(null); setHistoryDetail(null); setMode('view'); setEvidence(null); setMessage(null)
  }
  async function selectRecord(id: string) {
    if (!mayLeave()) return
    const ticket = ++readTicket.current
    readLock.current = true; setReading(true); setDetail(null); setHistoryDetail(null); setEvidence(null); setMessage(null); setMode('view')
    const result = await request(() => api.getStoryRecord({ bookId: book.book.id, id }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.id === id && result.data.fields.kind === kind) setDetail(result.data)
    else setMessage(result.ok ? '故事记录的身份或类型不符，请刷新后重试。' : result.error.message)
  }
  useEffect(() => {
    if (!initialId || initialOpened.current || !ready || busy || pendingMessage) return
    initialOpened.current = true
    void selectRecord(initialId)
  }, [initialId, ready, busy, pendingMessage])
  function beginEdit(create: boolean) {
    if (!mayLeave() || archived || !ready || (create ? !page : !detail)) return
    if (!evolutionReady && (kind === 'cognition' || kind === 'foreshadow')) { setMessage('编辑伏笔计划与认知变迁前，请先在本面板备份升级作品。原记录仍可查阅。'); return }
    setMode(create ? 'create' : 'edit'); setFields(create ? initialStoryFields(kind) : detail!.fields)
    // 编辑期间固定知识修订号；冲突后不从列表刷新中偷偷取得覆盖新资料的基线。
    setExpectedRevision(create ? page!.knowledgeRevision : detail!.knowledgeRevision)
    if (create) setDetail(null)
    setSource(undefined); setThumbnail(undefined); setHistoryDetail(null); setEvidence(null); setMessage(null); setDirtyState(true)
  }
  useEffect(() => {
    if (!initialCreate || initialId || initialOpened.current || !ready || !page || busy || pendingMessage || archived) return
    initialOpened.current = true
    beginEdit(true)
  }, [initialCreate, initialId, ready, page, busy, pendingMessage, archived])
  function beginCognitionChange() {
    if (!mayLeave() || archived || !ready || !detail || detail.fields.kind !== 'cognition') return
    if (!evolutionReady) { setMessage('追加认知变化前，请先在本面板备份升级作品。'); return }
    const last = detail.cognitionHistory?.at(-1)
    if (!last || last.id !== detail.id) { setMessage('请先在认知历程中打开最后一个状态，再追加下一次变化。'); return }
    if ((detail.cognitionHistory?.length ?? 0) >= MAX_COGNITION_STATES) { setMessage(`一条认知历程最多 ${MAX_COGNITION_STATES} 个状态。`); return }
    if (detail.fields.storyTime.kind === 'unknown' || detail.fields.storyTime.order === null) { setMessage('请先编辑本状态，补全明确的故事排序值，再追加变化。'); return }
    setMode('create')
    setFields({ ...detail.fields, storyTime: { kind: 'unknown' }, acquisitionEventId: null, disclosure: { state: 'unknown' },
      nature: 'character_belief', authorDecision: 'unreviewed', freshness: 'current', conflictState: 'unchecked',
      evolution: { kind: 'revised', previousId: detail.id, validUntil: { kind: 'unknown' } } })
    setExpectedRevision(detail.knowledgeRevision)
    setSource(undefined); setHistoryDetail(null); setEvidence(null); setMessage(null); setDirtyState(true)
  }
  function discard() {
    if (unavailable || writeLock.current || readLock.current || childReads.current.size > 0) return
    setDirtyState(false); setMode('view'); setSource(undefined); setThumbnail(undefined); setMessage(null)
  }
  async function chooseThumbnail(file: File) {
    if (unavailable || archived || !thumbnailsReady || mode === 'view' || readLock.current || writeLock.current) return
    const ticket = ++readTicket.current
    imageEditor.current?.focus({ preventScroll: true })
    readLock.current = true; setReading(true); setMessage(null)
    try {
      const image = await readNoteThumbnailFile(file)
      if (!mounted.current || ticket !== readTicket.current) return
      setThumbnail(image); setDirtyState(true)
    } catch (caught) {
      if (mounted.current && ticket === readTicket.current) setMessage(caught instanceof Error ? caught.message : '伏笔配图读取失败。')
    } finally {
      if (mounted.current && ticket === readTicket.current) { readLock.current = false; setReading(false) }
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (unavailable || archived || mode === 'view' || readLock.current || writeLock.current || childReads.current.size > 0) return
    let input: CreateStoryRecordInput
    try {
      input = { bookId: book.book.id, expectedKnowledgeRevision: expectedRevision, fields: parseStoryFields(fields, book.book.id), ...(source ? { source: parseKnowledgeSource(source, book.book.id) } : {}),
        ...(fields.kind === 'foreshadow' && thumbnail !== undefined ? { thumbnail } : {}) }
    } catch (caught) { setMessage(caught instanceof DomainError ? caught.detail.message : '记录内容无效，请检查后保存。'); return }
    const expectedId = mode === 'edit' ? detail?.id : null
    const expectedKind = fields.kind
    writeLock.current = true; setWriting(true); setMessage(null)
    const accept = (saved: StoryRecordDetail) => {
      if (!mounted.current) return false
      try {
        if (saved.bookId !== book.book.id || saved.fields.kind !== expectedKind || (expectedId && saved.id !== expectedId)
          || !Number.isSafeInteger(saved.bookRevision) || saved.bookRevision < book.book.revision
          || !Number.isSafeInteger(saved.knowledgeRevision) || saved.knowledgeRevision < expectedRevision
          || saved.knowledgeRevision > expectedRevision + 1 || !expectedId && saved.knowledgeRevision !== expectedRevision + 1
          || JSON.stringify(parseStoryFields(saved.fields, book.book.id)) !== JSON.stringify(input.fields)) throw new Error('wrong record')
      } catch { setMessage('保存回执的记录身份、内容或版本不符，编辑内容仍保留。'); return false }
      if (expectedKind === 'foreshadow') {
        try {
          const image = saved.thumbnail === null ? null : parseForeshadowThumbnailMetadata(saved.thumbnail)
          if (image && (image.recordId !== saved.id || image.knowledgeRevision > (saved.revisions[0]?.knowledgeRevision ?? -1))
            || input.thumbnail !== undefined && !matchesForeshadowThumbnail(image, input.thumbnail)
            || input.thumbnail === undefined && !sameForeshadowThumbnail(image, mode === 'edit' ? detail?.thumbnail ?? null : null)) throw new Error('wrong thumbnail')
        } catch { setMessage('保存回执的伏笔配图与本次提交不符，编辑内容仍保留，请核对原请求。'); return false }
      }
      setDirtyState(false); setDetail(saved); setHistoryDetail(null); setMode('view'); setSource(undefined); setThumbnail(undefined); setRefresh((value) => value + 1)
      return true
    }
    try {
      if (mode === 'edit' && detail) await onUpdate({ ...input, id: detail.id }, accept)
      else await onCreate(input, accept)
    } catch { if (mounted.current) setMessage('保存结果尚未确认，请保留当前编辑并核对回执。') }
    finally { writeLock.current = false; if (mounted.current) setWriting(false) }
  }
  async function showSource(value: KnowledgeSourceInput) {
    if (unavailable || value.sourceType !== 'chapter_text' || readLock.current) return
    const ticket = ++readTicket.current
    readLock.current = true; setReading(true); setEvidence(null); setMessage(null)
    const result = await request(() => api.readRevision({ bookId: book.book.id, chapterId: value.chapterId, revisionId: value.revisionId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.chapterId === value.chapterId && result.data.id === value.revisionId) setEvidence({ source: value, revision: result.data })
    else setMessage(result.ok ? '来源版本身份不符。' : '无法读取来源版本：' + result.error.message)
  }
  async function showHistory(revisionId: string) {
    if (!detail || mode !== 'view' || !mayLeave()) return
    const recordId = detail.id
    const expected = detail.revisions.find((revision) => revision.id === revisionId)
    if (!expected) return
    const ticket = ++readTicket.current
    // 一次只保留作者选中的快照，避免将多次完整里程碑历史长期放在界面内存中。
    readLock.current = true; setReading(true); setHistoryDetail(null); setMessage(null)
    const result = await request(() => api.readStoryRevision({ bookId: book.book.id, id: recordId, revisionId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.recordId === recordId && result.data.id === revisionId &&
        result.data.fields.kind === kind && result.data.knowledgeRevision === expected.knowledgeRevision) setHistoryDetail(result.data)
    else setMessage(result.ok ? '故事历史的身份或版本不符，请刷新后重试。' : result.error.message)
  }

  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null
  const draftJson = pendingMessage && mode !== 'view' ? JSON.stringify({ format: 'storyweave-story-draft', version: 1, bookId: book.book.id, operation: mode === 'edit' ? 'story.update' : 'story.create', ...(mode === 'edit' && detail ? { recordId: detail.id } : {}), expectedKnowledgeRevision: expectedRevision, fields, source, ...(thumbnail === undefined ? {} : { thumbnail }) }, null, 2) : null
  const evidenceIndex = evidence ? evidence.revision.document.content.findIndex((block) => block.attrs.id === evidence.source.blockId) : -1
  const milestoneSources = detail?.fields.kind === 'foreshadow' ? detail.fields.milestones.filter((item) => item.source?.sourceType === 'chapter_text') : []

  return <Dialog title="故事脉络 · 关系与时间线" wide busy={unavailable} onClose={() => { if (mayLeave()) onClose() }} error={panelError}>
    <div className={layout.intro}><p>《{book.book.title}》的故事记录</p><span>作者全知视图 · 手工维护</span></div>
    <p className={shared.helpText}>故事时间、读者披露与人物知情分别记录。此处呈现全书信息，尚未提供读者或人物视角的防剧透过滤。</p>
    {pendingMessage && <section className={layout.pending} aria-label="核对故事记录操作结果"><h3>操作结果尚未确认</h3><p role="status">{pendingMessage}</p><button type="button" className={shared.button} disabled={checkingReceipt} onClick={onCheckReceipt}>{checkingReceipt ? '正在核对…' : '核对回执'}</button>
      {draftJson && <label>故事记录草稿副本（只读，可全选复制）<textarea className={styles.draftCopy} rows={10} readOnly spellCheck={false} value={draftJson} onFocus={(event) => event.currentTarget.select()} /></label>}
      <label className={`${shared.checkLabel} ${layout.upgradeCheck}`}><input type="checkbox" checked={recoveryConfirmed} disabled={checkingReceipt} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />{draftJson ? '我已复制保留记录草稿，了解原操作可能已写入。' : '我了解结构升级可能已完成，需要恢复后核对。'}</label><p>进入恢复页会关闭当前面板。请先核对原操作结果；草稿副本不会自动导入或重发。</p><button type="button" className={shared.button} disabled={!recoveryConfirmed || checkingReceipt} onClick={() => { if (recoveryConfirmed && pendingMessage && !checkingReceipt) onRecover() }}>进入草稿与恢复</button>
    </section>}
    {archived && <p className={shared.helpText}>作品已归档，可查阅记录；解除归档后才能编辑。</p>}
    {statusLoading && <p className={layout.status} role="status">正在读取作品结构…</p>}
    {!statusLoading && !status && <button type="button" className={shared.button} disabled={unavailable} onClick={() => setStatusRefresh((value) => value + 1)}>重试读取状态</button>}
    {status && upgradeRequired && <section className={layout.upgrade}><h3>{kind === 'foreshadow' ? '为本书启用伏笔配图与计划范围' : '为本书启用计划范围与认知变迁'}</h3><p>当前作品使用结构版本 {status.schemaVersion}。先保存独立数据库备份并核对，再升级到当前作品格式。已有故事记录仍可查阅；原稿与历史快照保留。</p><label className={`${shared.checkLabel} ${layout.upgradeCheck}`}><input type="checkbox" checked={upgradeConfirmed} disabled={unavailable || archived || dirty} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />我同意先备份，再升级本书结构。</label><button type="button" className={shared.primaryButton} disabled={unavailable || archived || dirty || !upgradeConfirmed} title={dirty ? '请先保存或放弃当前修改，再启用配图' : undefined} onClick={() => void upgrade()}>备份并启用新故事记录</button></section>}
    {status?.backupPath && <p className={layout.backupPath}>本次升级前备份：{status.backupPath}</p>}
    {ready && <><nav className={styles.tabs} aria-label="故事记录类型">{STORY_KINDS.map((value) => <button key={value} type="button" aria-pressed={kind === value} disabled={unavailable} onClick={() => switchKind(value)}>{storyKindLabels[value]}</button>)}</nav>
      <div className={`${layout.layout} ${styles.layout}`}><aside className={layout.listPane} aria-label={`${storyKindLabels[kind]}列表`}>
        <form className={layout.search} onSubmit={(event) => { event.preventDefault(); if (mayLeave()) { setSearch(query); setOffset(0); setRefresh((value) => value + 1) } }}><label>搜索名称与说明<input value={query} maxLength={200} disabled={unavailable} onChange={(event) => setQuery(event.target.value)} /></label><button className={shared.button} disabled={unavailable || listLoading} type="submit">搜索</button></form>
        <div className={layout.listActions}><button type="button" className={shared.primaryButton} disabled={unavailable || archived || !page} onClick={() => beginEdit(true)}>新建{storyKindLabels[kind]}</button><button type="button" className={shared.button} disabled={unavailable || listLoading} onClick={() => { if (mayLeave()) setRefresh((value) => value + 1) }}>刷新</button></div>
        {kind === 'event' && <p className={styles.listNote}>按作者填写的排序值排列；未指定排序的事件单独标记，不推测故事先后。</p>}
        {listLoading ? <p role="status" className={layout.status}>正在读取记录…</p> : page && <><p className={layout.status}>共 {page.total} 条 · 知识版本 {page.knowledgeRevision}</p><ul className={styles.recordList}>{page.items.map((item) => { const time = item.time; return <li key={item.id}><button type="button" disabled={unavailable} aria-pressed={detail?.id === item.id} onClick={() => void selectRecord(item.id)}><strong>{item.title}</strong>{kind === 'event' && <span>{time.kind !== 'unknown' && time.order !== null ? '已指定故事顺序' : '未排序 / 时间待定'}</span>}<small>{timeLabel(time)}</small>{item.kind === 'foreshadow' && item.stage && <small>{stageLabels[item.stage]}</small>}</button></li> })}</ul>{page.items.length === 0 && <p className={styles.help}>尚无匹配记录。新建一条，关联本书实体并填写时间、披露或认知信息。</p>}<div className={styles.paging}><button type="button" className={shared.button} disabled={unavailable || offset === 0} onClick={() => { if (mayLeave()) setOffset(Math.max(0, offset - PAGE_SIZE)) }}>上一页</button><button type="button" className={shared.button} disabled={unavailable || page.nextOffset === null} onClick={() => { if (mayLeave() && page.nextOffset !== null) setOffset(page.nextOffset) }}>下一页</button></div></>}
      </aside><section className={layout.detailPane} aria-label="故事记录详情">
        {reading && <p className={layout.status} role="status">正在读取固定记录…</p>}
        {mode === 'view' && !detail && !reading && <div className={layout.empty}><h3>把故事的变化留下来</h3><p>先选择记录，或新建关系、事件、伏笔与人物认知。实体来自本书知识库；所有引用按同一作品核对。</p></div>}
        {mode === 'view' && detail && <><div className={layout.detailHeading}><div><span>{storyKindLabels[detail.fields.kind]}</span><h3>{detail.fields.title}</h3></div><button type="button" className={shared.button} disabled={unavailable || archived} onClick={() => beginEdit(false)}>{detail.fields.kind === 'cognition' ? '复核状态 / 补充来源' : '编辑记录'}</button></div>
          {detail.fields.kind === 'foreshadow' && detail.thumbnail && <ForeshadowThumbnail api={api} bookId={book.book.id} recordId={detail.id} metadata={detail.thumbnail} name={detail.fields.title} className={styles.thumbnail} />}
          <StoryFieldsView fields={detail.fields} book={book} names={names} />
          {detail.fields.kind === 'cognition' && <><button type="button" className={shared.primaryButton} disabled={unavailable || archived} onClick={beginCognitionChange}>记录认知变化</button><CognitionHistoryView key={detail.id} states={detail.cognitionHistory ?? []} currentId={detail.id} disabled={unavailable} onSelect={(id) => void selectRecord(id)} /></>}
          <div className={layout.sectionHeading}><h4>记录来源</h4><span>出处可查不代表陈述已被证实</span></div><ul className={layout.sources}>{detail.sources.map((item) => <li key={item.id}><div><strong>{sourceLabels[item.sourceType]}</strong><span>{validityLabels[item.validity]}{item.referenceState && ` · ${item.referenceState === 'historical' ? '历史稿引用' : '当前稿引用'}`}</span></div><blockquote>{item.quote}</blockquote>{item.sourceType === 'chapter_text' && <><p className={layout.sourceIds}>章节 {item.chapterId} · 版本 {item.revisionId} · 段落 {item.blockId}</p><button type="button" className={shared.button} disabled={unavailable} onClick={() => void showSource(item)}>查看来源原稿</button></>}</li>)}</ul>{detail.sources.length === 0 && <p className={styles.help}>尚未追加记录来源。</p>}
          {milestoneSources.length > 0 && <><div className={layout.sectionHeading}><h4>伏笔里程碑原稿</h4></div>{milestoneSources.map((milestone) => <p key={milestone.id} className={layout.sourceIds}>{stageLabels[milestone.stage]} · {milestone.note}<button type="button" className={shared.button} disabled={unavailable} onClick={() => { if (milestone.source) void showSource(milestone.source) }}>查看里程碑来源</button></p>)}</>}
          {evidence && <section aria-label="来源版本上下文"><div className={layout.sectionHeading}><h4>来源原稿 · {displayTime(evidence.revision.createdAt)}</h4><button type="button" className={shared.button} disabled={unavailable} onClick={() => setEvidence(null)}>收起原稿</button></div><p className={layout.sourceIds}>固定版本 {evidence.revision.id} · 引用段落 {evidence.source.blockId}</p>{evidenceIndex < 0 ? <p className={styles.help}>此版本中未找到指定段落，未展示其他正文。</p> : evidence.revision.document.content.slice(Math.max(0, evidenceIndex - 1), evidenceIndex + 2).map((block) => <p key={block.attrs.id} className={block.attrs.id === evidence.source.blockId ? layout.evidenceQuote : layout.evidenceContext}>{blockText(block) || '分场线 / 空段落'}</p>)}</section>}
          <div className={layout.sectionHeading}><h4>修改历史</h4><span>最近 {detail.revisions.length} 次摘要；选中后读取单个快照，完整历史保留在本书</span></div>
          <ul className={styles.historyList}>{detail.revisions.map((revision) => <li key={revision.id}><button type="button" className={styles.historyButton} disabled={unavailable} aria-expanded={historyDetail?.id === revision.id} aria-controls="story-history-detail" onClick={() => void showHistory(revision.id)}><strong>{revision.title}</strong><span>知识版本 {revision.knowledgeRevision} · {revision.reason === 'created' ? '创建' : '更新'} · {displayTime(revision.createdAt)}</span></button></li>)}</ul>
          {historyDetail && <section id="story-history-detail" className={styles.history} aria-label="故事记录历史快照"><div className={layout.sectionHeading}><h4>{historyDetail.fields.title} · 知识版本 {historyDetail.knowledgeRevision}</h4><button type="button" className={shared.button} disabled={unavailable} onClick={() => setHistoryDetail(null)}>收起历史</button></div><p className={styles.help}>关联名称显示当前名称，历史关联身份与内容保持原快照。</p>
            {historyDetail.fields.kind === 'foreshadow' && <><ForeshadowThumbnail api={api} bookId={book.book.id} recordId={historyDetail.recordId} metadata={historyDetail.thumbnail ?? null} name={historyDetail.fields.title} className={styles.thumbnail} /><p className={styles.help}>配图取自该次修订，不随当前换图或移除改变。</p></>}
            <StoryFieldsView fields={historyDetail.fields} book={book} names={historyDetail.labels} /></section>}
        </>}
        {mode !== 'view' && <form className={styles.form} onSubmit={(event) => void save(event)}><div className={layout.detailHeading}><h3>{mode === 'create' ? '新建' : '编辑'}{storyKindLabels[fields.kind]}</h3><span>固定知识版本 {expectedRevision}</span></div>
          {fields.kind === 'foreshadow' && <fieldset ref={imageEditor} tabIndex={-1} aria-label="伏笔配图"><legend>伏笔配图</legend><div className={styles.thumbnailEditor}>
            {thumbnail ? <img className={styles.thumbnail} src={`data:${thumbnail.mime};base64,${thumbnail.dataBase64}`} alt={thumbnail.alt || fields.title} />
              : <ForeshadowThumbnail api={api} bookId={book.book.id} recordId={detail?.id ?? ''} metadata={thumbnail === undefined && mode === 'edit' ? detail?.thumbnail ?? null : null} name={fields.title} className={styles.thumbnail} />}
            <div className={styles.stack}><p className={styles.help}>{!thumbnailsReady ? '本书尚未启用配图，文字仍可保存。请先保存或放弃当前修改，再备份升级。' : thumbnail === null ? '本次保存将移除当前配图，历史原图保留。' : 'PNG、JPEG 或 WebP，单张不超过 2 MiB；随记录一起保存。'}</p>
              <input ref={imageInput} type="file" hidden accept="image/png,image/jpeg,image/webp" disabled={unavailable || archived || !thumbnailsReady}
                onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void chooseThumbnail(file) }} />
              <div className={styles.thumbnailActions}><button type="button" className={shared.button} disabled={unavailable || archived || !thumbnailsReady} title={!thumbnailsReady ? '请先备份升级作品' : undefined} onClick={() => imageInput.current?.click()}>选择配图</button>
                <button type="button" className={shared.button} disabled={unavailable || archived || !thumbnailsReady || (thumbnail === null || thumbnail === undefined && (mode !== 'edit' || !detail?.thumbnail))} onClick={() => { setThumbnail(null); setDirtyState(true) }}>移除配图</button>
                {thumbnail !== undefined && <button type="button" className={shared.button} disabled={unavailable || archived} onClick={() => setThumbnail(undefined)}>撤销本次配图修改</button>}</div>
              {thumbnail && <label>图片说明<input value={thumbnail.alt} maxLength={2000} disabled={unavailable || archived} onChange={(event) => { setThumbnail({ ...thumbnail, alt: event.target.value }); setDirtyState(true) }} /></label>}
            </div></div></fieldset>}
          <StoryFieldsEditor fields={fields} onChange={changeFields} api={api} book={book} disabled={unavailable || archived} names={names} savedMilestones={mode === 'edit' && detail?.fields.kind === 'foreshadow' ? detail.fields.milestones.length : 0}
          savedCognition={mode === 'edit' && detail?.fields.kind === 'cognition' ? detail.fields : undefined}
          previousCognition={mode === 'create' && detail?.fields.kind === 'cognition' ? detail.fields : undefined}
          scenes={scenes} onReadingChange={onReadingChange} /><SourceEditor api={api} book={book} disabled={unavailable || archived} value={source} onReadingChange={onReadingChange} onChange={(value) => { setSource(value); setDirtyState(true); setMessage(null) }} /><div className={shared.formActions}><button type="button" className={shared.button} disabled={unavailable} onClick={discard}>{dirty ? '放弃本次修改' : '返回详情'}</button><button type="submit" className={shared.primaryButton} disabled={unavailable || archived || !fields.title.trim()}>{writing || busy ? '正在保存…' : '保存记录'}</button></div></form>}
      </section></div>
    </>}
  </Dialog>
}
