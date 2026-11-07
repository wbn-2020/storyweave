import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { DomainError, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import { KNOWLEDGE_KINDS, type KnowledgeKind, type KnowledgeStatus } from '../../contracts/knowledge'
import {
  MAX_NOTE_BODY, MAX_NOTES, NOTE_CATEGORIES, NOTE_CATEGORY_LABELS, NOTE_PAGE_SIZE, NOTE_SCHEMA_VERSION,
  isNoteWriteReceiptFor, parseCreateNoteInput, parseListNotesInput, parseNoteFields, parsePromoteNoteInput, parseUpdateNoteInput,
  type CreateNoteInput, type ListNotesInput, type NoteCategory, type NoteDetail, type NoteFields, type NotePage,
  type PromoteNoteInput, type UpdateNoteInput,
} from '../../contracts/notes'
import { displayPreferenceStyle, type DisplayPreferences } from '../display-preferences'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import shared from '../App.module.css'
import paperStyles from './PaperSurface.module.css'
import styles from './NotesPanel.module.css'

export interface NotesPanelProps {
  api: StudioApi
  book: BookSnapshot
  displayPreferences: DisplayPreferences
  busy: boolean
  error?: string | null
  pendingMessage?: string | null
  checkingReceipt: boolean
  onCheckReceipt: () => void
  onRecover: () => void
  onClose: () => void
  onDirtyChange: (value: boolean) => void
  onUpgrade: (accept: (saved: KnowledgeStatus) => void) => Promise<void>
  onCreate: (input: CreateNoteInput, accept: (saved: NoteDetail) => boolean) => Promise<void>
  onUpdate: (input: UpdateNoteInput, accept: (saved: NoteDetail) => boolean) => Promise<void>
  onPromote: (input: PromoteNoteInput, accept: (saved: NoteDetail) => boolean) => Promise<void>
}

interface Listing { search: string; category: NoteCategory | ''; offset: number }
interface Versions { bookRevision: number; knowledgeRevision: number }
interface Draft {
  id: string
  fields: NoteFields
  expectedBookRevision: number
  expectedKnowledgeRevision: number
  expectedNoteRevision: number | null
}
interface PendingRead { command: 'knowledge.status' | 'notes.list' | 'notes.get'; requestId?: string }
type WriteOperation =
  | { command: 'notes.create'; input: CreateNoteInput }
  | { command: 'notes.update'; input: UpdateNoteInput }
  | { command: 'notes.promote'; input: PromoteNoteInput }

const kindLabels: Record<KnowledgeKind, string> = { person: '人物', place: '地点', organization: '组织', object: '物品', rule: '世界规则', theme: '主题', other: '其他' }
const initialListing: Listing = { search: '', category: '', offset: 0 }
const emptyFields: NoteFields = { category: 'inspiration', title: '', body: '' }
function validRevision(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }
function sameFields(left: NoteFields, right: NoteFields): boolean {
  return left.title === right.title && left.body === right.body && left.category === right.category
}
function validFields(fields: NoteFields): boolean {
  try { return sameFields(parseNoteFields({ category: fields.category, title: fields.title, body: fields.body }), fields) }
  catch { return false }
}
function validDetail(value: NoteDetail, bookId: string, id: string): boolean {
  return Boolean(value && value.bookId === bookId && value.id === id && validFields(value)
    && validRevision(value.bookRevision) && validRevision(value.knowledgeRevision) && validRevision(value.revision) && value.revision > 0
    && typeof value.archived === 'boolean' && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
    && (value.promotion === null ? value.promotedFields === null : value.promotion && typeof value.promotion.itemId === 'string'
      && value.promotion.itemId.length > 0 && validRevision(value.promotion.noteRevision) && value.promotion.noteRevision > 0
      && value.promotion.noteRevision <= value.revision && typeof value.promotion.createdAt === 'string'
      && KNOWLEDGE_KINDS.includes(value.promotion.kind)
      && value.promotedFields && validFields(value.promotedFields)))
}

function samePromotion(left: NoteDetail, right: NoteDetail): boolean {
  if (!left.promotion || !right.promotion) return left.promotion === right.promotion
  return left.promotion.itemId === right.promotion.itemId && left.promotion.kind === right.promotion.kind
    && left.promotion.noteRevision === right.promotion.noteRevision && left.promotion.createdAt === right.promotion.createdAt
    && Boolean(left.promotedFields && right.promotedFields && sameFields(left.promotedFields, right.promotedFields))
}

export function NotesPanel(props: NotesPanelProps) {
  return <NotesContent key={props.book.book.id} {...props} />
}

function NotesContent({ api, book, displayPreferences, busy, error, pendingMessage, checkingReceipt,
  onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onCreate, onUpdate, onPromote }: NotesPanelProps) {
  const bookId = book.book.id
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [page, setPage] = useState<NotePage | null>(null)
  const [listing, setListing] = useState<Listing>(initialListing)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<NoteCategory | ''>('')
  const [detail, setDetail] = useState<NoteDetail | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [reading, setReading] = useState<'status' | 'list' | 'detail' | null>(null)
  const [writing, setWriting] = useState<'create' | 'update' | 'promote' | 'upgrade' | null>(null)
  const [pendingRead, setPendingRead] = useState<PendingRead | null>(null)
  const [checkingRead, setCheckingRead] = useState(false)
  const [readMessage, setReadMessage] = useState<string | null>(null)
  const [writeIssue, setWriteIssue] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [needsRefresh, setNeedsRefresh] = useState(true)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const [promotionOpen, setPromotionOpen] = useState(false)
  const [promotionKind, setPromotionKind] = useState<KnowledgeKind | ''>('')
  const [promotionConfirmed, setPromotionConfirmed] = useState(false)
  const [focusIntent, setFocusIntent] = useState(0)
  const headingId = useId()
  const bodyHelpId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const readTicket = useRef(0)
  const receiptTicket = useRef(0)
  const readLock = useRef(false)
  const writeLock = useRef(false)
  const receiptLock = useRef(false)
  const pendingReadRef = useRef<PendingRead | null>(null)
  const writeIssueRef = useRef<string | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const dirtyRef = useRef(false)
  const lastWrite = useRef<WriteOperation | null>(null)
  const dirtyCallback = useRef(onDirtyChange)
  const external = useRef({ busy, pendingMessage, checkingReceipt })
  dirtyCallback.current = onDirtyChange
  external.current = { busy, pendingMessage, checkingReceipt }

  const ready = Boolean(status && !status.requiresUpgrade && status.schemaVersion >= NOTE_SCHEMA_VERSION)
  const archived = Boolean(book.book.archivedAt || page?.archived || detail?.archived)
  const processing = busy || reading !== null || writing !== null || checkingRead || checkingReceipt
  const blocked = processing || Boolean(pendingRead || pendingMessage || writeIssue)
  const formLocked = blocked || archived || needsRefresh

  function reportGuard() {
    // 父层的关窗保护与事件同步更新，不能等下一次渲染才发现已经开始读写或产生草稿。
    dirtyCallback.current(dirtyRef.current || readLock.current || writeLock.current || receiptLock.current
      || Boolean(pendingReadRef.current || writeIssueRef.current || external.current.pendingMessage)
      || external.current.busy || external.current.checkingReceipt)
  }
  function putDraft(value: Draft | null, changed: boolean) {
    draftRef.current = value; dirtyRef.current = changed
    setDraft(value); setDirty(changed); setRecoveryConfirmed(false); reportGuard()
  }
  function holdWrite(message: string) {
    writeIssueRef.current = message; setWriteIssue(message); setRecoveryConfirmed(false); reportGuard()
  }
  function operationBlocked(): boolean {
    return external.current.busy || external.current.checkingReceipt || Boolean(external.current.pendingMessage)
      || readLock.current || writeLock.current || receiptLock.current || Boolean(pendingReadRef.current || writeIssueRef.current)
  }
  function mayLeave(): boolean {
    if (operationBlocked()) { setMessage('仍有处理中或未确认的请求，请先核对结果，或留存副本后进入恢复。'); return false }
    if (dirtyRef.current) { setMessage('这条笔记有未保存内容。请先保存，或点击“放弃本次修改”后再继续。'); return false }
    return true
  }
  function beginRead(kind: NonNullable<typeof reading>): number | null {
    if (!mounted.current || operationBlocked()) return null
    readLock.current = true; setReading(kind); setMessage(null); setNotice(null); setReadMessage(null)
    setRecoveryConfirmed(false); reportGuard()
    return ++readTicket.current
  }
  function isCurrent(ticket: number): boolean { return mounted.current && ticket === readTicket.current }
  function finishRead(ticket: number) {
    if (!isCurrent(ticket)) return
    readLock.current = false; setReading(null); reportGuard()
  }
  function failedRead(failure: AppError, command: PendingRead['command']) {
    setNeedsRefresh(true); setPage(null)
    if (failure.code === 'REQUEST_TIMEOUT' || failure.code === 'SERVICE_UNAVAILABLE') {
      const pending = { command, ...(failure.requestId ? { requestId: failure.requestId } : {}) }
      pendingReadRef.current = pending; setPendingRead(pending)
      setReadMessage(failure.requestId ? '读取结果尚未确认。请查询原请求，查询结束后手动刷新列表。'
        : '本地服务不可用，未取得可查询的请求编号。请留存当前内容后进入恢复。')
      reportGuard()
    } else setMessage(failure.message)
  }
  function listInput(next: Listing, expected: Versions | null): ListNotesInput {
    return parseListNotesInput({ bookId, search: next.search, ...(next.category ? { category: next.category } : {}),
      offset: next.offset, limit: NOTE_PAGE_SIZE, ...(expected ? { expectedBookRevision: expected.bookRevision } : {}) })
  }
  function acceptPage(value: NotePage, next: Listing, expected: Versions | null): boolean {
    if (!value || value.bookId !== bookId || !validRevision(value.bookRevision) || !validRevision(value.knowledgeRevision)
      || typeof value.archived !== 'boolean' || !Array.isArray(value.items) || value.items.length > NOTE_PAGE_SIZE
      || !validRevision(value.total) || value.total > MAX_NOTES || next.offset + value.items.length > value.total
      || value.items.length !== Math.min(NOTE_PAGE_SIZE, Math.max(0, value.total - next.offset))
      || (value.nextOffset !== null && (value.nextOffset !== next.offset + value.items.length || value.nextOffset >= value.total || value.items.length === 0))
      || (value.nextOffset === null && next.offset + value.items.length !== value.total)
      || (expected && (value.bookRevision !== expected.bookRevision || value.knowledgeRevision !== expected.knowledgeRevision))
      || value.items.some((item) => !item || item.bookId !== bookId || typeof item.id !== 'string' || !item.id
        || !NOTE_CATEGORIES.includes(item.category) || (next.category && item.category !== next.category)
        || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120 || typeof item.excerpt !== 'string'
        || item.excerpt.length > 180 || typeof item.updatedAt !== 'string' || typeof item.createdAt !== 'string'
        || !validRevision(item.revision) || item.revision < 1)
      || new Set(value.items.map((item) => item.id)).size !== value.items.length) {
      setMessage('列表的身份、分页或版本与本次读取不符，请手动刷新列表。'); return false
    }
    // 列表只保留摘要；刷新列表不会重置右侧表单，也不会更新其保存基线。
    setPage({ bookId: value.bookId, bookRevision: value.bookRevision, knowledgeRevision: value.knowledgeRevision,
      archived: value.archived, total: value.total, nextOffset: value.nextOffset,
      items: value.items.map(({ id, bookId: itemBookId, category, title, excerpt, revision, createdAt, updatedAt, promotion }) =>
        ({ id, bookId: itemBookId, category, title, excerpt, revision, createdAt, updatedAt, promotion })) })
    setNeedsRefresh(false); return true
  }
  async function loadStatus() {
    if (!mayLeave()) return
    const ticket = beginRead('status')
    if (ticket === null) return
    setStatus(null); setPage(null); setNeedsRefresh(true)
    try {
      const result = await request(() => api.getKnowledgeStatus({ bookId }))
      if (!isCurrent(ticket)) return
      if (!result.ok) { failedRead(result.error, 'knowledge.status'); return }
      const saved = result.data
      if (!saved || saved.bookId !== bookId || !validRevision(saved.bookRevision) || !validRevision(saved.knowledgeRevision)
        || !Number.isSafeInteger(saved.schemaVersion) || saved.schemaVersion < 1) {
        setMessage('作品状态的身份或版本无效，请重新检查。'); return
      }
      setStatus(saved)
      if (saved.requiresUpgrade || saved.schemaVersion < NOTE_SCHEMA_VERSION) return
      setListing(initialListing); setReading('list')
      const notes = await request(() => api.listNotes(listInput(initialListing, saved)))
      if (!isCurrent(ticket)) return
      if (notes.ok) acceptPage(notes.data, initialListing, saved)
      else failedRead(notes.error, 'notes.list')
    } finally { finishRead(ticket) }
  }
  async function loadList(next: Listing, expected: Versions | null = null) {
    if (!ready || !mayLeave()) return
    let input: ListNotesInput
    try { input = listInput(next, expected) }
    catch (caught) { setMessage(caught instanceof DomainError ? caught.detail.message : '搜索条件无效，请检查后重试。'); return }
    const ticket = beginRead('list')
    if (ticket === null) return
    setListing(next); setPage(null); setNeedsRefresh(true); setPromotionOpen(false); setPromotionConfirmed(false)
    try {
      const result = await request(() => api.listNotes(input))
      if (!isCurrent(ticket)) return
      if (result.ok) acceptPage(result.data, next, expected)
      else failedRead(result.error, 'notes.list')
    } finally { finishRead(ticket) }
  }
  async function selectNote(id: string) {
    if (!page || !mayLeave()) return
    const summary = page.items.find((item) => item.id === id)
    if (!summary) return
    const snapshot = page
    const ticket = beginRead('detail')
    if (ticket === null) return
    lastWrite.current = null
    setSelectedId(id); setDetail(null); putDraft(null, false); setPromotionOpen(false); setPromotionConfirmed(false)
    setFocusIntent((value) => value + 1)
    try {
      const result = await request(() => api.getNote({ bookId, id }))
      if (!isCurrent(ticket)) return
      if (!result.ok) { failedRead(result.error, 'notes.get'); return }
      const saved = result.data
      if (!validDetail(saved, bookId, id) || saved.bookRevision !== snapshot.bookRevision
        || saved.knowledgeRevision !== snapshot.knowledgeRevision || saved.revision !== summary.revision || saved.archived !== snapshot.archived) {
        setPage(null); setNeedsRefresh(true); setMessage('笔记身份或版本与列表不一致，请刷新列表后重新选择。'); return
      }
      setDetail(saved)
    } finally { finishRead(ticket) }
  }

  useEffect(() => {
    let cancelled = false
    mounted.current = true
    // 等待本次挂载稳定后才发起首次读取，避免 StrictMode 的即时清理留下重复请求。
    queueMicrotask(() => { if (!cancelled && mounted.current) void loadStatus() })
    return () => {
      cancelled = true; mounted.current = false; readTicket.current += 1; receiptTicket.current += 1
      readLock.current = false; receiptLock.current = false; dirtyCallback.current(false)
    }
  }, [])
  useEffect(() => { reportGuard() }, [busy, pendingMessage, checkingReceipt])
  useEffect(() => { setRecoveryConfirmed(false) }, [pendingMessage, pendingRead, writeIssue])
  useEffect(() => {
    // 仅由选择、新建或编辑按钮发起焦点移动；迟到的详情不抢走搜索框或复制框的焦点。
    if (focusIntent > 0) (titleInput.current ?? heading.current)?.focus()
  }, [focusIntent])

  async function checkReadReceipt() {
    const pending = pendingReadRef.current
    if (!pending?.requestId || receiptLock.current || readLock.current || writeLock.current
      || external.current.busy || external.current.checkingReceipt || external.current.pendingMessage) return
    const ticket = ++receiptTicket.current
    receiptLock.current = true; setCheckingRead(true); reportGuard()
    try {
      const result = await request(() => api.getRequestStatus({ requestId: pending.requestId! }))
      if (!mounted.current || ticket !== receiptTicket.current || pendingReadRef.current !== pending) return
      if (!result.ok) { setReadMessage(`查询原读取失败：${result.error.message} 可稍后再查，或留存内容后进入恢复。`); return }
      if (result.data?.state === 'pending') { setReadMessage('原读取仍在处理中，请稍后再次查询。'); return }
      if (!result.data || (result.data.state !== 'unknown' && result.data.state !== 'completed')
        || (result.data.state === 'completed' && result.data.response?.command !== pending.command)) {
        setReadMessage('原请求返回的命令不符，仍暂停新的读取。请留存当前内容后进入恢复。'); return
      }
      // 回执只解除等待，绝不把迟到的结果当作当前列表或详情。
      pendingReadRef.current = null; setPendingRead(null); setReadMessage(null); setPage(null); setNeedsRefresh(true)
      setNotice(result.data.state === 'unknown' ? '原请求已无法查询。请手动重新检查状态或刷新列表。' : '原读取已结束。请手动重新检查状态或刷新列表。')
    } finally {
      if (mounted.current && ticket === receiptTicket.current) { receiptLock.current = false; setCheckingRead(false); reportGuard() }
    }
  }
  async function upgrade() {
    if (!status || ready || !upgradeConfirmed || archived || !mayLeave()) return
    writeLock.current = true; setWriting('upgrade'); setMessage(null); reportGuard()
    try {
      await onUpgrade((saved) => {
        if (!mounted.current) return
        if (!saved || saved.bookId !== bookId || saved.requiresUpgrade || !Number.isSafeInteger(saved.schemaVersion) || saved.schemaVersion < NOTE_SCHEMA_VERSION
          || !validRevision(saved.bookRevision) || !validRevision(saved.knowledgeRevision)) {
          holdWrite('升级回执尚未确认素材与笔记可用，请保留窗口并进入恢复核对。'); return
        }
        writeIssueRef.current = null; setWriteIssue(null); setStatus(saved); setPage(null); setNeedsRefresh(true)
        setUpgradeConfirmed(false); setNotice('升级已完成。请点击“刷新列表”读取本书笔记。'); reportGuard()
      })
    } catch { if (mounted.current) holdWrite('升级结果尚未确认，请留存当前状态后进入恢复核对。') }
    finally { writeLock.current = false; if (mounted.current) { setWriting(null); reportGuard() } }
  }
  function beginDraft(create: boolean) {
    if (!ready || archived || needsRefresh || !mayLeave() || (create ? !page : !detail)) return
    let next: Draft
    if (create) {
      try { next = { id: crypto.randomUUID(), fields: { ...emptyFields }, expectedBookRevision: page!.bookRevision,
        expectedKnowledgeRevision: page!.knowledgeRevision, expectedNoteRevision: null } }
      catch { setMessage('无法生成笔记标识，请关闭面板后重试。'); return }
      setDetail(null); setSelectedId(null)
    } else {
      const saved = detail!
      next = { id: saved.id, fields: { category: saved.category, title: saved.title, body: saved.body },
        expectedBookRevision: saved.bookRevision, expectedKnowledgeRevision: saved.knowledgeRevision, expectedNoteRevision: saved.revision }
    }
    // 创建标识和 CAS 基线只在明确开始编辑时确定，列表刷新与父层版本更新均不重写它们。
    lastWrite.current = null; putDraft(next, create); setMessage(null); setNotice(null)
    setPromotionOpen(false); setPromotionConfirmed(false); setFocusIntent((value) => value + 1)
  }
  function changeFields(change: Partial<NoteFields>) {
    const current = draftRef.current
    if (!current || formLocked || operationBlocked()) return
    putDraft({ ...current, fields: { ...current.fields, ...change } }, true); setMessage(null); setNotice(null)
  }
  function discard() {
    if (operationBlocked()) return
    putDraft(null, false); lastWrite.current = null; setMessage(null); setNotice('已放弃本次未保存内容。')
  }
  function acceptSaved(operation: WriteOperation, saved: NoteDetail, submitted: Draft | null, original: NoteDetail | null): boolean {
    if (!mounted.current || draftRef.current !== submitted) return false
    let valid = false
    try { valid = validDetail(saved, bookId, operation.input.id) && isNoteWriteReceiptFor(operation.input, saved)
      && (operation.command === 'notes.promote' ? Boolean(original && sameFields(saved, original))
        : saved.knowledgeRevision === submitted?.expectedKnowledgeRevision
          && (original ? samePromotion(saved, original) : saved.promotion === null)) }
    catch { valid = false }
    if (!valid) { holdWrite('回执的笔记身份、内容或版本不符。当前输入仍保留，请核对原请求或留存后进入恢复。'); return false }
    writeIssueRef.current = null; setWriteIssue(null); lastWrite.current = null
    setDetail(saved); setSelectedId(saved.id); putDraft(null, false); setPromotionOpen(false); setPromotionConfirmed(false)
    // 父层仍在确认写入；这里只更新已核对的详情，后续读取由作者手动发起。
    setPage(null); setNeedsRefresh(true); setMessage(null)
    setNotice(operation.command === 'notes.promote' ? '已转为本书设定。请刷新列表查看更新。' : '笔记已保存。请刷新列表查看更新。')
    return true
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const submitted = draftRef.current
    if (!submitted || !ready || archived || needsRefresh || operationBlocked()) return
    let operation: WriteOperation
    try {
      const input = { bookId, id: submitted.id, expectedBookRevision: submitted.expectedBookRevision, fields: submitted.fields }
      operation = submitted.expectedNoteRevision === null
        ? { command: 'notes.create', input: parseCreateNoteInput(input) }
        : { command: 'notes.update', input: parseUpdateNoteInput({ ...input, expectedNoteRevision: submitted.expectedNoteRevision }) }
    } catch (caught) { setMessage(caught instanceof DomainError ? caught.detail.message : '笔记内容无效，请检查后再保存。'); return }
    writeLock.current = true; lastWrite.current = operation; setWriting(operation.command === 'notes.create' ? 'create' : 'update')
    setMessage(null); setNotice(null); setRecoveryConfirmed(false); reportGuard()
    try {
      const accept = (saved: NoteDetail) => acceptSaved(operation, saved, submitted, detail)
      if (operation.command === 'notes.create') await onCreate(operation.input, accept)
      else await onUpdate(operation.input, accept)
    } catch { if (mounted.current) holdWrite('保存结果尚未确认，当前输入仍保留。请先核对回执，或留存内容后进入恢复。') }
    finally { writeLock.current = false; if (mounted.current) { setWriting(null); reportGuard() } }
  }
  async function promote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || draftRef.current || dirtyRef.current || !ready || needsRefresh || archived || operationBlocked()
      || detail.promotion || !detail.body.trim() || !promotionKind || !promotionConfirmed) return
    const source = detail
    let operation: Extract<WriteOperation, { command: 'notes.promote' }>
    try { operation = { command: 'notes.promote', input: parsePromoteNoteInput({ bookId, id: source.id,
      expectedBookRevision: source.bookRevision, expectedKnowledgeRevision: source.knowledgeRevision,
      expectedNoteRevision: source.revision, kind: promotionKind }) } }
    catch (caught) { setMessage(caught instanceof DomainError ? caught.detail.message : '转换条件无效，请检查后再试。'); return }
    writeLock.current = true; lastWrite.current = operation; setWriting('promote'); setMessage(null); setNotice(null)
    setRecoveryConfirmed(false); reportGuard()
    try { await onPromote(operation.input, (saved) => acceptSaved(operation, saved, null, source)) }
    catch { if (mounted.current) holdWrite('转为设定的结果尚未确认。请核对原请求，避免重复转换。') }
    finally { writeLock.current = false; if (mounted.current) { setWriting(null); reportGuard() } }
  }
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void loadList({ search: search.trim(), category, offset: 0 })
  }
  function movePage(offset: number) {
    if (!page) return
    // 包括返回第一页在内的翻页都固定首次读取的版本；只有明确刷新或应用搜索建立新快照。
    void loadList({ ...listing, offset }, { bookRevision: page.bookRevision, knowledgeRevision: page.knowledgeRevision })
  }

  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null
  const baseline = draft?.expectedBookRevision ?? detail?.bookRevision
  const directoryChanged = baseline !== undefined && baseline !== book.book.revision
  const recoveryVisible = Boolean(draft || pendingRead || pendingMessage || writeIssue || message || error)
  const recoveryCopy = JSON.stringify({ format: 'storyweave-note-draft', version: 1, bookId,
    observedBookRevision: book.book.revision, observedSchemaVersion: status?.schemaVersion ?? null,
    draft: draft ?? (detail ? { id: detail.id, fields: { category: detail.category, title: detail.title, body: detail.body },
      expectedBookRevision: detail.bookRevision, expectedKnowledgeRevision: detail.knowledgeRevision, expectedNoteRevision: detail.revision } : null),
    lastWrite: lastWrite.current, pendingRead, writeReceiptUnconfirmed: Boolean(pendingMessage || writeIssue),
    promotion: detail?.promotion ?? null, promotedFields: detail?.promotedFields ?? null,
  }, null, 2)
  const recoveryBlocked = reading !== null || writing !== null || checkingRead || checkingReceipt || (busy && !pendingMessage)

  return <Dialog title="素材与笔记" wide busy={processing} error={panelError} onClose={() => { if (mayLeave()) onClose() }}>
    <div className={styles.panel}>
      <div className={styles.intro}><p>《{book.book.title}》</p><span>本书私有笔记</span></div>
      <p className={shared.helpText}>灵感、素材和方法，保存在当前作品中。确认转为设定后才进入本书知识库。</p>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {archived && <p className={styles.notice}>作品已归档，可查看笔记；解除归档后才能新建、编辑或转为设定。</p>}
      {pendingRead && <section className={styles.pending} aria-label="核对笔记读取">
        <h3>读取结果尚未确认</h3><p role="status">{readMessage}</p>
        <p className={styles.identity}>原请求：{pendingRead.command}{pendingRead.requestId ? ` · ${pendingRead.requestId}` : ' · 无可查询编号'}</p>
        {pendingRead.requestId && <button type="button" className={shared.button} disabled={busy || checkingRead || checkingReceipt || Boolean(pendingMessage)} onClick={() => void checkReadReceipt()}>{checkingRead ? '正在查询…' : '查询原读取'}</button>}
      </section>}
      {(pendingMessage || writeIssue) && <section className={styles.pending} aria-label="核对笔记写入">
        <h3>写入结果尚未确认</h3><p role="status">{pendingMessage || writeIssue}</p>
        {pendingMessage && <button type="button" className={shared.button} disabled={checkingReceipt || checkingRead || writing !== null} onClick={onCheckReceipt}>{checkingReceipt ? '正在核对…' : '核对写入回执'}</button>}
        <p>当前输入仍保留。请核对原操作，确认之前不会再次提交。</p>
      </section>}
      {reading === 'status' && <p className={styles.status} role="status">正在检查本书笔记状态…</p>}
      {!status && reading !== 'status' && <button type="button" className={`${shared.button} ${styles.statusButton}`} disabled={blocked} onClick={() => void loadStatus()}>重新检查状态</button>}
      {status && !ready && <section className={styles.upgrade} aria-label="启用素材与笔记">
        <h3>为这本书启用素材与笔记</h3>
        <p>当前作品格式尚不支持独立笔记。启用时会先保存本书数据库的独立备份，再升级作品格式。</p>
        <p>旧版应用无法读取升级后的数据库。升级成功后会显示备份位置，请保留恢复副本。</p>
        <label className={shared.checkLabel}><input type="checkbox" checked={upgradeConfirmed} disabled={blocked || archived} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />我了解升级会修改本书数据库，并同意先备份后启用。</label>
        <button type="button" className={shared.primaryButton} disabled={blocked || archived || !upgradeConfirmed} onClick={() => void upgrade()}>{writing === 'upgrade' ? '正在备份并启用…' : '备份并启用笔记'}</button>
      </section>}
      {status?.backupPath && <p className={styles.identity}>升级前备份：{status.backupPath}</p>}
      {ready && <div className={styles.layout}>
        <section className={styles.catalog} aria-label="笔记列表">
          <form className={styles.search} onSubmit={submitSearch}>
            <label>搜索标题与正文<input type="search" value={search} maxLength={200} disabled={blocked} onChange={(event) => setSearch(event.target.value)} /></label>
            <label>笔记分类<select value={category} disabled={blocked} onChange={(event) => setCategory(event.target.value as NoteCategory | '')}>
              <option value="">全部分类</option>{NOTE_CATEGORIES.map((value) => <option key={value} value={value}>{NOTE_CATEGORY_LABELS[value]}</option>)}
            </select></label>
            <button type="submit" className={shared.button} disabled={blocked}>应用搜索与分类</button>
          </form>
          <div className={styles.actions}>
            <button type="button" className={shared.primaryButton} disabled={blocked || archived || !page || needsRefresh} onClick={() => beginDraft(true)}>新建笔记</button>
            <button type="button" className={shared.button} disabled={blocked} onClick={() => void loadList({ ...listing, offset: 0 })}>刷新列表</button>
          </div>
          {reading === 'list' && <p className={styles.status} role="status">正在读取笔记摘要…</p>}
          {!page && reading !== 'list' && <p className={styles.status}>请刷新列表读取笔记。当前详情与编辑内容会保留。</p>}
          {page && <>
            <p className={styles.status}>{listing.category ? NOTE_CATEGORY_LABELS[listing.category] : '全部分类'} · {page.total} 条{listing.search ? ` · 搜索“${listing.search}”` : ''}</p>
            {page.items.length === 0 && <div className={styles.listEmpty}><h3>{listing.search || listing.category ? '没有匹配的笔记' : '还没有笔记'}</h3><p>{listing.search || listing.category ? '调整搜索词或分类后，点击“应用搜索与分类”。' : '记下一个念头、一段素材，或一条写作方法。'}</p></div>}
            <ol className={styles.items}>{page.items.map((item) => <li key={item.id}>
              <button type="button" disabled={blocked} aria-current={selectedId === item.id ? 'true' : undefined} onClick={() => void selectNote(item.id)}>
                <span className={styles.itemMeta}>{NOTE_CATEGORY_LABELS[item.category]}{item.promotion ? ' · 已转为设定' : ''}</span>
                <strong>{item.title}</strong><span className={styles.excerpt}>{item.excerpt || '尚无正文'}</span>
                <small>更新于 {displayTime(item.updatedAt)}</small>
              </button>
            </li>)}</ol>
            <nav className={styles.paging} aria-label="笔记分页">
              <span>{page.total ? `${listing.offset + 1}–${listing.offset + page.items.length}` : '0'} / {page.total}</span>
              <button type="button" className={shared.button} disabled={blocked || listing.offset === 0} onClick={() => movePage(Math.max(0, listing.offset - NOTE_PAGE_SIZE))}>上一页</button>
              <button type="button" className={shared.button} disabled={blocked || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) movePage(page.nextOffset) }}>下一页</button>
            </nav>
          </>}
        </section>
        <section className={`${paperStyles.surface} ${styles.paper}`} data-paper-tone={displayPreferences.paperTone} style={displayPreferenceStyle(displayPreferences)} aria-labelledby={headingId}>
          <header className={styles.paperHeading}><h3 ref={heading} tabIndex={-1} id={headingId}>{draft ? (draft.expectedNoteRevision === null ? '新建笔记' : '编辑笔记') : reading === 'detail' ? '正在读取笔记…' : detail?.title || '给念头留一页纸'}</h3>
            {draft && <span>{dirty ? '尚未保存' : '当前内容已保存'}</span>}
          </header>
          {directoryChanged && <p className={styles.paperNotice}>当前笔记使用的作品版本与目录不同。编辑内容仍保留；请复制留存后放弃本次修改，关闭面板并刷新目录，再重新读取笔记。</p>}
          {draft ? <form className={styles.editor} onSubmit={save}>
            <label>标题<input ref={titleInput} value={draft.fields.title} maxLength={120} disabled={formLocked} onChange={(event) => changeFields({ title: event.target.value })} /></label>
            <label>分类<select value={draft.fields.category} disabled={formLocked} onChange={(event) => changeFields({ category: event.target.value as NoteCategory })}>
              {NOTE_CATEGORIES.map((value) => <option key={value} value={value}>{NOTE_CATEGORY_LABELS[value]}</option>)}
            </select></label>
            <label>正文<textarea className={styles.noteBody} value={draft.fields.body} maxLength={MAX_NOTE_BODY} rows={12} disabled={formLocked} aria-describedby={bodyHelpId} onChange={(event) => changeFields({ body: event.target.value })} /></label>
            <p id={bodyHelpId} className={styles.paperMeta}>{draft.fields.body.length.toLocaleString('zh-CN')} / 20,000 字符。正文可留空，补充并保存后才能转为设定。</p>
            <p className={styles.paperMeta}>编辑基线：作品版本 {draft.expectedBookRevision}{draft.expectedNoteRevision === null ? ' · 新笔记' : ` · 笔记版本 ${draft.expectedNoteRevision}`}</p>
            <div className={styles.actions}>
              <button type="submit" className={`${shared.primaryButton} ${styles.saveButton}`} disabled={formLocked}>{writing === 'create' || writing === 'update' ? '正在保存…' : '保存笔记'}</button>
              <button type="button" className={shared.button} disabled={blocked} onClick={discard}>放弃本次修改</button>
            </div>
          </form> : detail ? <>
            <p className={styles.paperMeta}>{NOTE_CATEGORY_LABELS[detail.category]} · 笔记版本 {detail.revision} · 更新于 {displayTime(detail.updatedAt)}</p>
            <div className={styles.prose}>{detail.body || <p className={styles.paperMeta}>这条笔记尚无正文。</p>}</div>
            <div className={styles.actions}>
              <button type="button" className={shared.button} disabled={blocked || archived || needsRefresh} onClick={() => beginDraft(false)}>编辑笔记</button>
              {!detail.promotion && <button type="button" className={shared.button} disabled={blocked || archived || needsRefresh || !detail.body.trim()} onClick={() => { setPromotionOpen(true); setPromotionKind(''); setPromotionConfirmed(false); setMessage(null) }}>转为本书设定</button>}
            </div>
            {!detail.promotion && !detail.body.trim() && <p className={styles.paperMeta}>补充正文并保存后，才能转为设定。</p>}
            {detail.promotion && <section className={styles.promotionRecord} aria-label="笔记转换记录">
              <h4>已转为本书设定</h4>
              <p className={styles.paperMeta}>知识条目标识：{detail.promotion.itemId}</p>
              <p className={styles.paperMeta}>来自笔记版本 {detail.promotion.noteRevision} · {displayTime(detail.promotion.createdAt)}</p>
              <p className={styles.paperMeta}>后续编辑笔记不会自动同步到知识条目。可在本书知识库继续维护设定。</p>
              {detail.promotedFields && <details><summary>查看转为设定时的原始文本</summary>
                <p className={styles.paperMeta}>分类：{NOTE_CATEGORY_LABELS[detail.promotedFields.category]}</p>
                <h4>{detail.promotedFields.title}</h4><div className={styles.prose}>{detail.promotedFields.body}</div>
              </details>}
            </section>}
            {promotionOpen && !detail.promotion && <form className={styles.promotionForm} onSubmit={promote}>
              <h4>确认转为设定</h4>
              <p className={styles.paperMeta}>将复制以下已保存的标题和正文，记为“作者设定 / 已采纳 / 未检查冲突”。设定正文会去除首尾空白，原笔记与转换时的原始文本保留。</p>
              <label>设定类型<select value={promotionKind} disabled={blocked || archived || needsRefresh} onChange={(event) => { setPromotionKind(event.target.value as KnowledgeKind | ''); setPromotionConfirmed(false) }}>
                <option value="">请选择设定类型</option>{KNOWLEDGE_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}
              </select></label>
              <div className={styles.promotionPreview}><h4>{detail.title}</h4><div className={styles.prose}>{detail.body.trim()}</div></div>
              <label className={shared.checkLabel}><input type="checkbox" checked={promotionConfirmed} disabled={blocked || archived || needsRefresh || !promotionKind} onChange={(event) => setPromotionConfirmed(event.target.checked)} />我已核对内容，确认将笔记版本 {detail.revision} 转为本书设定。</label>
              <div className={styles.actions}>
                <button type="submit" className={`${shared.primaryButton} ${styles.saveButton}`} disabled={blocked || archived || needsRefresh || !promotionKind || !promotionConfirmed}>{writing === 'promote' ? '正在转为设定…' : '确认转为设定'}</button>
                <button type="button" className={shared.button} disabled={blocked} onClick={() => { setPromotionOpen(false); setPromotionConfirmed(false) }}>取消转换</button>
              </div>
            </form>}
          </> : reading !== 'detail' && <div className={styles.empty}><p>从左侧选择笔记，或新建一条，保留写作途中想到的内容。</p><p>灵感、素材和方法按分类查找。保存后可继续编辑，需要成为设定时再明确确认。</p></div>}
          {reading === 'detail' && <p className={styles.paperMeta} role="status">正在读取所选笔记的保存版本…</p>}
        </section>
      </div>}
      {recoveryVisible && <details className={styles.recovery} open={Boolean(pendingRead || pendingMessage || writeIssue)}>
        <summary>复制留存与恢复</summary>
        <label>当前笔记与请求副本（只读，可全选复制）<textarea className={styles.draftCopy} readOnly value={recoveryCopy} rows={9} spellCheck={false} onFocus={(event) => event.currentTarget.select()} /></label>
        <p>副本包含当前输入、保存基线及已知请求标识。请复制到安全位置。进入恢复页会关闭本面板；恢复后需要核对本书笔记，副本不会自动导入或重发。</p>
        <label className={shared.checkLabel}><input type="checkbox" checked={recoveryConfirmed} disabled={recoveryBlocked} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />已复制留存，了解原操作可能已经写入，恢复后会先核对结果。</label>
        <button type="button" className={shared.button} disabled={recoveryBlocked || !recoveryConfirmed} onClick={() => { if (recoveryConfirmed && !recoveryBlocked) onRecover() }}>进入草稿与恢复</button>
      </details>}
      <div className={styles.footer}><span>笔记只属于当前作品。</span><button type="button" className={shared.button} disabled={processing} onClick={() => { if (mayLeave()) onClose() }}>关闭</button></div>
    </div>
  </Dialog>
}
