import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { DomainError, isRecord, requiredId, type AppError, type BookSnapshot, type BookSummary, type StudioApi } from '../../contracts/api'
import { isNoteWriteReceiptFor, MAX_NOTE_BODY, NOTE_CHAPTER_SCHEMA_VERSION, NOTE_MATERIAL_SCHEMA_VERSION, NOTE_SCHEMA_VERSION, parseNoteMaterial, type NoteFields } from '../../contracts/notes'
import {
  INSPIRATION_KINDS, parseCopyInspirationInput, parseInspirationFields, parseListInspirationInput, parseSaveInspirationInput,
  type CopyInspirationInput, type InspirationFields, type InspirationItem, type InspirationPage, type ListInspirationInput, type SaveInspirationInput,
} from '../../contracts/workbench'
import { displayTime, request } from '../request'
import { sameFields, useToolSession } from './workbench-ui'
import ui from './stellar/Workspace.module.css'
import styles from './StellarInspiration.module.css'
import { InspirationImport } from './InspirationImport'
import { emptyStudyCard, isStudyCardKind, studyMaterialText } from '../../contracts/study-card'
import { StudyCardEditor, StudyTextCardEditor } from './StudyCardEditor'
import { hasStudyTextCard, isStudyTextCardKind } from '../../contracts/study-text-card'
import { StudioIcon, type StudioIconName } from './StudioIcon'
import { NoteChapterPicker } from './NoteChapterPicker'
import { InspirationThumbnail, readNoteThumbnailFile } from './NoteThumbnail'
import { NOTE_THUMBNAIL_SCHEMA_VERSION } from '../../contracts/note-thumbnail'
import {
  INSPIRATION_THUMBNAIL_SCHEMA_VERSION, matchesCopiedInspirationThumbnail, matchesInspirationThumbnail,
  parseInspirationThumbnailMetadata, sameInspirationThumbnail,
} from '../../contracts/inspiration-thumbnail'

export interface InspirationPanelProps {
  api: StudioApi
  books: BookSummary[]
  activeBook?: BookSnapshot | BookSummary | null
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
  onUnknown?: (error: AppError) => void
  onBookChanged: (bookId: string) => void | Promise<void>
  onRecover?: () => void
  onBookMaterials?: () => void
  onOpenNote: (bookId: string, noteId: string) => void
}

interface Draft { input: SaveInspirationInput; tags: string }
interface Listing { search: string; bookId: string; includeArchived: boolean; offset: number }
interface CopyDraft {
  source: InspirationItem
  noteId: string
  targetBookId: string
  target: BookSnapshot | null
  requiresUpgrade: boolean
  materialSupported: boolean
  linkChapters: boolean
  chapterIds: string[]
}
const kindLabels: Record<InspirationFields['kind'], string> = {
  idea: '灵感', reference: '参考作品', observation: '场景观察', excerpt: '摘录', technique: '手法分析', method: '方法卡', beat: '节拍骨架', style: '文风卡',
}
const nextKind: Record<InspirationFields['kind'], InspirationFields['kind']> = {
  idea: 'observation', reference: 'observation', observation: 'excerpt', excerpt: 'technique', technique: 'method', method: 'observation', beat: 'method', style: 'method',
}
const kindIcons: Record<InspirationFields['kind'], StudioIconName> = {
  idea: 'bulb', reference: 'read', observation: 'compass', excerpt: 'notes', technique: 'magic', method: 'workflow', beat: 'layers', style: 'pen',
}
const firstListing: Listing = { search: '', bookId: '', includeArchived: false, offset: 0 }
function savedFields(item: InspirationItem): InspirationFields {
  return { kind: item.kind, title: item.title, body: item.body, source: item.source, tags: [...item.tags], parentId: item.parentId, bookId: item.bookId, archived: item.archived }
}
function sourceLabel(item: InspirationItem, names: Record<string, string>): string {
  try {
    const source: unknown = JSON.parse(item.source)
    if (isRecord(source) && source.type === 'study' && source.version === 1 && source.sourceId === item.parentId
      && Number.isSafeInteger(source.sourceRevision) && Number(source.sourceRevision) > 0 && typeof source.quote === 'string') {
      return `拆书 · ${names[item.parentId!] ?? '固定参考原文'} · v${source.sourceRevision}`
    }
  } catch { /* 手工出处保持原文，不将普通文本猜测为结构化来源。 */ }
  return item.source
}
function asNote(source: InspirationItem): NoteFields {
  const attribution = [`灵感来源：${source.title}`, source.source && `出处：${source.source}`, source.tags.length && `标签：${source.tags.join('、')}`].filter(Boolean).join('\n')
  return { title: source.title, category: source.kind === 'method' || source.kind === 'technique' || isStudyCardKind(source.kind) ? 'method' : source.kind === 'idea' ? 'inspiration' : 'material', body: `${studyMaterialText(source.kind, source.body)}\n\n${attribution}` }
}
function validItem(value: InspirationItem): boolean {
  try {
    return Boolean(value && requiredId(value.id).toLowerCase() === value.id && Number.isSafeInteger(value.revision) && value.revision > 0
      && [value.createdAt, value.updatedAt].every((time) => typeof time === 'string' && time.length === 24
        && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time)
      && value.createdAt <= value.updatedAt && sameFields(value, parseInspirationFields(value)))
      && (value.thumbnail === null || sameInspirationThumbnail(value.thumbnail, parseInspirationThumbnailMetadata(value.thumbnail))
        && value.thumbnail.inspirationId === value.id && value.thumbnail.inspirationRevision <= value.revision
        && value.thumbnail.createdAt >= value.createdAt && value.thumbnail.createdAt <= value.updatedAt)
  } catch { return false }
}
function validPage(value: InspirationPage, offset: number): boolean {
  return Boolean(value && [1, INSPIRATION_THUMBNAIL_SCHEMA_VERSION].includes(value.schemaVersion)
    && Array.isArray(value.items) && value.items.length <= 50 && value.items.every((item) => validItem(item) && (value.schemaVersion !== 1 || item.thumbnail === null))
    && new Set(value.items.map((item) => item.id)).size === value.items.length && Number.isSafeInteger(value.total) && value.total >= 0 && value.total <= 10_000
    && value.items.length === Math.min(50, Math.max(0, value.total - offset))
    && value.nextOffset === (offset + value.items.length < value.total ? offset + value.items.length : null))
}
function copySchema(value: CopyDraft): number {
  return value.source.thumbnail ? NOTE_THUMBNAIL_SCHEMA_VERSION : value.linkChapters ? NOTE_CHAPTER_SCHEMA_VERSION : NOTE_SCHEMA_VERSION
}

