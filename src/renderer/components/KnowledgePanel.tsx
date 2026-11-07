import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { BookSnapshot, ChapterSnapshot, RevisionSnapshot, StudioApi } from '../../contracts/api'
import { DomainError } from '../../contracts/api'
import {
  AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_KINDS, KNOWLEDGE_NATURES,
  parseKnowledgeFields, parseKnowledgeSource,
  type CreateKnowledgeItemInput, type KnowledgeItemDetail, type KnowledgeItemFields, type KnowledgeItemPage,
  type KnowledgeKind, type KnowledgeNature, type KnowledgeSource, type KnowledgeSourceInput, type KnowledgeStatus, type UpdateKnowledgeItemInput,
} from '../../contracts/knowledge'
import type { ManuscriptBlock } from '../../contracts/manuscript'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import shared from '../App.module.css'
import styles from './KnowledgePanel.module.css'

interface Props {
  api: StudioApi
  book: BookSnapshot
  busy: boolean
  error?: string | null
  pendingMessage?: string | null
  checkingReceipt: boolean
  onCheckReceipt: () => void
  onRecover: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  onUpgrade: (accept: (status: KnowledgeStatus) => void) => Promise<void>
  onCreate: (input: CreateKnowledgeItemInput, accept: (saved: KnowledgeItemDetail) => void) => Promise<void>
  onUpdate: (input: UpdateKnowledgeItemInput, accept: (saved: KnowledgeItemDetail) => void) => Promise<void>
}

const kindLabels: Record<KnowledgeKind, string> = { person: '人物', place: '地点', organization: '组织', object: '物品', rule: '世界规则', theme: '主题', other: '其他' }
const natureLabels: Record<KnowledgeNature, string> = { author_setting: '作者设定', future_plan: '未来计划', narrative_claim: '正文陈述', character_belief: '人物认知', ai_derived: 'AI 整理', ai_inference: 'AI 推断', external_reference: '外部参考' }
const decisionLabels = { unreviewed: '未处理', adopted: '已采纳', rejected: '已否决', review_later: '要求复核' }
const freshnessLabels = { current: '当前', affected: '受影响', updating: '更新中', failed: '更新失败' }
const conflictLabels = { unchecked: '未检查冲突', clear: '未发现已知冲突', candidate: '存在候选冲突', explained: '作者已解释' }
const sourceLabels = { author_input: '作者输入', chapter_text: '正文摘录', external: '外部资料' }
const validityLabels = { valid: '出处可查', partial: '出处部分缺失', missing: '出处缺失' }
const initialFields: KnowledgeItemFields = { kind: 'person', name: '', aliases: [], summary: '', nature: 'author_setting', authorDecision: 'unreviewed', freshness: 'current', conflictState: 'unchecked' }
const PAGE_SIZE = 50

function blockText(block: ManuscriptBlock): string {
  return block.type === 'horizontalRule' ? '' : (block.content ?? []).map((node) => node.type === 'hardBreak' ? '\n' : node.text).join('')
}

