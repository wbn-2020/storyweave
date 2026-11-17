import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { DomainError, type AppError, type BookSnapshot, type StudioApi } from '../../contracts/api'
import { KNOWLEDGE_KINDS, type KnowledgeKind, type KnowledgeStatus } from '../../contracts/knowledge'
import { NOTE_THUMBNAIL_SCHEMA_VERSION, parseNoteThumbnailMetadata, sameNoteThumbnail, type NoteThumbnailFields, type NoteThumbnailMetadata } from '../../contracts/note-thumbnail'
import {
  MAX_NOTE_BODY, MAX_NOTES, NOTE_CATEGORIES, NOTE_CATEGORY_LABELS, NOTE_MATERIAL_SCHEMA_VERSION, NOTE_PAGE_SIZE, NOTE_SCHEMA_VERSION,
  isNoteWriteReceiptFor, parseCreateNoteInput, parseListNotesInput, parseNoteChapterIds, parseNoteFields, parseNoteMaterial, parsePromoteNoteInput, parseSetNoteChaptersInput, parseUpdateNoteInput, sameNoteChapters, sameNoteMaterial,
  type CreateNoteInput, type ListNotesInput, type NoteCategory, type NoteDetail, type NoteFields, type NoteMaterial, type NotePage,
  type PromoteNoteInput, type SetNoteChaptersInput, type UpdateNoteInput,
} from '../../contracts/notes'
import { displayPreferenceStyle, type DisplayPreferences } from '../display-preferences'
import { displayTime, request } from '../request'
import { Dialog } from './Dialog'
import shared from '../StellarShared.module.css'
import paperStyles from './PaperSurface.module.css'
import styles from './StellarNotes.module.css'
import materialStyles from './StellarInspiration.module.css'
import { StudioIcon } from './StudioIcon'
import { NoteChapterPicker } from './NoteChapterPicker'
import { NoteThumbnail, readNoteThumbnailFile } from './NoteThumbnail'

export interface NotesPanelProps {
  api: StudioApi
  book: BookSnapshot
  initialNoteId?: string
  displayPreferences: DisplayPreferences
  busy: boolean
  error?: string | null
  pendingMessage?: string | null
  checkingReceipt: boolean
  onCheckReceipt: () => void
  onRecover: () => void
  onClose: () => void
  onDirtyChange: (value: boolean) => void
  onGlobalMaterials?: () => void
  onUpgrade: (accept: (saved: KnowledgeStatus) => void) => Promise<void>
  onCreate: (input: CreateNoteInput, accept: (saved: NoteDetail) => boolean) => Promise<void>
  onUpdate: (input: UpdateNoteInput, accept: (saved: NoteDetail) => boolean) => Promise<void>
  onPromote: (input: PromoteNoteInput, accept: (saved: NoteDetail) => boolean) => Promise<void>
  onSetChapters: (input: SetNoteChaptersInput, accept: (saved: NoteDetail) => boolean) => Promise<void>
  onOpenChapter: (id: string) => void
}

interface Listing { search: string; category: NoteCategory | ''; tag: string; offset: number }
interface Versions { bookRevision: number; knowledgeRevision: number }
interface Draft {
  id: string
  fields: NoteFields
  material: NoteMaterial | null
  tags: string
  thumbnail?: NoteThumbnailFields | null
  expectedBookRevision: number
  expectedKnowledgeRevision: number
  expectedNoteRevision: number | null
}
interface PendingRead { command: 'knowledge.status' | 'notes.list' | 'notes.get'; requestId?: string }
type WriteOperation =
  | { command: 'notes.create'; input: CreateNoteInput }
  | { command: 'notes.update'; input: UpdateNoteInput }
  | { command: 'notes.promote'; input: PromoteNoteInput }
  | { command: 'notes.chapters'; input: SetNoteChaptersInput }