export function InspirationPanel({ api, books, activeBook, disabled, onDirtyChange, onUnknown, onBookChanged, onRecover, onBookMaterials, onOpenNote }: InspirationPanelProps) {
  const currentBook = activeBook && ('book' in activeBook ? activeBook.book : activeBook)
  const [importDirty, setImportDirty] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  const [importRefresh, setImportRefresh] = useState(0)
  const dirtyCallback = useRef(onDirtyChange)
  dirtyCallback.current = onDirtyChange
  const copyRef = useRef<CopyDraft | null>(null)
  const importDirtyRef = useRef(false)
  const editorDirtyRef = useRef(false)
  const tool = useToolSession({ api, disabled: disabled || importDirty, isProtected: () => copyRef.current !== null,
    onDirtyChange: (value) => { editorDirtyRef.current = value; setEditorDirty(value); dirtyCallback.current(value || importDirtyRef.current) }, onUnknown })
  useEffect(() => { onDirtyChange(editorDirty || importDirty) }, [editorDirty, importDirty, onDirtyChange])
  const [page, setPage] = useState<InspirationPage | null>(null)
  const [listing, setListing] = useState<Listing>(firstListing)
  const [filters, setFilters] = useState(firstListing)
  const [kind, setKind] = useState<InspirationFields['kind'] | ''>('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const thumbnailInput = useRef<HTMLInputElement>(null)
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false)
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [discard, setDiscard] = useState(false)
  const [recoveryPreserved, setRecoveryPreserved] = useState(false)
  const [copy, setCopy] = useState<CopyDraft | null>(null)
  const [parentNames, setParentNames] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<InspirationItem | null>(null)
  const [tag, setTag] = useState('')
  const [quick, setQuick] = useState(() => ({ id: crypto.randomUUID(), body: '' }))
  const [copiedNote, setCopiedNote] = useState<{ bookId: string; id: string } | null>(null)
  const quickCountId = useId()
  const freshRef = useRef(true)
  const editorRef = useRef<HTMLFormElement>(null)
  const discardTrigger = useRef<HTMLButtonElement>(null)
  const discardDisabledReason = tool.locked ? '请先完成当前操作或核对原请求' : undefined
  const visible = (page?.items ?? []).filter((item) => (!kind || item.kind === kind) && (!tag || item.tags.includes(tag)))
  const tags = [...new Set(page?.items.flatMap((item) => item.tags) ?? [])].slice(0, 12)
  const copyFields = copy ? asNote(copy.source) : null
  const copyTooLarge = Boolean(copyFields && (copyFields.title.length > 120 || copyFields.body.length > MAX_NOTE_BODY))
  const supportsThumbnails = page?.schemaVersion === INSPIRATION_THUMBNAIL_SCHEMA_VERSION

  useEffect(() => { if (!disabled && freshRef.current) { freshRef.current = false; void load(firstListing) } }, [disabled])
  useEffect(() => { if (importRefresh && !importDirty && !editorDirty) void load(firstListing) }, [importRefresh, importDirty])
  // 恢复会卸载整个面板，聚合后的离开保护须直接向主窗口解除。
  useEffect(() => () => { freshRef.current = true; dirtyCallback.current(false) }, [])
  useEffect(() => { if (draft) { editorRef.current?.scrollIntoView({ block: 'nearest' }); editorRef.current?.focus({ preventScroll: true }) } }, [draft?.input.id])
  useEffect(() => { setRecoveryPreserved(false) }, [tool.pending])

  function canSwitch() {
    if (copyRef.current || !tool.canLeave()) { tool.setError('请先保存、放弃当前更改或取消关联，再切换内容；未确认请求须先核对。'); return false }
    return true
  }
  function putCopy(value: CopyDraft | null) {
    copyRef.current = value; setCopy(value); tool.setDirty(Boolean(value))
  }
  function putDraft(next: Draft | null) { draftRef.current = next; setDraft(next) }
  function changed(next: Draft) { putDraft(next); setDiscard(false); tool.setDirty(true); tool.setNotice(null) }
  function remember(items: InspirationItem[]) { setParentNames((previous) => ({ ...previous, ...Object.fromEntries(items.map((item) => [item.id, item.title])) })) }
  async function load(next: Listing, keepEditor = false) {
    if (!canSwitch()) return
    let input: ListInspirationInput
    try { input = parseListInspirationInput({ search: next.search, ...(next.bookId ? { bookId: next.bookId } : {}), includeArchived: next.includeArchived, offset: next.offset }) }
    catch (failure) { tool.setError(failure instanceof DomainError ? failure.detail.message : '筛选条件无效。'); return }
    await tool.read(() => api.listInspirations(input), (value) => {
      if (!validPage(value, next.offset)) throw new Error('Invalid inspiration page')
      setPage(value); setListing(next); setFilters(next); setTag(''); remember(value.items)
      if (!keepEditor) { putDraft(null); setCopy(null); setSelected(null); setDiscard(false) }
    })
  }
  function open(item: InspirationItem) {
    if (!canSwitch()) return
    setSelected(item); setCopy(null); setDiscard(false)
    putDraft({ input: { id: item.id, expectedRevision: item.revision, fields: savedFields(item) }, tags: item.tags.join('，') })
    tool.setError(null); tool.setNotice(null)
  }
  function create(parent?: InspirationItem, initialKind: InspirationFields['kind'] = 'idea') {
    if (!canSwitch()) return
    if (parent) remember([parent])
    const fields: InspirationFields = { kind: parent ? nextKind[parent.kind] : initialKind, title: '', body: '',
      source: parent?.source ?? '', tags: parent ? [...parent.tags] : [], parentId: parent?.id ?? null,
      bookId: parent?.bookId ?? null, archived: false }
    if (isStudyCardKind(fields.kind)) fields.body = emptyStudyCard(fields.kind)
    setSelected(null); setCopy(null); setDiscard(false)
    putDraft({ input: { id: crypto.randomUUID(), expectedRevision: 0, fields }, tags: fields.tags.join('，') })
    tool.setDirty(Boolean(parent))
    tool.setError(null); tool.setNotice(null)
  }
  function closeEditor(confirmed = false) {
    if (tool.locked || tool.hasPending()) return
    if (tool.hasChanges() && (!confirmed || !discard)) { setDiscard(true); return }
    putDraft(null); setSelected(null); setCopy(null); setDiscard(false); tool.setDirty(false); tool.setError(null)
  }
  function cancelDiscard() {
    if (tool.locked || tool.hasPending()) return
    setDiscard(false); discardTrigger.current?.focus()
  }
  function discardQuick() {
    if (tool.locked || tool.hasPending() || !discard || draftRef.current || copyRef.current) return
    setQuick({ id: crypto.randomUUID(), body: '' }); setDiscard(false); tool.setDirty(false)
  }
  async function pickThumbnail(file: File) {
    const submitted = draftRef.current
    if (!submitted || !supportsThumbnails || tool.locked) return
    // 使用现有同步忙锁覆盖本地读取与解码，迟到结果只回到原草稿。
    await tool.read(async () => {
      try { return { ok: true as const, data: await readNoteThumbnailFile(file) } }
      catch (failure) { return { ok: false as const, error: { code: 'INVALID_INPUT' as const,
        message: failure instanceof DomainError ? failure.detail.message : failure instanceof Error ? failure.message : '灵感图片读取失败，原输入仍保留。' } } }
    }, (thumbnail) => {
      if (draftRef.current !== submitted) throw new Error('Inspiration draft changed')
      changed({ ...submitted, input: { ...submitted.input, thumbnail } })
    })
  }
  async function upgradeImages() {
    if (page?.schemaVersion !== 1 || !upgradeConfirmed || tool.locked || !canSwitch()) return
    const success = await tool.write('inspiration.upgrade', () => api.upgradeInspirations({ expectedSchemaVersion: 1 }),
      (value) => value?.schemaVersion === INSPIRATION_THUMBNAIL_SCHEMA_VERSION && typeof value.backupPath === 'string' && Boolean(value.backupPath),
      (value) => { setBackupPath(value.backupPath); setUpgradeConfirmed(false) }, '全局灵感库已备份并启用配图。')
    if (success) await load({ ...listing, offset: 0 })
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || tool.locked) return
    let input: SaveInspirationInput
    try { input = parseSaveInspirationInput({ ...draft.input, fields: { ...draft.input.fields,
      // 修改其他字段时保留已有标签原值；仅在标签文本变化后拆分输入。
      tags: draft.tags === draft.input.fields.tags.join('，') ? draft.input.fields.tags
        : draft.tags.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean) } }) }
    catch (failure) { tool.setError(failure instanceof DomainError ? failure.detail.message : '请检查灵感内容后重试。'); return }
    setDiscard(false)
    const success = await tool.write('inspiration.save', () => api.saveInspiration(input), (value) => validItem(value) && value.id === input.id
      && value.revision === input.expectedRevision + 1 && sameFields(value, input.fields)
      && (input.thumbnail === undefined ? sameInspirationThumbnail(value.thumbnail, selected?.thumbnail ?? null) : matchesInspirationThumbnail(value.thumbnail, input.thumbnail)), (value) => {
      setSelected(value); remember([value]); setDiscard(false)
      putDraft({ input: { id: value.id, expectedRevision: value.revision, fields: savedFields(value) }, tags: value.tags.join('，') })
    }, input.fields.archived ? '灵感已归档，原文和参考链均已保留。' : '灵感已保存。')
    if (success) await load({ ...listing, offset: 0 }, true)
  }
  async function saveQuick(event: FormEvent) {
    event.preventDefault()
    if (tool.locked || !quick.body.trim()) return
    // 快速记录也固定客户端身份；超时后由原回执接续，不能重新生成 ID 再次写入。
    let input: SaveInspirationInput
    try { input = parseSaveInspirationInput({ id: quick.id, expectedRevision: 0, fields: {
      kind: 'idea', title: quick.body.trim().split(/\r?\n/, 1)[0].slice(0, 160), body: quick.body,
      source: '', tags: [], parentId: null, bookId: currentBook && !currentBook.archivedAt ? currentBook.id : null, archived: false,
    } }) }
    catch (failure) { tool.setError(failure instanceof DomainError ? failure.detail.message : '快速记录内容无效，原文仍保留，请检查后重试。'); return }
    // 保存开始即收起旧的放弃确认，避免失败或回执未知时丢失原文及固定标识。
    setDiscard(false)
    const success = await tool.write('inspiration.save', () => api.saveInspiration(input),
      (value) => validItem(value) && value.id === input.id && value.revision === 1 && sameFields(value, input.fields) && value.thumbnail === null,
      () => { setQuick({ id: crypto.randomUUID(), body: '' }); setDiscard(false) }, '灵感已保存，原文保留在全局收件箱。')
    if (success) await load({ ...listing, offset: 0 }, true)
  }
  function startCopy(source: InspirationItem, linkChapters = false) {
    if (!canSwitch()) return
    putDraft(null); setSelected(source); setDiscard(false)
    putCopy({ source, noteId: crypto.randomUUID(), targetBookId: currentBook && !currentBook.archivedAt ? currentBook.id : '',
      target: null, requiresUpgrade: false, materialSupported: false, linkChapters, chapterIds: [] })
    tool.setDirty(true)
    tool.setError(null); tool.setNotice(null)
  }
  async function prepareCopy() {
    if (!copy || !copy.targetBookId || copyTooLarge || tool.locked) return
    const intended = copy
    await tool.read(async () => {
      const nextBook = await api.getBook({ bookId: intended.targetBookId })
      if (!nextBook.ok) return nextBook
      const status = await api.getKnowledgeStatus({ bookId: intended.targetBookId })
      if (!status.ok) return status
      if (nextBook.data.book.id !== intended.targetBookId || status.data.bookId !== intended.targetBookId || nextBook.data.book.revision !== status.data.bookRevision) {
        return { ok: false as const, error: { code: 'REVISION_CONFLICT' as const, message: '作品在准备期间发生变化，请重新读取。' } }
      }
      return { ok: true as const, data: { book: nextBook.data, materialSupported: status.data.schemaVersion >= NOTE_MATERIAL_SCHEMA_VERSION,
        requiresUpgrade: status.data.schemaVersion < copySchema(intended) } }
    }, (value) => {
      if (value.book.book.archivedAt) { tool.setError('目标作品已归档，请先恢复作品，或选择其他作品。'); return }
      putCopy({ ...intended, target: value.book, requiresUpgrade: value.requiresUpgrade, materialSupported: value.materialSupported })
    })
  }
  function notifyBook(bookId: string) {
    void Promise.resolve().then(() => onBookChanged(bookId)).catch(() => tool.setError('笔记写入已确认；作品目录未同步，请在主窗口刷新作品。'))
  }
  async function upgradeTarget() {
    if (!copy?.target || !copy.requiresUpgrade || tool.locked) return
    const intended = copy
    const bookId = copy.target.book.id
    const expectedBookRevision = copy.target.book.revision
    const success = await tool.write('knowledge.upgrade', () => api.upgradeKnowledge({ bookId, expectedBookRevision }), (value) => value.bookId === bookId
      && value.bookRevision > expectedBookRevision && value.schemaVersion >= copySchema(intended) && !value.requiresUpgrade, () => {
      putCopy({ ...intended, target: null, requiresUpgrade: false, materialSupported: false }); notifyBook(bookId)
    }, '作品备份和升级已完成，请重新读取复制目标。')
    if (success) { tool.setDirty(true); tool.setNotice('作品备份和升级已完成，请点击“读取目标并预览”取得新版本。') }
  }
  async function confirmCopy() {
    if (!copy?.target || copy.requiresUpgrade || copyTooLarge || tool.locked
      || copy.linkChapters && (!copy.chapterIds.length || copy.chapterIds.some((id) => !copy.target!.chapters.some((chapter) => chapter.id === id)))) return
    const fields = asNote(copy.source)
    let input: CopyInspirationInput
    try { input = parseCopyInspirationInput({ bookId: copy.target.book.id, expectedBookRevision: copy.target.book.revision,
      id: copy.source.id, expectedRevision: copy.source.revision, noteId: copy.noteId,
      ...(copy.linkChapters ? { chapterIds: copy.chapterIds } : {}) }) }
    catch (failure) { tool.setError(failure instanceof DomainError ? failure.detail.message : '复制目标无效。'); return }
    await tool.write('inspiration.copy', () => api.copyInspirationToNote(input),
      (value) => isNoteWriteReceiptFor({ bookId: input.bookId, id: input.noteId, expectedBookRevision: input.expectedBookRevision,
        fields, ...(copy.materialSupported ? { material: parseNoteMaterial({ source: copy.source.source, tags: copy.source.tags }) } : {}),
        ...(input.chapterIds === undefined ? {} : { chapterIds: input.chapterIds }) }, value) && matchesCopiedInspirationThumbnail(value.thumbnail, copy.source.thumbnail),
      () => { putCopy(null); setCopiedNote({ bookId: input.bookId, id: input.noteId }); notifyBook(input.bookId) },
      copy.source.thumbnail ? `原图与文字已复制到作品笔记${copy.linkChapters ? '并关联所选章节' : ''}；收件箱原件保留。`
        : copy.linkChapters ? '已复制到作品笔记并关联所选章节，原件保留。可在本书素材中查看、解除关联或前往章节。'
        : copy.materialSupported ? '已复制到作品笔记，并保存独立出处和标签；收件箱原件保留。'
          : '已复制到作品笔记，出处和标签已保留在正文中；收件箱原件保留。')
  }

  return <section className={`${ui.panel} ${styles.panel}`} aria-label="灵感与拆书收件箱" aria-busy={tool.busy}>
    <div className={styles.topbar}><div className={styles.scope} aria-label="素材范围"><button type="button" aria-pressed="true"><StudioIcon name="spark" />全局灵感</button><button type="button" disabled={tool.locked || !onBookMaterials} title={onBookMaterials ? '查看当前作品保存的笔记' : '先打开一部作品'} onClick={onBookMaterials}><StudioIcon name="read" />本书素材</button></div>
      <div className={ui.actions}><button className={ui.primaryButton} type="button" disabled={tool.locked} onClick={() => create()}><StudioIcon name="plus" size={16} />记一条灵感</button><button className={ui.button} type="button" disabled={tool.locked} onClick={() => create(undefined, 'reference')}><StudioIcon name="read" size={16} />添加参考作品</button></div></div>
    {tool.error && <p className={ui.error} role="alert">{tool.error}</p>}
    {tool.readFailure?.requestId && <button className={ui.button} type="button" disabled={tool.locked} onClick={() => void tool.checkReadReceipt()}>核对原读取</button>}
    {tool.notice && <p className={ui.notice} role="status">{tool.notice}</p>}
    {page?.schemaVersion === 1 && <section className={styles.upgrade} aria-label="启用全局灵感配图">
      <h4>启用全局灵感配图</h4><p>已有文字条目仍可编辑。启用图片前会独立备份整个灵感库，再追加图片结构；旧版应用无法读取新格式。</p>
      <label className={ui.check}><input type="checkbox" checked={upgradeConfirmed} disabled={tool.locked || tool.dirty}
        onChange={(event) => setUpgradeConfirmed(event.target.checked)} />我了解格式升级，并同意先备份后启用。</label>
      <button type="button" className={ui.button} disabled={tool.locked || tool.dirty || !upgradeConfirmed} onClick={() => void upgradeImages()}>备份并启用配图</button>
    </section>}
    {backupPath && <p className={ui.muted}>启用前备份：{backupPath}</p>}
    {copiedNote && <button className={ui.button} type="button" disabled={tool.locked || tool.dirty}
      onClick={() => { if (canSwitch()) onOpenNote(copiedNote.bookId, copiedNote.id) }}>查看保存的素材与章节关联</button>}
    {tool.pending && <div className={ui.warning}><p>保存结果尚未确认，表单与本次复制标识已保留。核对原请求前暂停写入。</p><div className={ui.actions}>{tool.pending.error.requestId && <button className={ui.button} type="button" disabled={tool.busy} onClick={() => void tool.checkReceipt().then((success) => { if (success && !copyRef.current) void load({ ...listing, offset: 0 }, true) })}>核对原请求</button>}</div><p>若服务连接已中断，请先保留当前输入，再从主窗口的草稿恢复入口重新连接并核对资料。不会自动重发本次复制。</p>{onRecover && <><label className={ui.check}><input type="checkbox" checked={recoveryPreserved} onChange={(event) => setRecoveryPreserved(event.target.checked)} />我已留存当前输入与复制标识，可以离开面板恢复</label><button className={ui.button} type="button" disabled={tool.busy || !recoveryPreserved} onClick={onRecover}>打开主窗口恢复</button></>}</div>}
    {(tool.pending || tool.error || tool.readFailure) && <details className={ui.details}><summary>查看并复制当前输入留存</summary><textarea readOnly rows={10}
      value={JSON.stringify({ draft, copy, quick, originalThumbnail: selected?.thumbnail ?? null, schemaVersion: page?.schemaVersion ?? null,
        backupPath, pendingCommand: tool.pending?.command ?? null, requestId: tool.pending?.error.requestId ?? null,
        readRequestId: tool.readFailure?.requestId ?? null }, null, 2)} aria-label="尚未确认的灵感内容与复制标识" /></details>}
    <div className={styles.layout}><aside className={styles.filters} aria-label="素材分类">
      <h4>本页类型</h4><button type="button" aria-pressed={!kind} onClick={() => setKind('')}><StudioIcon name="grid" size={18} />全部<span>{page?.items.length ?? '—'}</span></button>
      {INSPIRATION_KINDS.map((value) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}><StudioIcon name={kindIcons[value]} size={18} />{kindLabels[value]}<span>{page?.items.filter((item) => item.kind === value).length ?? '—'}</span></button>)}
    </aside><div className={styles.listPane}>
    <form className={styles.search} onSubmit={(event) => { event.preventDefault(); void load({ ...filters, offset: 0 }) }}>
      <label><span className={styles.srOnly}>查找内容</span><input type="search" maxLength={200} value={filters.search} disabled={tool.locked} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="搜索灵感、内容或标签…" /></label>
      <button className={ui.button} type="submit" disabled={tool.locked || tool.dirty} title="应用搜索与筛选"><StudioIcon name="search" size={16} />筛选 / 刷新</button>
      <details className={styles.searchOptions}><summary><StudioIcon name="settings" size={16} />筛选与导入</summary><div className={styles.searchOptionsBody}>
      <label>关联作品<select value={filters.bookId} disabled={tool.locked} onChange={(event) => setFilters({ ...filters, bookId: event.target.value })}><option value="">全部作品与未关联内容</option>{books.map((item) => <option key={item.id} value={item.id}>{item.title}{item.archivedAt ? '（已归档）' : ''}</option>)}</select></label>
      <label className={ui.check}><input type="checkbox" checked={filters.includeArchived} disabled={tool.locked} onChange={(event) => setFilters({ ...filters, includeArchived: event.target.checked })} />包含已归档</label>
      <InspirationImport api={api} disabled={disabled || editorDirty} onDirtyChange={(value) => { importDirtyRef.current = value; setImportDirty(value); dirtyCallback.current(value || editorDirtyRef.current) }} onSaved={() => setImportRefresh((value) => value + 1)} onUnknown={onUnknown} onRecover={onRecover} />
      </div></details>
    </form>
    {!!tags.length && <div className={styles.tagFilters} aria-label="本页标签筛选"><button type="button" aria-pressed={!tag} onClick={() => setTag('')}>全部标签</button>{tags.map((value) => <button key={value} type="button" aria-pressed={tag === value} onClick={() => setTag(tag === value ? '' : value)}>{value}</button>)}</div>}
      {!page ? <div className={ui.empty}><p>{tool.busy ? '正在读取收件箱…' : '尚未取得收件箱资料，请点击筛选 / 刷新。'}</p></div>
        : !visible.length ? <div className={ui.empty}><h4>{page.total ? '本页没有匹配类型' : '留住还没找到归属的想法'}</h4><p>{page.total ? '可切换本页类型，或翻页继续查找。' : '写下一个画面、一句对白，或添加一本参考作品。以后再关联作品、补充出处。'}</p><button className={ui.button} type="button" disabled={tool.locked} onClick={() => create()}>新建灵感</button></div>
          : <ul className={styles.items}>{visible.map((item) => {
            const source = sourceLabel(item, parentNames)
            const metadata = [item.source && `出处：${source}`,
              item.parentId && source === item.source && `上级：${parentNames[item.parentId] ?? `参考条目 ${item.parentId}`}`,
              item.bookId ? books.find((entry) => entry.id === item.bookId)?.title ?? '关联作品暂不在书架' : '未关联作品',
              displayTime(item.updatedAt)].filter(Boolean).join(' · ')
            return <li key={item.id} className={selected?.id === item.id ? styles.selected : undefined}>
              <div className={styles.cardBody}>
                {item.thumbnail && <InspirationThumbnail api={api} metadata={item.thumbnail} name={item.title} className={styles.thumbnail} />}
                <div className={styles.cardText}>
                <button className={styles.itemTitle} type="button" disabled={tool.locked} aria-pressed={selected?.id === item.id} onClick={() => open(item)}><span><StudioIcon name={kindIcons[item.kind]} size={16} />{kindLabels[item.kind]}{item.archived ? ' · 已归档' : ''}</span><strong>{item.title}</strong></button>
                <p className={styles.preview}>{studyMaterialText(item.kind, item.body) || '尚未填写内容'}</p>
                {!!item.tags.length && <p className={styles.tags}>{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</p>}
                </div>
              </div>
              <div className={styles.cardFooter}>
                <p className={styles.source} title={metadata}><StudioIcon name={item.source || item.parentId ? 'read' : 'clock'} size={14} /><span>{metadata}</span></p>
                <div className={styles.cardActions}>
                  <button className={`${ui.button} ${styles.cardIcon}`} type="button" disabled={tool.locked} aria-label={`继续写${kindLabels[nextKind[item.kind]]}：${item.title}`} title={`继续写${kindLabels[nextKind[item.kind]]}`} onClick={() => create(item)}><StudioIcon name="pen" size={14} /></button>
                  <button className={ui.button} type="button" disabled={tool.locked || !books.some((entry) => !entry.archivedAt)} onClick={() => startCopy(item)}><StudioIcon name="copy" size={14} />复制到作品笔记</button>
                  <button className={ui.button} type="button" disabled={tool.locked || !books.some((entry) => !entry.archivedAt)} onClick={() => startCopy(item, true)}><StudioIcon name="link" size={14} />关联章节</button>
                </div>
              </div>
            </li>
          })}</ul>}
      {page && <div className={styles.paging}><button className={ui.button} type="button" disabled={tool.locked || tool.dirty || listing.offset === 0} onClick={() => void load({ ...listing, offset: Math.max(0, listing.offset - 50) })}>上一页</button><span className={ui.muted}>{page.items.length ? `${listing.offset + 1}–${listing.offset + page.items.length} / ${page.total}` : `共 ${page.total} 条`} · 每页最多 50 条</span><button className={ui.button} type="button" disabled={tool.locked || tool.dirty || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) void load({ ...listing, offset: page.nextOffset }) }}>下一页</button></div>}
    </div><div className={styles.detailPane}>
      {draft && <form ref={editorRef} tabIndex={-1} className={styles.editor} onSubmit={(event) => void save(event)}>
        <div className={ui.heading}><h4>{draft.input.expectedRevision ? '编辑收集条目' : '新建收集条目'}</h4><span className={ui.muted}>{tool.dirty ? '有未保存更改' : '尚未修改'}</span></div>
        <fieldset disabled={tool.locked}><div className={ui.fields}><div className={ui.fieldGrid}>
          <label>类型<select value={draft.input.fields.kind} onChange={(event) => {
            const kind = event.target.value as InspirationFields['kind']
            const body = studyMaterialText(draft.input.fields.kind, draft.input.fields.body)
            changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, kind, body: isStudyCardKind(kind) ? emptyStudyCard(kind, body) : body } } })
          }}>{INSPIRATION_KINDS.map((item) => <option key={item} value={item}>{kindLabels[item]}</option>)}</select></label>
          <label>关联作品<select value={draft.input.fields.bookId ?? ''} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, bookId: event.target.value || null } } })}><option value="">暂不关联</option>{draft.input.fields.bookId && !books.some((item) => item.id === draft.input.fields.bookId) && <option value={draft.input.fields.bookId}>原关联作品暂不在书架</option>}{books.map((item) => <option key={item.id} value={item.id}>{item.title}{item.archivedAt ? '（已归档）' : ''}</option>)}</select></label></div>
          <label>标题<input required maxLength={160} value={draft.input.fields.title} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, title: event.target.value } } })} /></label>
          {isStudyCardKind(draft.input.fields.kind) ? <StudyCardEditor kind={draft.input.fields.kind} body={draft.input.fields.body} disabled={tool.locked} onChange={(body) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, body } } })} />
            : isStudyTextCardKind(draft.input.fields.kind) && hasStudyTextCard(draft.input.fields.kind, draft.input.fields.body) ? <StudyTextCardEditor kind={draft.input.fields.kind} body={draft.input.fields.body} disabled={tool.locked} onChange={(body) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, body } } })} />
            : <label>{draft.input.fields.kind === 'excerpt' ? '摘录内容' : draft.input.fields.kind === 'method' ? '方法与适用条件' : draft.input.fields.kind === 'technique' ? '写法、作用与分析' : '内容'}<textarea rows={10} maxLength={40000} value={draft.input.fields.body} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, body: event.target.value } } })} /></label>}
          <label>出处<textarea rows={2} maxLength={2000} placeholder="作品、作者、章节、页码或链接；记录足够的回查线索" value={draft.input.fields.source} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, source: event.target.value } } })} /></label>
          <label>标签<input maxLength={1100} placeholder="用逗号分隔，最多 20 个，每个最多 50 字符" value={draft.tags} onChange={(event) => changed({ ...draft, tags: event.target.value })} /></label>
          {supportsThumbnails && <section className={styles.thumbnailEditor} aria-label="灵感配图"><h4>灵感配图</h4>
            {draft.input.thumbnail ? <img className={styles.draftThumbnail} src={`data:${draft.input.thumbnail.mime};base64,${draft.input.thumbnail.dataBase64}`}
              alt={draft.input.thumbnail.alt || draft.input.fields.title} onError={() => tool.setError('当前配图无法显示，请重新选择有效图片。')} />
              : draft.input.thumbnail === undefined && selected?.thumbnail ? <InspirationThumbnail api={api} metadata={selected.thumbnail} name={selected.title} className={styles.thumbnail} />
                : <p className={ui.muted}>尚未配图。</p>}
            <input ref={thumbnailInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void pickThumbnail(file) }} />
            <div className={ui.actions}><button type="button" className={ui.button} onClick={() => thumbnailInput.current?.click()}><StudioIcon name="plus" size={16} />选择本地图片</button>
              <button type="button" className={ui.button} disabled={!(draft.input.thumbnail || draft.input.thumbnail === undefined && selected?.thumbnail)}
                onClick={() => changed({ ...draft, input: { ...draft.input, thumbnail: null } })}>移除当前配图</button></div>
            <p className={ui.muted}>单图不超过 2 MiB，支持 PNG、JPEG、WebP。换图和移除后仍保留旧图，占用全局图片预算。</p>
          </section>}
          <InspirationParentPicker key={draft.input.id} api={api} id={draft.input.id} value={draft.input.fields.parentId} label={draft.input.fields.parentId ? parentNames[draft.input.fields.parentId] : undefined} disabled={tool.locked}
            onChange={(parent) => { if (parent) remember([parent]); changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, parentId: parent?.id ?? null } } }) }} />
          <label className={ui.check}><input type="checkbox" checked={draft.input.fields.archived} onChange={(event) => changed({ ...draft, input: { ...draft.input, fields: { ...draft.input.fields, archived: event.target.checked } } })} />归档条目（原文、出处与参考链继续保留）</label>
          <p className={ui.muted}>关联作品只标记归属。点击“复制到作品笔记”才会在作品内新增笔记，后续可在笔记中明确转为设定。</p>
        </div></fieldset>
        <div className={ui.actions}><button className={ui.primaryButton} type="submit" disabled={tool.locked || Boolean(draft.input.expectedRevision && !tool.dirty)}>{tool.busy ? '正在保存…' : '保存条目'}</button><button ref={discardTrigger} className={ui.button} type="button" disabled={tool.locked} onClick={() => closeEditor()}>{tool.dirty ? '放弃未保存更改' : '收起编辑'}</button></div>
        {discard && <div className={ui.warning} role="alert"><p>确定放弃这份表单的未保存更改？已保存原件会保留。</p><div className={ui.actions}><button className={ui.button} type="button" disabled={tool.locked} title={discardDisabledReason} onClick={() => closeEditor(true)}>确认放弃</button><button className={ui.button} type="button" disabled={tool.locked} title={discardDisabledReason} onClick={cancelDiscard}>继续编辑</button></div></div>}
        {selected && <div className={ui.actions}><button className={ui.button} type="button" disabled={tool.locked || tool.dirty} onClick={() => create(selected)}>以此继续写{kindLabels[nextKind[selected.kind]]}</button><button className={ui.button} type="button" disabled={tool.locked || tool.dirty || !books.some((item) => !item.archivedAt)} onClick={() => startCopy(selected)}>复制已保存版本到作品笔记</button></div>}
      </form>}
      {copy && copyFields && <section className={styles.copy} aria-label={copy.linkChapters ? '关联章节' : '复制到作品笔记'}><div className={ui.heading}><h4>{copy.linkChapters ? '关联章节' : '复制'} · {copy.source.title}</h4><button className={ui.button} type="button" disabled={tool.locked} onClick={() => putCopy(null)}>取消{copy.linkChapters ? '关联' : '复制'}</button></div><p className={ui.muted}>{copy.linkChapters ? '确认后在目标作品保存一份笔记并关联所选章节。' : ''}原件与参考链留在收件箱，作品笔记中保留出处和标签。</p>
        {copy.source.thumbnail && <><InspirationThumbnail api={api} metadata={copy.source.thumbnail} name={copy.source.title} className={styles.thumbnail} />
          <p className={ui.muted}>将携带这个已保存版本的原图一同复制，占用目标作品的素材图片预算。</p></>}
        <label>目标作品<select value={copy.targetBookId} disabled={tool.locked} onChange={(event) => putCopy({ ...copy, targetBookId: event.target.value, target: null, requiresUpgrade: false, materialSupported: false, chapterIds: [] })}><option value="">选择作品</option>{books.filter((item) => !item.archivedAt).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {copyTooLarge && <p className={ui.warning}>这条灵感超过作品笔记的限制（标题 120 字符、含出处的正文 20,000 字符）。请保留原件，先将需要的部分整理为一条子记录，再复制。</p>}
        <div className={ui.actions}><button className={ui.button} type="button" disabled={tool.locked || !copy.targetBookId || copyTooLarge} onClick={() => void prepareCopy()}>读取目标并预览</button></div>
        {copy.target && <><details className={ui.details} open><summary>将复制到《{copy.target.book.title}》的笔记内容</summary><textarea readOnly rows={8} value={copyFields.body} aria-label="复制后的完整笔记内容" /></details>
          {copy.materialSupported ? <div className={ui.fields}><p className={ui.muted}>独立出处：{copy.source.source || '未填写'}</p>
            {!!copy.source.tags.length && <p className={styles.tags}>{copy.source.tags.map((tag) => <span key={tag}>{tag}</span>)}</p>}</div>
            : !copy.requiresUpgrade && <p className={ui.muted}>当前格式仅在笔记正文保留出处和标签。需要独立筛选时，可在本书素材中先备份启用素材信息。</p>}
          {copy.requiresUpgrade ? <div className={ui.warning}><p>这部作品需要先备份升级才能{copy.source.thumbnail ? '完整复制原图与笔记' : copy.linkChapters ? '保存章节关联' : '使用笔记'}。</p><button className={ui.button} type="button" disabled={tool.locked} onClick={() => void upgradeTarget()}>备份并升级目标作品</button></div>
            : <>{copy.linkChapters && <NoteChapterPicker key={copy.target.book.id} book={copy.target} value={copy.chapterIds} disabled={tool.locked}
              onChange={(chapterIds) => putCopy({ ...copy, chapterIds })} />}
              <button className={ui.primaryButton} type="button" disabled={tool.locked || copyTooLarge || copy.linkChapters && (!copy.chapterIds.length || copy.chapterIds.some((id) => !copy.target!.chapters.some((chapter) => chapter.id === id)))} onClick={() => void confirmCopy()}>{copy.linkChapters ? '确认复制并关联章节' : '确认复制到作品笔记'}</button></>}</>}
      </section>}
      {!draft && !copy && <><form className={styles.quick} onSubmit={(event) => void saveQuick(event)}><h4><StudioIcon name="spark" size={20} />快速记录</h4>
        <div className={styles.quickInput}><label><span className={styles.srOnly}>快速记录内容</span><textarea rows={10} maxLength={500} value={quick.body} disabled={tool.locked} aria-describedby={quickCountId} placeholder="记录一闪而过的灵感…" onChange={(event) => { setQuick({ ...quick, body: event.target.value }); setDiscard(false); tool.setDirty(Boolean(event.target.value)); tool.setNotice(null) }} /></label>
          <span id={quickCountId} className={styles.quickCount}>{quick.body.length} / 500</span></div>
        <button type="submit" className={`${ui.primaryButton} ${styles.quickSave}`} disabled={tool.locked || !quick.body.trim()}><StudioIcon name="save" size={18} />{currentBook && !currentBook.archivedAt ? '保存并关联本书' : '保存灵感'}</button>
        {quick.body && <button ref={discardTrigger} type="button" className={ui.button} disabled={tool.locked} onClick={() => setDiscard(true)}>放弃本次记录</button>}
        {discard && <div className={ui.warning} role="alert"><p>放弃这条尚未保存的记录？</p><div className={ui.actions}><button type="button" className={ui.button} disabled={tool.locked} title={discardDisabledReason} onClick={discardQuick}>确认放弃记录</button><button type="button" className={ui.button} disabled={tool.locked} title={discardDisabledReason} onClick={cancelDiscard}>继续记录</button></div></div>}
      </form><section className={styles.recent} aria-label="当前筛选最近记录"><h4><StudioIcon name="clock" size={20} />最近记录</h4><ul>{page?.items.slice(0, 3).map((item) => <li key={item.id}><button type="button" disabled={tool.locked || tool.dirty} title={item.title} onClick={() => open(item)}><span>{item.title}</span><time dateTime={item.updatedAt}>{displayTime(item.updatedAt)}</time></button></li>)}</ul>{!page?.items.length && <p className={styles.recentEmpty}>{page ? '暂无记录' : '尚未取得记录'}</p>}</section></>}
    </div></div>
  </section>
}

