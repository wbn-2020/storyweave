import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type {
  AppError, BookSnapshot, BookSummary, ChapterSnapshot, ChapterSummary, CommandMap, CompletedRequest,
  Result, ServiceCommand, StudioApi, WorkspaceSnapshot, CreateBookInput,
} from '../contracts/api'
import { parseManuscript } from '../contracts/manuscript'
import type { CreateKnowledgeItemInput, KnowledgeItemDetail, KnowledgeKind, KnowledgeStatus, UpdateKnowledgeItemInput } from '../contracts/knowledge'
import type { CreateStoryRecordInput, StoryRecordDetail, UpdateStoryRecordInput, StoryKind } from '../contracts/story'
import type { MemoryControlInput, MemoryStartInput, MemoryTaskInput, MemoryTaskReceipt } from '../contracts/memory'
import { isAiAdoptReceiptFor, isAiMemoryAdoptReceiptFor, type AiAdoptInput, type AiAdoptReceipt, type AiMemoryAdoptInput, type AiMemoryAdoptReceipt, type AiRun } from '../contracts/ai'
import { isAiSummaryAdoptReceiptFor, type AiSummaryAdoptInput, type AiSummaryAdoptReceipt, type AiSummaryTaskSummary } from '../contracts/ai-summary'
import type { BookRecoveryRestoreReceipt } from '../contracts/book-recovery'
import type { KickstartSnapshot } from '../contracts/generation'
import { isNoteWriteReceiptFor, type CreateNoteInput, type NoteDetail, type PromoteNoteInput, type UpdateNoteInput } from '../contracts/notes'
import { ManuscriptEditor } from './components/ManuscriptEditor'
import { BookShelf, ChapterOutline } from './components/LibraryPanels'
import { WelcomeWorkspace } from './components/WelcomeWorkspace'
import { StudioIcon } from './components/StudioIcon'
import { Dialog, DialogDisplayContext } from './components/Dialog'
import { BookDetailsDialog, ChapterDetailsDialog, ConfirmDialog, NameDialog, type BookFields, type ChapterFields } from './components/EditingDialogs'
import { RevisionHistory } from './components/RevisionHistory'
import { TextImportDialog } from './components/TextImportDialog'
import { OrphanBooksDialog, RecoveryDialog } from './components/RecoveryDialogs'
import { DraftImportDialog } from './components/DraftImportDialog'
import { KnowledgePanel } from './components/KnowledgePanel'
import { StoryPanel } from './components/StoryPanel'
import { StoryTimelinePanel } from './components/StoryTimelinePanel'
import { StoryGalaxyPanel } from './components/StoryGalaxyPanel'
import { CommandPalette, type StudioCommand } from './components/CommandPalette'
import { ForeshadowDueNotice } from './components/StoryControlPanel'
import type { CreativeResourceRef } from '../contracts/creative-resources'
import { BookReaderPanel } from './components/BookReaderPanel'
import { DisplayPreferencesPanel } from './components/DisplayPreferencesPanel'
import { NotesPanel } from './components/NotesPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { AiPanel } from './components/AiPanel'
import { AiMemoryTasksPanel } from './components/AiMemoryTasksPanel'
import { AiSummaryPanel } from './components/AiSummaryPanel'
import { BookRecoveryPanel } from './components/BookRecoveryPanel'
import { NewBookDialog } from './components/NewBookDialog'
import { KickstartPanel } from './components/KickstartPanel'
import { ExportBookPanel } from './components/ExportBookPanel'
import { CompanionPanel, type CompanionNavigateTarget } from './components/CompanionPanel'
import { WorkbenchPanel } from './components/WorkbenchPanel'
import { LivingPanel } from './components/LivingPanel'
import { ForgePanel } from './components/ForgePanel'
import type { ForgeKind } from '../contracts/forge'
import { CreativeSpine, ChapterBeatStrip, useLivingSnapshot, type CreativeDomain } from './components/CreativeSpine'
import { InspirationPanel } from './components/InspirationPanel'
import { WritingCalendarPanel } from './components/WritingCalendarPanel'
import { BookMediaPanel } from './components/BookMediaPanel'
import { isRevisionMergeOutputFor, type RevisionMergeInput } from '../contracts/revision-merge'
import type { BookExportCommitInput } from '../contracts/export'
import { STUDIO_THEMES, STUDIO_THEME_META } from './display-preferences'
import { lastWritingBook, rememberWritingPosition, writingPosition, type WritingPosition } from './writing-location'
import { useChapterSession } from './hooks/useChapterSession'
import { useDraftProtection } from './hooks/useDraftProtection'
import { useDisplayPreferences } from './hooks/useDisplayPreferences'
import { displayTime, request, statusLabels } from './request'
import styles from './App.module.css'

interface Props { api?: StudioApi }
type ViewState = 'loading' | 'ready' | 'error'
type StudioSurface = 'home' | 'shelf' | 'write'
type WorkspaceTool = 'knowledge' | 'galaxy' | 'timeline' | 'notes' | 'workbench' | 'calendar' | 'media' | 'living' | 'forge'
type WriteAsideMode = 'companion' | 'ai' | 'meta' | 'collapsed'
type Modal =
  | { kind: 'forge'; initialKind?: ForgeKind; personId?: string }
  | { kind: 'living'; tab?: 'outline' | 'memory'; initialId?: string }
  | { kind: 'knowledge'; initialKind?: KnowledgeKind }
  | { kind: 'ai'; initialInstruction?: string; useLivingContext?: boolean; purpose?: 'review' | 'study'; resources?: CreativeResourceRef[] }
  | { kind: 'newBook' } | { kind: 'kickstart'; bookId?: string } | { kind: 'newChapter'; volumeId: string | null }
  | { kind: 'volume'; volumeId?: string } | { kind: 'bookDetails'; book: BookSummary }
  | { kind: 'chapterDetails' } | { kind: 'history' } | { kind: 'finalize' } | { kind: 'preferences' } | { kind: 'notes' } | { kind: 'workbench' } | { kind: 'inspiration' } | { kind: 'calendar' } | { kind: 'media' }
  | { kind: 'import' } | { kind: 'export' } | { kind: 'orphans' } | { kind: 'recovery' } | { kind: 'bookRecovery' } | { kind: 'draftImport' } | { kind: 'story'; initialKind?: StoryKind; initialId?: string } | { kind: 'timeline' } | { kind: 'galaxy'; view?: 'galaxy' | 'matrix' | 'radar' } | { kind: 'reader' } | { kind: 'memory' } | { kind: 'aiMemoryTasks' } | { kind: 'aiSummary' } | null
interface DraftReceipt { bookId: string; chapterId: string; editSequence: number; loadEpoch: number; filePath: string }

// 全画布一级视图集合：不再弹出遮罩模态框，而是直接平铺在主工作区画布中
const CANVAS_MODAL_KINDS = new Set<NonNullable<Modal>['kind']>([
  'workbench', 'knowledge', 'galaxy', 'timeline', 'story', 'notes',
  'inspiration', 'calendar', 'media', 'reader', 'memory', 'aiMemoryTasks', 'aiSummary', 'kickstart',
  'living', 'forge',
])