export function KnowledgePanel({ api, book, busy, error, pendingMessage, checkingReceipt, onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onCreate, onUpdate }: Props) {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusRefresh, setStatusRefresh] = useState(0)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<{ search: string; kind: KnowledgeKind | ''; nature: KnowledgeNature | '' }>({ search: '', kind: '', nature: '' })
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<KnowledgeItemPage | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [detail, setDetail] = useState<KnowledgeItemDetail | null>(null)
  const [reading, setReading] = useState(false)
  const [writing, setWriting] = useState(false)
  const [mode, setMode] = useState<'view' | 'create' | 'edit'>('view')
  const [fields, setFields] = useState<KnowledgeItemFields>(initialFields)
  const [aliases, setAliases] = useState('')
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [expectedRevision, setExpectedRevision] = useState(0)
  const [sourceType, setSourceType] = useState<KnowledgeSourceInput['sourceType'] | ''>('')
  const [quote, setQuote] = useState('')
  const [sourceChapter, setSourceChapter] = useState<ChapterSnapshot | null>(null)
  const [blockId, setBlockId] = useState('')
  const [evidence, setEvidence] = useState<{ source: KnowledgeSource; revision: RevisionSnapshot } | null>(null)
  const mounted = useRef(false)
  const readTicket = useRef(0)
  const listTicket = useRef(0)
  const statusTicket = useRef(0)
  const dirtyRef = useRef(false)
  const writeLock = useRef(false)
  const readLock = useRef(false)
  const callback = useRef(onDirtyChange)
  callback.current = onDirtyChange
  const unavailable = busy || writing || reading || Boolean(pendingMessage)
  const archived = Boolean(book.book.archivedAt)
  const knowledgeReady = status !== null && !status.requiresUpgrade

  function setDirtyState(value: boolean) { dirtyRef.current = value; setDirty(value); callback.current(value) }
  function markChanged() { setDirtyState(true); setMessage(null) }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; readTicket.current += 1; listTicket.current += 1; statusTicket.current += 1; callback.current(false) }
  }, [])

  useEffect(() => { setRecoveryConfirmed(false) }, [pendingMessage])

  useEffect(() => {
    const ticket = ++statusTicket.current
    setStatusLoading(true); setStatus(null)
    void request(() => api.getKnowledgeStatus({ bookId: book.book.id })).then((result) => {
      if (!mounted.current || ticket !== statusTicket.current) return
      setStatusLoading(false)
      if (result.ok && result.data.bookId === book.book.id) setStatus(result.data)
      else setMessage(result.ok ? '知识库状态与当前作品不符，请重新打开后再试。' : result.error.message)
    })
    return () => { statusTicket.current += 1 }
  }, [api, book.book.id, statusRefresh])

  useEffect(() => {
    // 旧书必须由作者确认备份并升级；读取列表不能隐式触发结构迁移。
    if (!knowledgeReady) { setPage(null); setListLoading(false); return }
    const ticket = ++listTicket.current
    setListLoading(true); setPage(null)
    void request(() => api.listKnowledgeItems({ bookId: book.book.id, search: filters.search, ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.nature ? { nature: filters.nature } : {}), limit: PAGE_SIZE, offset })).then((result) => {
      if (!mounted.current || ticket !== listTicket.current) return
      setListLoading(false)
      if (result.ok && result.data.bookId === book.book.id) setPage(result.data)
      else if (result.ok) setMessage('知识列表与当前作品不符，请重新打开后再试。')
      else setMessage(result.error.message)
    })
    return () => { listTicket.current += 1 }
  }, [api, book.book.id, filters, offset, refresh, knowledgeReady])

  async function upgrade() {
    if (!upgradeConfirmed || !status?.requiresUpgrade || archived || busy || pendingMessage || writeLock.current) return
    writeLock.current = true; setWriting(true); setMessage(null)
    try {
      await onUpgrade((saved) => {
        if (!mounted.current) return
        if (saved.bookId !== book.book.id || saved.requiresUpgrade) { setMessage('启用回执尚未确认知识库可用，请保留窗口并核对结果。'); return }
        setStatus(saved); setUpgradeConfirmed(false)
      })
    } catch { if (mounted.current) setMessage('启用结果尚未确认，请保留窗口并核对回执。') }
    finally { writeLock.current = false; if (mounted.current) setWriting(false) }
  }

  function mayLeave(): boolean {
    if (busy || pendingMessage || writeLock.current || readLock.current) return false
    if (dirtyRef.current) { setMessage('此条目有未保存修改。请先保存，或点击“放弃本次修改”后再切换。'); return false }
    return true
  }

  function resetSource() { setSourceType(''); setQuote(''); setSourceChapter(null); setBlockId(''); setEvidence(null) }

  async function selectItem(id: string) {
    if (!mayLeave()) return
    const ticket = ++readTicket.current
    readLock.current = true; setReading(true); setMessage(null); setDetail(null); setMode('view'); resetSource()
    const result = await request(() => api.getKnowledgeItem({ bookId: book.book.id, id }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.id === id) setDetail(result.data)
    else if (result.ok) setMessage('读取条目的身份不符，请刷新后再试。')
    else setMessage(result.error.message)
  }

  function beginEdit(create: boolean) {
    if (!mayLeave() || archived || (create ? !page : !detail)) return
    setMode(create ? 'create' : 'edit')
    const values = create ? initialFields : detail!
    if (create) setDetail(null)
    setFields({ kind: values.kind, name: values.name, aliases: [...values.aliases], summary: values.summary, nature: values.nature, authorDecision: values.authorDecision, freshness: values.freshness, conflictState: values.conflictState })
    setAliases(values.aliases.join('\n'))
    // 编辑开始时固定知识版本。冲突后不能仅刷新列表就用新版本覆盖并发修改。
    setExpectedRevision(create ? page!.knowledgeRevision : detail!.knowledgeRevision)
    resetSource(); setMessage(null)
  }

  function discard() {
    if (busy || pendingMessage || writeLock.current || readLock.current) return
    setDirtyState(false); setMode('view'); resetSource(); setMessage(null)
  }

  async function chooseChapter(chapterId: string) {
    if (unavailable) return
    markChanged(); setSourceChapter(null); setBlockId(''); setQuote('')
    if (!chapterId) return
    const ticket = ++readTicket.current
    readLock.current = true; setReading(true)
    const result = await request(() => api.readChapter({ bookId: book.book.id, chapterId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.id === chapterId) setSourceChapter(result.data)
    else if (result.ok) setMessage('读取的正文来源身份不符，请重新选择章节。')
    else setMessage(result.error.message)
  }

  function chooseBlock(id: string) {
    setBlockId(id); markChanged()
    const block = sourceChapter?.document.content.find((item) => item.attrs.id === id)
    setQuote(block ? blockText(block).slice(0, 2000) : '')
  }

  async function showSource(source: KnowledgeSource) {
    if (source.sourceType !== 'chapter_text' || unavailable) return
    const ticket = ++readTicket.current
    readLock.current = true; setReading(true); setEvidence(null); setMessage(null)
    const result = await request(() => api.readRevision({ bookId: book.book.id, chapterId: source.chapterId, revisionId: source.revisionId }))
    if (!mounted.current || ticket !== readTicket.current) return
    readLock.current = false; setReading(false)
    if (result.ok && result.data.bookId === book.book.id && result.data.chapterId === source.chapterId && result.data.id === source.revisionId) setEvidence({ source, revision: result.data })
    else if (result.ok) setMessage('读取的正文版本身份不符，未展示其他正文。')
    else setMessage('无法读取此条来源的原版本：' + result.error.message)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || pendingMessage || writeLock.current || readLock.current || archived || mode === 'view') return
    let input: CreateKnowledgeItemInput
    try {
      const parsed = parseKnowledgeFields({ ...fields, aliases: aliases.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) })
      let source: KnowledgeSourceInput | undefined
      if (sourceType === 'chapter_text') {
        if (!sourceChapter || !blockId) { setMessage('请选择正文来源的章节和段落。'); return }
        source = parseKnowledgeSource({ sourceType, bookId: book.book.id, chapterId: sourceChapter.id, revisionId: sourceChapter.revisionId, blockId, quote }, book.book.id)
        const selected = sourceChapter.document.content.find((block) => block.attrs.id === blockId)
        if (!selected || !blockText(selected).includes(quote)) { setMessage('引文必须是所选段落中连续的原文，请保留原文的字词与空白。'); return }
      } else if (sourceType) source = parseKnowledgeSource({ sourceType, bookId: book.book.id, quote }, book.book.id)
      input = { bookId: book.book.id, expectedKnowledgeRevision: expectedRevision, fields: parsed, ...(source ? { source } : {}) }
    } catch (caught) { setMessage(caught instanceof DomainError ? caught.detail.message : '条目内容无效，请检查后再保存。'); return }
    writeLock.current = true; setWriting(true); setMessage(null)
    const expectedItemId = mode === 'edit' ? detail?.id : null
    const accept = (saved: KnowledgeItemDetail) => {
      if (!mounted.current) return
      if (saved.bookId !== book.book.id || (expectedItemId && saved.id !== expectedItemId)) { setMessage('保存回执的条目身份不符，当前修改仍保留。'); return }
      setDirtyState(false); setDetail(saved); setMode('view'); resetSource(); setRefresh((value) => value + 1)
    }
    try {
      if (mode === 'edit' && detail) await onUpdate({ ...input, id: detail.id }, accept)
      else await onCreate(input, accept)
    } catch { if (mounted.current) setMessage('保存尚未确认，请保留当前修改并核对回执。') }
    finally { writeLock.current = false; if (mounted.current) setWriting(false) }
  }

  function filterKind(value: string) { if (mayLeave()) { setFilters({ ...filters, kind: value as KnowledgeKind | '' }); setOffset(0) } }
  function filterNature(value: string) { if (mayLeave()) { setFilters({ ...filters, nature: value as KnowledgeNature | '' }); setOffset(0) } }
  const sourceBlock = sourceChapter?.document.content.find((block) => block.attrs.id === blockId)
  // 回执未定期间保留可复制副本；原编辑控件会锁住，不能把 disabled 输入框当作唯一出口。
  const draftJson = pendingMessage && mode !== 'view' ? JSON.stringify({
    format: 'storyweave-knowledge-draft', version: 1, bookId: book.book.id,
    operation: mode === 'edit' ? 'knowledge.update' : 'knowledge.create',
    ...(mode === 'edit' && detail ? { itemId: detail.id } : {}), expectedKnowledgeRevision: expectedRevision,
    fields: { ...fields, aliases: aliases.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }, aliasesText: aliases,
    source: sourceType ? { sourceType, bookId: book.book.id, quote,
      ...(sourceType === 'chapter_text' ? { chapterId: sourceChapter?.id ?? null, revisionId: sourceChapter?.revisionId ?? null, blockId: blockId || null } : {}) } : null,
  }, null, 2) : null
  // 本地校验与服务错误都可见，避免一个旧服务错误遮住关闭保护或输入校验提示。
  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null

  return <Dialog title="故事星海 · 本书知识库" wide busy={unavailable} error={panelError} onClose={() => { if (mayLeave()) onClose() }}>
    <div className={styles.intro}><p>《{book.book.title}》的知识记录</p><span>作者全知视图 · 手工记录</span></div>
    <p className={shared.helpText}>设定、正文陈述和未来计划分别记录。这里的条目与作者决定属于本书；人物认知和推断不会自动成为世界事实。</p>
    {pendingMessage && <section className={styles.pending} aria-label="核对知识库操作结果">
      <h3>操作结果尚未确认</h3>
      <p role="status">{pendingMessage}</p>
      <button className={shared.button} type="button" disabled={checkingReceipt} onClick={onCheckReceipt}>{checkingReceipt ? '正在核对…' : '核对回执'}</button>
      {draftJson && <><label>条目草稿副本（只读，可全选复制）<textarea className={styles.draftCopy} readOnly value={draftJson} rows={9} spellCheck={false} onFocus={(event) => event.currentTarget.select()} /></label><p>请将以上内容复制到安全位置。此副本保留条目与新增来源；恢复页不会自动导入或重新提交它。</p></>}
      <label className={`${shared.checkLabel} ${styles.upgradeCheck}`}><input type="checkbox" checked={recoveryConfirmed} disabled={checkingReceipt} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />{draftJson ? '我已复制保留条目草稿，了解原操作可能已写入。' : '我了解知识库启用操作可能已成功，需要在恢复后核对结果。'}</label>
      <p>进入恢复页会关闭当前知识库面板。请先核对原操作结果，再决定如何处理，避免重复记录。</p>
      <button className={shared.button} type="button" disabled={!recoveryConfirmed || checkingReceipt} onClick={() => { if (pendingMessage && recoveryConfirmed && !checkingReceipt) onRecover() }}>进入草稿与恢复</button>
    </section>}
    {archived && <p className={shared.helpText}>作品已归档，可查看知识资料；解除归档后才能编辑。</p>}
    {statusLoading && <p className={styles.status} role="status">正在检查本书知识库…</p>}
    {!statusLoading && !status && <button className={shared.button} type="button" disabled={unavailable} onClick={() => { setMessage(null); setStatusRefresh((value) => value + 1) }}>重新检查知识库</button>}
    {status?.requiresUpgrade && <section className={styles.upgrade} aria-label="启用本书知识库">
      <h3>为这本书启用知识库</h3>
      <p>当前作品使用旧版数据结构。启用时会先保存本书数据库的独立备份，再升级数据结构，以存储知识条目、来源与修改记录。</p>
      <p>旧版应用无法读取升级后的数据库。升级成功后会显示备份位置，便于保留恢复副本。</p>
      <label className={`${shared.checkLabel} ${styles.upgradeCheck}`}><input type="checkbox" checked={upgradeConfirmed} disabled={unavailable || archived} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />我了解升级会修改本书数据库，并同意先备份后启用。</label>
      <button className={shared.primaryButton} type="button" disabled={unavailable || archived || !upgradeConfirmed} onClick={() => void upgrade()}>{writing || busy ? '正在备份并启用…' : '备份并启用知识库'}</button>
    </section>}
    {status?.backupPath && <p className={styles.backupPath}>升级前备份：{status.backupPath}</p>}
    {knowledgeReady && <div className={styles.layout}>
      <section className={styles.listPane} aria-label="知识条目列表">
        <form className={styles.search} onSubmit={(event) => { event.preventDefault(); if (mayLeave()) { setFilters({ ...filters, search: search.trim() }); setOffset(0) } }}>
          <label>搜索名称、别名或说明<input value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} disabled={unavailable || dirty} placeholder="例如：林舟、旧城、契约" /></label>
          <button className={shared.button} type="submit" disabled={unavailable || dirty}>查找</button>
        </form>
        <div className={styles.filters}><label>类型<select value={filters.kind} onChange={(event) => filterKind(event.target.value)} disabled={unavailable || dirty}><option value="">全部类型</option>{KNOWLEDGE_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label><label>性质<select value={filters.nature} onChange={(event) => filterNature(event.target.value)} disabled={unavailable || dirty}><option value="">全部性质</option>{KNOWLEDGE_NATURES.map((nature) => <option key={nature} value={nature}>{natureLabels[nature]}</option>)}</select></label></div>
        <div className={styles.listActions}><button className={shared.primaryButton} type="button" disabled={unavailable || dirty || archived || !page} onClick={() => beginEdit(true)}>新建条目</button><button className={shared.button} type="button" disabled={unavailable || dirty || listLoading} onClick={() => { setMessage(null); setRefresh((value) => value + 1) }}>刷新列表</button></div>
        {listLoading && <p className={styles.status} role="status">正在读取本书知识记录…</p>}
        {page && <p className={styles.status}>{page.total.toLocaleString()} 条记录 · 每页 {PAGE_SIZE} 条</p>}
        <ul className={styles.items}>{page?.items.map((item) => <li key={item.id}><button type="button" className={detail?.id === item.id ? styles.selected : ''} disabled={unavailable || dirty} aria-pressed={detail?.id === item.id} onClick={() => void selectItem(item.id)}><strong>{item.name}</strong><span>{kindLabels[item.kind]} · {natureLabels[item.nature]}</span><small>{decisionLabels[item.authorDecision]} · {freshnessLabels[item.freshness]}</small></button></li>)}</ul>
        {page?.items.length === 0 && <p className={styles.status}>没有匹配条目。可以补充一个人物或世界规则，随后关联正文出处。</p>}
        <div className={styles.paging}><button type="button" className={shared.button} disabled={unavailable || dirty || listLoading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button><button type="button" className={shared.button} disabled={unavailable || dirty || listLoading || page?.nextOffset == null} onClick={() => { if (page?.nextOffset != null) setOffset(page.nextOffset) }}>下一页</button></div>
      </section>
      <section className={styles.detailPane} aria-label="知识条目详情" aria-busy={reading}>
        {mode === 'view' ? detail ? <>
          <div className={styles.detailHeading}><div><span>{kindLabels[detail.kind]} · {natureLabels[detail.nature]}</span><h3>{detail.name}</h3></div><button className={shared.button} type="button" disabled={unavailable || archived} onClick={() => beginEdit(false)}>编辑条目</button></div>
          {detail.aliases.length > 0 && <p className={shared.helpText}>普通别名：{detail.aliases.join('、')}</p>}
          <div className={styles.labels}><span>{decisionLabels[detail.authorDecision]}</span><span>新鲜度：{freshnessLabels[detail.freshness]}</span><span>{conflictLabels[detail.conflictState]}</span></div>
          {detail.nature === 'future_plan' && <p className={styles.natureNote}>这是尚未写成的计划，不作为当前已发生事实。</p>}
          {detail.nature === 'ai_inference' && <p className={styles.natureNote}>这是推断记录，需要依据与作者判断，不能自动视为已成立。</p>}
          <p className={styles.body}>{detail.summary || '尚未填写说明。'}</p>
          <div className={styles.sectionHeading}><h4>来源与依据</h4><span>{detail.sources.length} 条</span></div>
          {detail.sources.length === 0 && <p className={shared.helpText}>暂无关联来源。条目内容是手工记录，尚无正文依据。</p>}
          <ul className={styles.sources}>{detail.sources.map((source) => <li key={source.id}><div><strong>{sourceLabels[source.sourceType]}</strong><span>{source.sourceType === 'chapter_text' ? validityLabels[source.validity] : '手工来源记录'}{source.sourceType === 'chapter_text' && source.referenceState === 'historical' ? ' · 引用历史稿' : ''}{source.sourceType === 'external' ? ' · 未核验外部内容' : ''}</span></div><blockquote>{source.quote}</blockquote>{source.sourceType === 'chapter_text' && <><p className={styles.sourceIds}>章节 {source.chapterId}<br />版本 {source.revisionId}<br />段落 {source.blockId}</p><button className={shared.button} type="button" onClick={() => void showSource(source)} disabled={unavailable}>查看此版本原文</button></>}</li>)}</ul>
          {evidence && <Evidence source={evidence.source} revision={evidence.revision} onClose={() => setEvidence(null)} />}
          <div className={styles.sectionHeading}><h4>最近修改</h4><span>完整历史保留在知识库</span></div>
          <ol className={styles.history}>{detail.revisions.map((revision) => <li key={revision.id}><time dateTime={revision.createdAt}>{displayTime(revision.createdAt)}</time><span>{revision.reason === 'created' ? '建立条目' : '更新条目'} · {revision.fields.name} · {decisionLabels[revision.fields.authorDecision]}</span></li>)}</ol>
        </> : <div className={styles.empty}><h3>{reading ? '正在读取条目…' : '从本书的一个人物开始'}</h3><p>选择条目查看出处与作者决定，或建立人物、地点和世界规则。关系图、时间线和自动整理将在后续阶段接入。</p></div> : <form className={styles.editorForm} onSubmit={(event) => void save(event)}>
          <div className={styles.detailHeading}><h3>{mode === 'create' ? '新建知识条目' : '编辑知识条目'}</h3><span>{dirty ? '有未保存修改' : '尚未修改'}</span></div>
          <label>名称<input autoFocus value={fields.name} maxLength={120} required disabled={unavailable} onChange={(event) => { setFields({ ...fields, name: event.target.value }); markChanged() }} /></label>
          <div className={styles.twoColumns}><label>类型<select value={fields.kind} disabled={unavailable} onChange={(event) => { setFields({ ...fields, kind: event.target.value as KnowledgeKind }); markChanged() }}>{KNOWLEDGE_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label><label>知识性质<select value={fields.nature} disabled={unavailable} onChange={(event) => { setFields({ ...fields, nature: event.target.value as KnowledgeNature }); markChanged() }}>{KNOWLEDGE_NATURES.map((nature) => <option key={nature} value={nature}>{natureLabels[nature]}</option>)}</select></label></div>
          <label>普通别名（每行一个）<textarea value={aliases} rows={2} maxLength={6049} disabled={unavailable} onChange={(event) => { setAliases(event.target.value); markChanged() }} /></label><p className={shared.helpText}>此处仅记录普通称谓；涉及秘密身份的对应关系需要独立的披露与知情范围，暂不在别名中记录。</p>
          <label>内容与适用范围<textarea value={fields.summary} rows={7} maxLength={20000} disabled={unavailable} onChange={(event) => { setFields({ ...fields, summary: event.target.value }); markChanged() }} placeholder="写下设定、条件、限制，以及需要保留的不确定性。" /></label>
          <div className={styles.twoColumns}><label>作者决定<select value={fields.authorDecision} disabled={unavailable} onChange={(event) => { setFields({ ...fields, authorDecision: event.target.value as KnowledgeItemFields['authorDecision'] }); markChanged() }}>{AUTHOR_DECISIONS.map((value) => <option key={value} value={value}>{decisionLabels[value]}</option>)}</select></label><label>冲突状态<select value={fields.conflictState} disabled={unavailable} onChange={(event) => { setFields({ ...fields, conflictState: event.target.value as KnowledgeItemFields['conflictState'] }); markChanged() }}>{CONFLICT_STATES.map((value) => <option key={value} value={value}>{conflictLabels[value]}</option>)}</select></label></div>
          <label>新鲜度标注<select value={fields.freshness} disabled={unavailable} onChange={(event) => { setFields({ ...fields, freshness: event.target.value as KnowledgeItemFields['freshness'] }); markChanged() }}>{KNOWLEDGE_FRESHNESS.map((value) => <option key={value} value={value}>{freshnessLabels[value]}</option>)}</select></label><p className={shared.helpText}>这些是作者的状态标注，不代表已完成自动检查或事实验证。</p>
          <div className={styles.sectionHeading}><h4>{mode === 'edit' ? '追加来源' : '关联来源'}</h4></div>
          <label>来源类型<select value={sourceType} disabled={unavailable} onChange={(event) => { resetSource(); setSourceType(event.target.value as typeof sourceType); markChanged() }}><option value="">暂不添加来源</option><option value="author_input">作者输入</option><option value="chapter_text">本书正文摘录</option><option value="external">外部资料说明</option></select></label>
          {sourceType === 'chapter_text' && <><label>来源章节<select value={sourceChapter?.id ?? ''} disabled={unavailable} onChange={(event) => void chooseChapter(event.target.value)}><option value="">选择章节</option>{book.chapters.map((item) => <option key={item.id} value={item.id}>第 {item.position + 1} 章 · {item.title}</option>)}</select></label>{sourceChapter && <><p className={styles.sourceIds}>固定正文版本：{sourceChapter.revisionId}</p><label>来源段落<select value={blockId} disabled={unavailable} onChange={(event) => chooseBlock(event.target.value)}><option value="">选择段落</option>{sourceChapter.document.content.map((block, index) => { const text = blockText(block); return text.trim() ? <option key={block.attrs.id} value={block.attrs.id}>段落 {index + 1} · {text.slice(0, 65)}</option> : null })}</select></label></>}{sourceBlock && <blockquote className={styles.blockPreview}>{blockText(sourceBlock)}</blockquote>}</>}
          {sourceType && <label>{sourceType === 'chapter_text' ? '连续原文引文（最多 2,000 字符）' : '来源说明（包含出处或作者判断依据）'}<textarea value={quote} maxLength={2000} rows={3} disabled={unavailable || (sourceType === 'chapter_text' && !blockId)} onChange={(event) => { setQuote(event.target.value); markChanged() }} required /></label>}
          {sourceType === 'chapter_text' && <p className={shared.helpText}>补充同章较新稿的引文，会推进本条对该章的索引复核基线，请先核对内容；历史引文仍保留。只改变采纳状态或重新整理不会自动确认旧引用。</p>}
          <div className={shared.formActions}><button className={shared.button} type="button" disabled={unavailable} onClick={discard}>{dirty ? '放弃本次修改' : '返回详情'}</button><button className={shared.primaryButton} type="submit" disabled={unavailable || archived || !fields.name.trim() || (mode === 'edit' && !dirty)}>{writing || busy ? '正在保存…' : '保存条目'}</button></div>
        </form>}
      </section>
    </div>}
  </Dialog>
}

function Evidence({ source, revision, onClose }: { source: KnowledgeSource; revision: RevisionSnapshot; onClose: () => void }) {
  if (source.sourceType !== 'chapter_text') return null
  const index = revision.document.content.findIndex((block) => block.attrs.id === source.blockId)
  const blocks = index < 0 ? [] : revision.document.content.slice(Math.max(0, index - 1), index + 2)
  return <section className={styles.evidence} aria-label="来源版本原文"><div className={styles.sectionHeading}><h4>来源版本上下文</h4><button type="button" className={shared.button} onClick={onClose}>收起原文</button></div><p className={styles.sourceIds}>版本 {revision.id}</p>{index < 0 ? <p className={shared.helpText}>该版本中未找到所引用段落，未跳转到其他正文。</p> : blocks.map((block) => <p className={block.attrs.id === source.blockId ? styles.evidenceQuote : styles.evidenceContext} key={block.attrs.id}>{block.type === 'horizontalRule' ? '分场线' : blockText(block)}</p>)}</section>
}
