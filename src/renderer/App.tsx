import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type {
  AppError, BookSnapshot, BookSummary, ChapterSnapshot, ChapterSummary, CommandMap, CompletedRequest,
  Result, ServiceCommand, StudioApi, WorkspaceSnapshot,
} from '../contracts/api'
import { parseManuscript } from '../contracts/manuscript'
import type { CreateKnowledgeItemInput, KnowledgeItemDetail, KnowledgeStatus, UpdateKnowledgeItemInput } from '../contracts/knowledge'
import type { CreateStoryRecordInput, StoryRecordDetail, UpdateStoryRecordInput } from '../contracts/story'
import type { MemoryControlInput, MemoryStartInput, MemoryTaskInput, MemoryTaskReceipt } from '../contracts/memory'
import { isAiAdoptReceiptFor, isAiMemoryAdoptReceiptFor, type AiAdoptInput, type AiAdoptReceipt, type AiMemoryAdoptInput, type AiMemoryAdoptReceipt, type AiRun } from '../contracts/ai'
import { isAiSummaryAdoptReceiptFor, type AiSummaryAdoptInput, type AiSummaryAdoptReceipt, type AiSummaryTaskSummary } from '../contracts/ai-summary'
import type { BookRecoveryRestoreReceipt } from '../contracts/book-recovery'
import { isNoteWriteReceiptFor, type CreateNoteInput, type NoteDetail, type PromoteNoteInput, type UpdateNoteInput } from '../contracts/notes'
import { ManuscriptEditor } from './components/ManuscriptEditor'
import { BookShelf, ChapterOutline } from './components/LibraryPanels'
import { BookDetailsDialog, ChapterDetailsDialog, ConfirmDialog, ExportDialog, NameDialog, type BookFields, type ChapterFields, type ExportFields } from './components/EditingDialogs'
import { RevisionHistory } from './components/RevisionHistory'
import { TextImportDialog } from './components/TextImportDialog'
import { OrphanBooksDialog, RecoveryDialog } from './components/RecoveryDialogs'
import { DraftImportDialog } from './components/DraftImportDialog'
import { KnowledgePanel } from './components/KnowledgePanel'
import { StoryPanel } from './components/StoryPanel'
import { StoryTimelinePanel } from './components/StoryTimelinePanel'
import { StoryGalaxyPanel } from './components/StoryGalaxyPanel'
import { BookReaderPanel } from './components/BookReaderPanel'
import { DisplayPreferencesPanel } from './components/DisplayPreferencesPanel'
import { NotesPanel } from './components/NotesPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { AiPanel } from './components/AiPanel'
import { AiMemoryTasksPanel } from './components/AiMemoryTasksPanel'
import { AiSummaryPanel } from './components/AiSummaryPanel'
import { BookRecoveryPanel } from './components/BookRecoveryPanel'
import { useChapterSession } from './hooks/useChapterSession'
import { useDraftProtection } from './hooks/useDraftProtection'
import { useDisplayPreferences } from './hooks/useDisplayPreferences'
import { displayTime, request, statusLabels } from './request'
import styles from './App.module.css'

interface Props { api?: StudioApi }
type ViewState = 'loading' | 'ready' | 'error'
type Modal =
  | { kind: 'newBook' } | { kind: 'newChapter'; volumeId: string | null }
  | { kind: 'volume'; volumeId?: string } | { kind: 'bookDetails'; book: BookSummary }
  | { kind: 'chapterDetails' } | { kind: 'history' } | { kind: 'finalize' } | { kind: 'preferences' } | { kind: 'notes' }
  | { kind: 'import' } | { kind: 'export' } | { kind: 'orphans' } | { kind: 'recovery' } | { kind: 'bookRecovery' } | { kind: 'draftImport' } | { kind: 'knowledge' } | { kind: 'story'; initialKind?: 'event' } | { kind: 'timeline' } | { kind: 'galaxy' } | { kind: 'reader' } | { kind: 'memory' } | { kind: 'ai' } | { kind: 'aiMemoryTasks' } | { kind: 'aiSummary' } | null
interface DraftReceipt { bookId: string; chapterId: string; editSequence: number; loadEpoch: number; filePath: string }

function toChapterSummary(chapter: ChapterSnapshot): ChapterSummary {
  // 目录仅保留元数据，不能把已编辑章节的全文逐步累积到书级界面状态中。
  const { id, title, position, revisionId, characterCount, updatedAt, volumeId, goal, viewpoint, targetCharacters, notes, status, finalizedRevisionId, finalizedAt } = chapter
  return { id, title, position, revisionId, characterCount, updatedAt, volumeId, goal, viewpoint, targetCharacters, notes, status, finalizedRevisionId, finalizedAt }
}