function InspirationParentPicker({ api, id, value, label, disabled, onChange }: {
  api: StudioApi; id: string; value: string | null; label?: string; disabled: boolean; onChange: (parent: InspirationItem | null) => void
}) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<InspirationPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const ticket = useRef(0)
  useEffect(() => { active.current = true; return () => { active.current = false; ticket.current += 1 } }, [])
  async function load(nextSearch: string, nextOffset: number) {
    if (disabled || loading) return
    const expected = ++ticket.current
    setLoading(true); setError(null)
    const result = await request(() => api.listInspirations({ search: nextSearch.trim(), offset: nextOffset, includeArchived: true }))
    if (!active.current || ticket.current !== expected) return
    setLoading(false)
    if (!result.ok) { setError(result.error.message); return }
    if (!validPage(result.data, nextOffset)) { setError('参考条目分页回执无效，请重新查询。'); return }
    setPage(result.data); setQuery(nextSearch); setOffset(nextOffset)
  }
  return <details className={ui.details}><summary>上级参考：{value ? label ?? value : '无（独立条目）'}</summary>
    {value && <button className={ui.button} type="button" disabled={disabled || loading} onClick={() => onChange(null)}>改为独立条目</button>}
    <div className={ui.toolbar}><label>查找上级参考<input type="search" value={search} maxLength={200} disabled={disabled || loading} onChange={(event) => setSearch(event.target.value)} /></label><button className={ui.button} type="button" disabled={disabled || loading} onClick={() => void load(search, 0)}>{loading ? '查找中…' : '查找条目'}</button></div>
    {error && <p className={ui.error} role="alert">{error}</p>}
    {page && <><ul className={ui.selection}>{page.items.filter((item) => item.id !== id).map((item) => <li key={item.id}><span>{item.title}<small>{kindLabels[item.kind]}{item.archived ? ' · 已归档' : ''}</small></span><button className={ui.button} type="button" disabled={disabled || loading || item.id === value} onClick={() => onChange(item)}>{item.id === value ? '已关联' : '设为上级'}</button></li>)}</ul>{!page.items.some((item) => item.id !== id) && <p className={ui.muted}>本页没有可选的上级参考。</p>}<div className={ui.actions}><button className={ui.button} type="button" disabled={disabled || loading || offset === 0} onClick={() => void load(query, Math.max(0, offset - 50))}>上一页</button><span className={ui.muted}>共 {page.total} 条</span><button className={ui.button} type="button" disabled={disabled || loading || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) void load(query, page.nextOffset) }}>下一页</button></div></>}
  </details>
}