const SURFACE_TITLES: Record<string, { title: string; subtitle: string }> = {
  home: { title: '今日书桌', subtitle: '在一个安静的房间里，让念头长成完整的世界' },
  write: { title: '正文创作', subtitle: '文字是主角，资料与 AI 副驾驶在页边待命' },
  shelf: { title: '作品书架', subtitle: '每个故事，都值得拥有一间专属书房' },
  kickstart: { title: '故事孵化', subtitle: '一个脑洞，几种可能，再走进第一章' },
  workbench: { title: '章节规划与审稿', subtitle: '从故事种子、场景节拍到审稿清单，连接下一章' },
  living: { title: '大纲与演进沙盘', subtitle: '总纲、卷目标与章纲可编辑，记忆和修纲都有来源' },
  forge: { title: '角色与世界工坊', subtitle: '生成角色班底，核对历史认知，与人物演一场对手戏' },
  knowledge: { title: '故事设定 · 世界观与人物', subtitle: '世界的规则与人物弧光，随着故事一条条生长' },
  galaxy: { title: '关系星海 · 脉络画布', subtitle: '退后一步，用可视化卡片与星图看清所有羁绊' },
  timeline: { title: '故事时间线', subtitle: '叙述顺序与故事时间分开梳理，过去伏笔与未来谜团一目了然' },
  story: { title: '故事事件与伏笔追踪', subtitle: '记录发生了什么、谁参与其中、埋下了哪些回响' },
  notes: { title: '素材与随手记', subtitle: '随时接住一闪而过的灵感、台词与片段' },
  inspiration: { title: '拆书导入与技能库', subtitle: '把读过的好书变成可调用的创作方法与素材' },
  calendar: { title: '创作日历', subtitle: '记录每日码字节奏与心流时刻，让写作成为日常' },
  media: { title: '封面与人物立绘', subtitle: '为你的故事与角色留存视觉印象' },
  reader: { title: '沉浸阅读预览', subtitle: '以读者视角通读工作稿或作者定稿' },
  memory: { title: '长篇记忆与混合检索', subtitle: '管理本地索引、向量召回与原文出处证据' },
  aiMemoryTasks: { title: '逐章整理任务', subtitle: '按章提炼摘要与设定候选，经作者确认后入库' },
  aiSummary: { title: '全书分层汇总', subtitle: '从单章摘要向上凝聚卷级与全书脉络' },
  ai: { title: 'AI 创作工作台', subtitle: '结合场景计划、写作技能与人物视角协同创作' },
}

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
  const [commandOpen, setCommandOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [companionOpen, setCompanionOpen] = useState(false)
  const [writeAsideMode, setWriteAsideMode] = useState<WriteAsideMode>('meta')
  const [aiWideMode, setAiWideMode] = useState(false)
  const [returnLocation, setReturnLocation] = useState<{ root: string; bookId: string; chapterId: string; blockId?: string; offset?: number; scrollTop?: number } | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>({ rootPath: null, books: [] })
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const [book, setBook] = useState<BookSnapshot | null>(null)
  const bookRef = useRef<BookSnapshot | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const aiInstruction = modal?.kind === 'ai' ? modal.initialInstruction : undefined
  const aiLivingContext = modal?.kind === 'ai' ? modal.useLivingContext : undefined
  const aiResources = modal?.kind === 'ai' ? modal.resources : undefined
  const aiResourceKey = aiResources?.map((ref) => `${ref.source}:${ref.id}:${ref.revision}`).join(',') ?? ''
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
  const auxiliaryDirty = useRef(false)
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
      ? current.books.map((item) => item.id === summary.id && item.revision <= summary.revision ? summary : item) : [...current.books, summary] }))
  }, [])

  const onSaved = useCallback((saved: ChapterSnapshot) => {
    const current = bookRef.current
    if (current?.book.id === saved.bookId && current.book.revision <= saved.bookRevision) {
      const summary = { ...current.book, revision: saved.bookRevision,
        updatedAt: saved.updatedAt > current.book.updatedAt ? saved.updatedAt : current.book.updatedAt }
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
  const creative = useLivingSnapshot(api, book?.book.id, book?.book.revision)
  const archived = Boolean(book?.book.archivedAt)
  const baseStudioView = surface === 'write' && book ? 'write' : surface === 'shelf' && workspace.rootPath ? 'shelf' : 'home'

  // 判断当前 modal 是否为内嵌在主画布的全屏视图，还是传统的遮罩弹窗
  const isAiInWriteDrawer = modal?.kind === 'ai' && baseStudioView === 'write' && !aiWideMode
  const isCanvasView = Boolean(
    modal && (CANVAS_MODAL_KINDS.has(modal.kind) || (modal.kind === 'ai' && !isAiInWriteDrawer)),
  )
  const hasBlockingDialog = Boolean(modal && !isCanvasView && !isAiInWriteDrawer)
  const studioView = baseStudioView

  const recentBooks = [...workspace.books].sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
  const rememberedBook = workspace.books.find((item) => item.id === lastWritingBook(workspace.rootPath))
  const featuredBook = book?.book ?? rememberedBook ?? recentBooks.find((item) => !item.archivedAt) ?? recentBooks[0]

  useLayoutEffect(() => {
    if (!chapter || studioView !== 'write' || isCanvasView) return
    const position = writingPosition(workspace.rootPath, chapter.bookId)
    const reveal = navigationPosition.current?.bookId === chapter.bookId && navigationPosition.current.chapterId === chapter.id
    // 来源跳转由编辑器将目标段落滚入视野；普通返回仍恢复作者离开时的滚动位置。
    if (manuscriptScroll.current && !reveal) manuscriptScroll.current.scrollTop = position?.chapterId === chapter.id ? position.scrollTop ?? 0 : 0
    navigationPosition.current = null
    rememberWritingPosition(workspace.rootPath, chapter.bookId, chapter.id)
  }, [workspace.rootPath, chapter?.bookId, chapter?.id, session.session.loadEpoch, studioView, isCanvasView])

  async function changeView(operation: () => Promise<void>, fromMemoryPanel = false, fromNotesPanel = false, fromWorkbenchPanel = false, fromInternalPanel = false) {
    if (transition.current || recoveryLock.current) return
    if (bookRecoveryDirty.current) { setMessage('作品备份或恢复仍在处理或等待回执，请先在面板中核对。'); return }
    if (memoryWorking.current && !fromMemoryPanel) { setMessage('记忆面板仍有处理中或未确认的请求，请先核对回执后再切换。'); return }
    if (notesDirty.current && !fromNotesPanel) { setMessage('笔记有未保存修改或未确认请求，请先在素材与笔记中处理。'); return }
    if ((workbenchDirty.current || inspirationDirty.current || auxiliaryDirty.current) && !fromWorkbenchPanel) { setMessage('创作工具还有未保存表单或待核对请求，请先在面板中处理。'); return }
    if (!fromInternalPanel && knowledgeDirty.current) { setMessage('故事设定有未保存修改，请先保存或放弃当前条目修改后再切换视图。'); return }
    if (!fromInternalPanel && storyDirty.current) { setMessage('故事记录有未保存修改，请先保存或放弃当前修改后再切换视图。'); return }
    if (!fromInternalPanel && aiDirty.current) { setMessage('AI 副驾驶仍有生成中或未保存的改稿，请先在面板内处理后再切换视图。'); return }
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
    // 抽屉同步与正文自动保存可以交错，迟到的目录读取不能回退已确认的作品版本。
    if (bookRef.current?.book.id === snapshot.book.id && bookRef.current.book.revision > snapshot.book.revision) return
    upsertShelf(snapshot.book)
    if (!enter && bookRef.current?.book.id !== snapshot.book.id) return
    const current = session.getCurrent().chapter
    updateCurrentBook(snapshot)
    if (enter) setSurface('write')
    if (current?.bookId === snapshot.book.id) {
      const summary = snapshot.chapters.find((item) => item.id === current.id)
      if (summary?.revisionId === current.revisionId) session.updateMetadata(snapshot)
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

  async function openWorkspace(next?: 'kickstart' | 'import') {
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
      if (result.data.book.lifecycle === 'kickstarting') {
        session.load(null); updateCurrentBook(null); upsertShelf(result.data.book); setReturnLocation(null)
        setModal({ kind: 'kickstart', bookId }); return
      }
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
    if (!bookRef.current) return
    // 创作面板也使用本入口；复用完整开章流程，同章返回时保留编辑实例并切回正文画布。
    await openBook(bookRef.current.book.id, chapterId)
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
      session.load(next); setSurface('write'); setModal(null)
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
    const target = kind === 'newBook' ? 'kickstart' : 'import'
    if (workspace.rootPath) showDialog({ kind: target })
    else void openWorkspace(target)
  }

  async function enterKickstart(snapshot: KickstartSnapshot): Promise<boolean> {
    if (!api || !snapshot.adoption || transition.current || recoveryLock.current) return false
    transition.current = true; setBusy(true)
    const root = workspaceRef.current.rootPath, bookId = snapshot.book.book.id, chapterId = snapshot.adoption.firstChapterId
    try {
      const read = await request(() => api.readChapter({ bookId, chapterId }))
      if (!read.ok) { setMessage(read.error.message); return false }
      if (workspaceRef.current.rootPath !== root || read.data.bookId !== bookId || read.data.id !== chapterId || read.data.bookRevision !== snapshot.book.book.revision) {
        setMessage('首章或作品版本已变化，请从书架重新打开。'); return false
      }
      auxiliaryDirty.current = false
      applyBook(snapshot.book, true); session.load(read.data); setModal(null); setSurface('write'); setMessage(null)
      return true
    } finally { transition.current = false; setBusy(false) }
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

  function useForeshadow(ref: CreativeResourceRef) {
    if (!chapter || !book || archived) { setMessage('请先打开可编辑章节，再选择本章的待回收伏笔。'); return }
    setAiWideMode(false)
    showDialog({ kind: 'ai', resources: [ref] })
  }

  function resumeWriting() {
    if (book && session.getCurrent().chapter?.bookId === book.book.id) void changeView(async () => { setSurface('write'); setModal(null) })
    else if (book) void openBook(book.book.id)
    else if (featuredBook) void openBook(featuredBook.id)
    else startBook('newBook')
  }

  function openCreativeDomain(domain: CreativeDomain) {
    if (domain === 'manuscript') { resumeWriting(); return }
    if (!book) return
    if (domain === 'world' || domain === 'cast') showDialog({ kind: 'forge', initialKind: domain === 'cast' ? 'cast' : 'world' })
    else showDialog({ kind: 'living', initialId: domain === 'idea' ? book.book.id : chapter?.id })
  }

  function showDraftProtection() {
    if (transition.current || recoveryLock.current || session.isComposing() || hasBlockingDialog || !book || !workspace.recoveryScope) return
    if (detailsDirty.current || knowledgeDirty.current || storyDirty.current || notesDirty.current || workbenchDirty.current || inspirationDirty.current || auxiliaryDirty.current || memoryWorking.current || aiDirty.current || bookRecoveryDirty.current) {
      setMessage('当前面板有未保存修改或未确认请求，请先处理后再查看草稿容量。'); return
    }
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
      } else if (next.kind === 'kickstart') {
        session.load(null); updateCurrentBook(null); setReturnLocation(null); setModal(next)
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
      } else {
        if (next.kind === 'ai' && surface === 'write') {
          setWriteAsideMode('ai')
          setCompanionOpen(false)
        }
        setModal(next)
      }
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
    }, false, false, false, true)
  }

  async function createChapter(title: string, volumeId: string | null) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current || current.book.archivedAt) return
      await mutate('chapter.create', () => api.createChapter({ bookId: current.book.id, title, volumeId }), (saved) => acceptChapter(saved, true))
    }, false, false, false, true)
  }

  async function updateBookDetails(target: BookSummary, fields: BookFields) {
    if (!api) return
    await changeView(async () => {
      const revision = bookRef.current?.book.id === target.id ? bookRef.current.book.revision : target.revision
      await mutate('book.update', () => api.updateBook({ bookId: target.id, expectedBookRevision: revision, ...fields }), (snapshot) => { applyBook(snapshot); setModal(null) })
    }, false, false, false, true)
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
    }, false, false, false, true)
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
    }, false, false, false, true)
  }

  async function finalizeChapter() {
    if (!api) return
    await changeView(async () => {
      const current = session.getCurrent().chapter, activeBook = bookRef.current
      if (!current || !activeBook || activeBook.book.archivedAt) return
      await mutate('chapter.finalize', () => api.finalizeChapter({ bookId: current.bookId, chapterId: current.id, expectedRevisionId: current.revisionId, expectedBookRevision: activeBook.book.revision }), acceptChapter)
    }, false, false, false, true)
  }

  async function restoreRevision(revisionId: string) {
    if (!api) return
    await changeView(async () => {
      const current = session.getCurrent().chapter
      if (!current || bookRef.current?.book.archivedAt) return
      await mutate('revision.restore', () => api.restoreRevision({ bookId: current.bookId, chapterId: current.id, revisionId, expectedRevisionId: current.revisionId }), acceptChapter)
    }, false, false, false, true)
  }

  async function commitImport(token: string, title: string) {
    if (!api) return
    await changeView(async () => {
      await mutate('import.commit', () => api.commitTextImport({ token, title }), (snapshot) => { applyBook(snapshot, true); setModal(null); setMessage('导入完成。请选择目录中的章节开始检查与编辑。') })
    }, false, false, false, true)
  }

  async function commitDraftImport(token: string, title: string) {
    if (!api || !workspace.recoveryScope) return
    const scope = workspace.recoveryScope
    await changeView(async () => {
      await mutate('draft.import', () => api.commitDraftImport({ scope, token, title }), async (saved) => {
        await acceptChapter(saved, true)
        setMessage('草稿已恢复为新章节，原章和原始副本已保留。请核对新章正文与来源记录。')
      })
    }, false, false, false, true)
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
    }, false, false, false, true)
  }

  async function updateKnowledge(input: UpdateKnowledgeItemInput, accept: (saved: KnowledgeItemDetail) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('knowledge.update', () => api.updateKnowledgeItem(input), (saved) => acceptKnowledge(saved, accept))
    }, false, false, false, true)
  }

  async function upgradeKnowledge(accept: (status: KnowledgeStatus) => void) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current || current.book.archivedAt) return
      await mutate('knowledge.upgrade', () => api.upgradeKnowledge({ bookId: current.book.id, expectedBookRevision: current.book.revision }), (status) => acceptKnowledge(status, accept))
    }, modal?.kind === 'memory', modal?.kind === 'notes', false, true)
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
    }, false, true, false, true)
  }

  async function createStory(input: CreateStoryRecordInput, accept: (saved: StoryRecordDetail) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('story.create', () => api.createStoryRecord(input), (saved) => acceptKnowledge(saved, accept))
    }, false, false, false, true)
  }

  async function updateStory(input: UpdateStoryRecordInput, accept: (saved: StoryRecordDetail) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('story.update', () => api.updateStoryRecord(input), (saved) => acceptKnowledge(saved, accept))
    }, false, false, false, true)
  }

  async function startMemory(input: MemoryStartInput, accept: (saved: MemoryTaskReceipt) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => { await mutate('memory.start', () => api.startMemoryTask(input), accept) }, true, false, false, true)
  }

  async function stepMemory(input: MemoryTaskInput, accept: (saved: MemoryTaskReceipt) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => { await mutate('memory.step', () => api.stepMemoryTask(input), accept) }, true, false, false, true)
  }

  async function controlMemory(input: MemoryControlInput, accept: (saved: MemoryTaskReceipt) => void) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => { await mutate('memory.control', () => api.controlMemoryTask(input), accept) }, true, false, false, true)
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
    }, false, false, false, true)
  }

  async function adoptAiMemory(input: AiMemoryAdoptInput, source: AiRun, accept: (saved: AiMemoryAdoptReceipt) => boolean) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('ai.memory.adopt', () => api.adoptAiMemory(input), async (saved) => {
        if (!isAiMemoryAdoptReceiptFor(input, source, saved)) { setMessage('知识采用回执与固定提议不符，请保留审阅内容并核对记录。'); return false }
        if (!accept(saved)) return false
        await acceptKnowledge(saved.status, () => {})
      })
    }, false, false, false, true)
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
    }, false, false, false, true)
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
    }, false, false, false, true)
  }

  async function registerBook(bookId: string) {
    if (!api) return
    await changeView(async () => {
      await mutate('workspace.register', () => api.registerOrphanBook({ bookId }), (snapshot) => { applyBook(snapshot); setModal(null); setMessage('已将《' + snapshot.book.title + '》登记到书架。') })
    }, false, false, false, true)
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
    if (hasBlockingDialog || recoveryLock.current || receiptCheck.current || closeLocked.current || session.isComposing() || session.getCurrent().saving) return
    // 等待切换时禁止重开导航；未确认回执仍需保留进入恢复的入口。
    if (transition.current && !pendingMutation.current) return
    setNavigationOpen(true)
  }

  function openRecovery(preservedForm = false) {
    if (recoveryLock.current || receiptCheck.current || closeLocked.current || session.isComposing() || session.getCurrent().saving) return
    if (transition.current && !pendingMutation.current) return
    // 资料与 AI 改稿独立于正文副本；只有面板确认留存后才能转入恢复。
    if ((detailsDirty.current || knowledgeDirty.current || storyDirty.current || notesDirty.current || workbenchDirty.current || inspirationDirty.current || auxiliaryDirty.current || memoryWorking.current || aiDirty.current || bookRecoveryDirty.current) && !preservedForm) {
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
      if (event.isComposing || event.keyCode === 229) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (!event.repeat && !busy && !transition.current && !recoveryLock.current && !hasBlockingDialog && !session.isComposing()) {
          setNavigationOpen(false); setCommandOpen((value) => !value)
        }
        return
      }
      if (commandOpen) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!transition.current && !recoveryLock.current && !bookRecoveryDirty.current && modal?.kind !== 'recovery' && modal?.kind !== 'bookRecovery') void session.flush()
      }
      if (studioView === 'write' && !isCanvasView && !hasBlockingDialog && !navigationOpen && !event.defaultPrevented && !session.isComposing() && chapter) {
        if (event.key === 'Escape' && focused) {
          event.preventDefault(); setFocused(false)
        } else if (!busy && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter') {
          event.preventDefault(); setFocused((value) => !value)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [session.flush, session.isComposing, isCanvasView, hasBlockingDialog, modal?.kind, navigationOpen, busy, chapter, focused, studioView, commandOpen])

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
      if (workbenchDirty.current || inspirationDirty.current || auxiliaryDirty.current) { setMessage('创作工具有未保存修改或待核对请求，请先在面板中处理。'); return false }
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

  if (viewState === 'loading') return <div className={styles.centerState}><span className={styles.spinner} />正在打开织章书房…</div>
  const modalError = message ?? session.session.error?.message
  const detailsRecovery = pendingMessage ? { message: pendingMessage, checking: checkingReceipt,
    onCheck: () => void checkMutationReceipt(), onRecover: () => openRecovery(true) } : undefined
  const closeModal = () => {
    if (recoveryLock.current) return
    if ((modal?.kind === 'bookDetails' || modal?.kind === 'chapterDetails' || modal?.kind === 'newBook') && detailsDirty.current) { setDetailsCloseRequested(true); return }
    if (modal?.kind === 'knowledge' && knowledgeDirty.current) return
    if (modal?.kind === 'story' && storyDirty.current) return
    if (modal?.kind === 'notes' && notesDirty.current) return
    if ((modal?.kind === 'workbench' || modal?.kind === 'living' || modal?.kind === 'forge') && workbenchDirty.current) return
    if (modal?.kind === 'inspiration' && inspirationDirty.current) return
    if ((modal?.kind === 'calendar' || modal?.kind === 'galaxy' || modal?.kind === 'media' || modal?.kind === 'kickstart') && auxiliaryDirty.current) return
    if (modal?.kind === 'memory' && memoryWorking.current) return
    if ((modal?.kind === 'ai' || modal?.kind === 'aiMemoryTasks' || modal?.kind === 'aiSummary') && aiDirty.current) return
    if (modal?.kind === 'bookRecovery' && bookRecoveryDirty.current) return
    if (modal?.kind === 'recovery') session.pauseAutoSave(false)
    if (modal?.kind === 'recovery' && bookRecoveryDirty.current) { setModal({ kind: 'bookRecovery' }); setMessage(null); return }
    if (!pendingMutation.current) {
      if (modal?.kind === 'ai' && writeAsideMode === 'ai') setWriteAsideMode('meta')
      setModal(null); setMessage(null)
    }
    else if (modal?.kind === 'recovery') setModal(null)
  }

  const activeCanvasKey = isCanvasView && modal ? modal.kind : studioView
  const headerInfo = SURFACE_TITLES[activeCanvasKey] ?? SURFACE_TITLES.home

  const navigation = <>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true"><StudioIcon name="spark" size={17} /></span>
        <div className={styles.brandText}>
          <strong className={styles.brandWord}>织章 · StoryWeave</strong>
          <small className={styles.brandEn}>AI 小说创作工作台</small>
        </div>
      </div>

      <button
        className={styles.workspaceCard}
        type="button"
        onClick={() => workspace.rootPath ? void showShelf() : void openWorkspace()}
        disabled={!api || busy || bookRecoveryLocked || session.session.saving}
        title={book?.book.title ?? workspace.rootPath ?? '切换创作空间'}
      >
        <span className={styles.wsLabel}>创作空间</span>
        <div className={styles.wsRow}>
          <strong>{book?.book.title ?? featuredBook?.title ?? (workspace.rootPath ? '我的作品书房' : '选择本地作品库')}</strong>
          <StudioIcon name="down" size={13} />
        </div>
        <small className={styles.wsMeta}>
          {book ? `${book.chapters.length} 章节 · ${session.session.characterCount.toLocaleString()} 字` : (workspace.rootPath ? `${workspace.books.length} 部作品 · 本地存储` : '点击选择创作文件夹')}
        </small>
      </button>

      <nav className={styles.nav} aria-label="创作空间主导航">
        <button className={`${styles.navItem} ${!isCanvasView && studioView === 'home' ? styles.navItemActive : ''}`} type="button" aria-current={!isCanvasView && studioView === 'home' ? 'page' : undefined} onClick={() => void showHome()} disabled={busy || bookRecoveryLocked}><StudioIcon name="home" size={16} /><span>创作概览</span></button>
        <button className={`${styles.navItem} ${!isCanvasView && studioView === 'write' ? styles.navItemActive : ''}`} type="button" aria-current={!isCanvasView && studioView === 'write' ? 'page' : undefined} onClick={resumeWriting} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="pen" size={16} /><span>写作台</span></button>
        <button className={`${styles.navItem} ${modal?.kind === 'living' && modal.tab !== 'memory' ? styles.navItemActive : ''}`} type="button" aria-current={modal?.kind === 'living' && modal.tab !== 'memory' ? 'page' : undefined} onClick={() => openToolFromNav('living')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="compass" size={16} /><span>大纲与演进</span></button>
        <button className={`${styles.navItem} ${modal?.kind === 'knowledge' || modal?.kind === 'forge' ? styles.navItemActive : ''}`} type="button" aria-current={modal?.kind === 'knowledge' || modal?.kind === 'forge' ? 'page' : undefined} onClick={() => openToolFromNav('forge')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="user" size={16} /><span>角色与世界</span></button>
        <button className={`${styles.navItem} ${modal?.kind === 'galaxy' || modal?.kind === 'living' && modal.tab === 'memory' ? styles.navItemActive : ''}`} type="button" aria-current={modal?.kind === 'galaxy' || modal?.kind === 'living' && modal.tab === 'memory' ? 'page' : undefined} onClick={() => openToolFromNav('galaxy')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="galaxy" size={16} /><span>记忆星图</span></button>
        <button className={`${styles.navItem} ${modal?.kind === 'inspiration' ? styles.navItemActive : ''}`} type="button" aria-current={modal?.kind === 'inspiration' ? 'page' : undefined} onClick={() => workspace.rootPath ? showDialog({ kind: 'inspiration' }) : void openWorkspace()} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="spark" size={16} /><span>拆书与技能库</span><span className={styles.navSkillTag}>8 Skill</span></button>
        <button className={`${styles.navItem} ${modal?.kind === 'notes' ? styles.navItemActive : ''}`} type="button" aria-current={modal?.kind === 'notes' ? 'page' : undefined} onClick={() => openToolFromNav('notes')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="notes" size={16} /><span>素材与便笺</span></button>
        <button className={`${styles.navItem} ${!isCanvasView && studioView === 'shelf' ? styles.navItemActive : ''}`} type="button" aria-current={!isCanvasView && studioView === 'shelf' ? 'page' : undefined} onClick={() => workspace.rootPath ? void showShelf() : void openWorkspace()} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="books" size={16} /><span>作品书架</span><span className={styles.navCount}>{workspace.books.filter((item) => !item.archivedAt).length}</span></button>
      </nav>

      <div className={styles.sidebarTools}>
        <button className={`${styles.navTool} ${modal?.kind === 'calendar' ? styles.navItemActive : ''}`} type="button" onClick={() => openToolFromNav('calendar')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="calendar" size={15} /><span>创作日历</span></button>
        <button className={`${styles.navTool} ${modal?.kind === 'media' ? styles.navItemActive : ''}`} type="button" onClick={() => openToolFromNav('media')} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="image" size={15} /><span>封面立绘</span></button>
        <details className={styles.navGroup}>
          <summary title="整理与管理工具"><StudioIcon name="layers" size={15} /><span>整理与审阅</span><StudioIcon name="down" size={13} /></summary>
          <div className={styles.navPopover}>
            {book && <>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'workbench' })} disabled={busy}><StudioIcon name="compass" size={13} />场景、审稿与写作记录</button>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'timeline' })} disabled={busy}><StudioIcon name="timeline" size={13} />故事时间线</button>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'living', tab: 'memory' })} disabled={busy}><StudioIcon name="read" size={13} />定稿记忆与依赖复核</button>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'story' })} disabled={busy}><StudioIcon name="timeline" size={13} />伏笔与事件记录</button>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'reader' })} disabled={busy}><StudioIcon name="read" size={13} />沉浸阅读预览</button>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'bookDetails', book: book.book })} disabled={busy}><StudioIcon name="pen" size={13} />作品资料与简介</button>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'memory' })} disabled={busy}><StudioIcon name="search" size={13} />长篇记忆与检索</button>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'aiMemoryTasks' })} disabled={busy}><StudioIcon name="spark" size={13} />逐章整理任务</button>
              <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'aiSummary' })} disabled={busy}><StudioIcon name="layers" size={13} />全书分层汇总</button>
            </>}
            <button className={styles.popoverItem} type="button" onClick={() => void openWorkspace()} disabled={!api || busy || bookRecoveryLocked || session.session.saving}><StudioIcon name="folder" size={13} />切换作品库目录</button>
            <button className={styles.popoverItem} type="button" onClick={() => showDialog({ kind: 'bookRecovery' })} disabled={!api || busy || bookRecoveryLocked || session.session.saving}><StudioIcon name="archive" size={13} />作品备份与恢复</button>
            <button className={styles.popoverItem} type="button" onClick={() => openRecovery()} disabled={!api || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt || (busy && !pendingMessage)}><StudioIcon name="history" size={13} />草稿与服务恢复</button>
          </div>
        </details>
        <button className={styles.navTool} type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked || session.session.saving || session.session.composing}><StudioIcon name="settings" size={15} /><span>外观与字号偏好</span></button>
        <div className={styles.sidebarThemeBox} role="group" aria-label="多主题换色与明暗模式">
          {STUDIO_THEMES.map((theme) => {
            const meta = STUDIO_THEME_META[theme]
            const active = display.preferences.studioTheme === theme
            return (
              <button
                key={theme}
                type="button"
                className={`${styles.sidebarThemePill} ${active ? styles.sidebarThemePillActive : ''}`}
                aria-pressed={active}
                disabled={busy}
                onClick={() => display.update({ studioTheme: theme })}
              >
                <span className={styles.sidebarThemeSwatch} style={{ background: meta.swatches[1] }} />
                <span>{meta.label}</span>
              </button>
            )
          })}
        </div>
        <div className={styles.sidebarStatusRow}>
          <span><span className={styles.statusDot} />仅本机存储</span>
          <button
            type="button"
            className={styles.darkToggleBtn}
            title="一键切换日间/夜间模式"
            onClick={() => display.update({ studioTheme: display.preferences.studioTheme === 'night' ? 'mirroric' : 'night' })}
            disabled={busy}
          >
            {display.preferences.studioTheme === 'night' ? '☀️ 日间' : '🌙 夜间'}
          </button>
        </div>
      </div>
    </>

  const rightAsideExpanded = companionOpen || modal?.kind === 'ai' || writeAsideMode !== 'collapsed'
  const commandUnavailable = !api ? '本地服务未连接' : busy || bookRecoveryLocked || pendingMessage ? '请先完成或核对当前操作' : undefined
  const needsBook = commandUnavailable ?? (!book ? '请先打开作品' : undefined)
  const needsChapter = needsBook ?? (!chapter ? '请先打开章节' : undefined)
  const editableChapter = needsChapter ?? (archived ? '归档作品仅供查阅' : undefined)
  const commandItems: StudioCommand[] = [
    { id: 'home', label: '返回今日书桌', group: '工作室', disabledReason: commandUnavailable, run: showHome },
    { id: 'shelf', label: '打开作品书架', group: '工作室', disabledReason: commandUnavailable ?? (!workspace.rootPath ? '请先打开作品库' : undefined), run: showShelf },
    { id: 'workspace', label: '选择作品库', group: '工作室', disabledReason: commandUnavailable, run: () => openWorkspace() },
    { id: 'newBook', label: '开始 AI 开书', group: '创作', keywords: '新建 故事 孵化', disabledReason: commandUnavailable, run: () => startBook('newBook') },
    { id: 'import', label: '导入小说文本', group: '作品', disabledReason: commandUnavailable, run: () => startBook('import') },
    { id: 'write', label: '回到正文写作', group: '创作', disabledReason: commandUnavailable, run: resumeWriting },
    { id: 'save', label: '保存当前章节', group: '正文', shortcut: 'Ctrl+S', disabledReason: editableChapter, run: async () => { if (!transition.current && !recoveryLock.current) await session.flush() } },
    { id: 'newChapter', label: '新建章节', group: '正文', disabledReason: needsBook ?? (archived ? '归档作品仅供查阅' : undefined), run: () => showDialog({ kind: 'newChapter', volumeId: chapter?.volumeId ?? null }) },
    { id: 'newVolume', label: '新建卷', group: '正文', disabledReason: needsBook ?? (archived ? '归档作品仅供查阅' : undefined), run: () => showDialog({ kind: 'volume' }) },
    { id: 'chapterDetails', label: '编辑本章资料', group: '正文', keywords: '目标 视角', disabledReason: editableChapter, run: () => showDialog({ kind: 'chapterDetails' }) },
    { id: 'history', label: '查看章节修订历史', group: '正文', disabledReason: needsChapter, run: () => showDialog({ kind: 'history' }) },
    { id: 'finalize', label: '确认本章定稿', group: '正文', disabledReason: editableChapter, run: () => showDialog({ kind: 'finalize' }) },
    { id: 'ai', label: '打开 AI 副驾驶', group: 'AI', disabledReason: editableChapter, run: () => showDialog({ kind: 'ai' }) },
    { id: 'review', label: '审稿与虚拟读者', group: 'AI', disabledReason: needsBook, run: () => openToolFromNav('workbench') },
    { id: 'living', label: '大纲与演进沙盘', group: '故事', disabledReason: needsBook, run: () => openToolFromNav('living') },
    { id: 'forge', label: '角色与世界工坊', group: '故事', keywords: '人物 起名', disabledReason: needsBook, run: () => openToolFromNav('forge') },
    { id: 'knowledge', label: '故事设定', group: '故事', disabledReason: needsBook, run: () => openToolFromNav('knowledge') },
    { id: 'galaxy', label: '全书记忆星图', group: '控盘', disabledReason: needsBook, run: () => showDialog({ kind: 'galaxy', view: 'galaxy' }) },
    { id: 'matrix', label: '章节与实体出场矩阵', group: '控盘', keywords: '人物 掉线 缺席', disabledReason: needsBook, run: () => showDialog({ kind: 'galaxy', view: 'matrix' }) },
    { id: 'radar', label: '伏笔到期雷达', group: '控盘', keywords: '回收 逾期', disabledReason: needsBook, run: () => showDialog({ kind: 'galaxy', view: 'radar' }) },
    { id: 'story', label: '故事事件与伏笔记录', group: '控盘', disabledReason: needsBook, run: () => showDialog({ kind: 'story', initialKind: 'event' }) },
    { id: 'timeline', label: '故事时间线', group: '控盘', disabledReason: needsBook, run: () => openToolFromNav('timeline') },
    { id: 'notes', label: '素材与便笺', group: '资料', disabledReason: needsBook, run: () => openToolFromNav('notes') },
    { id: 'inspiration', label: '全局灵感与拆书技能库', group: '资料', disabledReason: commandUnavailable ?? (!workspace.rootPath ? '请先打开作品库' : undefined), run: () => showDialog({ kind: 'inspiration' }) },
    { id: 'calendar', label: '创作日历', group: '工具', disabledReason: needsBook, run: () => openToolFromNav('calendar') },
    { id: 'media', label: '封面与人物立绘', group: '工具', disabledReason: needsBook, run: () => openToolFromNav('media') },
    { id: 'reader', label: '沉浸阅读', group: '作品', disabledReason: needsBook, run: () => showDialog({ kind: 'reader' }) },
    { id: 'export', label: '导出作品', group: '作品', disabledReason: needsBook, run: () => showDialog({ kind: 'export' }) },
    { id: 'backup', label: '作品备份与恢复', group: '作品', disabledReason: commandUnavailable ?? (!workspace.rootPath ? '请先打开作品库' : undefined), run: () => showDialog({ kind: 'bookRecovery' }) },
    { id: 'memory', label: '记忆索引与检索', group: '资料', disabledReason: needsBook, run: () => showDialog({ kind: 'memory' }) },
    { id: 'preferences', label: '阅读与显示设置', group: '显示', disabledReason: commandUnavailable, run: () => showDialog({ kind: 'preferences' }) },
    { id: 'focus', label: focused ? '退出专注模式' : '进入专注模式', group: '显示', shortcut: 'Ctrl+Shift+Enter', disabledReason: needsChapter,
      run: () => changeView(async () => { setSurface('write'); setModal(null); setFocused((value) => !value) }) },
    ...STUDIO_THEMES.map((theme): StudioCommand => ({ id: `theme:${theme}`, label: `切换主题 · ${STUDIO_THEME_META[theme].label}`, group: '显示',
      keywords: theme === 'night' ? '夜间 暗色 dark' : '日间 明亮 light', disabledReason: commandUnavailable,
      run: () => { display.update({ studioTheme: theme }) } })),
    ...(book?.chapters.map((item): StudioCommand => ({ id: `chapter:${item.id}`, label: `第 ${item.position + 1} 章 · ${item.title}`, group: '跳转章节',
      disabledReason: needsBook, run: () => openBook(book.book.id, item.id) })) ?? []),
  ]

  return <div className={`${styles.appShell} ${sidebarCollapsed ? styles.sidebarCollapsed : ''} ${studioView === 'write' && !isCanvasView && focused && chapter ? styles.focusMode : ''}`}>
    {commandOpen && <CommandPalette commands={commandItems} onClose={() => setCommandOpen(false)} />}
    <aside id="studio-sidebar" className={styles.sidebar} aria-label="工作室导航">{navigation}</aside>
    <main className={`${styles.main} ${studioView !== 'write' || isCanvasView ? styles.homeMain : ''}`}>
      <header className={styles.topbar}>
        <div className={styles.breadcrumb}>
          <button className={styles.sidebarToggle} type="button" title={sidebarCollapsed ? '显示侧栏' : '隐藏侧栏'} aria-label={sidebarCollapsed ? '显示侧栏' : '隐藏侧栏'} aria-expanded={!sidebarCollapsed} aria-controls="studio-sidebar" onClick={() => setSidebarCollapsed((value) => !value)}>
            <StudioIcon name="sidebar" size={18} />
          </button>
          <span className={styles.topbarPage}>{headerInfo.title}</span>
          <span className={styles.crumbSlash}>/</span>
          <span className={styles.crumb} title={book?.book.title ?? headerInfo.subtitle}>
            {book ? `《${book.book.title}》 · ${headerInfo.subtitle}` : headerInfo.subtitle}
          </span>
        </div>

        <div className={styles.topActions}>
          <button className={styles.button} type="button" aria-keyshortcuts="Control+k Meta+k" disabled={busy || hasBlockingDialog || bookRecoveryLocked} onClick={() => { setNavigationOpen(false); setCommandOpen(true) }} title="搜索命令与章节 · Ctrl+K">搜索命令 <kbd>Ctrl+K</kbd></button>
          {/* 顶栏快捷工作室主题切换点 */}
          <div className={styles.themeQuickBar} role="group" aria-label="快速切换书房配色">
            {STUDIO_THEMES.map((theme) => {
              const meta = STUDIO_THEME_META[theme]
              const active = display.preferences.studioTheme === theme
              return <button
                key={theme}
                type="button"
                className={`${styles.themeDotButton} ${active ? styles.themeDotActive : ''}`}
                title={`切换配色：${meta.label}`}
                aria-label={`切换配色：${meta.label}`}
                aria-pressed={active}
                disabled={busy}
                onClick={() => display.update({ studioTheme: theme })}
              >
                <span className={styles.themeDotSwatch} style={{ background: meta.swatches[1] }} />
                <span className={styles.themeDotLabel}>{meta.label.slice(0, 2)}</span>
              </button>
            })}
          </div>
          {studioView === 'write' && !isCanvasView && chapter && <>
            <span className={`${styles.saveState} ${session.session.error ? styles.saveError : session.session.dirty || session.session.saving || session.session.composing ? styles.savePending : ''}`} role="status">
              <span className={styles.statusDot} />{saveLabel(session.session)}
            </span>
            <button className={styles.button} type="button" onClick={() => void session.flush()} disabled={busy || !session.session.dirty || session.session.saving || session.session.composing}>
              <StudioIcon name="save" size={14} />保存 <kbd>Ctrl S</kbd>
            </button>
            <button className={styles.button} type="button" aria-pressed={focused} title="切换专注模式（Ctrl+Shift+Enter），Esc退出" onClick={() => setFocused(!focused)} disabled={session.session.composing || (busy && !focused)}>
              <StudioIcon name="focus" size={14} />{focused ? '退出专注' : '专注写作'}
            </button>
          </>}
          {studioView === 'write' && !isCanvasView && book ? focused ? <>
            <button className={styles.button} type="button" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked || session.session.saving || session.session.composing}><StudioIcon name="settings" size={14} />外观</button>
            <button className={styles.button} type="button" onClick={() => openRecovery()} disabled={!api || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt || (busy && !pendingMessage)}><StudioIcon name="history" size={14} />恢复</button>
          </> : <button className={styles.button} type="button" onClick={() => showDialog({ kind: 'export' })} disabled={busy || book.chapters.length === 0}><StudioIcon name="export" size={14} />导出</button> : <>
            <span className={styles.localBadge}><span className={styles.statusDot} />{workspace.rootPath ? '仅本机 · 已连接' : '仅本机'}</span>
            <button className={styles.iconButton} type="button" aria-label="外观与显示偏好" title="工作室配色与稿纸偏好" aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked}><StudioIcon name="settings" size={17} /></button>
          </>}
        </div>
      </header>
      {book && <CreativeSpine snapshot={creative.snapshot} reading={creative.reading} error={creative.error} disabled={busy || bookRecoveryLocked || hasBlockingDialog} onNavigate={openCreativeDomain} onReload={creative.reload} />}
      {message && !hasBlockingDialog && <div className={styles.notice} role="alert"><span>{message}</span><button type="button" onClick={() => setMessage(null)} aria-label="关闭提示">×</button></div>}
      {display.warning && !hasBlockingDialog && <div className={styles.notice} role="status"><span>{display.warning}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing} onClick={display.retrySave}>保存当前显示偏好</button></div>}
      {pendingMessage && <div className={styles.notice} role="alert"><span>{pendingMessage}</span><button className={styles.receiptButton} type="button" onClick={() => void checkMutationReceipt()} disabled={checkingReceipt || recoveryBusy}>{checkingReceipt ? '正在核对…' : '核对回执'}</button></div>}
      {session.session.error && <div className={`${styles.notice} ${styles.noticeError}`} role="alert"><span>{session.session.error.message}{session.session.error.code === 'REVISION_CONFLICT' && ' 请从“草稿与恢复”另存后重载磁盘版本。'}</span></div>}
      {session.session.dirty && protection.state.error && <div className={`${styles.notice} ${styles.noticeError}`} role="alert"><span>恢复检查点未更新：{protection.state.error}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing} onClick={protection.retry}>重试留存</button><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing || hasBlockingDialog} onClick={showDraftProtection}>查看容量与分代</button></div>}
      {protection.state.warning && <div className={styles.notice} role="status"><span>{protection.state.warning}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing || hasBlockingDialog} onClick={showDraftProtection}>查看容量与分代</button></div>}
      {archived && <div className={styles.notice}><span>此作品已归档，可阅读和导出。继续编辑前请在作品资料中解除归档。</span></div>}

      {/* 全画布一级功能视图：取代旧版模态弹窗地狱，直接在主画布内平铺展开 */}
      {isCanvasView && <DialogDisplayContext.Provider value="canvas">
        <div className={styles.canvasViewport}>
          {modal?.kind === 'forge' && book && api && <Dialog title="角色与世界工坊" wide inline onClose={closeModal} busy={busy}>
            <ForgePanel key={`${workspace.rootPath}:${book.book.id}:${modal.initialKind ?? 'cast'}:${modal.personId ?? ''}`} api={api} book={book} chapter={chapter} disabled={busy}
              initialKind={modal.initialKind} initialPersonId={modal.personId} onDirtyChange={(value) => { workbenchDirty.current = value }} onBookChange={applyBook}
              onConfigure={() => showDialog({ kind: 'ai' })} onKnowledge={() => showDialog({ kind: 'knowledge' })} onRelations={() => showDialog({ kind: 'galaxy' })} onMedia={() => showDialog({ kind: 'media' })} onRecover={() => openRecovery(true)} />
          </Dialog>}
          {modal?.kind === 'living' && book && api && <Dialog title={modal.tab === 'memory' ? '定稿记忆与来源复核' : '大纲与演进沙盘'} wide inline onClose={closeModal} busy={busy}>
            <LivingPanel key={`${workspace.rootPath}:${book.book.id}:${modal.tab ?? 'outline'}:${modal.initialId ?? ''}`} api={api} book={book} chapter={chapter} disabled={busy}
              initialTab={modal.tab} initialId={modal.initialId} onDirtyChange={(value) => { workbenchDirty.current = value }} onBookChange={applyBook} onSnapshotChange={creative.receive}
              onConfigure={() => showDialog({ kind: 'ai' })} onNavigate={(id) => void openChapter(id)} onRecover={() => openRecovery(true)} />
          </Dialog>}
          {modal?.kind === 'kickstart' && api && workspace.rootPath && <KickstartPanel key={`${workspace.rootPath}:${modal.bookId ?? 'new'}`} api={api} bookId={modal.bookId} disabled={busy}
            onDirtyChange={(value) => { auxiliaryDirty.current = value }} onBookChange={upsertShelf} onAdopted={enterKickstart} onClose={closeModal}
            onManual={() => showDialog({ kind: 'newBook' })} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'workbench' && book && api && <Dialog title="规划、审稿与写作记录" wide inline onClose={closeModal} busy={busy}>
            <WorkbenchPanel key={`${workspace.rootPath}:${book.book.id}`} api={api} book={book} chapter={chapter} disabled={busy} onDirtyChange={(value) => { workbenchDirty.current = value }} onBookChange={applyBook} onChapterChange={(value) => { onSaved(value); session.load(value) }} onNavigate={(id) => void changeView(async () => { const value = await api.readChapter({ bookId: book.book.id, chapterId: id }); if (value.ok && value.data.bookId === book.book.id && value.data.id === id) { session.load(value.data); setModal(null); setSurface('write') } else setMessage(value.ok ? '章节身份不匹配。' : value.error.message) })} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} onReview={(instruction) => showDialog({ kind: 'ai', purpose: 'review', initialInstruction: instruction })} />
          </Dialog>}
          {modal?.kind === 'inspiration' && workspace.rootPath && api && <Dialog title="全局灵感与拆书技能库" wide inline onClose={closeModal} busy={busy}>
            <InspirationPanel key={workspace.rootPath} api={api} books={workspace.books} activeBook={book} disabled={busy} onDirtyChange={(value) => { inspirationDirty.current = value }} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} onBookChanged={async (id) => { if (bookRef.current?.book.id === id) await refreshCurrentBook(id); else { const value = await request(() => api.getBook({ bookId: id })); if (value.ok) upsertShelf(value.data.book) } }} />
          </Dialog>}
          {modal?.kind === 'knowledge' && api && book && <KnowledgePanel key={`${book.book.id}:${modal.initialKind ?? 'all'}`} initialKind={modal.initialKind} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(dirty) => { knowledgeDirty.current = dirty }} onUpgrade={upgradeKnowledge} onCreate={createKnowledge} onUpdate={updateKnowledge} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onForge={(personId, initialKind) => showDialog({ kind: 'forge', personId, initialKind })} />}
          {modal?.kind === 'story' && api && book && <StoryPanel key={`${book.book.id}:${modal.initialKind ?? ''}:${modal.initialId ?? ''}`} api={api} book={book} initialKind={modal.initialKind} initialId={modal.initialId} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(dirty) => { storyDirty.current = dirty }} onUpgrade={upgradeKnowledge} onCreate={createStory} onUpdate={updateStory} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'calendar' && api && book && <Dialog title="创作日历与每日打卡" wide inline onClose={closeModal} busy={busy}><WritingCalendarPanel key={`${workspace.rootPath}:${book.book.id}`} api={api} book={book} disabled={busy} onDirtyChange={(value) => { auxiliaryDirty.current = value }} onBookChange={applyBook} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} /></Dialog>}
          {modal?.kind === 'media' && api && book && <Dialog title="封面与人物立绘" wide inline onClose={closeModal} busy={busy}><BookMediaPanel key={`${workspace.rootPath}:${book.book.id}`} api={api} book={book} disabled={busy} onDirtyChange={(value) => { auxiliaryDirty.current = value }} onBookChange={applyBook} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} /></Dialog>}
          {modal?.kind === 'timeline' && api && book && <StoryTimelinePanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onOpenRecords={(kind) => showDialog({ kind: 'story', initialKind: kind })} />}
          {modal?.kind === 'galaxy' && api && book && <StoryGalaxyPanel key={`${workspace.rootPath}:${book.book.id}:${modal.view ?? ''}`} api={api} book={book} busy={busy} error={modalError} initialView={modal.view} chapterId={chapter?.id} onNavigate={navigateCompanion} onUseForeshadow={chapter && !archived ? useForeshadow : undefined} onClose={closeModal} onDirtyChange={(value) => { auxiliaryDirty.current = value }} onBookChange={applyBook} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} onOpenKnowledge={() => changeView(async () => { setModal({ kind: 'knowledge' }) })} onOpenRecords={(initialKind, initialId) => changeView(async () => { setModal({ kind: 'story', initialKind, initialId }) })} />}
          {modal?.kind === 'notes' && api && book && <NotesPanel key={book.book.id} api={api} book={book} displayPreferences={display.preferences} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { notesDirty.current = value }} onUpgrade={upgradeKnowledge}
            onCreate={(input, accept) => writeNote('notes.create', input, () => api.createNote(input), accept)} onUpdate={(input, accept) => writeNote('notes.update', input, () => api.updateNote(input), accept)} onPromote={(input, accept) => writeNote('notes.promote', input, () => api.promoteNote(input), accept)} />}
          {modal?.kind === 'reader' && api && book && <BookReaderPanel key={book.book.id} api={api} book={book} initialChapterId={chapter?.id} busy={busy} error={modalError} displayPreferences={display.preferences} preferencesWarning={display.warning} onPreferencesChange={display.update} onRetryPreferencesSave={display.retrySave} onClose={closeModal} />}
          {modal?.kind === 'memory' && api && book && <MemoryPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(value) => { memoryWorking.current = value }} onUpgrade={upgradeKnowledge} onStart={startMemory} onStep={stepMemory} onControl={controlMemory} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'aiMemoryTasks' && api && book && <AiMemoryTasksPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdoptMemory={adoptAiMemory} />}
          {modal?.kind === 'aiSummary' && api && book && <AiSummaryPanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdoptSummary={adoptAiSummary} />}
          {modal?.kind === 'ai' && api && book && chapter && <div className={styles.wideAiContainer}>
            <div className={styles.wideAiBanner}>
              <span>当前处于宽屏 AI 创作视图，可点击右侧切换回正文伴随侧栏</span>
              <button type="button" className={styles.button} disabled={busy} onClick={() => void changeView(async () => { setAiWideMode(false) })}>切回侧栏伴随模式</button>
            </div>
            <AiPanel key={`${book.book.id}:${modal?.kind === 'ai' ? modal.purpose ?? '' : ''}:${aiInstruction ?? ''}:${aiResourceKey}`} initialResources={aiResources} initialPurpose={modal?.kind === 'ai' ? modal.purpose : undefined} initialInstruction={aiInstruction} initialLivingContext={aiLivingContext} api={api} book={book} chapter={chapter} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onBookChange={applyBook} onUpgrade={upgradeKnowledge} onAdopt={adoptAi} onAdoptMemory={adoptAiMemory} />
          </div>}
        </div>
      </DialogDisplayContext.Provider>}

      {!isCanvasView && studioView === 'home' && <WelcomeWorkspace
        api={api}
        workspace={workspace}
        currentBook={book}
        studioTheme={display.preferences.studioTheme}
        onThemeChange={(studioTheme) => display.update({ studioTheme })}
        onOpenWorkspace={() => void openWorkspace()}
        onCreate={() => startBook('newBook')}
        onImport={() => startBook('import')}
        onShelf={() => workspace.rootPath ? void showShelf() : void openWorkspace()}
        onRecover={() => showDialog({ kind: 'bookRecovery' })}
        onPreferences={() => showDialog({ kind: 'preferences' })}
        onOpenBook={(id, chapterId) => void openBook(id, chapterId)}
        onTool={(id, kind) => void openWorkspaceTool(id, kind)}
        onOpenInspiration={() => showDialog({ kind: 'inspiration' })}
        busy={busy || bookRecoveryLocked}
      />}
      {!isCanvasView && studioView === 'shelf' && <BookShelf api={api} workspaceScope={workspace.rootPath ? JSON.stringify([workspace.rootPath, workspace.recoveryScope]) : undefined} books={workspace.books} onOpen={(id) => void openBook(id)} onEdit={(item) => showDialog({ kind: 'bookDetails', book: item })} onCreate={() => showDialog({ kind: 'kickstart' })} onImport={() => showDialog({ kind: 'import' })} onRecover={() => showDialog({ kind: 'orphans' })} busy={busy || bookRecoveryLocked} />}
      {book && <div className={styles.editorSurface} hidden={studioView !== 'write' || isCanvasView} inert={studioView !== 'write' || isCanvasView}>
        <div className={styles.chapterActions}>
          <span className={styles.chapterTitle}>{chapter?.title ?? '选择或新建章节'}<small>{book.chapters.length} 章 · {book.volumes.length} 卷</small></span>
          <button className={styles.chapterOutlineToggle} type="button" aria-label="章节目录" aria-controls="chapter-outline" aria-expanded={outlineOpen || !chapter} onClick={() => setOutlineOpen((value) => !value)} disabled={busy || !chapter || session.session.composing}><StudioIcon name="list" size={16} />目录 · {book.chapters.length} 章<StudioIcon name="down" size={14} /></button>
          <div className={styles.actionRow}>
            <button
              className={styles.button}
              type="button"
              aria-expanded={companionOpen}
              onClick={() => {
                const next = !companionOpen
                setCompanionOpen(next)
                if (next) setWriteAsideMode('companion')
                else if (writeAsideMode === 'companion') setWriteAsideMode('meta')
              }}
              disabled={busy}
            >
              <StudioIcon name="read" size={16} />伴随资料
            </button>
            {chapter && <button
              className={styles.aiEntry}
              type="button"
              aria-expanded={isAiInWriteDrawer}
              onClick={() => {
                if (modal?.kind === 'ai') closeModal()
                else {
                  setAiWideMode(false)
                  setCompanionOpen(false)
                  setWriteAsideMode('ai')
                  showDialog({ kind: 'ai' })
                }
              }}
              disabled={busy}
            >
              <StudioIcon name="spark" size={16} />{modal?.kind === 'ai' ? '收起 AI 副驾驶' : 'AI 协作'}
            </button>}
            <button className={styles.button} type="button" onClick={() => openToolFromNav('workbench')} disabled={busy}><StudioIcon name="compass" size={15} />章节规划</button>
            <details className={styles.chapterTools}>
              <summary>章节工具<StudioIcon name="down" size={14} /></summary>
              <div className={styles.chapterToolItems}>
                {chapter && <><button type="button" onClick={() => showDialog({ kind: 'chapterDetails' })} disabled={busy || archived}>{chapter.status === 'finalized' ? '资料 / 重开工作稿' : '本章资料'}</button><button type="button" onClick={() => showDialog({ kind: 'history' })} disabled={busy}>版本历史与对比</button><button type="button" onClick={() => showDialog({ kind: 'finalize' })} disabled={busy || archived || (chapter.status === 'finalized' && !session.session.dirty)}>作者定稿</button></>}
                <button type="button" onClick={() => void changeView(async () => { await refreshCurrentBook(book.book.id) })} disabled={busy}>刷新目录</button>
                <button type="button" onClick={() => showDialog({ kind: 'draftImport' })} disabled={busy || archived || !workspace.recoveryScope}>从草稿恢复新章</button>
              </div>
            </details>
          </div>
        </div>
        <div className={`${styles.writeLayout} ${outlineOpen || !chapter ? styles.outlineExpanded : ''} ${companionOpen || isAiInWriteDrawer ? styles.companionExpanded : ''} ${isAiInWriteDrawer ? styles.aiDrawerExpanded : ''} ${!rightAsideExpanded ? styles.asideCollapsed : ''}`}>
          <div className={`${styles.chapterRail} ${styles.outlineColumn}`}>
            <ChapterOutline book={book} selectedId={chapter?.id} busy={busy} onOpen={(id) => void openChapter(id)} onCreate={(volumeId) => showDialog({ kind: 'newChapter', volumeId })} onVolume={(volumeId) => showDialog({ kind: 'volume', volumeId })} onMoveChapter={(id, direction) => void moveItem('chapter', id, direction)} onMoveVolume={(id, direction) => void moveItem('volume', id, direction)} />
            {chapter && <ChapterBeatStrip outline={creative.snapshot?.outlines.find((item) => item.id === chapter.id)} reading={creative.reading} disabled={busy} onOpen={() => showDialog({ kind: 'living', initialId: chapter.id })} onExpand={(instruction) => showDialog({ kind: 'ai', initialInstruction: instruction, useLivingContext: true })} />}
          </div>
          <section ref={manuscriptScroll} onScroll={(event) => { if (chapter && studioView === 'write' && !isCanvasView) rememberWritingPosition(workspace.rootPath, chapter.bookId, chapter.id, { scrollTop: event.currentTarget.scrollTop }) }} className={styles.manuscript} aria-label="正文编辑区">{chapter ? <>
            <div className={styles.manuscriptMeta}>
              <span>第 {chapter.position + 1} 章 · {statusLabels[chapter.status]}{chapter.viewpoint ? ' · 视角：' + chapter.viewpoint : ''}{chapter.goal ? ' · 目标：' + chapter.goal : ''}</span>
              <span>{session.session.characterCount.toLocaleString()} 字{chapter.targetCharacters !== null ? ' / 目标 ' + chapter.targetCharacters.toLocaleString() + ' 字' : ''}</span>
            </div>
            {chapter.finalizedRevisionId && <p className={styles.finalizedNote}>本章已有作者定稿。继续修改将生成新工作稿，原定稿完整保留。</p>}
            {chapter.finalizedRevisionId === chapter.revisionId && <div className={styles.finalizedMemory}><span>定稿后的摘要、事件和人物状态可整理为带引文的记忆批次。</span><button className={styles.button} type="button" disabled={busy} onClick={() => showDialog({ kind: 'living', tab: 'memory', initialId: chapter.id })}>整理与复核本章记忆</button></div>}
            <ManuscriptEditor key={chapter.bookId + ':' + chapter.id + ':' + session.session.loadEpoch} title={chapter.title} document={chapter.document} disabled={studioView !== 'write' || isCanvasView || busy || bookRecoveryLocked || hasBlockingDialog} readOnly={archived} displayPreferences={display.preferences} onChange={session.changed} onComposition={session.setComposing} initialPosition={navigationPosition.current?.bookId === chapter.bookId && navigationPosition.current.chapterId === chapter.id ? navigationPosition.current.position : writingPosition(workspace.rootPath, chapter.bookId)?.chapterId === chapter.id ? writingPosition(workspace.rootPath, chapter.bookId) : null} onPositionChange={(position) => { if (studioView === 'write' && !isCanvasView) rememberWritingPosition(workspace.rootPath, chapter.bookId, chapter.id, position) }} />
          </> : <div className={styles.emptyChapter}>
            <span className={styles.emptyChapterBadge}><StudioIcon name="spark" size={16} />从第一个脑洞开始</span>
            <h2>{book.chapters.length ? '从左侧选择一章继续落笔' : '让故事从第一幕长出来'}</h2>
            <p>{book.chapters.length ? '点击左侧卷章目录打开正文，或去「章节规划」用已有文字连接下一章。' : '不需要先填满复杂的世界观。建立第一章，写下一句话冲突，人物与设定可以边写边长。'}</p>
            <div className={styles.actionRow}>
              {!archived && <button className={styles.primaryButton} type="button" onClick={() => showDialog({ kind: 'newChapter', volumeId: null })} disabled={busy}><StudioIcon name="pen" size={15} />建立章节</button>}
              <button className={styles.button} type="button" onClick={() => openToolFromNav('workbench')} disabled={busy}><StudioIcon name="compass" size={15} />打开章节规划</button>
              <button className={styles.button} type="button" onClick={() => openToolFromNav('knowledge')} disabled={busy}><StudioIcon name="read" size={15} />整理故事设定</button>
            </div>
          </div>}</section>

          {isAiInWriteDrawer && api && chapter ? (
            <aside className={`${styles.companionAside} ${styles.aiCopilotAside}`} aria-label="AI 创作副驾驶">
              <div className={styles.copilotToolbar}>
                <div className={styles.copilotTabs}>
                  <button type="button" className={styles.copilotTabActive}><StudioIcon name="spark" size={14} />AI 副驾驶</button>
                  <button type="button" onClick={() => { if (!aiDirty.current) { setModal(null); setCompanionOpen(true); setWriteAsideMode('companion') } else setMessage('请先处理 AI 副驾驶中未保存的内容。') }}><StudioIcon name="read" size={14} />伴随资料</button>
                </div>
                <div className={styles.copilotActions}>
                  {/* 两种布局会重新挂载 AI 会话，切换同样需要保护未保存要求、改稿与待核对请求。 */}
                  <button type="button" className={styles.copilotExpandBtn} disabled={busy} onClick={() => void changeView(async () => { setAiWideMode(true) })} title="展开为全画布宽屏视图">宽屏审阅</button>
                </div>
              </div>
              <DialogDisplayContext.Provider value="drawer">
                <AiPanel key={`${book.book.id}:${modal?.kind === 'ai' ? modal.purpose ?? '' : ''}:${aiInstruction ?? ''}:${aiResourceKey}`} initialResources={aiResources} initialPurpose={modal?.kind === 'ai' ? modal.purpose : undefined} initialInstruction={aiInstruction} initialLivingContext={aiLivingContext} api={api} book={book} chapter={chapter} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onBookChange={applyBook} onUpgrade={upgradeKnowledge} onAdopt={adoptAi} onAdoptMemory={adoptAiMemory} />
              </DialogDisplayContext.Provider>
            </aside>
          ) : companionOpen && api ? (
            <aside className={styles.companionAside} aria-label="伴随资料">
              <div className={styles.copilotToolbar}>
                <div className={styles.copilotTabs}>
                  <button type="button" className={styles.copilotTabActive}><StudioIcon name="read" size={14} />伴随资料</button>
                  {chapter && <button type="button" onClick={() => { setCompanionOpen(false); setAiWideMode(false); setWriteAsideMode('ai'); showDialog({ kind: 'ai' }) }}><StudioIcon name="spark" size={14} />AI 副驾驶</button>}
                </div>
              </div>
              <CompanionPanel api={api} book={book} chapter={chapter} scopeKey={workspace.rootPath ?? ''} busy={busy || hasBlockingDialog || session.session.composing} onNavigate={navigateCompanion} onReturn={returnFromCompanion} canReturn={Boolean(returnLocation && returnLocation.root === workspace.rootPath && returnLocation.bookId === book.book.id)} onClose={() => { setCompanionOpen(false); setWriteAsideMode('meta') }} />
            </aside>
          ) : (
            <aside className={styles.memoryAside} aria-label="本章记录">
              <div className={styles.asideHeadingRow}>
                <div className={styles.asideHeading}>本章与副驾驶</div>
                {chapter && <button type="button" className={styles.asideQuickAi} onClick={() => { setAiWideMode(false); setWriteAsideMode('ai'); showDialog({ kind: 'ai' }) }} disabled={busy}><StudioIcon name="spark" size={13} />呼出 AI</button>}
              </div>
              <div className={styles.stateBlock}>
                <strong>{chapter ? saveLabel(session.session) : '等待打开章节'}</strong>
                <p>停笔片刻后自动落盘保存，也可随时按 Ctrl+S。每次保存均生成可回溯的历史版本。</p>
                {chapter && <p>{protection.state.createdAt ? `恢复检查点：${displayTime(protection.state.createdAt)}${protection.state.editSequence < session.session.editSequence ? '（之后的输入尚未留存）' : ''}` : '未保存内容会定时留存到作品库的恢复目录。'}</p>}
              </div>
              {chapter && <>
                {api && <ForeshadowDueNotice api={api} book={book} chapterId={chapter.id} disabled={busy || archived} onUse={useForeshadow} onOpen={() => showDialog({ kind: 'galaxy', view: 'radar' })} />}
                <div className={styles.asideRule} />
                <div className={styles.stateBlock}>
                  <span className={styles.label}>本章目标与视角</span>
                  {chapter.goal ? <p className={styles.goalHighlight}>{chapter.goal}</p> : <p>尚未填写本章目标，可在「本章资料」或「章节规划」中补充。</p>}
                  {chapter.viewpoint && <p>叙事视角：<strong>{chapter.viewpoint}</strong></p>}
                  <div className={styles.asideQuickLinks}>
                    <button type="button" onClick={() => showDialog({ kind: 'chapterDetails' })} disabled={busy || archived}>编辑本章目标</button>
                    <button type="button" onClick={() => { setCompanionOpen(true); setWriteAsideMode('companion') }} disabled={busy}>查阅人物/伏笔</button>
                  </div>
                </div>
              </>}
              <div className={styles.asideRule} />
              <div className={styles.stateBlock}>
                <span className={styles.label}>最近保存</span>
                <strong>{chapter ? displayTime(chapter.updatedAt) : '—'}</strong>
                {chapter?.finalizedAt && <p>最近定稿：{displayTime(chapter.finalizedAt)}</p>}
              </div>
              <div className={styles.asideRule} />
              <div className={styles.stateBlock}>
                <span className={styles.label}>故事空间直达</span>
                <div className={styles.asideShortcutGrid}>
                  <button type="button" onClick={() => openToolFromNav('knowledge')} disabled={busy}><StudioIcon name="read" size={14} />故事设定</button>
                  <button type="button" onClick={() => openToolFromNav('galaxy')} disabled={busy}><StudioIcon name="galaxy" size={14} />关系画布</button>
                  <button type="button" onClick={() => openToolFromNav('timeline')} disabled={busy}><StudioIcon name="timeline" size={14} />时间线</button>
                  <button type="button" onClick={() => showDialog({ kind: 'inspiration' })} disabled={busy}><StudioIcon name="spark" size={14} />技能与拆书</button>
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>}
    </main>
    <nav className={styles.mobileTabs} aria-label="主要页面">
      <button type="button" aria-current={!isCanvasView && studioView === 'home' ? 'page' : undefined} onClick={() => void showHome()} disabled={busy || bookRecoveryLocked}><StudioIcon name="home" size={21} /><span>工作台</span></button>
      <button type="button" aria-current={!isCanvasView && studioView === 'write' ? 'page' : undefined} onClick={resumeWriting} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="pen" size={21} /><span>写作</span></button>
      <button type="button" aria-current={!isCanvasView && studioView === 'shelf' ? 'page' : undefined} onClick={() => workspace.rootPath ? void showShelf() : void openWorkspace()} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="books" size={21} /><span>书架</span></button>
      <button type="button" aria-haspopup="dialog" aria-expanded={navigationOpen} aria-disabled={hasBlockingDialog || recoveryBusy || checkingReceipt || session.session.saving || session.session.composing || (busy && !pendingMessage)} onClick={openNavigation}><StudioIcon name="more" size={21} /><span>更多</span></button>
    </nav>
    {navigationOpen && <Dialog title="工作室导航" className={`${styles.lightDialog} ${styles.navigationSheet}`} onClose={() => setNavigationOpen(false)}>{navigation}</Dialog>}
    {modal?.kind === 'preferences' && <DisplayPreferencesPanel preferences={display.preferences} warning={display.warning} busy={busy} onChange={display.update} onReset={display.reset} onRetrySave={display.retrySave} onClose={closeModal} />}
    {api && <BookRecoveryPanel api={api} open={modal?.kind === 'bookRecovery'} book={book?.book ?? null} targetRoot={workspace.rootPath} recoveryEpoch={bookRecoveryEpoch} busy={busy || recoveryBusy} error={modalError} onDirtyChange={markBookRecoveryDirty} onClose={closeModal} onRecover={() => openRecovery(true)} onChooseWorkspace={() => void openWorkspace()} onRestored={acceptBookRecovery} onRefresh={refreshRecoveryShelf} onOpenBook={(id) => void openBook(id)} />}
    {modal?.kind === 'newBook' && <NewBookDialog onSubmit={(input) => void createBook(input)} onImport={() => setModal({ kind: 'import' })} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmCloseRequested={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
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