export function App({ api }: Props) {
  const display = useDisplayPreferences()
  const [viewState, setViewState] = useState<ViewState>('loading')
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>({ rootPath: null, books: [] })
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const [book, setBook] = useState<BookSnapshot | null>(null)
  const bookRef = useRef<BookSnapshot | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [busy, setBusy] = useState(false)
  const transition = useRef(false)
  const closeLocked = useRef(false)
  const pendingMutation = useRef<{ requestId?: string; receive: (response: CompletedRequest) => Promise<boolean> } | null>(null)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [checkingReceipt, setCheckingReceipt] = useState(false)
  const receiptCheck = useRef(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const recoveryLock = useRef(false)
  const [draftReceipt, setDraftReceipt] = useState<DraftReceipt | null>(null)
  const [focused, setFocused] = useState(false)
  const knowledgeDirty = useRef(false)
  const storyDirty = useRef(false)
  const notesDirty = useRef(false)
  const memoryWorking = useRef(false)
  const aiDirty = useRef(false)
  const detailsDirty = useRef(false)
  const [detailsCloseRequested, setDetailsCloseRequested] = useState(false)
  const markDetailsDirty = useCallback((value: boolean) => {
    detailsDirty.current = value
    if (!value) setDetailsCloseRequested(false)
  }, [])
  const bookRecoveryDirty = useRef(false)
  const [bookRecoveryLocked, setBookRecoveryLocked] = useState(false)
  const [bookRecoveryEpoch, setBookRecoveryEpoch] = useState(0)
  const markBookRecoveryDirty = useCallback((value: boolean) => {
    bookRecoveryDirty.current = value; setBookRecoveryLocked(value)
  }, [])

  const updateCurrentBook = useCallback((snapshot: BookSnapshot | null) => {
    bookRef.current = snapshot
    setBook(snapshot)
  }, [])

  const upsertShelf = useCallback((summary: BookSummary) => {
    setWorkspace((current) => ({ ...current, books: current.books.some((item) => item.id === summary.id)
      ? current.books.map((item) => item.id === summary.id ? summary : item) : [...current.books, summary] }))
  }, [])

  const onSaved = useCallback((saved: ChapterSnapshot) => {
    const current = bookRef.current
    if (current?.book.id === saved.bookId) {
      const summary = { ...current.book, revision: saved.bookRevision, updatedAt: saved.updatedAt }
      const chapters = current.chapters.some((item) => item.id === saved.id)
        ? current.chapters.map((item) => item.id === saved.id ? toChapterSummary(saved) : item)
        : [...current.chapters, toChapterSummary(saved)].sort((a, b) => a.position - b.position)
      // ref 与状态一起推进，await flush 后的 CAS 不依赖 React 的下一次渲染。
      updateCurrentBook({ ...current, book: summary, chapters })
      upsertShelf(summary)
    }
  }, [updateCurrentBook, upsertShelf])
  const session = useChapterSession(api, onSaved)
  const protection = useDraftProtection(api, workspace.recoveryScope, session)
  const chapter = session.session.chapter
  const archived = Boolean(book?.book.archivedAt)

  async function changeView(operation: () => Promise<void>, fromMemoryPanel = false, fromNotesPanel = false) {
    if (transition.current || recoveryLock.current) return
    if (bookRecoveryDirty.current) { setMessage('作品备份或恢复仍在处理或等待回执，请先在面板中核对。'); return }
    if (memoryWorking.current && !fromMemoryPanel) { setMessage('记忆面板仍有处理中或未确认的请求，请先核对回执后再切换。'); return }
    if (notesDirty.current && !fromNotesPanel) { setMessage('笔记有未保存修改或未确认请求，请先在素材与笔记中处理。'); return }
    if (session.isComposing()) { setMessage('请先完成当前输入，再继续操作。'); return }
    transition.current = true
    flushSync(() => setBusy(true))
    setMessage(null)
    try {
      // 切换目录、恢复与定稿都先冻结并保存，再读取当前版本执行后续命令。
      if (await session.flush()) await operation()
    } catch {
      setMessage('操作未完成，当前稿件仍保留在窗口中。')
    } finally {
      if (!pendingMutation.current) { transition.current = false; setBusy(false) }
    }
  }

  function holdUnconfirmed(error: AppError, receive: (response: CompletedRequest) => Promise<boolean>, preserveForm = false) {
    if (error.code !== 'REQUEST_TIMEOUT' && error.code !== 'SERVICE_UNAVAILABLE') return
    pendingMutation.current = { requestId: error.requestId, receive }
    setPendingMessage('上次操作尚未确认。已暂停新的写入，请核对回执；服务退出后可从草稿与恢复入口重新连接。')
    if (!preserveForm) setModal(null)
  }

  async function mutate<K extends ServiceCommand>(command: K, run: () => Promise<Result<CommandMap[K]['output'] | null>>, apply: (value: CommandMap[K]['output']) => void | boolean | Promise<void | boolean>) {
    const preserveForm = command === 'book.update' || command === 'chapter.update' || command.startsWith('knowledge.') || command.startsWith('story.') || command.startsWith('memory.') || command.startsWith('ai.') || command.startsWith('notes.')
    const receive = async (response: CompletedRequest): Promise<boolean> => {
      if (response.command !== command) return false
      // command 已核对；映射类型的关联在跨回调处由这一处收窄保留。
      const completion = response.result as Result<CommandMap[K]['output']>
      if (completion.ok) return await apply(completion.data) !== false
      setMessage(completion.error.message)
      return true
    }
    const result = await request(run)
    if (result.ok) {
      // 成功信封仍须通过业务回执核对；不符时保持原稿与版本基线并停止写入。
      if (result.data !== null && await apply(result.data) === false) holdUnconfirmed({ code: 'SERVICE_UNAVAILABLE', message: '操作回执与当前内容不符，请留存编辑并进入恢复核对。' }, receive, preserveForm)
      return
    }
    setMessage(result.error.message)
    holdUnconfirmed(result.error, receive, preserveForm)
  }

  async function checkMutationReceipt() {
    if (!api || !pendingMutation.current || receiptCheck.current || recoveryLock.current) return
    const pending = pendingMutation.current
    if (!pending.requestId) { setPendingMessage('操作结果无法确认，请先另存草稿。服务退出后可重新连接并核对作品和目录。'); return }
    receiptCheck.current = true; setCheckingReceipt(true)
    try {
      const result = await request(() => api.getRequestStatus({ requestId: pending.requestId! }))
      if (!result.ok) { setPendingMessage(result.error.message); return }
      if (result.data.state !== 'completed') {
        setPendingMessage(result.data.state === 'pending' ? '操作仍在处理中，请稍后再次核对。' : '回执已不可用，暂时无法确认结果。请先另存草稿再进入恢复。')
        return
      }
      const completion = result.data.response.result
      if (!completion.ok && (completion.error.code === 'REQUEST_TIMEOUT' || completion.error.code === 'SERVICE_UNAVAILABLE')) {
        setPendingMessage(completion.error.message); return
      }
      if (!await pending.receive(result.data.response)) { setPendingMessage('回执与当前操作不匹配，已停止切换。'); return }
      pendingMutation.current = null; setPendingMessage(null); transition.current = false; setBusy(false)
    } catch { setPendingMessage('回执处理未完成，当前内容已保留，请稍后重试核对。') }
    finally { receiptCheck.current = false; setCheckingReceipt(false) }
  }

  function applyBook(snapshot: BookSnapshot, enter = false) {
    upsertShelf(snapshot.book)
    if (!enter && bookRef.current?.book.id !== snapshot.book.id) return
    const current = session.getCurrent().chapter
    updateCurrentBook(snapshot)
    if (current?.bookId === snapshot.book.id) {
      const summary = snapshot.chapters.find((item) => item.id === current.id)
      if (summary?.revisionId === current.revisionId) session.load({ ...current, ...summary, bookRevision: snapshot.book.revision })
      else if (summary) setMessage('磁盘正文有更新，当前窗口保留原稿。请点击“刷新目录”读取最新正文。')
    } else if (enter) session.load(null)
  }

  async function refreshCurrentBook(bookId: string) {
    if (!api) return
    const result = await request(() => api.getBook({ bookId }))
    if (!result.ok) { setMessage('操作已完成，但目录刷新失败：' + result.error.message + ' 请点击刷新目录。'); return }
    applyBook(result.data)
    const current = session.getCurrent().chapter
    const latest = result.data.chapters.find((item) => item.id === current?.id)
    if (current && latest && latest.revisionId !== current.revisionId) {
      const read = await request(() => api.readChapter({ bookId, chapterId: current.id }))
      if (!read.ok) { setMessage(read.error.message); return }
      session.load(read.data); setMessage(null)
    }
  }

  async function acceptChapter(saved: ChapterSnapshot, refreshDirectory = false) {
    onSaved(saved); session.load(saved); setModal(null)
    if (refreshDirectory) await refreshCurrentBook(saved.bookId)
  }

  async function openWorkspace() {
    if (!api) return
    await changeView(async () => {
      await mutate('workspace.open', () => api.selectWorkspace(), (snapshot) => {
        session.load(null); setWorkspace(snapshot); updateCurrentBook(null); setViewState('ready'); setModal(null)
      })
    })
  }

  async function openBook(bookId: string) {
    if (!api) return
    await changeView(async () => {
      const result = await request(() => api.getBook({ bookId }))
      if (!result.ok) { setMessage(result.error.message); return }
      let first: ChapterSnapshot | null = null
      if (result.data.chapters[0]) {
        const read = await request(() => api.readChapter({ bookId, chapterId: result.data.chapters[0].id }))
        if (!read.ok) { setMessage(read.error.message); return }
        first = read.data
      }
      session.load(first); updateCurrentBook(result.data); upsertShelf(result.data.book); setModal(null)
    })
  }

  async function openChapter(chapterId: string) {
    if (!api || !bookRef.current || session.getCurrent().chapter?.id === chapterId) return
    const bookId = bookRef.current.book.id
    await changeView(async () => {
      const result = await request(() => api.readChapter({ bookId, chapterId }))
      if (!result.ok) { setMessage(result.error.message); return }
      session.load(result.data)
    })
  }

  async function showShelf() {
    await changeView(async () => { session.load(null); updateCurrentBook(null); setModal(null) })
  }

  function showDialog(next: Exclude<Modal, null>) {
    if (next.kind === 'bookRecovery' && (knowledgeDirty.current || storyDirty.current || notesDirty.current || memoryWorking.current || aiDirty.current)) {
      setMessage('当前面板仍有未保存修改或未确认请求，请先处理后再进入作品备份与恢复。'); return
    }
    void changeView(async () => {
      if (next.kind === 'bookDetails' && api) {
        const result = await request(() => api.getBook({ bookId: next.book.id }))
        if (!result.ok) { setMessage(result.error.message); return }
        applyBook(result.data); setModal({ kind: 'bookDetails', book: result.data.book })
      } else if (next.kind === 'timeline' && api && bookRef.current) {
        const bookId = bookRef.current.book.id
        const result = await request(() => api.getBook({ bookId }))
        if (!result.ok) { setMessage(result.error.message); return }
        if (result.data.book.id !== bookId) { setMessage('时间线的作品目录身份不符，请重新打开作品。'); return }
        // 只读视图刷新目录时保留正文编辑实例及其撤销历史。
        upsertShelf(result.data.book); updateCurrentBook(result.data)
        const current = session.getCurrent().chapter
        if (current?.bookId === bookId && result.data.chapters.find((item) => item.id === current.id)?.revisionId !== current.revisionId) {
          setMessage('磁盘正文有更新，当前窗口保留原稿。请关闭时间线后刷新目录读取最新正文。')
        }
        setModal(next)
      } else setModal(next)
    })
  }

  async function createBook(title: string) {
    if (!api) return
    await changeView(async () => {
      await mutate('book.create', () => api.createBook({ title }), (snapshot) => { applyBook(snapshot, true); setModal(null) })
    })
  }

  async function createChapter(title: string, volumeId: string | null) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current || current.book.archivedAt) return
      await mutate('chapter.create', () => api.createChapter({ bookId: current.book.id, title, volumeId }), (saved) => acceptChapter(saved, true))
    })
  }

  async function updateBookDetails(target: BookSummary, fields: BookFields) {
    if (!api) return
    await changeView(async () => {
      const revision = bookRef.current?.book.id === target.id ? bookRef.current.book.revision : target.revision
      await mutate('book.update', () => api.updateBook({ bookId: target.id, expectedBookRevision: revision, ...fields }), (snapshot) => { applyBook(snapshot); setModal(null) })
    })
  }

  async function saveVolume(title: string, volumeId?: string) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current || current.book.archivedAt) return
      const input = { bookId: current.book.id, expectedBookRevision: current.book.revision, title }
      const apply = (snapshot: BookSnapshot) => { applyBook(snapshot); setModal(null) }
      if (volumeId) await mutate('volume.rename', () => api.renameVolume({ ...input, volumeId }), apply)
      else await mutate('volume.create', () => api.createVolume(input), apply)
    })
  }

  async function moveItem(kind: 'chapter' | 'volume', id: string, direction: -1 | 1) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current || current.book.archivedAt) return
      const input = { bookId: current.book.id, expectedBookRevision: current.book.revision }
      if (kind === 'volume') {
        const ids = current.volumes.map((item) => item.id)
        const index = ids.indexOf(id), next = index + direction
        if (index < 0 || next < 0 || next >= ids.length) return
        ;[ids[index], ids[next]] = [ids[next]!, ids[index]!]
        await mutate('volume.reorder', () => api.reorderVolumes({ ...input, volumeIds: ids }), applyBook)
      } else {
        const item = current.chapters.find((candidate) => candidate.id === id)
        if (!item) return
        const siblings = current.chapters.filter((candidate) => candidate.volumeId === item.volumeId)
        const index = siblings.findIndex((candidate) => candidate.id === id), neighbor = siblings[index + direction]
        if (!neighbor) return
        const ids = current.chapters.map((candidate) => candidate.id)
        const from = ids.indexOf(id), to = ids.indexOf(neighbor.id)
        ;[ids[from], ids[to]] = [ids[to]!, ids[from]!]
        await mutate('chapter.reorder', () => api.reorderChapters({ ...input, chapterIds: ids }), applyBook)
      }
    })
  }

  async function updateChapterDetails(fields: ChapterFields) {
    if (!api) return
    await changeView(async () => {
      const current = session.getCurrent().chapter, activeBook = bookRef.current
      if (!current || !activeBook || activeBook.book.archivedAt) return
      await mutate('chapter.update', () => api.updateChapter({ bookId: current.bookId, chapterId: current.id, expectedBookRevision: activeBook.book.revision, ...fields }), (saved) => acceptChapter(saved, true))
    })
  }

  async function finalizeChapter() {
    if (!api) return
    await changeView(async () => {
      const current = session.getCurrent().chapter, activeBook = bookRef.current
      if (!current || !activeBook || activeBook.book.archivedAt) return
      await mutate('chapter.finalize', () => api.finalizeChapter({ bookId: current.bookId, chapterId: current.id, expectedRevisionId: current.revisionId, expectedBookRevision: activeBook.book.revision }), acceptChapter)
    })
  }

  async function restoreRevision(revisionId: string) {
    if (!api) return
    await changeView(async () => {
      const current = session.getCurrent().chapter
      if (!current || bookRef.current?.book.archivedAt) return
      await mutate('revision.restore', () => api.restoreRevision({ bookId: current.bookId, chapterId: current.id, revisionId, expectedRevisionId: current.revisionId }), acceptChapter)
    })
  }

  async function commitImport(token: string, title: string) {
    if (!api) return
    await changeView(async () => {
      await mutate('import.commit', () => api.commitTextImport({ token, title }), (snapshot) => { applyBook(snapshot, true); setModal(null); setMessage('导入完成。请选择目录中的章节开始检查与编辑。') })
    })
  }

  async function commitDraftImport(token: string, title: string) {
    if (!api || !workspace.recoveryScope) return
    const scope = workspace.recoveryScope
    await changeView(async () => {
      await mutate('draft.import', () => api.commitDraftImport({ scope, token, title }), async (saved) => {
        await acceptChapter(saved, true)
        setMessage('草稿已恢复为新章节，原章和原始副本已保留。请核对新章正文与来源记录。')
      })
    })
  }

  async function acceptKnowledge<T extends KnowledgeItemDetail | StoryRecordDetail | KnowledgeStatus>(saved: T, accept: (saved: T) => void) {
    const current = bookRef.current
    if (current?.book.id === saved.bookId) {
      // 已确认的知识写入也推进作品版本；即使随后目录刷新失败，下一次 CAS 仍有正确基线。
      const summary = { ...current.book, revision: saved.bookRevision, updatedAt: saved.updatedAt > current.book.updatedAt ? saved.updatedAt : current.book.updatedAt }
      updateCurrentBook({ ...current, book: summary }); upsertShelf(summary)
    }
    setMessage(null); accept(saved)
    await refreshCurrentBook(saved.bookId)
  }

  async function createKnowledge(input: CreateKnowledgeItemInput, accept: (saved: KnowledgeItemDetail) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('knowledge.create', () => api.createKnowledgeItem(input), (saved) => acceptKnowledge(saved, accept))
    })
  }

  async function updateKnowledge(input: UpdateKnowledgeItemInput, accept: (saved: KnowledgeItemDetail) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('knowledge.update', () => api.updateKnowledgeItem(input), (saved) => acceptKnowledge(saved, accept))
    })
  }

  async function upgradeKnowledge(accept: (status: KnowledgeStatus) => void) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current || current.book.archivedAt) return
      await mutate('knowledge.upgrade', () => api.upgradeKnowledge({ bookId: current.book.id, expectedBookRevision: current.book.revision }), (status) => acceptKnowledge(status, accept))
    }, modal?.kind === 'memory', modal?.kind === 'notes')
  }

  async function writeNote(command: 'notes.create' | 'notes.update' | 'notes.promote', input: CreateNoteInput | UpdateNoteInput | PromoteNoteInput,
    run: () => Promise<Result<NoteDetail>>, accept: (saved: NoteDetail) => boolean) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      // 不能把新笔记版本附着到旧目录，再让后续目录写入误用新的 CAS 基线。
      if (bookRef.current?.book.revision !== input.expectedBookRevision) {
        setMessage('笔记使用的作品版本与当前目录不同。请先复制留存修改，关闭面板并刷新目录后再编辑。'); return
      }
      await mutate(command, run, (saved) => {
        const current = bookRef.current
        if (!isNoteWriteReceiptFor(input, saved) || current?.book.id !== saved.bookId || current.book.revision > saved.bookRevision) {
          setMessage('笔记回执与本次提交不符，当前输入仍保留，请核对原请求。'); return false
        }
        if (!accept(saved)) return false
        // 笔记只更新作品版本，保存后保留当前正文实例及其撤销历史。
        const savedAt = saved.promotion && saved.promotion.createdAt > saved.updatedAt ? saved.promotion.createdAt : saved.updatedAt
        const summary = { ...current.book, revision: saved.bookRevision, updatedAt: savedAt > current.book.updatedAt ? savedAt : current.book.updatedAt }
        updateCurrentBook({ ...current, book: summary }); upsertShelf(summary); setMessage(null)
        return true
      })
    }, false, true)
  }

  async function createStory(input: CreateStoryRecordInput, accept: (saved: StoryRecordDetail) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('story.create', () => api.createStoryRecord(input), (saved) => acceptKnowledge(saved, accept))
    })
  }

  async function updateStory(input: UpdateStoryRecordInput, accept: (saved: StoryRecordDetail) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('story.update', () => api.updateStoryRecord(input), (saved) => acceptKnowledge(saved, accept))
    })
  }

  async function startMemory(input: MemoryStartInput, accept: (saved: MemoryTaskReceipt) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => { await mutate('memory.start', () => api.startMemoryTask(input), accept) }, true)
  }

  async function stepMemory(input: MemoryTaskInput, accept: (saved: MemoryTaskReceipt) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => { await mutate('memory.step', () => api.stepMemoryTask(input), accept) }, true)
  }

  async function controlMemory(input: MemoryControlInput, accept: (saved: MemoryTaskReceipt) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => { await mutate('memory.control', () => api.controlMemoryTask(input), accept) }, true)
  }

  async function adoptAi(input: AiAdoptInput, source: AiRun, accept: (saved: AiAdoptReceipt) => boolean) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('ai.adopt', () => api.adoptAiRun(input), async (saved) => {
        if (!isAiAdoptReceiptFor(input, source, saved)) { setMessage('采用回执与固定提议不符，请保留改稿并核对记录。'); return false }
        if (!accept(saved)) return false
        // 采用回执推进正文与目录版本；候选面板继续保留原输出和采用记录。
        onSaved(saved.chapter); session.load(saved.chapter); setMessage(null)
        await refreshCurrentBook(saved.bookId)
      })
    })
  }

  async function adoptAiMemory(input: AiMemoryAdoptInput, source: AiRun, accept: (saved: AiMemoryAdoptReceipt) => boolean) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('ai.memory.adopt', () => api.adoptAiMemory(input), async (saved) => {
        if (!isAiMemoryAdoptReceiptFor(input, source, saved)) { setMessage('知识采用回执与固定提议不符，请保留审阅内容并核对记录。'); return false }
        if (!accept(saved)) return false
        await acceptKnowledge(saved.status, () => {})
      })
    })
  }

  async function adoptAiSummary(input: AiSummaryAdoptInput, source: AiRun, previous: AiSummaryTaskSummary, accept: (saved: AiSummaryAdoptReceipt) => boolean) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('ai.summary.adopt', () => api.adoptAiSummary(input), async (saved) => {
        if (!isAiSummaryAdoptReceiptFor(input, source, previous, saved)) { setMessage('汇总采用回执与固定节点不符，请保留审阅内容并核对记录。'); return false }
        if (!accept(saved)) return false
        const current = bookRef.current
        if (current?.book.id === input.bookId) {
          // 汇总采用只推进作品版本，子面板确认前不改变父层的条件写入基线。
          const summary = { ...current.book, revision: saved.status.bookRevision, updatedAt: saved.status.updatedAt > current.book.updatedAt ? saved.status.updatedAt : current.book.updatedAt }
          updateCurrentBook({ ...current, book: summary }); upsertShelf(summary)
        }
        setMessage(null); await refreshCurrentBook(input.bookId)
      })
    })
  }

  async function exportBook(fields: ExportFields) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current) return
      await mutate('book.export', () => api.exportBook({ bookId: current.book.id, expectedBookRevision: current.book.revision, ...fields }), (receipt) => {
        setModal(null); setMessage('已导出 ' + receipt.chapterCount + ' 章、' + receipt.characterCount.toLocaleString() + ' 字到：' + receipt.filePath)
      })
    })
  }

  async function registerBook(bookId: string) {
    if (!api) return
    await changeView(async () => {
      await mutate('workspace.register', () => api.registerOrphanBook({ bookId }), (snapshot) => { applyBook(snapshot); setModal(null); setMessage('已将《' + snapshot.book.title + '》登记到书架。') })
    })
  }

  function acceptBookRecovery(receipt: BookRecoveryRestoreReceipt) {
    // 完成回执先登记到当前书架；随后刷新失败不改变恢复成功的事实。
    if (workspaceRef.current.rootPath === receipt.targetRoot) upsertShelf(receipt.book)
  }

  async function refreshRecoveryShelf(targetRoot: string): Promise<string | null> {
    if (!api || workspaceRef.current.rootPath !== targetRoot) return '当前作品库已变化，请回到恢复目标作品库查看。'
    const result = await request(() => api.getWorkspace())
    if (!result.ok) return result.error.message
    if (result.data.rootPath !== targetRoot || workspaceRef.current.rootPath !== targetRoot) return '返回的作品库与恢复目标不一致，请重新选择目标作品库查看。'
    setWorkspace(result.data); setViewState('ready')
    return null
  }

  function openRecovery(preservedForm = false) {
    if (recoveryLock.current || receiptCheck.current || closeLocked.current || session.isComposing() || session.getCurrent().saving) return
    if (transition.current && !pendingMutation.current) return
    // 资料与 AI 改稿独立于正文副本；只有面板确认留存后才能转入恢复。
    if ((detailsDirty.current || knowledgeDirty.current || storyDirty.current || notesDirty.current || memoryWorking.current || aiDirty.current || bookRecoveryDirty.current) && !preservedForm) {
      setMessage('当前面板有未保存修改或未确认请求，请先处理或在面板内留存副本后再进入恢复。'); return
    }
    session.pauseAutoSave(true)
    setMessage(null); setModal({ kind: 'recovery' })
  }

  function currentCopy(): DraftReceipt | null {
    const current = session.getCurrent()
    return draftReceipt && current.chapter?.id === draftReceipt.chapterId && current.chapter.bookId === draftReceipt.bookId
      && current.editSequence === draftReceipt.editSequence && current.loadEpoch === draftReceipt.loadEpoch ? draftReceipt : null
  }

  async function saveDraftCopy() {
    if (!api || recoveryLock.current || session.isComposing() || session.getCurrent().saving) return
    recoveryLock.current = true
    flushSync(() => { setBusy(true); setRecoveryBusy(true) })
    try {
      const current = session.getCurrent()
      if (!current.chapter) return
      const document = parseManuscript(current.draft)
      const result = await request(() => api.saveDraftCopy({ bookId: current.chapter!.bookId, chapterId: current.chapter!.id, title: current.chapter!.title, baseRevisionId: current.chapter!.revisionId, document }))
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data) setDraftReceipt({ bookId: current.chapter.bookId, chapterId: current.chapter.id, editSequence: current.editSequence, loadEpoch: current.loadEpoch, filePath: result.data.filePath })
    } catch { setMessage('无法生成当前草稿副本。当前内容仍保留，请先选中正文复制留存。') }
    finally { recoveryLock.current = false; setRecoveryBusy(false); setBusy(Boolean(pendingMutation.current)) }
  }

  async function recoverWorkspace(restart: boolean) {
    if (!api || recoveryLock.current || receiptCheck.current || session.isComposing() || session.getCurrent().saving) return
    const captured = session.getCurrent()
    if (captured.chapter && !currentCopy()) { setMessage('草稿已变化，请先另存当前版本的副本。'); return }
    if (!restart && (pendingMutation.current || bookRecoveryDirty.current || captured.error?.code !== 'REVISION_CONFLICT')) return
    recoveryLock.current = true
    flushSync(() => { setBusy(true); setRecoveryBusy(true) })
    setMessage(null)
    try {
      // 主进程掌握服务实例身份：恢复服务上的重试只读工作室，旧实例退出后才重建。
      const result = await request(() => restart ? api.restartService() : api.getWorkspace())
      if (!result.ok) { setMessage(result.error.message); return }
      let freshBook: BookSnapshot | null = null
      let freshChapter: ChapterSnapshot | null = null
      const bookId = captured.chapter?.bookId ?? bookRef.current?.book.id
      if (bookId && result.data.books.some((item) => item.id === bookId)) {
        const readBook = await request(() => api.getBook({ bookId }))
        if (!readBook.ok) { setMessage(readBook.error.message); return }
        freshBook = readBook.data
        if (captured.chapter) {
          const read = await request(() => api.readChapter({ bookId, chapterId: captured.chapter!.id }))
          if (!read.ok) { setMessage(read.error.message); return }
          freshChapter = read.data
        }
      } else if (captured.chapter) { setMessage('重新连接后未找到当前作品。窗口草稿已保留，请先核对作品库。'); return }
      // 副本对应同一编辑序号，且新服务/磁盘读取都成功，才允许作者确认的替换。
      session.resetAfterRecovery(freshChapter, captured.editSequence)
      setWorkspace(result.data); updateCurrentBook(freshBook); setViewState('ready')
      pendingMutation.current = null; setPendingMessage(null); transition.current = false; setModal(bookRecoveryDirty.current ? { kind: 'bookRecovery' } : null); setDraftReceipt(null)
      setBookRecoveryEpoch((value) => value + 1)
      session.pauseAutoSave(false)
      setMessage('已重新读取磁盘内容。此前未确认的操作可能已写入，请先核对书架和目录；草稿副本已保留在另存位置。')
    } catch { setMessage('恢复尚未完成，窗口草稿和已保存副本仍保留，请再次核对后重试。') }
    finally { recoveryLock.current = false; setRecoveryBusy(false); setBusy(Boolean(pendingMutation.current)) }
  }

  useEffect(() => {
    let active = true
    if (!api) { setViewState('error'); setMessage('桌面桥接未加载，当前窗口无法访问本地作品。'); return }
    void request(() => api.getWorkspace()).then((result) => {
      if (!active) return
      if (!result.ok) { setViewState('error'); setMessage(result.error.message); return }
      setWorkspace(result.data); setViewState('ready')
    })
    return () => { active = false }
  }, [api])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!transition.current && !recoveryLock.current && !bookRecoveryDirty.current && modal?.kind !== 'recovery' && modal?.kind !== 'bookRecovery') void session.flush()
      }
      if (!modal && !event.defaultPrevented && !session.isComposing() && !busy && chapter) {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter') {
          event.preventDefault(); setFocused((value) => !value)
        } else if (event.key === 'Escape') setFocused(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [session.flush, session.isComposing, modal, busy, chapter])

  useEffect(() => { if (!chapter) setFocused(false) }, [chapter])

  useEffect(() => {
    if (!api) return
    const cancelClose = api.onCloseCancelled(() => {
      if (!closeLocked.current) return
      closeLocked.current = false; transition.current = false; setBusy(false)
    })
    const requestClose = api.onCloseRequested(async () => {
      if (transition.current || recoveryLock.current || session.isComposing()) return false
      if (detailsDirty.current) { setDetailsCloseRequested(true); return false }
      if (knowledgeDirty.current) { setMessage('知识条目有未保存修改，请先保存或在知识库面板中明确放弃，再关闭窗口。'); return false }
      if (storyDirty.current) { setMessage('故事记录有未保存修改，请先保存或在故事记录面板中明确放弃，再关闭窗口。'); return false }
      if (notesDirty.current) { setMessage('笔记有未保存修改或未确认请求，请先在素材与笔记中保存或处理，再关闭窗口。'); return false }
      if (memoryWorking.current) { setMessage('本批整理操作尚未确认，请等回执返回后再关闭。'); return false }
      if (aiDirty.current) { setMessage('AI 面板仍有未确认请求或未保存修改，请先处理后再关闭。'); return false }
      if (bookRecoveryDirty.current) { setMessage('作品备份或恢复尚未确认，请先核对原回执后再关闭。'); return false }
      closeLocked.current = true; transition.current = true
      // 关闭回调必须等编辑器实际锁定后再回应，不能只排队一个状态更新。
      flushSync(() => setBusy(true))
      const saved = await session.flush()
      if (!saved) { closeLocked.current = false; transition.current = false; setBusy(false) }
      return saved
    })
    return () => { requestClose(); cancelClose() }
  }, [api, session.flush, session.isComposing])

  if (viewState === 'loading') return <div className={styles.centerState}><span className={styles.spinner} />正在打开工作室…</div>
  const modalError = message ?? session.session.error?.message
  const detailsRecovery = pendingMessage ? { message: pendingMessage, checking: checkingReceipt,
    onCheck: () => void checkMutationReceipt(), onRecover: () => openRecovery(true) } : undefined
  const closeModal = () => {
    if (recoveryLock.current) return
    if ((modal?.kind === 'bookDetails' || modal?.kind === 'chapterDetails') && detailsDirty.current) { setDetailsCloseRequested(true); return }
    if (modal?.kind === 'knowledge' && knowledgeDirty.current) return
    if (modal?.kind === 'story' && storyDirty.current) return
    if (modal?.kind === 'notes' && notesDirty.current) return
    if (modal?.kind === 'memory' && memoryWorking.current) return
    if ((modal?.kind === 'ai' || modal?.kind === 'aiMemoryTasks' || modal?.kind === 'aiSummary') && aiDirty.current) return
    if (modal?.kind === 'bookRecovery' && bookRecoveryDirty.current) return
    if (modal?.kind === 'recovery') session.pauseAutoSave(false)
    if (modal?.kind === 'recovery' && bookRecoveryDirty.current) { setModal({ kind: 'bookRecovery' }); setMessage(null); return }
    if (!pendingMutation.current) { setModal(null); setMessage(null) }
    else if (modal?.kind === 'recovery') setModal(null)
  }

  return <div className={`${styles.appShell} ${focused && chapter ? styles.focusMode : ''}`}>
    <aside className={styles.sidebar} aria-label="工作室导航">
      <div className={styles.brand}><span className={styles.brandMark} aria-hidden="true" /><div><strong>织章</strong><small>STORYWEAVE</small></div></div>
      <button className={styles.workspaceButton} type="button" onClick={() => void openWorkspace()} disabled={!api || busy || bookRecoveryLocked || session.session.saving}><span className={styles.bookGlyph} aria-hidden="true">卷</span><span><strong>{workspace.rootPath ? '本地作品库' : '选择作品库'}</strong><small>{workspace.rootPath ? '点击切换目录' : '尚未选择目录'}</small></span></button>
      <nav className={styles.nav} aria-label="作品功能"><button className={`${styles.navItem} ${!book ? styles.navItemActive : ''}`} type="button" onClick={() => void showShelf()} disabled={busy || bookRecoveryLocked || !workspace.rootPath}><span aria-hidden="true">册</span>我的书架</button>{book && <><div className={`${styles.navItem} ${styles.navItemActive}`} aria-current="page"><span aria-hidden="true">写</span>正文创作</div><button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'reader' })} disabled={!api || busy || bookRecoveryLocked}><span aria-hidden="true">读</span>作品阅读</button><button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'galaxy' })} disabled={!api || busy || bookRecoveryLocked}><span aria-hidden="true">星</span>故事星海</button><button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'timeline' })} disabled={!api || busy || bookRecoveryLocked}><span aria-hidden="true">序</span>故事时间线</button></>}<button className={styles.navItem} type="button" onClick={() => showDialog({ kind: 'bookRecovery' })} disabled={!api || busy || bookRecoveryLocked || session.session.saving}><span aria-hidden="true">存</span>作品备份与恢复</button></nav>
      <div className={styles.sidebarFooter}><span className={styles.statusDot} />本地保存优先<span className={styles.version}>写作工作室</span></div>
    </aside>
    <main className={styles.main}>
      <header className={styles.topbar}><div><span className={styles.crumb}>工作室{book ? ' / ' + book.book.title : ''}</span><h1>{chapter?.title ?? book?.book.title ?? '我的书架'}</h1></div>
        <div className={styles.topActions}>{book && <><button className={styles.button} type="button" onClick={() => showDialog({ kind: 'bookDetails', book: book.book })} disabled={busy}>作品资料</button><button className={styles.button} type="button" onClick={() => showDialog({ kind: 'knowledge' })} disabled={busy}>本书知识库</button><button className={styles.button} type="button" onClick={() => showDialog({ kind: 'story' })} disabled={busy}>故事记录</button><button className={styles.button} type="button" onClick={() => showDialog({ kind: 'memory' })} disabled={busy}>记忆与检索</button><button className={styles.button} type="button" onClick={() => showDialog({ kind: 'aiMemoryTasks' })} disabled={busy}>章节整理任务</button><button className={styles.button} type="button" onClick={() => showDialog({ kind: 'aiSummary' })} disabled={busy}>分层汇总</button><button className={styles.button} type="button" onClick={() => showDialog({ kind: 'export' })} disabled={busy || book.chapters.length === 0}>导出</button></>}
          {chapter && <><span className={styles.saveState} role="status">{saveLabel(session.session)}</span><button className={styles.button} type="button" onClick={() => void session.flush()} disabled={busy || !session.session.dirty || session.session.saving || session.session.composing}>保存 <kbd>Ctrl S</kbd></button><button className={styles.button} type="button" aria-pressed={focused} title="切换专注模式（Ctrl+Shift+Enter），Esc退出" onClick={() => setFocused(!focused)} disabled={busy || session.session.composing}>{focused ? '退出专注' : '专注写作'}</button></>}
          <button className={styles.button} type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked || session.session.saving || session.session.composing}>显示偏好</button>
          <button className={styles.button} type="button" onClick={() => openRecovery()} disabled={!api || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt || (busy && !pendingMessage)}>草稿与恢复</button>
        </div>
      </header>
      {message && !modal && <div className={styles.notice} role="alert"><span>{message}</span><button type="button" onClick={() => setMessage(null)} aria-label="关闭提示">×</button></div>}
      {display.warning && !modal && <div className={styles.notice} role="status"><span>{display.warning}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing} onClick={display.retrySave}>保存当前显示偏好</button></div>}
      {pendingMessage && <div className={styles.notice} role="alert"><span>{pendingMessage}</span><button className={styles.receiptButton} type="button" onClick={() => void checkMutationReceipt()} disabled={checkingReceipt || recoveryBusy}>{checkingReceipt ? '正在核对…' : '核对回执'}</button></div>}
      {session.session.error && <div className={`${styles.notice} ${styles.noticeError}`} role="alert"><span>{session.session.error.message}{session.session.error.code === 'REVISION_CONFLICT' && ' 请从“草稿与恢复”另存后重载磁盘版本。'}</span></div>}
      {session.session.dirty && protection.state.error && <div className={`${styles.notice} ${styles.noticeError}`} role="alert"><span>恢复检查点未更新：{protection.state.error}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing} onClick={protection.retry}>重试留存</button></div>}
      {archived && <div className={styles.notice}><span>此作品已归档，可阅读和导出。继续编辑前请在作品资料中解除归档。</span></div>}
      {!workspace.rootPath ? <EmptyWorkspace onOpen={() => void openWorkspace()} busy={busy} available={Boolean(api)} /> : !book ? <BookShelf books={workspace.books} onOpen={(id) => void openBook(id)} onEdit={(item) => showDialog({ kind: 'bookDetails', book: item })} onCreate={() => showDialog({ kind: 'newBook' })} onImport={() => showDialog({ kind: 'import' })} onRecover={() => showDialog({ kind: 'orphans' })} busy={busy} /> : <>
        <div className={styles.chapterActions}><span>{book.chapters.length} 章 · {book.volumes.length} 卷</span><div className={styles.actionRow}>
          <button type="button" onClick={() => void changeView(async () => { await refreshCurrentBook(book.book.id) })} disabled={busy}>刷新目录</button>
          <button type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'notes' })} disabled={!api || busy || bookRecoveryLocked}>素材与笔记</button>
          {chapter && <button type="button" onClick={() => showDialog({ kind: 'ai' })} disabled={busy}>AI 协作</button>}
          <button type="button" onClick={() => showDialog({ kind: 'draftImport' })} disabled={busy || archived || !workspace.recoveryScope}>从草稿恢复新章</button>
          {chapter && <><button type="button" onClick={() => showDialog({ kind: 'chapterDetails' })} disabled={busy || archived}>{chapter.status === 'finalized' ? '资料 / 重开工作稿' : '本章资料'}</button><button type="button" onClick={() => showDialog({ kind: 'history' })} disabled={busy}>版本历史</button><button type="button" onClick={() => showDialog({ kind: 'finalize' })} disabled={busy || archived || (chapter.status === 'finalized' && !session.session.dirty)}>作者定稿</button></>}
        </div></div>
        <div className={styles.writeLayout}>
          <ChapterOutline book={book} selectedId={chapter?.id} busy={busy} onOpen={(id) => void openChapter(id)} onCreate={(volumeId) => showDialog({ kind: 'newChapter', volumeId })} onVolume={(volumeId) => showDialog({ kind: 'volume', volumeId })} onMoveChapter={(id, direction) => void moveItem('chapter', id, direction)} onMoveVolume={(id, direction) => void moveItem('volume', id, direction)} />
          <section className={styles.manuscript} aria-label="正文编辑区">{chapter ? <>
            <div className={styles.manuscriptMeta}><span>第 {chapter.position + 1} 章 · {statusLabels[chapter.status]}{chapter.viewpoint ? ' · ' + chapter.viewpoint : ''}</span><span>{session.session.characterCount.toLocaleString()} 字{chapter.targetCharacters !== null ? ' / ' + chapter.targetCharacters.toLocaleString() : ''}</span></div>
            {chapter.finalizedRevisionId && <p className={styles.finalizedNote}>已有作者定稿。修改后成为新草稿，原定稿保留。</p>}
            <ManuscriptEditor key={chapter.bookId + ':' + chapter.id + ':' + session.session.loadEpoch} document={chapter.document} disabled={busy || bookRecoveryLocked || Boolean(modal)} readOnly={archived} displayPreferences={display.preferences} onChange={session.changed} onComposition={session.setComposing} />
          </> : <div className={styles.emptyChapter}><h2>{book.chapters.length ? '选择一章继续' : '从第一场开始'}</h2><p>{book.chapters.length ? '从左侧目录打开正文。' : '建立章节后，每次正文保存都会留下版本。'}</p>{!archived && <button className={styles.primaryButton} type="button" onClick={() => showDialog({ kind: 'newChapter', volumeId: null })} disabled={busy}>建立章节</button>}</div>}</section>
          <aside className={styles.memoryAside} aria-label="本章记录"><div className={styles.asideHeading}>本章记录</div>
            <div className={styles.stateBlock}><strong>{chapter ? saveLabel(session.session) : '等待章节'}</strong><p>停笔片刻后自动保存，也可以按 Ctrl+S。保存失败时，当前草稿会留在窗口。</p>{chapter && <p>{protection.state.createdAt ? `恢复检查点：${displayTime(protection.state.createdAt)}${protection.state.editSequence < session.session.editSequence ? '（之后的输入尚未留存）' : ''}` : '未保存内容会定时留存到作品库的恢复目录。意外退出后，可从“从草稿恢复新章”预览。'}</p>}</div>
            {chapter?.goal && <><div className={styles.asideRule} /><div className={styles.stateBlock}><span className={styles.label}>本章目标</span><p>{chapter.goal}</p></div></>}
            <div className={styles.asideRule} /><div className={styles.stateBlock}><span className={styles.label}>最近保存</span><strong>{chapter ? displayTime(chapter.updatedAt) : '—'}</strong>{chapter?.finalizedAt && <p>最近定稿：{displayTime(chapter.finalizedAt)}</p>}</div>
            <div className={styles.asideRule} /><div className={styles.stateBlock}><span className={styles.label}>作品目录</span><p className={styles.directoryPath}>{workspace.rootPath}</p></div>
          </aside>
        </div>
      </>}
    </main>
    {modal?.kind === 'preferences' && <DisplayPreferencesPanel preferences={display.preferences} warning={display.warning} busy={busy} onChange={display.update} onReset={display.reset} onRetrySave={display.retrySave} onClose={closeModal} />}
    {modal?.kind === 'notes' && api && book && <NotesPanel key={book.book.id} api={api} book={book} displayPreferences={display.preferences} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { notesDirty.current = value }} onUpgrade={upgradeKnowledge}
      onCreate={(input, accept) => writeNote('notes.create', input, () => api.createNote(input), accept)} onUpdate={(input, accept) => writeNote('notes.update', input, () => api.updateNote(input), accept)} onPromote={(input, accept) => writeNote('notes.promote', input, () => api.promoteNote(input), accept)} />}
    {api && <BookRecoveryPanel api={api} open={modal?.kind === 'bookRecovery'} book={book?.book ?? null} targetRoot={workspace.rootPath} recoveryEpoch={bookRecoveryEpoch} busy={busy || recoveryBusy} error={modalError} onDirtyChange={markBookRecoveryDirty} onClose={closeModal} onRecover={() => openRecovery(true)} onChooseWorkspace={() => void openWorkspace()} onRestored={acceptBookRecovery} onRefresh={refreshRecoveryShelf} onOpenBook={(id) => void openBook(id)} />}
    {modal?.kind === 'ai' && api && book && chapter && <AiPanel key={book.book.id} api={api} book={book} chapter={chapter} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdopt={adoptAi} onAdoptMemory={adoptAiMemory} />}
    {modal?.kind === 'aiMemoryTasks' && api && book && <AiMemoryTasksPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdoptMemory={adoptAiMemory} />}
    {modal?.kind === 'aiSummary' && api && book && <AiSummaryPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdoptSummary={adoptAiSummary} />}
    {modal?.kind === 'newBook' && <NameDialog title="新建作品" submitLabel="建立作品" onSubmit={(title) => void createBook(title)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'newChapter' && <NameDialog title="新建章节" submitLabel="建立章节" onSubmit={(title) => void createChapter(title, modal.volumeId)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'volume' && <NameDialog title={modal.volumeId ? '修改卷名' : '新建卷'} initialValue={book?.volumes.find((item) => item.id === modal.volumeId)?.title} submitLabel="保存卷名" onSubmit={(title) => void saveVolume(title, modal.volumeId)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'bookDetails' && <BookDetailsDialog key={modal.book.id} book={modal.book} onSubmit={(fields) => void updateBookDetails(modal.book, fields)} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmClose={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
    {modal?.kind === 'chapterDetails' && chapter && book && <ChapterDetailsDialog key={chapter.id} chapter={chapter} volumes={book.volumes} onSubmit={(fields) => void updateChapterDetails(fields)} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmClose={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
    {modal?.kind === 'history' && chapter && api && <RevisionHistory api={api} chapter={chapter} archived={archived} onRestore={(id) => void restoreRevision(id)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'finalize' && chapter && <ConfirmDialog title="作者定稿" label="确认当前稿为定稿" onSubmit={() => void finalizeChapter()} onClose={closeModal} busy={busy} error={modalError}>当前正文会先保存，再成为本章新的作者定稿。后续编辑会生成工作稿，导出时仍可单独选择这次定稿。</ConfirmDialog>}
    {modal?.kind === 'import' && api && <TextImportDialog api={api} onCommit={(token, title) => void commitImport(token, title)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'export' && book && <ExportDialog title={book.book.title} finalizedCount={book.chapters.filter((item) => item.finalizedRevisionId).length} onSubmit={(fields) => void exportBook(fields)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'orphans' && api && <OrphanBooksDialog api={api} onRegister={(id) => void registerBook(id)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'draftImport' && api && book && workspace.recoveryScope && <DraftImportDialog key={workspace.recoveryScope + ':' + book.book.id} api={api} scope={workspace.recoveryScope} book={book.book} busy={busy} error={modalError} onClose={closeModal} onCommit={(token, title) => void commitDraftImport(token, title)} />}
    {modal?.kind === 'knowledge' && api && book && <KnowledgePanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(dirty) => { knowledgeDirty.current = dirty }} onUpgrade={upgradeKnowledge} onCreate={createKnowledge} onUpdate={updateKnowledge} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} />}
    {modal?.kind === 'story' && api && book && <StoryPanel key={book.book.id} api={api} book={book} initialKind={modal.initialKind} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(dirty) => { storyDirty.current = dirty }} onUpgrade={upgradeKnowledge} onCreate={createStory} onUpdate={updateStory} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} />}
    {modal?.kind === 'timeline' && api && book && <StoryTimelinePanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onOpenRecords={() => showDialog({ kind: 'story', initialKind: 'event' })} />}
    {modal?.kind === 'galaxy' && api && book && <StoryGalaxyPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onOpenKnowledge={() => changeView(async () => { setModal({ kind: 'knowledge' }) })} onOpenRecords={() => changeView(async () => { setModal({ kind: 'story' }) })} />}
    {modal?.kind === 'reader' && api && book && <BookReaderPanel key={book.book.id} api={api} book={book} initialChapterId={chapter?.id} busy={busy} error={modalError} displayPreferences={display.preferences} preferencesWarning={display.warning} onPreferencesChange={display.update} onRetryPreferencesSave={display.retrySave} onClose={closeModal} />}
    {modal?.kind === 'memory' && api && book && <MemoryPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(value) => { memoryWorking.current = value }} onUpgrade={upgradeKnowledge} onStart={startMemory} onStep={stepMemory} onControl={controlMemory} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} />}
    {modal?.kind === 'recovery' && <RecoveryDialog busy={recoveryBusy} error={message} hasDraft={Boolean(chapter)} copiedPath={currentCopy()?.filePath ?? null} uncertainMutation={Boolean(pendingMutation.current) || bookRecoveryLocked} canReloadWithoutRestart={!pendingMutation.current && !bookRecoveryLocked && session.session.error?.code === 'REVISION_CONFLICT'} onCopy={() => void saveDraftCopy()} onRecover={(restart) => void recoverWorkspace(restart)} onClose={closeModal} />}
  </div>
}

function saveLabel(session: { dirty: boolean; saving: boolean; composing: boolean; error: { code: string } | null }) {
  if (session.composing) return '输入法处理中'
  if (session.saving) return '保存中…'
  if (session.error?.code === 'REVISION_CONFLICT') return '版本冲突'
  if (session.error?.code === 'REQUEST_TIMEOUT' || session.error?.code === 'SERVICE_UNAVAILABLE') return '保存待确认'
  if (session.error) return '保存失败'
  return session.dirty ? '未保存' : '已保存'
}

function EmptyWorkspace({ onOpen, busy, available }: { onOpen: () => void; busy: boolean; available: boolean }) {
  return <section className={styles.emptyState}><span className={styles.emptyMark}>卷</span><h2>选择一处本地作品库</h2><p>作品、正文版本和后续知识资料都会留在你选择的目录中。</p><button className={styles.primaryButton} type="button" onClick={onOpen} disabled={busy || !available}>{!available ? '桌面连接不可用' : busy ? '正在选择…' : '选择作品库目录'}</button><small>首次使用请选一个空目录或已有织章工作室目录。</small></section>
}
