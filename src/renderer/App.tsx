import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type {
  AppError, BookSnapshot, BookSummary, ChapterSnapshot, ChapterSummary, CommandMap, CompletedRequest,
  Result, ServiceCommand, StudioApi, WorkspaceSnapshot, CreateBookInput,
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
import { WelcomeWorkspace } from './components/WelcomeWorkspace'
import { StudioIcon } from './components/StudioIcon'
import { Dialog } from './components/Dialog'
import { BookDetailsDialog, ChapterDetailsDialog, ConfirmDialog, NameDialog, type BookFields, type ChapterFields } from './components/EditingDialogs'
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
import { NewBookDialog } from './components/NewBookDialog'
import { ExportBookPanel } from './components/ExportBookPanel'
import { CompanionPanel, type CompanionNavigateTarget } from './components/CompanionPanel'
import { WorkbenchPanel } from './components/WorkbenchPanel'
import { InspirationPanel } from './components/InspirationPanel'
import { isRevisionMergeOutputFor, type RevisionMergeInput } from '../contracts/revision-merge'
import type { BookExportCommitInput } from '../contracts/export'
import { lastWritingBook, rememberWritingPosition, writingPosition, type WritingPosition } from './writing-location'
import { useChapterSession } from './hooks/useChapterSession'
import { useDraftProtection } from './hooks/useDraftProtection'
import { useDisplayPreferences } from './hooks/useDisplayPreferences'
import { displayTime, request, statusLabels } from './request'
import styles from './App.module.css'

interface Props { api?: StudioApi }
type ViewState = 'loading' | 'ready' | 'error'
type StudioSurface = 'home' | 'shelf' | 'write'
type WorkspaceTool = 'knowledge' | 'galaxy' | 'timeline' | 'notes' | 'workbench'
type Modal =
  | { kind: 'newBook' } | { kind: 'newChapter'; volumeId: string | null }
  | { kind: 'volume'; volumeId?: string } | { kind: 'bookDetails'; book: BookSummary }
  | { kind: 'chapterDetails' } | { kind: 'history' } | { kind: 'finalize' } | { kind: 'preferences' } | { kind: 'notes' } | { kind: 'workbench' } | { kind: 'inspiration' }
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
  const [surface, setSurface] = useState<StudioSurface>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [companionOpen, setCompanionOpen] = useState(false)
  const [returnLocation, setReturnLocation] = useState<{ root: string; bookId: string; chapterId: string; blockId?: string; offset?: number; scrollTop?: number } | null>(null)
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
  const workbenchDirty = useRef(false)
  const inspirationDirty = useRef(false)
  const manuscriptScroll = useRef<HTMLElement>(null)
  const navigationPosition = useRef<{ bookId: string; chapterId: string; position: WritingPosition } | null>(null)
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
  const studioView = surface === 'write' && book ? 'write' : surface === 'shelf' && workspace.rootPath ? 'shelf' : 'home'
  const recentBooks = [...workspace.books].sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
  const rememberedBook = workspace.books.find((item) => item.id === lastWritingBook(workspace.rootPath))
  const featuredBook = book?.book ?? rememberedBook ?? recentBooks.find((item) => !item.archivedAt) ?? recentBooks[0]

  useLayoutEffect(() => {
    if (!chapter || studioView !== 'write') return
    const position = writingPosition(workspace.rootPath, chapter.bookId)
    const reveal = navigationPosition.current?.bookId === chapter.bookId && navigationPosition.current.chapterId === chapter.id
    // 来源跳转由编辑器将目标段落滚入视野；普通返回仍恢复作者离开时的滚动位置。
    if (manuscriptScroll.current && !reveal) manuscriptScroll.current.scrollTop = position?.chapterId === chapter.id ? position.scrollTop ?? 0 : 0
    navigationPosition.current = null
    rememberWritingPosition(workspace.rootPath, chapter.bookId, chapter.id)
  }, [workspace.rootPath, chapter?.bookId, chapter?.id, session.session.loadEpoch, studioView])

  async function changeView(operation: () => Promise<void>, fromMemoryPanel = false, fromNotesPanel = false, fromWorkbenchPanel = false) {
    if (transition.current || recoveryLock.current) return
    if (bookRecoveryDirty.current) { setMessage('作品备份或恢复仍在处理或等待回执，请先在面板中核对。'); return }
    if (memoryWorking.current && !fromMemoryPanel) { setMessage('记忆面板仍有处理中或未确认的请求，请先核对回执后再切换。'); return }
    if (notesDirty.current && !fromNotesPanel) { setMessage('笔记有未保存修改或未确认请求，请先在素材与笔记中处理。'); return }
    if ((workbenchDirty.current || inspirationDirty.current) && !fromWorkbenchPanel) { setMessage('创作工具还有未保存表单或待核对请求，请先在面板中处理。'); return }
    if (session.isComposing()) { setMessage('请先完成当前输入，再继续操作。'); return }
    transition.current = true
    // 先关闭窄屏导航面板，再打开目标页面或对话框，避免两个模态焦点相互覆盖。
    flushSync(() => { setBusy(true); setNavigationOpen(false) })
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
    const preserveForm = command === 'book.create' || command === 'book.update' || command === 'chapter.update' || command.startsWith('knowledge.') || command.startsWith('story.') || command.startsWith('memory.') || command.startsWith('ai.') || command.startsWith('notes.') || command.startsWith('workbench.') || command.startsWith('inspiration.')
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
    if (enter) setSurface('write')
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
    onSaved(saved); session.load(saved); setModal(null); setSurface('write')
    if (refreshDirectory) await refreshCurrentBook(saved.bookId)
  }

  async function openWorkspace(next?: 'newBook' | 'import') {
    if (!api) return
    await changeView(async () => {
      await mutate('workspace.open', () => api.selectWorkspace(), (snapshot) => {
        session.load(null); setWorkspace(snapshot); updateCurrentBook(null); setViewState('ready'); setSurface('home'); setFocused(false)
        setReturnLocation(null)
        setModal(snapshot.rootPath && next ? { kind: next } : null)
      })
    })
  }

  async function openBook(bookId: string, chapterId?: string) {
    if (!api) return
    await changeView(async () => {
      const result = await request(() => api.getBook({ bookId }))
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.book.id !== bookId) { setMessage('返回的作品与所选作品不一致，请重新打开。'); return }
      const last = writingPosition(workspaceRef.current.rootPath, bookId)
      const targetChapter = chapterId ? result.data.chapters.find((item) => item.id === chapterId)
        : result.data.chapters.find((item) => item.id === last?.chapterId) ?? result.data.chapters[0]
      if (chapterId && !targetChapter) { setMessage('所选章节已不在作品目录中，请刷新工作台后重试。'); return }
      const current = session.getCurrent().chapter
      if (current?.bookId !== bookId) setReturnLocation(null)
      // 同一章且目录版本未变化时只恢复页面，保留正文选区和撤销栈。
      if (current?.bookId === bookId && current.id === targetChapter?.id && current.revisionId === targetChapter.revisionId && current.bookRevision === result.data.book.revision) {
        updateCurrentBook(result.data); upsertShelf(result.data.book); setModal(null); setSurface('write'); return
      }
      let first: ChapterSnapshot | null = null
      if (targetChapter) {
        const read = await request(() => api.readChapter({ bookId, chapterId: targetChapter.id }))
        if (!read.ok) { setMessage(read.error.message); return }
        if (read.data.bookId !== bookId || read.data.id !== targetChapter.id) { setMessage('返回的正文与所选章节不一致，请重新打开。'); return }
        first = read.data
      }
      session.load(first); updateCurrentBook(result.data); upsertShelf(result.data.book); setModal(null); setSurface('write')
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

  async function navigateCompanion(target: CompanionNavigateTarget) {
    if (!api || bookRef.current?.book.id !== target.bookId) return
    const beforeSave = session.getCurrent().chapter
    await changeView(async () => {
      const result = await request(() => api.readChapter({ bookId: target.bookId, chapterId: target.chapterId }))
      if (!result.ok) { setMessage(result.error.message); return }
      const next = result.data
      const current = session.getCurrent().chapter
      // 同章待保存稿可能由本次门禁推进版本，只接受本窗口已确认的保存，不能放过外部版本变化。
      const savedHere = beforeSave?.bookId === target.bookId && beforeSave.id === target.chapterId && beforeSave.revisionId === target.expectedRevisionId
        && current?.bookId === target.bookId && current.id === target.chapterId && current.revisionId === next.revisionId
      if (next.bookId !== target.bookId || next.id !== target.chapterId || next.revisionId !== target.expectedRevisionId && !savedHere || !next.document.content.some((block) => block.attrs.id === target.blockId)) {
        setMessage('来源对应的当前稿已变化，请在伴随资料中重新核对；原写作位置已保留。'); return
      }
      const root = workspaceRef.current.rootPath
      if (root && current) {
        const previous = writingPosition(root, current.bookId)
        setReturnLocation((first) => first?.root === root && first.bookId === current.bookId ? first
          : { ...(previous?.chapterId === current.id ? previous : {}), root, bookId: current.bookId, chapterId: current.id, scrollTop: manuscriptScroll.current?.scrollTop ?? previous?.scrollTop })
      }
      navigationPosition.current = { bookId: target.bookId, chapterId: target.chapterId, position: { blockId: target.blockId, offset: 0, reveal: true } }
      rememberWritingPosition(root, target.bookId, target.chapterId, { blockId: target.blockId, offset: 0 })
      session.load(next); setSurface('write')
    })
  }

  async function returnFromCompanion() {
    const destination = returnLocation
    if (!api || !destination || destination.root !== workspaceRef.current.rootPath || destination.bookId !== bookRef.current?.book.id) return
    await changeView(async () => {
      const result = await request(() => api.readChapter({ bookId: destination.bookId, chapterId: destination.chapterId }))
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.bookId !== destination.bookId || result.data.id !== destination.chapterId) { setMessage('返回位置的章节身份不匹配。'); return }
      rememberWritingPosition(destination.root, destination.bookId, destination.chapterId, destination)
      session.load(result.data); setReturnLocation(null)
    })
  }

  async function mergeSelectedRevision(input: RevisionMergeInput) {
    if (!api) return
    await changeView(async () => {
      await mutate('revision.merge', () => api.mergeRevision(input), async (value) => {
        if (!isRevisionMergeOutputFor(input, value)) return false
        await acceptChapter(value.chapter)
        return true
      })
    })
  }

  async function showShelf() {
    await changeView(async () => { session.load(null); updateCurrentBook(null); setReturnLocation(null); setModal(null); setSurface('shelf'); setFocused(false) })
  }

  async function showHome() {
    // 返回工作台仍经过保存门禁；保留当前作品，供数据概览与故事工具共用。
    await changeView(async () => { setSurface('home'); setFocused(false); setModal(null) })
  }

  function startBook(kind: 'newBook' | 'import') {
    if (workspace.rootPath) showDialog({ kind })
    else void openWorkspace(kind)
  }

  async function openWorkspaceTool(bookId: string, kind: WorkspaceTool) {
    if (!api) return
    await changeView(async () => {
      // 工具只需要作品目录。跨作品时等新目录读取成功后再释放旧章节。
      if (bookRef.current?.book.id !== bookId) {
        const result = await request(() => api.getBook({ bookId }))
        if (!result.ok) { setMessage(result.error.message); return }
        if (result.data.book.id !== bookId) { setMessage('返回的作品与所选作品不一致，请重新打开。'); return }
        session.load(null); updateCurrentBook(result.data); upsertShelf(result.data.book)
      }
      setModal({ kind })
    })
  }

  function openToolFromNav(kind: WorkspaceTool) {
    if (book) showDialog({ kind })
    else if (featuredBook) void openWorkspaceTool(featuredBook.id, kind)
    else startBook('newBook')
  }

  function resumeWriting() {
    if (book && session.getCurrent().chapter?.bookId === book.book.id) void changeView(async () => { setSurface('write'); setModal(null) })
    else if (book) void openBook(book.book.id)
    else if (featuredBook) void openBook(featuredBook.id)
    else startBook('newBook')
  }

  function showDraftProtection() {
    if (transition.current || recoveryLock.current || session.isComposing() || modal || !book || !workspace.recoveryScope) return
    // 容量检查与分代由主进程处理；不依赖故障服务先保存成功，窗口正文仍原样保留。
    setNavigationOpen(false)
    setModal({ kind: 'draftImport' })
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

  async function createBook(input: CreateBookInput) {
    if (!api) return
    await changeView(async () => {
      await mutate('book.create', () => api.createBook(input), async (snapshot) => {
        applyBook(snapshot, true); setModal(null)
        const first = snapshot.chapters[0]
        if (first) {
          const read = await request(() => api.readChapter({ bookId: snapshot.book.id, chapterId: first.id }))
          if (read.ok && read.data.bookId === snapshot.book.id && read.data.id === first.id) session.load(read.data)
          else setMessage('作品已建立，请从目录打开第一章。')
        }
      })
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

  async function exportBook(input: BookExportCommitInput) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current) return
      if (input.bookId !== current.book.id || input.expectedBookRevision !== current.book.revision) { setMessage('作品已更新，请重新生成导出预览。'); return }
      await mutate('book.export.commit', () => api.commitBookExport(input), (receipt) => {
        if (receipt.bookId !== input.bookId || receipt.bookRevision !== input.expectedBookRevision || receipt.exportId !== input.token || receipt.manifestHash !== input.manifestHash) return false
        setModal(null); setMessage(`已导出 ${receipt.chapterCount} 章、${receipt.characterCount.toLocaleString()} 字符到：${receipt.filePath}；固定版本清单：${receipt.manifestPath}`)
        return true
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

  function openNavigation() {
    if (modal || recoveryLock.current || receiptCheck.current || closeLocked.current || session.isComposing() || session.getCurrent().saving) return
    // 等待切换时禁止重开导航；未确认回执仍需保留进入恢复的入口。
    if (transition.current && !pendingMutation.current) return
    setNavigationOpen(true)
  }

  function openRecovery(preservedForm = false) {
    if (recoveryLock.current || receiptCheck.current || closeLocked.current || session.isComposing() || session.getCurrent().saving) return
    if (transition.current && !pendingMutation.current) return
    // 资料与 AI 改稿独立于正文副本；只有面板确认留存后才能转入恢复。
    if ((detailsDirty.current || knowledgeDirty.current || storyDirty.current || notesDirty.current || workbenchDirty.current || inspirationDirty.current || memoryWorking.current || aiDirty.current || bookRecoveryDirty.current) && !preservedForm) {
      setMessage('当前面板有未保存修改或未确认请求，请先处理或在面板内留存副本后再进入恢复。'); return
    }
    session.pauseAutoSave(true)
    flushSync(() => setNavigationOpen(false))
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
      if (studioView === 'write' && !modal && !navigationOpen && !event.defaultPrevented && !session.isComposing() && chapter) {
        if (event.key === 'Escape' && focused) {
          event.preventDefault(); setFocused(false)
        } else if (!busy && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter') {
          event.preventDefault(); setFocused((value) => !value)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [session.flush, session.isComposing, modal, navigationOpen, busy, chapter, focused, studioView])

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
      if (workbenchDirty.current || inspirationDirty.current) { setMessage('创作工具有未保存修改或待核对请求，请先在面板中处理。'); return false }
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
    if ((modal?.kind === 'bookDetails' || modal?.kind === 'chapterDetails' || modal?.kind === 'newBook') && detailsDirty.current) { setDetailsCloseRequested(true); return }
    if (modal?.kind === 'knowledge' && knowledgeDirty.current) return
    if (modal?.kind === 'story' && storyDirty.current) return
    if (modal?.kind === 'notes' && notesDirty.current) return
    if (modal?.kind === 'workbench' && workbenchDirty.current) return
    if (modal?.kind === 'inspiration' && inspirationDirty.current) return
    if (modal?.kind === 'memory' && memoryWorking.current) return
    if ((modal?.kind === 'ai' || modal?.kind === 'aiMemoryTasks' || modal?.kind === 'aiSummary') && aiDirty.current) return
    if (modal?.kind === 'bookRecovery' && bookRecoveryDirty.current) return
    if (modal?.kind === 'recovery') session.pauseAutoSave(false)
    if (modal?.kind === 'recovery' && bookRecoveryDirty.current) { setModal({ kind: 'bookRecovery' }); setMessage(null); return }
    if (!pendingMutation.current) { setModal(null); setMessage(null) }
    else if (modal?.kind === 'recovery') setModal(null)
  }

  const navigation = <>
      <div className={styles.brand}><span className={styles.brandMark} aria-hidden="true"><StudioIcon name="pen" size={23} /></span><div><strong>织章</strong><small>StoryWeave</small></div></div>
      <button className={styles.workspaceButton} type="button" onClick={() => void openWorkspace()} disabled={!api || busy || bookRecoveryLocked || session.session.saving}>
        <StudioIcon name="folder" /><span><small>{workspace.rootPath ? '当前作品库' : '本地创作空间'}</small><strong title={book?.book.title ?? workspace.rootPath ?? undefined}>{book?.book.title ?? (workspace.rootPath ? '我的作品库' : '选择作品库')}</strong></span><StudioIcon name="down" size={14} />
      </button>
      <nav className={styles.nav} aria-label="作品功能">
        <button className={`${styles.navItem} ${studioView === 'home' ? styles.navItemActive : ''}`} type="button" aria-current={studioView === 'home' ? 'page' : undefined} onClick={() => void showHome()} disabled={busy || bookRecoveryLocked}><StudioIcon name="home" />工作台</button>
        <button className={`${styles.navItem} ${studioView === 'write' ? styles.navItemActive : ''}`} type="button" aria-current={studioView === 'write' ? 'page' : undefined} onClick={resumeWriting} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="pen" />写作</button>
        <button className={`${styles.navItem} ${studioView === 'shelf' ? styles.navItemActive : ''}`} type="button" aria-current={studioView === 'shelf' ? 'page' : undefined} onClick={() => workspace.rootPath ? void showShelf() : void openWorkspace()} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="books" />作品书架<span className={styles.navCount}>{workspace.rootPath ? workspace.books.filter((item) => !item.archivedAt).length : '—'}</span></button>
        <span className={styles.navLabel}>故事空间</span>
        <button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => openToolFromNav('workbench')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="list" />规划与审稿</button>
        <button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => openToolFromNav('knowledge')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="read" />故事设定</button>
        <button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => openToolFromNav('galaxy')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="galaxy" />关系星海</button>
        <button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => openToolFromNav('timeline')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="timeline" />故事时间线</button>
        <button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => openToolFromNav('notes')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="notes" />灵感与笔记</button>
        <button className={styles.navItem} type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'inspiration' })} disabled={!api || !workspace.rootPath || busy || bookRecoveryLocked}><StudioIcon name="spark" />全局灵感收件箱</button>
        {book && <>
          <details className={styles.navGroup}>
            <summary><StudioIcon name="layers" />整理与审阅<StudioIcon name="down" size={14} /></summary>
            <button className={styles.navItem} type="button" onClick={() => showDialog({ kind: 'reader' })} disabled={busy}>作品阅读</button>
            <button className={styles.navItem} type="button" onClick={() => showDialog({ kind: 'bookDetails', book: book.book })} disabled={busy}>作品资料</button>
            <button className={styles.navItem} type="button" onClick={() => showDialog({ kind: 'story' })} disabled={busy}>故事记录</button>
            <button className={styles.navItem} type="button" onClick={() => showDialog({ kind: 'memory' })} disabled={busy}>记忆与检索</button>
            <button className={styles.navItem} type="button" onClick={() => showDialog({ kind: 'aiMemoryTasks' })} disabled={busy}>章节整理任务</button>
            <button className={styles.navItem} type="button" onClick={() => showDialog({ kind: 'aiSummary' })} disabled={busy}>分层汇总</button>
          </details>
        </>}
      </nav>
      <div className={styles.sidebarTools}>
        <button className={styles.navItem} type="button" title="作品备份与恢复" onClick={() => showDialog({ kind: 'bookRecovery' })} disabled={!api || busy || bookRecoveryLocked || session.session.saving}><StudioIcon name="archive" />作品备份与恢复</button>
        <button className={styles.navItem} type="button" title="草稿与恢复" onClick={() => openRecovery()} disabled={!api || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt || (busy && !pendingMessage)}><StudioIcon name="history" />草稿与恢复</button>
        <button className={styles.navItem} type="button" title="显示偏好" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked || session.session.saving || session.session.composing}><StudioIcon name="settings" />显示偏好</button>
      </div>
      <div className={styles.sidebarFooter}><span className={styles.statusDot} />本地创作 · 数据由你掌管<small>每一个故事，都值得被写下。</small></div>
    </>

  return <div className={`${styles.appShell} ${sidebarCollapsed ? styles.sidebarCollapsed : ''} ${studioView === 'write' && focused && chapter ? styles.focusMode : ''}`}>
    <aside id="studio-sidebar" className={styles.sidebar} aria-label="工作室导航">{navigation}</aside>
    <main className={`${styles.main} ${studioView !== 'write' ? styles.homeMain : ''}`}>
      <header className={styles.topbar}>
        <div className={styles.breadcrumb}><button className={styles.sidebarToggle} type="button" title={sidebarCollapsed ? '显示侧栏' : '隐藏侧栏'} aria-label={sidebarCollapsed ? '显示侧栏' : '隐藏侧栏'} aria-expanded={!sidebarCollapsed} aria-controls="studio-sidebar" onClick={() => setSidebarCollapsed((value) => !value)}><StudioIcon name="sidebar" size={19} /></button><div><h1>{studioView === 'write' ? '正文创作' : studioView === 'shelf' ? '作品书架' : '工作台'}</h1><span className={styles.crumb} title={book?.book.title}>{book ? book.book.title : '个人创作空间'}</span></div></div>
        {studioView !== 'write' && <nav className={styles.workspaceTabs} aria-label="工作室页面"><button type="button" aria-current={studioView === 'home' ? 'page' : undefined} onClick={() => void showHome()} disabled={busy || bookRecoveryLocked}>工作台</button><button type="button" aria-current={studioView === 'shelf' ? 'page' : undefined} onClick={() => workspace.rootPath ? void showShelf() : void openWorkspace()} disabled={!api || busy || bookRecoveryLocked}>作品书架</button></nav>}
        <div className={styles.topActions}>
          {studioView === 'write' && chapter && <><span className={`${styles.saveState} ${session.session.error ? styles.saveError : session.session.dirty || session.session.saving || session.session.composing ? styles.savePending : ''}`} role="status"><span className={styles.statusDot} />{saveLabel(session.session)}</span><button className={styles.button} type="button" onClick={() => void session.flush()} disabled={busy || !session.session.dirty || session.session.saving || session.session.composing}><StudioIcon name="save" size={15} />保存 <kbd>Ctrl S</kbd></button><button className={styles.button} type="button" aria-pressed={focused} title="切换专注模式（Ctrl+Shift+Enter），Esc退出" onClick={() => setFocused(!focused)} disabled={session.session.composing || (busy && !focused)}><StudioIcon name="focus" size={15} />{focused ? '退出专注' : '专注写作'}</button></>}
          {studioView === 'write' && book ? focused ? <><button className={styles.button} type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked || session.session.saving || session.session.composing}><StudioIcon name="settings" size={15} />显示偏好</button><button className={styles.button} type="button" onClick={() => openRecovery()} disabled={!api || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt || (busy && !pendingMessage)}><StudioIcon name="history" size={15} />草稿与恢复</button></> : <button className={styles.button} type="button" onClick={() => showDialog({ kind: 'export' })} disabled={busy || book.chapters.length === 0}><StudioIcon name="export" size={15} />导出</button> : <><span className={styles.localBadge}><span className={styles.statusDot} />{workspace.rootPath ? '已连接作品库' : '本地创作'}</span><button className={styles.iconButton} type="button" aria-label="显示偏好" title="显示偏好" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked}><StudioIcon name="settings" size={18} /></button></>}
        </div>
      </header>
      {message && !modal && <div className={styles.notice} role="alert"><span>{message}</span><button type="button" onClick={() => setMessage(null)} aria-label="关闭提示">×</button></div>}
      {display.warning && !modal && <div className={styles.notice} role="status"><span>{display.warning}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing} onClick={display.retrySave}>保存当前显示偏好</button></div>}
      {pendingMessage && <div className={styles.notice} role="alert"><span>{pendingMessage}</span><button className={styles.receiptButton} type="button" onClick={() => void checkMutationReceipt()} disabled={checkingReceipt || recoveryBusy}>{checkingReceipt ? '正在核对…' : '核对回执'}</button></div>}
      {session.session.error && <div className={`${styles.notice} ${styles.noticeError}`} role="alert"><span>{session.session.error.message}{session.session.error.code === 'REVISION_CONFLICT' && ' 请从“草稿与恢复”另存后重载磁盘版本。'}</span></div>}
      {session.session.dirty && protection.state.error && <div className={`${styles.notice} ${styles.noticeError}`} role="alert"><span>恢复检查点未更新：{protection.state.error}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing} onClick={protection.retry}>重试留存</button><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing || Boolean(modal)} onClick={showDraftProtection}>查看容量与分代</button></div>}
      {protection.state.warning && <div className={styles.notice} role="status"><span>{protection.state.warning}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing || Boolean(modal)} onClick={showDraftProtection}>查看容量与分代</button></div>}
      {archived && <div className={styles.notice}><span>此作品已归档，可阅读和导出。继续编辑前请在作品资料中解除归档。</span></div>}
      {studioView === 'home' && <WelcomeWorkspace api={api} workspace={workspace} currentBook={book} onOpenWorkspace={() => void openWorkspace()} onCreate={() => startBook('newBook')} onImport={() => startBook('import')} onShelf={() => workspace.rootPath ? void showShelf() : void openWorkspace()} onRecover={() => showDialog({ kind: 'bookRecovery' })} onPreferences={() => showDialog({ kind: 'preferences' })} onOpenBook={(id, chapterId) => void openBook(id, chapterId)} onTool={(id, kind) => void openWorkspaceTool(id, kind)} busy={busy || bookRecoveryLocked} />}
      {studioView === 'shelf' && <BookShelf books={workspace.books} onOpen={(id) => void openBook(id)} onEdit={(item) => showDialog({ kind: 'bookDetails', book: item })} onCreate={() => showDialog({ kind: 'newBook' })} onImport={() => showDialog({ kind: 'import' })} onRecover={() => showDialog({ kind: 'orphans' })} busy={busy || bookRecoveryLocked} />}
      {book && <div className={styles.editorSurface} hidden={studioView !== 'write'} inert={studioView !== 'write'}>
        <div className={styles.chapterActions}>
          <span className={styles.chapterTitle}>{chapter?.title ?? '选择或新建章节'}<small>{book.chapters.length} 章 · {book.volumes.length} 卷</small></span>
          <button className={styles.chapterOutlineToggle} type="button" aria-label="章节目录" aria-controls="chapter-outline" aria-expanded={outlineOpen || !chapter} onClick={() => setOutlineOpen((value) => !value)} disabled={busy || !chapter || session.session.composing}><StudioIcon name="list" size={16} />目录 · {book.chapters.length} 章<StudioIcon name="down" size={14} /></button>
          <div className={styles.actionRow}>
            <button className={styles.button} type="button" aria-expanded={companionOpen} onClick={() => setCompanionOpen((value) => !value)} disabled={busy}><StudioIcon name="read" size={16} />伴随资料</button>
            {chapter && <button className={styles.aiEntry} type="button" onClick={() => showDialog({ kind: 'ai' })} disabled={busy}><StudioIcon name="spark" size={16} />AI 协作</button>}
            <details className={styles.chapterTools}>
              <summary>章节工具<StudioIcon name="down" size={14} /></summary>
              <div className={styles.chapterToolItems}>
                {chapter && <><button type="button" onClick={() => showDialog({ kind: 'chapterDetails' })} disabled={busy || archived}>{chapter.status === 'finalized' ? '资料 / 重开工作稿' : '本章资料'}</button><button type="button" onClick={() => showDialog({ kind: 'history' })} disabled={busy}>版本历史</button><button type="button" onClick={() => showDialog({ kind: 'finalize' })} disabled={busy || archived || (chapter.status === 'finalized' && !session.session.dirty)}>作者定稿</button></>}
                <button type="button" onClick={() => void changeView(async () => { await refreshCurrentBook(book.book.id) })} disabled={busy}>刷新目录</button>
                <button type="button" onClick={() => showDialog({ kind: 'draftImport' })} disabled={busy || archived || !workspace.recoveryScope}>从草稿恢复新章</button>
              </div>
            </details>
          </div>
        </div>
        <div className={`${styles.writeLayout} ${outlineOpen || !chapter ? styles.outlineExpanded : ''} ${companionOpen ? styles.companionExpanded : ''}`}>
          <ChapterOutline book={book} selectedId={chapter?.id} busy={busy} onOpen={(id) => void openChapter(id)} onCreate={(volumeId) => showDialog({ kind: 'newChapter', volumeId })} onVolume={(volumeId) => showDialog({ kind: 'volume', volumeId })} onMoveChapter={(id, direction) => void moveItem('chapter', id, direction)} onMoveVolume={(id, direction) => void moveItem('volume', id, direction)} />
          <section ref={manuscriptScroll} onScroll={(event) => { if (chapter && studioView === 'write') rememberWritingPosition(workspace.rootPath, chapter.bookId, chapter.id, { scrollTop: event.currentTarget.scrollTop }) }} className={styles.manuscript} aria-label="正文编辑区">{chapter ? <>
            <div className={styles.manuscriptMeta}><span>第 {chapter.position + 1} 章 · {statusLabels[chapter.status]}{chapter.viewpoint ? ' · ' + chapter.viewpoint : ''}</span><span>{session.session.characterCount.toLocaleString()} 字{chapter.targetCharacters !== null ? ' / ' + chapter.targetCharacters.toLocaleString() : ''}</span></div>
            {chapter.finalizedRevisionId && <p className={styles.finalizedNote}>已有作者定稿。修改后成为新草稿，原定稿保留。</p>}
            <ManuscriptEditor key={chapter.bookId + ':' + chapter.id + ':' + session.session.loadEpoch} title={chapter.title} document={chapter.document} disabled={studioView !== 'write' || busy || bookRecoveryLocked || Boolean(modal)} readOnly={archived} displayPreferences={display.preferences} onChange={session.changed} onComposition={session.setComposing} initialPosition={navigationPosition.current?.bookId === chapter.bookId && navigationPosition.current.chapterId === chapter.id ? navigationPosition.current.position : writingPosition(workspace.rootPath, chapter.bookId)?.chapterId === chapter.id ? writingPosition(workspace.rootPath, chapter.bookId) : null} onPositionChange={(position) => { if (studioView === 'write') rememberWritingPosition(workspace.rootPath, chapter.bookId, chapter.id, position) }} />
          </> : <div className={styles.emptyChapter}><h2>{book.chapters.length ? '选择一章继续' : '从第一场开始'}</h2><p>{book.chapters.length ? '从章节目录打开正文。' : '建立章节后，每次正文保存都会留下版本。'}</p>{!archived && <button className={styles.primaryButton} type="button" onClick={() => showDialog({ kind: 'newChapter', volumeId: null })} disabled={busy}>建立章节</button>}</div>}</section>
          {companionOpen && api ? <aside className={styles.companionAside} aria-label="伴随资料"><CompanionPanel api={api} book={book} chapter={chapter} scopeKey={workspace.rootPath ?? ''} busy={busy || Boolean(modal) || session.session.composing} onNavigate={navigateCompanion} onReturn={returnFromCompanion} canReturn={Boolean(returnLocation && returnLocation.root === workspace.rootPath && returnLocation.bookId === book.book.id)} onClose={() => setCompanionOpen(false)} /></aside> : <aside className={styles.memoryAside} aria-label="本章记录"><div className={styles.asideHeading}>本章记录</div>
            <div className={styles.stateBlock}><strong>{chapter ? saveLabel(session.session) : '等待章节'}</strong><p>停笔片刻后自动保存，也可以按 Ctrl+S。保存失败时，当前草稿会留在窗口。</p>{chapter && <p>{protection.state.createdAt ? `恢复检查点：${displayTime(protection.state.createdAt)}${protection.state.editSequence < session.session.editSequence ? '（之后的输入尚未留存）' : ''}` : '未保存内容会定时留存到作品库的恢复目录。意外退出后，可从“从草稿恢复新章”预览。'}</p>}</div>
            {chapter?.goal && <><div className={styles.asideRule} /><div className={styles.stateBlock}><span className={styles.label}>本章目标</span><p>{chapter.goal}</p></div></>}
            <div className={styles.asideRule} /><div className={styles.stateBlock}><span className={styles.label}>最近保存</span><strong>{chapter ? displayTime(chapter.updatedAt) : '—'}</strong>{chapter?.finalizedAt && <p>最近定稿：{displayTime(chapter.finalizedAt)}</p>}</div>
            <div className={styles.asideRule} /><div className={styles.stateBlock}><span className={styles.label}>作品目录</span><p className={styles.directoryPath}>{workspace.rootPath}</p></div>
          </aside>}
        </div>
      </div>}
    </main>
    <nav className={styles.mobileTabs} aria-label="主要页面">
      <button type="button" aria-current={studioView === 'home' ? 'page' : undefined} onClick={() => void showHome()} disabled={busy || bookRecoveryLocked}><StudioIcon name="home" size={21} /><span>工作台</span></button>
      <button type="button" aria-current={studioView === 'write' ? 'page' : undefined} onClick={resumeWriting} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="pen" size={21} /><span>写作</span></button>
      <button type="button" aria-current={studioView === 'shelf' ? 'page' : undefined} onClick={() => workspace.rootPath ? void showShelf() : void openWorkspace()} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="books" size={21} /><span>书架</span></button>
      <button type="button" aria-haspopup="dialog" aria-expanded={navigationOpen} aria-disabled={Boolean(modal) || recoveryBusy || checkingReceipt || session.session.saving || session.session.composing || (busy && !pendingMessage)} onClick={openNavigation}><StudioIcon name="more" size={21} /><span>更多</span></button>
    </nav>
    {navigationOpen && <Dialog title="工作室导航" className={`${styles.lightDialog} ${styles.navigationSheet}`} onClose={() => setNavigationOpen(false)}>{navigation}</Dialog>}
    {modal?.kind === 'preferences' && <DisplayPreferencesPanel preferences={display.preferences} warning={display.warning} busy={busy} onChange={display.update} onReset={display.reset} onRetrySave={display.retrySave} onClose={closeModal} />}
    {modal?.kind === 'notes' && api && book && <NotesPanel key={book.book.id} api={api} book={book} displayPreferences={display.preferences} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { notesDirty.current = value }} onUpgrade={upgradeKnowledge}
      onCreate={(input, accept) => writeNote('notes.create', input, () => api.createNote(input), accept)} onUpdate={(input, accept) => writeNote('notes.update', input, () => api.updateNote(input), accept)} onPromote={(input, accept) => writeNote('notes.promote', input, () => api.promoteNote(input), accept)} />}
    {api && <BookRecoveryPanel api={api} open={modal?.kind === 'bookRecovery'} book={book?.book ?? null} targetRoot={workspace.rootPath} recoveryEpoch={bookRecoveryEpoch} busy={busy || recoveryBusy} error={modalError} onDirtyChange={markBookRecoveryDirty} onClose={closeModal} onRecover={() => openRecovery(true)} onChooseWorkspace={() => void openWorkspace()} onRestored={acceptBookRecovery} onRefresh={refreshRecoveryShelf} onOpenBook={(id) => void openBook(id)} />}
    {modal?.kind === 'ai' && api && book && chapter && <AiPanel key={book.book.id} api={api} book={book} chapter={chapter} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdopt={adoptAi} onAdoptMemory={adoptAiMemory} />}
    {modal?.kind === 'aiMemoryTasks' && api && book && <AiMemoryTasksPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdoptMemory={adoptAiMemory} />}
    {modal?.kind === 'aiSummary' && api && book && <AiSummaryPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdoptSummary={adoptAiSummary} />}
    {modal?.kind === 'newBook' && <NewBookDialog onSubmit={(input) => void createBook(input)} onImport={() => setModal({ kind: 'import' })} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmCloseRequested={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
    {modal?.kind === 'workbench' && book && api && <Dialog title="规划、审稿与写作记录" wide className={styles.lightDialog} onClose={closeModal} busy={busy}>
      <WorkbenchPanel key={`${workspace.rootPath}:${book.book.id}`} api={api} book={book} chapter={chapter} disabled={busy} onDirtyChange={(value) => { workbenchDirty.current = value }} onBookChange={applyBook} onChapterChange={(value) => { onSaved(value); session.load(value) }} onNavigate={(id) => void changeView(async () => { const value = await api.readChapter({ bookId: book.book.id, chapterId: id }); if (value.ok && value.data.bookId === book.book.id && value.data.id === id) { session.load(value.data); setModal(null); setSurface('write') } else setMessage(value.ok ? '章节身份不匹配。' : value.error.message) })} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} />
    </Dialog>}
    {modal?.kind === 'inspiration' && workspace.rootPath && api && <Dialog title="全局灵感与拆书" wide className={styles.lightDialog} onClose={closeModal} busy={busy}>
      <InspirationPanel key={workspace.rootPath} api={api} books={workspace.books} activeBook={book} disabled={busy} onDirtyChange={(value) => { inspirationDirty.current = value }} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} onBookChanged={async (id) => { if (bookRef.current?.book.id === id) await refreshCurrentBook(id); else { const value = await request(() => api.getBook({ bookId: id })); if (value.ok) upsertShelf(value.data.book) } }} />
    </Dialog>}
    {modal?.kind === 'newChapter' && <NameDialog title="新建章节" submitLabel="建立章节" onSubmit={(title) => void createChapter(title, modal.volumeId)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'volume' && <NameDialog title={modal.volumeId ? '修改卷名' : '新建卷'} initialValue={book?.volumes.find((item) => item.id === modal.volumeId)?.title} submitLabel="保存卷名" onSubmit={(title) => void saveVolume(title, modal.volumeId)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'bookDetails' && <BookDetailsDialog key={modal.book.id} book={modal.book} onSubmit={(fields) => void updateBookDetails(modal.book, fields)} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmClose={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
    {modal?.kind === 'chapterDetails' && chapter && book && <ChapterDetailsDialog key={chapter.id} chapter={chapter} volumes={book.volumes} onSubmit={(fields) => void updateChapterDetails(fields)} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmClose={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
    {modal?.kind === 'history' && chapter && api && <RevisionHistory api={api} chapter={chapter} archived={archived} onRestore={(id) => void restoreRevision(id)} onMerge={mergeSelectedRevision} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'finalize' && chapter && <ConfirmDialog title="作者定稿" label="确认当前稿为定稿" onSubmit={() => void finalizeChapter()} onClose={closeModal} busy={busy} error={modalError}>当前正文会先保存，再成为本章新的作者定稿。后续编辑会生成工作稿，导出时仍可单独选择这次定稿。</ConfirmDialog>}
    {modal?.kind === 'import' && api && <TextImportDialog api={api} onCommit={(token, title) => void commitImport(token, title)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'export' && book && api && <ExportBookPanel api={api} book={book} onExport={exportBook} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'orphans' && api && <OrphanBooksDialog api={api} onRegister={(id) => void registerBook(id)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'draftImport' && api && book && workspace.recoveryScope && <DraftImportDialog key={workspace.recoveryScope + ':' + book.book.id} api={api} scope={workspace.recoveryScope} book={book.book} busy={busy} error={modalError} onClose={closeModal} onRotated={protection.retry} onCommit={(token, title) => void commitDraftImport(token, title)} />}
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