const kindLabels: Record<KnowledgeKind, string> = { person: '人物', place: '地点', organization: '组织', object: '物品', rule: '世界规则', theme: '主题', other: '其他' }
const initialListing: Listing = { search: '', category: '', tag: '', offset: 0 }
const emptyFields: NoteFields = { category: 'inspiration', title: '', body: '' }
function validRevision(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }
function sameFields(left: NoteFields, right: NoteFields): boolean {
  return left.title === right.title && left.body === right.body && left.category === right.category
}
function validFields(fields: NoteFields): boolean {
  try { return sameFields(parseNoteFields({ category: fields.category, title: fields.title, body: fields.body }), fields) }
  catch { return false }
}
function validChapters(value: string[] | null): boolean {
  try { return value === null || sameNoteChapters(value, parseNoteChapterIds(value)) }
  catch { return false }
}
function validMaterial(value: NoteMaterial | null): boolean {
  try { return value === null || sameNoteMaterial(value, parseNoteMaterial(value)) }
  catch { return false }
}
function validThumbnail(value: NoteThumbnailMetadata | null, id: string, revision: number): boolean {
  try { return value === null || sameNoteThumbnail(value, parseNoteThumbnailMetadata(value)) && value.noteId === id && value.noteRevision <= revision }
  catch { return false }
}
function validDetail(value: NoteDetail, bookId: string, id: string): boolean {
  return Boolean(value && value.bookId === bookId && value.id === id && validFields(value)
    && validRevision(value.bookRevision) && validRevision(value.knowledgeRevision) && validRevision(value.revision) && value.revision > 0 && value.revision <= value.bookRevision
    && typeof value.archived === 'boolean' && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' && validChapters(value.chapterIds) && validMaterial(value.material)
    && validThumbnail(value.thumbnail, value.id, value.revision)
    && (value.thumbnail === null || value.thumbnail.createdAt >= value.createdAt && value.thumbnail.createdAt <= value.updatedAt)
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

function NotesContent({ api, book, initialNoteId, displayPreferences, busy, error, pendingMessage, checkingReceipt, onGlobalMaterials,
  onCheckReceipt, onRecover, onClose, onDirtyChange, onUpgrade, onCreate, onUpdate, onPromote, onSetChapters, onOpenChapter }: NotesPanelProps) {
  const bookId = book.book.id
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [page, setPage] = useState<NotePage | null>(null)
  const [listing, setListing] = useState<Listing>(initialListing)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<NoteDetail | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [discardDraft, setDiscardDraft] = useState(false)
  const [quickBody, setQuickBody] = useState('')
  const [discardQuick, setDiscardQuick] = useState(false)
  const quickRef = useRef('')
  const [reading, setReading] = useState<'status' | 'list' | 'detail' | null>(null)
  const [writing, setWriting] = useState<'create' | 'update' | 'promote' | 'chapters' | 'upgrade' | null>(null)
  const [linkDraft, setLinkDraft] = useState<SetNoteChaptersInput | null>(null)
  const linkRef = useRef<SetNoteChaptersInput | null>(null)
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
  const quickCountId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const discardTrigger = useRef<HTMLButtonElement>(null)
  const tagFiltersRef = useRef<HTMLDivElement>(null)
  const restoreTagFocus = useRef(false)
  const thumbnailInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const initialReadStarted = useRef(false)
  const openedInitialNote = useRef<string | null>(null)
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
  const supportsMaterial = Boolean(status && status.schemaVersion >= NOTE_MATERIAL_SCHEMA_VERSION)
  const supportsThumbnails = Boolean(status && status.schemaVersion >= NOTE_THUMBNAIL_SCHEMA_VERSION)
  const tags = [...new Set([...(listing.tag ? [listing.tag] : []), ...(page?.items.flatMap((item) => item.material?.tags ?? []) ?? [])])]
  const archived = Boolean(book.book.archivedAt || page?.archived || detail?.archived)
  const processing = busy || reading !== null || writing !== null || checkingRead || checkingReceipt
  const blocked = processing || Boolean(pendingRead || pendingMessage || writeIssue)
  const formLocked = blocked || archived || needsRefresh

  function reportGuard() {
    // 父层的关窗保护与事件同步更新，不能等下一次渲染才发现已经开始读写或产生草稿。
    dirtyCallback.current(dirtyRef.current || Boolean(quickRef.current || linkRef.current) || readLock.current || writeLock.current || receiptLock.current
      || Boolean(pendingReadRef.current || writeIssueRef.current || external.current.pendingMessage)
      || external.current.busy || external.current.checkingReceipt)
  }
  function putDraft(value: Draft | null, changed: boolean) {
    draftRef.current = value; dirtyRef.current = changed
    setDraft(value); setDirty(changed); setDiscardDraft(false); setRecoveryConfirmed(false); reportGuard()
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
    if (linkRef.current) { setMessage('章节关联尚未确认。请先保存关联，或点击“取消关联修改”后再继续。'); return false }
    if (quickRef.current) { setMessage('快速记录尚未保存。请先保存到本书，或明确放弃本次记录后再继续。'); return false }
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
      ...(next.tag ? { tag: next.tag } : {}),
      offset: next.offset, limit: NOTE_PAGE_SIZE, ...(expected ? { expectedBookRevision: expected.bookRevision } : {}) })
  }
  function acceptPage(value: NotePage, next: Listing, expected: Versions | null, materialExpected = supportsMaterial, thumbnailsExpected = supportsThumbnails): boolean {
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
        || !validRevision(item.revision) || item.revision < 1 || !validChapters(item.chapterIds) || !validMaterial(item.material)
        || (item.material !== null) !== materialExpected || Boolean(next.tag && !item.material?.tags.includes(next.tag))
        || !validThumbnail(item.thumbnail, item.id, item.revision) || !thumbnailsExpected && item.thumbnail !== null
        || item.thumbnail !== null && (item.thumbnail.createdAt < item.createdAt || item.thumbnail.createdAt > item.updatedAt))
      || new Set(value.items.map((item) => item.id)).size !== value.items.length) {
      setMessage('列表的身份、分页或版本与本次读取不符，请手动刷新列表。'); return false
    }
    // 列表只保留摘要；刷新列表不会重置右侧表单，也不会更新其保存基线。
    setPage({ bookId: value.bookId, bookRevision: value.bookRevision, knowledgeRevision: value.knowledgeRevision,
      archived: value.archived, total: value.total, nextOffset: value.nextOffset,
      items: value.items.map(({ id, bookId: itemBookId, category, title, excerpt, revision, createdAt, updatedAt, promotion, chapterIds, material, thumbnail }) =>
        ({ id, bookId: itemBookId, category, title, excerpt, revision, createdAt, updatedAt, promotion, chapterIds, material, thumbnail })) })
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
      if (notes.ok) acceptPage(notes.data, initialListing, saved, saved.schemaVersion >= NOTE_MATERIAL_SCHEMA_VERSION, saved.schemaVersion >= NOTE_THUMBNAIL_SCHEMA_VERSION)
      else failedRead(notes.error, 'notes.list')
    } finally { finishRead(ticket) }
  }
  async function loadList(next: Listing, expected: Versions | null = null, focusTag = false) {
    if (!ready || !mayLeave()) return
    let input: ListNotesInput
    try { input = listInput(next, expected) }
    catch (caught) { setMessage(caught instanceof DomainError ? caught.detail.message : '搜索条件无效，请检查后重试。'); return }
    const ticket = beginRead('list')
    if (ticket === null) return
    restoreTagFocus.current = focusTag
    setListing(next); setPage(null); setNeedsRefresh(true); setPromotionOpen(false); setPromotionConfirmed(false)
    try {
      const result = await request(() => api.listNotes(input))
      if (!isCurrent(ticket)) return
      if (result.ok) acceptPage(result.data, next, expected)
      else failedRead(result.error, 'notes.list')
    } finally { finishRead(ticket) }
  }
  async function selectNote(id: string, intent: 'view' | 'promote' | 'chapters' = 'view', fromSavedResult = false) {
    if (!page || !mayLeave()) return
    const summary = page.items.find((item) => item.id === id)
    if (!summary && !fromSavedResult) return
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
      if (!validDetail(saved, bookId, id) || (saved.material !== null) !== supportsMaterial || !supportsThumbnails && saved.thumbnail !== null || saved.bookRevision !== snapshot.bookRevision
        || saved.knowledgeRevision !== snapshot.knowledgeRevision || saved.archived !== snapshot.archived
        || summary && (saved.revision !== summary.revision || !sameNoteChapters(saved.chapterIds, summary.chapterIds)
          || !sameNoteMaterial(saved.material, summary.material) || !sameNoteThumbnail(saved.thumbnail, summary.thumbnail))) {
        setPage(null); setNeedsRefresh(true); setMessage('笔记身份或版本与列表不一致，请刷新列表后重新选择。'); return
      }
      setDetail(saved)
      if (intent === 'promote' && !saved.archived && !saved.promotion && saved.body.trim()) { setPromotionOpen(true); setPromotionKind('') }
      if (intent === 'chapters' && !saved.archived) startLinks(saved)
    } finally { finishRead(ticket) }
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false; readTicket.current += 1; receiptTicket.current += 1
      readLock.current = false; receiptLock.current = false; dirtyCallback.current(false)
    }
  }, [])
  useEffect(() => {
    if (busy || pendingMessage || checkingReceipt || initialReadStarted.current) return
    let cancelled = false
    // 导航会在 busy 中挂载面板；等父层放行后只读一次，不能把初次门禁当作读取失败。
    queueMicrotask(() => {
      if (cancelled || !mounted.current || initialReadStarted.current || operationBlocked()) return
      initialReadStarted.current = true
      void loadStatus()
    })
    return () => { cancelled = true }
  }, [busy, pendingMessage, checkingReceipt])
  useEffect(() => { reportGuard() }, [busy, pendingMessage, checkingReceipt])
  useEffect(() => {
    if (!restoreTagFocus.current || processing) return
    restoreTagFocus.current = false
    // 筛选读取结束后，选项可能已移入首行；失败时不把焦点交给不存在的列表。
    const group = tagFiltersRef.current
    const more = group?.querySelector('details')
    if (more) more.open = false
    if (page) group?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus()
  }, [processing, page])
  useEffect(() => {
    if (!initialNoteId || !page || blocked || openedInitialNote.current === initialNoteId
      || dirtyRef.current || quickRef.current || linkRef.current) return
    // 复制结果按明确身份读取，目标不必落在列表首屏；仍核对当前列表的作品版本。
    openedInitialNote.current = initialNoteId
    void selectNote(initialNoteId, 'view', true)
  }, [initialNoteId, page, blocked])
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
    if (!status || status.schemaVersion >= NOTE_THUMBNAIL_SCHEMA_VERSION || !upgradeConfirmed || archived || !mayLeave()) return
    writeLock.current = true; setWriting('upgrade'); setMessage(null); reportGuard()
    try {
      await onUpgrade((saved) => {
        if (!mounted.current) return
        if (!saved || saved.bookId !== bookId || saved.requiresUpgrade || !Number.isSafeInteger(saved.schemaVersion) || saved.schemaVersion < NOTE_THUMBNAIL_SCHEMA_VERSION
          || !validRevision(saved.bookRevision) || !validRevision(saved.knowledgeRevision)) {
          holdWrite('升级回执尚未确认素材与笔记可用，请保留窗口并进入恢复核对。'); return
        }
        writeIssueRef.current = null; setWriteIssue(null); setStatus(saved); setPage(null); setNeedsRefresh(true)
        setUpgradeConfirmed(false); setDetail(null); setSelectedId(null); setNotice('升级已完成。请点击“刷新列表”读取本书笔记。'); reportGuard()
      })
    } catch { if (mounted.current) holdWrite('升级结果尚未确认，请留存当前状态后进入恢复核对。') }
    finally { writeLock.current = false; if (mounted.current) { setWriting(null); reportGuard() } }
  }
  function beginDraft(create: boolean) {
    if (!ready || archived || needsRefresh || !mayLeave() || (create ? !page : !detail)) return
    let next: Draft
    if (create) {
      try { next = { id: crypto.randomUUID(), fields: { ...emptyFields }, material: supportsMaterial ? { source: '', tags: [] } : null, tags: '', expectedBookRevision: page!.bookRevision,
        expectedKnowledgeRevision: page!.knowledgeRevision, expectedNoteRevision: null } }
      catch { setMessage('无法生成笔记标识，请关闭面板后重试。'); return }
      setDetail(null); setSelectedId(null)
    } else {
      const saved = detail!
      next = { id: saved.id, fields: { category: saved.category, title: saved.title, body: saved.body }, material: saved.material, tags: saved.material?.tags.join('，') ?? '',
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
  function changeMaterial(change: { source?: string; tags?: string }) {
    const current = draftRef.current
    if (!current?.material || formLocked || operationBlocked()) return
    putDraft({ ...current, material: { ...current.material, source: change.source ?? current.material.source }, tags: change.tags ?? current.tags }, true)
    setMessage(null); setNotice(null)
  }
  function discard() {
    if (operationBlocked()) return
    if (dirtyRef.current && !discardDraft) { setDiscardDraft(true); return }
    putDraft(null, false); lastWrite.current = null; setMessage(null); setNotice('已放弃本次未保存内容。')
  }
  async function pickThumbnail(file: File) {
    const submitted = draftRef.current
    if (!submitted || !supportsThumbnails || formLocked || operationBlocked()) return
    const ticket = beginRead('detail')
    if (ticket === null) return
    try {
      const thumbnail = await readNoteThumbnailFile(file)
      if (!isCurrent(ticket) || draftRef.current !== submitted) return
      putDraft({ ...submitted, thumbnail }, true); setNotice('图片已读入，将随本次笔记一起保存。')
    } catch (caught) {
      if (isCurrent(ticket)) setMessage(caught instanceof Error ? caught.message : '缩略图读取失败，原图和笔记输入仍保留。')
    } finally { finishRead(ticket) }
  }
  function removeThumbnail() {
    const current = draftRef.current
    if (!current || !supportsThumbnails || formLocked || operationBlocked()) return
    putDraft({ ...current, thumbnail: null }, true); setMessage(null); setNotice('保存笔记后移除当前配图；已保存旧图仍会保留。')
  }
  function acceptSaved(operation: WriteOperation, saved: NoteDetail, submitted: Draft | null, original: NoteDetail | null): boolean {
    if (!mounted.current || draftRef.current !== submitted) return false
    let valid = false
    try { valid = validDetail(saved, bookId, operation.input.id) && (saved.material !== null) === supportsMaterial && isNoteWriteReceiptFor(operation.input, saved)
      && (operation.command === 'notes.chapters' ? Boolean(original && sameFields(saved, original) && sameNoteMaterial(saved.material, original.material)
        && sameNoteThumbnail(saved.thumbnail, original.thumbnail)
        && samePromotion(saved, original) && saved.knowledgeRevision === original.knowledgeRevision)
        : operation.command === 'notes.promote' ? Boolean(original && sameFields(saved, original) && sameNoteMaterial(saved.material, original.material)
          && sameNoteThumbnail(saved.thumbnail, original.thumbnail) && sameNoteChapters(saved.chapterIds, original.chapterIds))
        : saved.knowledgeRevision === submitted?.expectedKnowledgeRevision
          && (submitted?.thumbnail !== undefined || sameNoteThumbnail(saved.thumbnail, original?.thumbnail ?? null))
          && (original ? samePromotion(saved, original) && sameNoteChapters(saved.chapterIds, original.chapterIds) : saved.promotion === null
            && (saved.chapterIds === null || saved.chapterIds.length === 0))) }
    catch { valid = false }
    if (!valid) { holdWrite('回执的笔记身份、内容或版本不符。当前输入仍保留，请核对原请求或留存后进入恢复。'); return false }
    writeIssueRef.current = null; setWriteIssue(null); lastWrite.current = null
    linkRef.current = null; setLinkDraft(null)
    setDetail(saved); setSelectedId(saved.id); putDraft(null, false); setPromotionOpen(false); setPromotionConfirmed(false)
    // 父层仍在确认写入；这里只更新已核对的详情，后续读取由作者手动发起。
    setPage(null); setNeedsRefresh(true); setMessage(null)
    setNotice(operation.command === 'notes.chapters' ? '章节关联已保存，正文保持原样。请刷新列表查看标记。'
      : operation.command === 'notes.promote' ? '已转为本书设定。请刷新列表查看更新。' : '笔记已保存。请刷新列表查看更新。')
    return true
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const submitted = draftRef.current
    if (!submitted || !ready || archived || needsRefresh || operationBlocked()) return
    let operation: WriteOperation
    try {
      const input = { bookId, id: submitted.id, expectedBookRevision: submitted.expectedBookRevision, fields: submitted.fields,
        ...(submitted.thumbnail === undefined ? {} : { thumbnail: submitted.thumbnail }),
        ...(submitted.material === null ? {} : { material: parseNoteMaterial({ source: submitted.material.source,
          // 标签文本未改动时保留原数组，避免正文编辑拆开标签内部的分隔符。
          tags: submitted.tags === submitted.material.tags.join('，') ? submitted.material.tags
            : submitted.tags.split(/[,，、\n]/).map((tag) => tag.trim()).filter(Boolean) }) }) }
      operation = submitted.expectedNoteRevision === null
        ? { command: 'notes.create', input: parseCreateNoteInput(input) }
        : { command: 'notes.update', input: parseUpdateNoteInput({ ...input, expectedNoteRevision: submitted.expectedNoteRevision }) }
    } catch (caught) {
      setMessage(caught instanceof DomainError ? caught.detail.message : '笔记内容无效，请检查后再保存。')
      if (!submitted.fields.title.trim()) titleInput.current?.focus()
      return
    }
    writeLock.current = true; lastWrite.current = operation; setWriting(operation.command === 'notes.create' ? 'create' : 'update')
    setMessage(null); setNotice(null); setRecoveryConfirmed(false); reportGuard()
    try {
      const accept = (saved: NoteDetail) => acceptSaved(operation, saved, submitted, detail)
      if (operation.command === 'notes.create') await onCreate(operation.input, accept)
      else await onUpdate(operation.input, accept)
    } catch { if (mounted.current) holdWrite('保存结果尚未确认，当前输入仍保留。请先核对回执，或留存内容后进入恢复。') }
    finally { writeLock.current = false; if (mounted.current) { setWriting(null); reportGuard() } }
  }
  function changeQuick(body: string) {
    if (operationBlocked() || archived || needsRefresh) return
    quickRef.current = body; setQuickBody(body); setDiscardQuick(false); setMessage(null); setNotice(null); reportGuard()
  }
  async function saveQuick(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!page || !quickRef.current.trim() || draftRef.current || linkRef.current || archived || needsRefresh || operationBlocked()) return
    let submitted: Draft
    try {
      const body = quickRef.current
      submitted = { id: crypto.randomUUID(), fields: parseNoteFields({ category: 'inspiration',
        title: body.trim().split(/\r?\n/, 1)[0].slice(0, 120), body }),
      material: supportsMaterial ? { source: '', tags: [] } : null, tags: '',
      expectedBookRevision: page.bookRevision, expectedKnowledgeRevision: page.knowledgeRevision, expectedNoteRevision: null }
    } catch (caught) { setMessage(caught instanceof DomainError ? caught.detail.message : '无法准备快速记录，原文仍保留。'); return }
    // 提交前转入固定身份的正式草稿；未知回执与恢复继续沿用同一笔记标识。
    putDraft(submitted, true); quickRef.current = ''; setQuickBody(''); setDiscardQuick(false)
    await save(event)
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
  function startLinks(source: NoteDetail) {
    if (source.chapterIds === null) { setMessage('请先在上方备份并启用章节关联，再选择章节。'); return }
    if (source.bookRevision !== book.book.revision) { setMessage('笔记与目录版本不同。请关闭面板刷新作品，再读取章节关联。'); return }
    const next: SetNoteChaptersInput = { bookId, id: source.id, expectedBookRevision: source.bookRevision,
      expectedNoteRevision: source.revision, chapterIds: [...source.chapterIds] }
    linkRef.current = next; setLinkDraft(next); setPromotionOpen(false); setMessage(null); setNotice(null); reportGuard()
  }
  function changeLinks(chapterIds: string[]) {
    if (!linkRef.current || operationBlocked()) return
    const next = { ...linkRef.current, chapterIds }
    linkRef.current = next; setLinkDraft(next); setRecoveryConfirmed(false); reportGuard()
  }
  function cancelLinks() {
    if (operationBlocked()) return
    linkRef.current = null; setLinkDraft(null); lastWrite.current = null; setMessage(null); reportGuard()
  }
  async function saveLinks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const source = detail, selected = linkRef.current
    if (!source || !selected || source.chapterIds === null || archived || needsRefresh || operationBlocked()
      || source.bookRevision !== book.book.revision || selected.chapterIds.some((id) => !book.chapters.some((chapter) => chapter.id === id))) return
    const operation: Extract<WriteOperation, { command: 'notes.chapters' }> = { command: 'notes.chapters', input: parseSetNoteChaptersInput(selected) }
    writeLock.current = true; lastWrite.current = operation; setWriting('chapters'); setMessage(null); setNotice(null)
    setRecoveryConfirmed(false); reportGuard()
    try { await onSetChapters(operation.input, (saved) => acceptSaved(operation, saved, null, source)) }
    catch { if (mounted.current) holdWrite('章节关联的保存结果尚未确认。选择与原请求已保留，请核对回执后再继续。') }
    finally { writeLock.current = false; if (mounted.current) { setWriting(null); reportGuard() } }
  }
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // 分类只使用通过离开门禁后的列表状态，拒绝切换时不留下隐藏筛选。
    void loadList({ search: search.trim(), category: listing.category, tag: listing.tag, offset: 0 })
  }
  function movePage(offset: number) {
    if (!page) return
    // 包括返回第一页在内的翻页都固定首次读取的版本；只有明确刷新或应用搜索建立新快照。
    void loadList({ ...listing, offset }, { bookRevision: page.bookRevision, knowledgeRevision: page.knowledgeRevision })
  }

  const panelError = [message, error].filter((value, index, values) => value && value !== pendingMessage && values.indexOf(value) === index).join(' ') || null
  const baseline = draft?.expectedBookRevision ?? detail?.bookRevision
  const directoryChanged = baseline !== undefined && baseline !== book.book.revision
  const recoveryVisible = Boolean(draft || quickBody || linkDraft || pendingRead || pendingMessage || writeIssue || message || error)
  const recoveryCopy = JSON.stringify({ format: 'storyweave-note-draft', version: 1, bookId,
    observedBookRevision: book.book.revision, observedSchemaVersion: status?.schemaVersion ?? null,
    draft: draft ?? (detail ? { id: detail.id, fields: { category: detail.category, title: detail.title, body: detail.body },
      material: detail.material, tags: detail.material?.tags.join('，') ?? '',
      expectedBookRevision: detail.bookRevision, expectedKnowledgeRevision: detail.knowledgeRevision, expectedNoteRevision: detail.revision } : null),
    lastWrite: lastWrite.current, pendingRead, writeReceiptUnconfirmed: Boolean(pendingMessage || writeIssue),
    promotion: detail?.promotion ?? null, promotedFields: detail?.promotedFields ?? null, chapterIds: detail?.chapterIds ?? null, linkDraft,
    thumbnail: detail?.thumbnail ?? null,
    quickBody,
  }, null, 2)
  const recoveryBlocked = reading !== null || writing !== null || checkingRead || checkingReceipt || (busy && !pendingMessage)
  const showingNote = Boolean(draft || detail || reading === 'detail')

  return <Dialog title="素材与笔记" wide busy={processing} error={panelError} onClose={() => { if (mayLeave()) onClose() }}>
    <div className={styles.panel}>
      <div className={materialStyles.scope} aria-label="素材范围"><button type="button" disabled={blocked || !onGlobalMaterials} onClick={() => { if (mayLeave()) onGlobalMaterials?.() }}><StudioIcon name="spark" />全局灵感</button><button type="button" aria-pressed="true"><StudioIcon name="read" />本书素材</button></div>
      <div className={styles.intro}><p>《{book.book.title}》</p><span>本书私有笔记</span></div>
      {initialNoteId && selectedId === initialNoteId && !detail && <button type="button" className={shared.button}
        disabled={blocked || !page || needsRefresh} onClick={() => void selectNote(initialNoteId, 'view', true)}>重新读取保存的素材</button>}
      <p className={shared.helpText}>灵感、素材和方法，保存在当前作品中。确认转为设定后才进入本书知识库。</p>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {archived && <p className={styles.notice}>作品已归档，可查看笔记；解除归档后才能新建、编辑或转为设定。</p>}
      {pendingRead && <section className={styles.pending} aria-label="核对笔记读取">
        <h3>读取结果尚未确认</h3><p role="status">{readMessage}</p>
        <p className={styles.identity}>原请求：{pendingRead.command}{pendingRead.requestId ? ` · ${pendingRead.requestId}` : ' · 无可查询编号'}</p>
        {pendingRead.requestId && <button type="button" className={shared.button} aria-busy={checkingRead} disabled={busy || checkingRead || checkingReceipt || Boolean(pendingMessage)} onClick={() => void checkReadReceipt()}>{checkingRead ? '正在查询…' : '查询原读取'}</button>}
      </section>}
      {(pendingMessage || writeIssue) && <section className={styles.pending} aria-label="核对笔记写入">
        <h3>写入结果尚未确认</h3><p role="status">{pendingMessage || writeIssue}</p>
        {pendingMessage && <button type="button" className={shared.button} aria-busy={checkingReceipt} disabled={checkingReceipt || checkingRead || writing !== null} onClick={onCheckReceipt}>{checkingReceipt ? '正在核对…' : '核对写入回执'}</button>}
        <p>当前输入仍保留。请核对原操作，确认之前不会再次提交。</p>
      </section>}
      {reading === 'status' && <p className={styles.status} role="status">正在检查本书笔记状态…</p>}
      {!status && reading !== 'status' && <button type="button" className={`${shared.button} ${styles.statusButton}`} disabled={blocked} onClick={() => void loadStatus()}>重新检查状态</button>}
      {status && status.schemaVersion < NOTE_THUMBNAIL_SCHEMA_VERSION && <section className={styles.upgrade} aria-label="启用素材缩略图、标签、出处与章节关联">
        <h3>{ready ? '为本书启用素材配图' : '为这本书启用素材与笔记'}</h3>
        <p>{ready ? '现有笔记可继续查看和编辑。启用缩略图及当前格式缺少的素材能力前' : '当前作品格式尚不支持独立笔记。启用时'}会先保存本书数据库的独立备份，再升级作品格式。</p>
        <p>旧版应用无法读取升级后的数据库。升级成功后会显示备份位置，请保留恢复副本。</p>
        <label className={shared.checkLabel}><input type="checkbox" checked={upgradeConfirmed} disabled={blocked || archived} onChange={(event) => setUpgradeConfirmed(event.target.checked)} />我了解升级会修改本书数据库，并同意先备份后启用。</label>
        <button type="button" className={shared.primaryButton} aria-busy={writing === 'upgrade'} disabled={blocked || archived || !upgradeConfirmed} onClick={() => void upgrade()}>{writing === 'upgrade' ? '正在备份并启用…' : ready ? '备份并启用素材信息' : '备份并启用笔记'}</button>
      </section>}
      {status?.backupPath && <p className={styles.identity}>升级前备份：{status.backupPath}</p>}
      {ready && <div className={styles.layout}>
        <aside className={materialStyles.filters} aria-label="本书素材分类">
          <h4>素材分类</h4>
          <button type="button" aria-pressed={!listing.category} disabled={blocked}
            onClick={() => void loadList({ search: search.trim(), category: '', tag: '', offset: 0 })}><StudioIcon name="grid" />全部</button>
          {NOTE_CATEGORIES.map((value) => <button key={value} type="button" aria-pressed={listing.category === value} disabled={blocked}
            onClick={() => void loadList({ search: search.trim(), category: value, tag: '', offset: 0 })}><StudioIcon name={value === 'inspiration' ? 'bulb' : value === 'method' ? 'workflow' : 'notes'} />{NOTE_CATEGORY_LABELS[value]}</button>)}
        </aside>
        <section className={styles.catalog} aria-label="笔记列表">
          <form className={styles.search} onSubmit={submitSearch}>
            <label><span className={materialStyles.srOnly}>{supportsMaterial ? '搜索标题、正文、标签与出处' : '搜索标题与正文'}</span><input type="search" placeholder="搜索本书灵感与素材…" value={search} maxLength={200} disabled={blocked} onChange={(event) => setSearch(event.target.value)} /></label>
            <button type="submit" className={shared.button} disabled={blocked}><StudioIcon name="search" size={16} />搜索</button>
          </form>
          <div className={styles.actions}>
            <button type="button" className={shared.primaryButton} disabled={blocked || archived || !page || needsRefresh} onClick={() => beginDraft(true)}>新建笔记</button>
            <button type="button" className={shared.button} disabled={blocked} onClick={() => void loadList({ ...listing, offset: 0 })}>刷新列表</button>
          </div>
          {reading === 'list' && <p className={styles.status} role="status">正在读取笔记摘要…</p>}
          {!page && reading !== 'list' && <p className={styles.status}>请刷新列表读取笔记。当前详情与编辑内容会保留。</p>}
          {page && <>
            <p className={styles.status}>{listing.category ? NOTE_CATEGORY_LABELS[listing.category] : '全部分类'} · {page.total} 条{listing.search ? ` · 搜索“${listing.search}”` : ''}{listing.tag ? ` · 标签“${listing.tag}”` : ''}</p>
            {!!tags.length && <div ref={tagFiltersRef} className={materialStyles.tagFilters} aria-label="当前页标签及已选标签">
              <button type="button" aria-pressed={!listing.tag} disabled={blocked} onClick={() => void loadList({ ...listing, tag: '', offset: 0 })}>全部标签</button>
              {tags.slice(0, 4).map((tag) => <button key={tag} type="button" title={tag} aria-pressed={listing.tag === tag} disabled={blocked}
                onClick={() => void loadList({ ...listing, tag: listing.tag === tag ? '' : tag, offset: 0 })}>{tag}</button>)}
              {tags.length > 4 && <details className={materialStyles.moreTags}><summary>更多标签（{tags.length - 4}）</summary><div className={materialStyles.tagOptions}>
                {tags.slice(4).map((tag) => <button key={tag} type="button" title={tag} aria-pressed={listing.tag === tag} disabled={blocked}
                  onClick={() => void loadList({ ...listing, tag: listing.tag === tag ? '' : tag, offset: 0 }, null, true)}>{tag}</button>)}
              </div></details>}
            </div>}
            {page.items.length === 0 && <div className={styles.listEmpty}><h3>{listing.search || listing.category || listing.tag ? '没有匹配的笔记' : '还没有笔记'}</h3><p>{listing.tag ? '可点击“全部标签”取消标签筛选，或调整搜索词与分类。' : listing.search || listing.category ? '调整搜索词后点击“搜索”，或切换左侧分类。' : '记下一个念头、一段素材，或一条写作方法。'}</p></div>}
            <ol className={styles.items}>{page.items.map((item) => <li key={item.id}>
              <div className={styles.cardBody}>
                {item.thumbnail && <NoteThumbnail api={api} bookId={bookId} metadata={item.thumbnail} name={item.title} className={styles.thumbnail} />}
              <button type="button" disabled={blocked} aria-current={selectedId === item.id ? 'true' : undefined} onClick={() => void selectNote(item.id)}>
                <span className={styles.itemMeta}>{NOTE_CATEGORY_LABELS[item.category]}{item.promotion ? ' · 已转为设定' : ''}{item.chapterIds?.length ? ` · 已关联 ${item.chapterIds.length} 章` : ''}</span>
                <strong>{item.title}</strong><span className={styles.excerpt}>{item.excerpt || '尚无正文'}</span>
                {!!item.material?.tags.length && <span className={materialStyles.tags}>{item.material.tags.map((tag) => <span key={tag} title={tag}>{tag}</span>)}</span>}
              </button>
              </div>
              <div className={styles.cardFooter}>
                <p className={materialStyles.source} title={[item.material?.source, `更新于 ${displayTime(item.updatedAt)}`].filter(Boolean).join(' · ')}><StudioIcon name={item.material?.source ? 'read' : 'clock'} size={14} /><span>{item.material?.source || `更新于 ${displayTime(item.updatedAt)}`}</span></p>
                <div className={materialStyles.cardActions}>
                  <button type="button" className={shared.button} disabled={blocked || archived || needsRefresh || Boolean(item.promotion)} onClick={() => void selectNote(item.id, 'promote')}><StudioIcon name="notes" size={14} />{item.promotion ? '已转为设定' : '转为设定'}</button>
                  <button type="button" className={shared.button} disabled={blocked || archived || needsRefresh} onClick={() => void selectNote(item.id, 'chapters')}><StudioIcon name="link" size={14} />关联章节</button>
                </div>
              </div>
            </li>)}</ol>
            <nav className={styles.paging} aria-label="笔记分页">
              <span>{page.total ? `${listing.offset + 1}–${listing.offset + page.items.length}` : '0'} / {page.total}</span>
              <button type="button" className={shared.button} disabled={blocked || listing.offset === 0} onClick={() => movePage(Math.max(0, listing.offset - NOTE_PAGE_SIZE))}>上一页</button>
              <button type="button" className={shared.button} disabled={blocked || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) movePage(page.nextOffset) }}>下一页</button>
            </nav>
          </>}
        </section>
        <section className={showingNote ? `${paperStyles.surface} ${styles.paper}` : styles.quickPane} data-paper-tone={draft ? displayPreferences.paperTone : undefined} style={showingNote ? displayPreferenceStyle(displayPreferences) : undefined} aria-labelledby={headingId}>
          {showingNote && <header className={styles.paperHeading}><h3 ref={heading} tabIndex={-1} id={headingId}>{draft ? (draft.expectedNoteRevision === null ? '新建笔记' : '编辑笔记') : reading === 'detail' ? '正在读取笔记…' : detail?.title}</h3>
            {draft && <span>{dirty ? '尚未保存' : '当前内容已保存'}</span>}
            {detail && !draft && <button type="button" className={shared.button} disabled={blocked} title="收起详情并返回快速记录" aria-label="收起详情并返回快速记录"
              onClick={() => { if (mayLeave()) { setDetail(null); setSelectedId(null); setPromotionOpen(false); setPromotionConfirmed(false) } }}><StudioIcon name="close" size={16} /></button>}
          </header>}
          {directoryChanged && <p className={styles.paperNotice}>当前笔记使用的作品版本与目录不同。编辑内容仍保留；请复制留存后放弃本次修改，关闭面板并刷新目录，再重新读取笔记。</p>}
          {draft ? <form className={styles.editor} onSubmit={save}>
            <label>标题<input ref={titleInput} value={draft.fields.title} maxLength={120} disabled={formLocked} onChange={(event) => changeFields({ title: event.target.value })} /></label>
            <label>分类<select value={draft.fields.category} disabled={formLocked} onChange={(event) => changeFields({ category: event.target.value as NoteCategory })}>
              {NOTE_CATEGORIES.map((value) => <option key={value} value={value}>{NOTE_CATEGORY_LABELS[value]}</option>)}
            </select></label>
            <label>正文<textarea className={styles.noteBody} value={draft.fields.body} maxLength={MAX_NOTE_BODY} rows={12} disabled={formLocked} aria-describedby={bodyHelpId} onChange={(event) => changeFields({ body: event.target.value })} /></label>
            <p id={bodyHelpId} className={styles.paperMeta}>{draft.fields.body.length.toLocaleString('zh-CN')} / 20,000 字符。正文可留空，补充并保存后才能转为设定。</p>
            {draft.material && <><label>出处<textarea rows={2} maxLength={2000} value={draft.material.source} disabled={formLocked}
              placeholder="作品、作者、章节、页码或链接" onChange={(event) => changeMaterial({ source: event.target.value })} /></label>
              <label>标签<input maxLength={1100} value={draft.tags} disabled={formLocked} placeholder="用逗号分隔，最多 20 个，每个最多 50 字符"
                onChange={(event) => changeMaterial({ tags: event.target.value })} /></label></>}
            {supportsThumbnails && <section className={styles.thumbnailEditor} aria-label="素材缩略图">
              <h4>素材配图</h4>
              {draft.thumbnail ? <img className={styles.draftThumbnail} src={`data:${draft.thumbnail.mime};base64,${draft.thumbnail.dataBase64}`} alt={draft.thumbnail.alt || draft.fields.title}
                onError={() => setMessage('当前缩略图无法显示，请重新选择有效图片。')} />
                : draft.thumbnail === undefined && detail?.thumbnail ? <NoteThumbnail api={api} bookId={bookId} metadata={detail.thumbnail} name={detail.title} className={styles.thumbnail} />
                  : <p className={styles.paperMeta}>尚未配图。</p>}
              <input ref={thumbnailInput} type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={formLocked}
                onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void pickThumbnail(file) }} />
              <div className={styles.actions}>
                <button type="button" className={shared.button} disabled={formLocked} onClick={() => thumbnailInput.current?.click()}><StudioIcon name="plus" size={16} />选择本地图片</button>
                <button type="button" className={shared.button} disabled={formLocked || !(draft.thumbnail || draft.thumbnail === undefined && detail?.thumbnail)} onClick={removeThumbnail}>移除当前配图</button>
              </div>
              <p className={styles.paperMeta}>单张不超过 2 MiB，支持 PNG、JPEG、WebP。换图和移除后仍保留旧图，占用本书素材图片预算。</p>
            </section>}
            <p className={styles.paperMeta}>编辑基线：作品版本 {draft.expectedBookRevision}{draft.expectedNoteRevision === null ? ' · 新笔记' : ` · 笔记版本 ${draft.expectedNoteRevision}`}</p>
            <div className={styles.actions}>
              <button type="submit" className={`${shared.primaryButton} ${styles.saveButton}`} aria-busy={writing === 'create' || writing === 'update'} disabled={formLocked}>{writing === 'create' || writing === 'update' ? '正在保存…' : '保存笔记'}</button>
              <button ref={discardTrigger} type="button" className={shared.button} disabled={blocked}
                onClick={() => { if (!operationBlocked()) { if (dirtyRef.current) setDiscardDraft(true); else discard() } }}>放弃本次修改</button>
            </div>
            {discardDraft && <div className={styles.paperNotice} role="alert"><p>确定放弃这份笔记尚未保存的修改？已保存的笔记会保留。</p><div className={styles.actions}>
              <button type="button" className={shared.button} disabled={blocked} onClick={discard}>确认放弃修改</button>
              <button type="button" className={shared.button} disabled={blocked} onClick={() => { setDiscardDraft(false); discardTrigger.current?.focus() }}>继续编辑</button>
            </div></div>}
          </form> : detail ? <>
            <p className={styles.paperMeta}>{NOTE_CATEGORY_LABELS[detail.category]} · 笔记版本 {detail.revision} · 更新于 {displayTime(detail.updatedAt)}</p>
            {detail.thumbnail && <NoteThumbnail api={api} bookId={bookId} metadata={detail.thumbnail} name={detail.title} className={styles.detailThumbnail} />}
            {detail.material?.source && <p className={styles.materialSource}>出处：{detail.material.source}</p>}
            {!!detail.material?.tags.length && <p className={styles.materialTags}>{detail.material.tags.map((tag) => <span key={tag}>{tag}</span>)}</p>}
            <div className={styles.prose}>{detail.body || <p className={styles.paperMeta}>这条笔记尚无正文。</p>}</div>
            <div className={styles.actions}>
              <button type="button" className={shared.button} disabled={blocked || archived || needsRefresh || Boolean(linkDraft)} onClick={() => beginDraft(false)}>编辑笔记</button>
              {!detail.promotion && <button type="button" className={shared.button} disabled={blocked || archived || needsRefresh || Boolean(linkDraft) || !detail.body.trim()} onClick={() => { setPromotionOpen(true); setPromotionKind(''); setPromotionConfirmed(false); setMessage(null) }}>转为本书设定</button>}
            </div>
            <section className={styles.chapterLinks} aria-label="笔记关联章节">
              <h4><StudioIcon name="link" size={16} />关联章节</h4>
              {detail.chapterIds === null ? <p className={styles.paperMeta}>当前格式尚未启用章节关联，可在上方先备份升级。</p>
                : <>{!detail.chapterIds.length && !linkDraft && <p className={styles.paperMeta}>尚未关联章节。</p>}
                  {!!detail.chapterIds.length && <ul>{detail.chapterIds.map((id) => <li key={id}>
                    <button type="button" className={shared.button} disabled={blocked || Boolean(linkDraft) || !book.chapters.some((chapter) => chapter.id === id)}
                      onClick={() => { if (mayLeave()) onOpenChapter(id) }}><StudioIcon name="read" size={14} />{book.chapters.find((chapter) => chapter.id === id)?.title ?? '章节不在当前目录'}</button>
                  </li>)}</ul>}
                  {!linkDraft && <button type="button" className={shared.button} disabled={blocked || archived || needsRefresh || directoryChanged} onClick={() => startLinks(detail)}>选择 / 调整关联章节</button>}
                  {linkDraft && <form className={styles.editor} onSubmit={saveLinks}>
                    <NoteChapterPicker book={book} value={linkDraft.chapterIds} disabled={blocked || archived || directoryChanged} onChange={changeLinks} />
                    <div className={styles.actions}><button className={`${shared.primaryButton} ${styles.saveButton}`} type="submit" aria-busy={writing === 'chapters'}
                      disabled={blocked || archived || needsRefresh || directoryChanged || sameNoteChapters(linkDraft.chapterIds, detail.chapterIds)
                        || linkDraft.chapterIds.some((id) => !book.chapters.some((chapter) => chapter.id === id))}>{writing === 'chapters' ? '正在保存…' : linkDraft.chapterIds.length ? '确认保存关联' : '确认解除全部关联'}</button>
                      <button className={shared.button} type="button" disabled={blocked} onClick={cancelLinks}>取消关联修改</button></div>
                  </form>}
                </>}
            </section>
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
                <button type="submit" className={`${shared.primaryButton} ${styles.saveButton}`} aria-busy={writing === 'promote'} disabled={blocked || archived || needsRefresh || !promotionKind || !promotionConfirmed}>{writing === 'promote' ? '正在转为设定…' : '确认转为设定'}</button>
                <button type="button" className={shared.button} disabled={blocked} onClick={() => { setPromotionOpen(false); setPromotionConfirmed(false) }}>取消转换</button>
              </div>
            </form>}
          </> : reading !== 'detail' && <><form className={materialStyles.quick} onSubmit={saveQuick}>
            <h3 ref={heading} tabIndex={-1} id={headingId}><StudioIcon name="spark" size={20} />快速记录</h3>
            <div className={materialStyles.quickInput}><label><span className={materialStyles.srOnly}>快速记录内容</span><textarea rows={10} maxLength={500} value={quickBody}
              disabled={formLocked || !page} aria-describedby={quickCountId} placeholder="记录一闪而过的灵感…" onChange={(event) => changeQuick(event.target.value)} /></label>
              <span id={quickCountId} className={materialStyles.quickCount}>{quickBody.length} / 500</span></div>
            <button type="submit" className={`${shared.primaryButton} ${materialStyles.quickSave}`} disabled={formLocked || !page || !quickBody.trim()}><StudioIcon name="save" size={18} />保存到本书</button>
            {quickBody && <button ref={discardTrigger} type="button" className={shared.button} disabled={blocked} onClick={() => setDiscardQuick(true)}>放弃本次记录</button>}
            {discardQuick && <div className={styles.paperNotice} role="alert"><p>确定放弃这条尚未保存的记录？</p><div className={styles.actions}>
              <button type="button" className={shared.button} disabled={blocked} onClick={() => { quickRef.current = ''; setQuickBody(''); setDiscardQuick(false); setMessage(null); reportGuard() }}>确认放弃记录</button>
              <button type="button" className={shared.button} disabled={blocked} onClick={() => { setDiscardQuick(false); discardTrigger.current?.focus() }}>继续记录</button></div></div>}
          </form><section className={materialStyles.recent} aria-label="当前筛选最近记录"><h4><StudioIcon name="clock" size={20} />最近记录</h4>
            <ul>{page?.items.slice(0, 3).map((item) => <li key={item.id}><button type="button" disabled={blocked || Boolean(quickBody)}
              title={item.title} onClick={() => void selectNote(item.id)}><span>{item.title}</span><time dateTime={item.updatedAt}>{displayTime(item.updatedAt)}</time></button></li>)}</ul>
            {!page?.items.length && <p className={materialStyles.recentEmpty}>{page ? '暂无记录' : '尚未取得记录'}</p>}
          </section></>}
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
