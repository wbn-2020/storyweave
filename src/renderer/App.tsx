import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type {
  AppError, BookSnapshot, BookSummary, ChapterSnapshot, ChapterSummary, CommandMap, CompletedRequest,
  Result, ServiceCommand, StudioApi, WorkspaceSnapshot, CreateBookInput,
} from '../contracts/api'
import { parseManuscript } from '../contracts/manuscript'
import { isKnowledgeAdjudicationReceiptFor, type CreateKnowledgeItemInput, type KnowledgeItemDetail, type KnowledgeKind, type KnowledgeStatus, type UpdateKnowledgeItemInput } from '../contracts/knowledge'
import type { CreateStoryRecordInput, StoryRecordDetail, UpdateStoryRecordInput, StoryKind } from '../contracts/story'
import type { MemoryControlInput, MemoryStartInput, MemoryTaskInput, MemoryTaskReceipt } from '../contracts/memory'
import { isAiAdoptReceiptFor, isAiMemoryAdoptReceiptFor, type AiAdoptInput, type AiAdoptReceipt, type AiMemoryAdoptInput, type AiMemoryAdoptReceipt, type AiRun, type AiTaskKind } from '../contracts/ai'
import { isAiSummaryAdoptReceiptFor, type AiSummaryAdoptInput, type AiSummaryAdoptReceipt, type AiSummaryTaskSummary } from '../contracts/ai-summary'
import type { BookRecoveryRestoreReceipt } from '../contracts/book-recovery'
import type { KickstartSnapshot } from '../contracts/generation'
import { isNoteWriteReceiptFor, type CreateNoteInput, type NoteDetail, type PromoteNoteInput, type SetNoteChaptersInput, type UpdateNoteInput } from '../contracts/notes'
import { ManuscriptEditor } from './components/ManuscriptEditor'
import { ChapterOutline } from './components/LibraryPanels'
import { StellarDesk } from './components/StellarDesk'
import { StellarShelf } from './components/StellarShelf'
import { BookOverview, BOOK_DESTINATIONS, type BookDestination } from './components/BookOverview'
import { StudioIcon } from './components/StudioIcon'
import { StellarTooltip } from './components/stellar/StellarTooltip'
import { StellarEmpty } from './components/stellar/StellarEmpty'
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
import { ModelConnectionsPanel } from './components/ModelConnectionsPanel'
import { TaskCenter, type StudioNotice, type TaskAiTarget } from './components/TaskCenter'
import { isTaskImageRun, isTaskVectorRun, taskStopOperation, type TaskStopResult, type TaskStopTarget } from './task-center'
import { CharacterComparison } from './components/CharacterComparison'
import { WeaveSystemPanel } from './components/WeaveSystemPanel'
import type { AiComposerPreset, AiPreset } from '../contracts/ai-presets'
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
import type { BookExportFileInput, BookExportReceipt } from '../contracts/export'
import { STUDIO_THEMES, STUDIO_THEME_META } from './display-preferences'
import { lastWritingBook, rememberWritingPosition, writingPosition, type WritingPosition } from './writing-location'
import { recentBookOpens, rememberBookOpen } from './recent-book-opens'
import { useChapterSession } from './hooks/useChapterSession'
import { useDraftProtection } from './hooks/useDraftProtection'
import { useDisplayPreferences } from './hooks/useDisplayPreferences'
import { useDrawerFocus } from './hooks/useDrawerFocus'
import type { PanelLeaveGuard } from './hooks/usePanelLeave'
import { displayTime, request, statusLabels } from './request'
import sharedStyles from './StellarShared.module.css'
import shellStyles from './StellarShell.module.css'

const styles = { ...sharedStyles, ...shellStyles }

interface Props { api?: StudioApi }
type ViewState = 'loading' | 'ready' | 'error'
type StudioSurface = 'home' | 'shelf' | 'book' | 'write'
type WorkspaceTool = 'knowledge' | 'galaxy' | 'timeline' | 'notes' | 'workbench' | 'calendar' | 'media' | 'living' | 'forge' | 'weave'
type WriteAsideMode = 'companion' | 'ai' | 'meta' | 'collapsed'
type Modal =
  | { kind: 'forge'; initialKind?: ForgeKind; personId?: string }
  | { kind: 'living'; tab?: 'outline' | 'memory'; initialId?: string }
  | { kind: 'knowledge'; initialKind?: KnowledgeKind; initialId?: string }
  | { kind: 'abilities' }
  | { kind: 'weave' }
  | { kind: 'ai'; initialInstruction?: string; initialPreset?: AiComposerPreset; initialTask?: AiTaskKind; initialRunId?: string; rewrite?: { firstBlockId: string; lastBlockId: string }; useLivingContext?: boolean; purpose?: 'review' | 'study'; resources?: CreativeResourceRef[] }
  | { kind: 'models' }
  | { kind: 'newBook' } | { kind: 'kickstart'; bookId?: string; genre?: string } | { kind: 'newChapter'; volumeId: string | null }
  | { kind: 'volume'; volumeId?: string } | { kind: 'bookDetails'; book: BookSummary }
  | { kind: 'chapterDetails' } | { kind: 'history' } | { kind: 'finalize' } | { kind: 'preferences' } | { kind: 'notes'; initialId?: string } | { kind: 'workbench'; tab?: 'review'; issueId?: string; reviewAction?: 'reply' | 'resolve' | 'reopen'; annotation?: { chapterId: string; blockIds: string[]; quote: string } } | { kind: 'inspiration' } | { kind: 'calendar' } | { kind: 'media'; scenePlaceId?: string; mapOffset?: number; initialRunId?: string }
  | { kind: 'import' } | { kind: 'export' } | { kind: 'orphans' } | { kind: 'recovery' } | { kind: 'bookRecovery' } | { kind: 'draftImport' } | { kind: 'story'; initialKind?: StoryKind; initialId?: string; initialCreate?: boolean } | { kind: 'timeline' } | { kind: 'galaxy'; view?: 'galaxy' | 'relationships' | 'world' | 'matrix' | 'radar'; initialPlaceId?: string; initialMapOffset?: number } | { kind: 'reader' } | { kind: 'memory'; initialTaskId?: string; initialVectorRunId?: string } | { kind: 'aiMemoryTasks'; initialTaskId?: string } | { kind: 'aiSummary'; initialTaskId?: string; initialPreset?: AiPreset } | null
interface DraftReceipt { bookId: string; chapterId: string; editSequence: number; loadEpoch: number; filePath: string }
interface AiWritingReceipt { root: string | null; previous: ChapterSnapshot; adoptedRevisionId: string; undone: boolean }

// 全画布一级视图集合：不再弹出遮罩模态框，而是直接平铺在主工作区画布中
const CANVAS_MODAL_KINDS = new Set<NonNullable<Modal>['kind']>([
  'workbench', 'knowledge', 'galaxy', 'timeline', 'story', 'notes',
  'inspiration', 'calendar', 'media', 'reader', 'memory', 'aiMemoryTasks', 'aiSummary', 'kickstart',
  'living', 'forge', 'preferences', 'models', 'abilities', 'weave', 'bookRecovery', 'export', 'history',
])

const SURFACE_TITLES: Record<string, { title: string; subtitle: string }> = {
  home: { title: '织章', subtitle: 'StoryWeave' },
  write: { title: '写作台', subtitle: '正文创作' },
  shelf: { title: '作品', subtitle: '作品书架' },
  book: { title: '作品', subtitle: '作品总览' },
  preferences: { title: '设置', subtitle: '外观与工作室' },
  models: { title: '设置', subtitle: '模型路由中心' },
  bookRecovery: { title: '设置', subtitle: '备份与恢复' },
  abilities: { title: '境界与战力', subtitle: '境界阶梯、人物战力与突破推演' },
  weave: { title: '织星系统', subtitle: '本书系统设定' },
  export: { title: '导出', subtitle: '将作品导出为多种格式，便于分享与发布' },
  history: { title: '版本历史', subtitle: '当前稿与历史稿对照' },
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
  calendar: { title: '创作数据', subtitle: '已保存版本的写作记录与创作日程' },
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
  const [taskCenterOpen, setTaskCenterOpen] = useState(false)
  const [seenNotices, setSeenNotices] = useState<Set<string>>(new Set())
  const [outlineOpen, setOutlineOpen] = useState<boolean | null>(null)
  const [companionOpen, setCompanionOpen] = useState(false)
  const [writeAsideMode, setWriteAsideMode] = useState<WriteAsideMode>('ai')
  const [aiWideMode, setAiWideMode] = useState(false)
  const [returnLocation, setReturnLocation] = useState<{ root: string; bookId: string; chapterId: string; blockId?: string; offset?: number; scrollTop?: number } | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>({ rootPath: null, books: [] })
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const [book, setBook] = useState<BookSnapshot | null>(null)
  const bookRef = useRef<BookSnapshot | null>(null)
  const [messageState, setMessageState] = useState<{ text: string; tone: 'warning' | 'success' } | null>(null)
  const message = messageState?.text ?? null
  const setMessage = useCallback((text: string | null) => setMessageState(text === null ? null : { text, tone: 'warning' }), [])
  const [modal, setModal] = useState<Modal>(null)
  const [exportReceipt, setExportReceipt] = useState<BookExportReceipt | null>(null)
  const aiInstruction = modal?.kind === 'ai' ? modal.initialInstruction : undefined
  const aiRewrite = modal?.kind === 'ai' ? modal.rewrite : undefined
  const aiPreset = modal?.kind === 'ai' ? modal.initialPreset : undefined
  const aiTask = modal?.kind === 'ai' ? modal.initialTask : undefined
  const aiLivingContext = modal?.kind === 'ai' ? modal.useLivingContext : undefined
  const aiResources = modal?.kind === 'ai' ? modal.resources : undefined
  const aiResourceKey = aiResources?.map((ref) => `${ref.source}:${ref.id}:${ref.revision}`).join(',') ?? ''
  const [busy, setBusy] = useState(false)
  const transition = useRef(false)
  const closeLocked = useRef(false)
  const pendingMutation = useRef<
    { requestId?: string; receive: (response: CompletedRequest) => Promise<boolean> }
    | { requestId?: never; read: () => Promise<boolean> } | null
  >(null)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [checkingReceipt, setCheckingReceipt] = useState(false)
  const receiptCheck = useRef(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const recoveryLock = useRef(false)
  const [draftReceipt, setDraftReceipt] = useState<DraftReceipt | null>(null)
  const [aiWritingReceipt, setAiWritingReceipt] = useState<AiWritingReceipt | null>(null)
  const [focused, setFocused] = useState(false)
  const knowledgeDirty = useRef(false)
  const storyDirty = useRef(false)
  const notesDirty = useRef(false)
  const workbenchDirty = useRef(false)
  const inspirationDirty = useRef(false)
  const auxiliaryDirty = useRef(false)
  const panelLeaveGuard = useRef<PanelLeaveGuard | null>(null)
  const registerPanelLeaveGuard = useCallback((guard: PanelLeaveGuard | null) => {
    panelLeaveGuard.current = guard
  }, [])
  const aiDrawerClose = useRef<(() => void) | null>(null)
  const registerAiDrawerClose = useCallback((close: (() => void) | null) => {
    aiDrawerClose.current = close
  }, [])
  const manuscriptScroll = useRef<HTMLElement>(null)
  const outlineDrawer = useRef<HTMLDivElement>(null)
  const chapterToolsTrigger = useRef<HTMLElement>(null)
  const inspectorDrawer = useRef<HTMLElement>(null)
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

  function recordBookOpen(origin: WorkspaceSnapshot, bookId: string) {
    if (origin.rootPath !== workspaceRef.current.rootPath || origin.recoveryScope !== workspaceRef.current.recoveryScope) return
    rememberBookOpen(origin, bookId)
  }

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
  const storageReason = session.session.error?.code === 'STORAGE_ERROR'
    && (session.session.error.storageReason === 'disk-full' || session.session.error.storageReason === 'database-full')
    ? session.session.error.storageReason : undefined
  const baseStudioView = surface === 'write' && book ? 'write' : surface === 'book' && book ? 'book' : surface === 'shelf' && workspace.rootPath ? 'shelf' : 'home'

  // 判断当前 modal 是否为内嵌在主画布的全屏视图，还是传统的遮罩弹窗
  const isAiInWriteDrawer = baseStudioView === 'write' && !aiWideMode
    && (modal?.kind === 'ai' || !modal && writeAsideMode === 'ai')
  const inspectorRequested = companionOpen || isAiInWriteDrawer && modal?.kind === 'ai'
  const isCanvasView = Boolean(
    modal && (CANVAS_MODAL_KINDS.has(modal.kind) || (modal.kind === 'ai' && !isAiInWriteDrawer)),
  )
  const hasBlockingDialog = Boolean(modal && !isCanvasView && !isAiInWriteDrawer)
  const studioView = baseStudioView
  const drawerActive = studioView === 'write' && !isCanvasView && !hasBlockingDialog && !commandOpen && !taskCenterOpen && !focused
  useDrawerFocus(outlineDrawer, drawerActive && outlineOpen === true && !inspectorRequested, () => setOutlineOpen(false), '', chapterToolsTrigger)
  useDrawerFocus(inspectorDrawer, drawerActive && inspectorRequested, closeInspector, isAiInWriteDrawer ? 'ai' : 'companion')

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
    if (panelLeaveGuard.current && !await panelLeaveGuard.current('navigation')) return
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
    flushSync(() => {
      setBusy(true); setNavigationOpen(false)
      if (outlineDrawer.current && getComputedStyle(outlineDrawer.current).position === 'absolute') setOutlineOpen(false)
    })
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
    receiptCheck.current = true; setCheckingReceipt(true)
    try {
      if ('read' in pending) {
        if (!await pending.read()) return
      } else {
        if (!pending.requestId) { setPendingMessage('操作结果无法确认，请先另存草稿。服务退出后可重新连接并核对作品和目录。'); return }
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
      }
      pendingMutation.current = null; setPendingMessage(null); transition.current = false; setBusy(false)
    } catch { setPendingMessage('回执处理未完成，当前内容已保留，请稍后重试核对。') }
    finally { receiptCheck.current = false; setCheckingReceipt(false) }
  }

  async function stopCenterTask(target: TaskStopTarget): Promise<TaskStopResult> {
    const bookId = target.kind === 'image' ? target.bookId : target.task.bookId
    if (!api || transition.current || recoveryLock.current || bookRecoveryDirty.current || bookRef.current?.book.id !== bookId) return { confirmed: false, message: '当前作品或操作已变化，请重新读取后再停止。' }
    const root = workspaceRef.current.rootPath, scope = workspaceRef.current.recoveryScope
    const current = () => workspaceRef.current.rootPath === root && workspaceRef.current.recoveryScope === scope && bookRef.current?.book.id === bookId
    if (target.kind === 'image') return stopCenterImage(target, current)
    if (target.kind === 'vector') return stopCenterVector(target, current)
    const operation = taskStopOperation(api, target)
    const receive = async (response: CompletedRequest): Promise<boolean> => {
      if (!current() || !operation.commands.includes(response.command)) return false
      // 取消生成可能等待原 checkpoint／finish；只回读终态，不把阶段回执当成已停止，也不重发取消。
      if (operation.read) {
        const read = await request(operation.read)
        if (!current() || !read.ok || !operation.accept(read.data)) return false
      } else {
        if (!response.result.ok) { setMessage(response.result.error.message); return true }
        if (!operation.accept(response.result.data)) return false
      }
      setMessage('任务状态已确认，请刷新记录核对。')
      return true
    }
    transition.current = true
    setBusy(true); setMessage(null)
    try {
      const result = await request(operation.send)
      if (!current()) return { confirmed: false, message: '作品库或恢复会话已变化，请核对原任务。' }
      if (result.ok) {
        if (operation.accept(result.data)) { setMessage('任务状态已确认。'); return { confirmed: true, message: '任务状态已确认。' } }
        holdUnconfirmed({ code: 'SERVICE_UNAVAILABLE', message: '停止回执与原任务不符。' }, receive, true)
        return { confirmed: false, message: '停止回执与原任务不符，请保留当前内容并核对结果。' }
      } else {
        setMessage(result.error.message)
        holdUnconfirmed(result.error, receive, true)
        return { confirmed: false, message: result.error.message }
      }
    } catch {
      if (current()) holdUnconfirmed({ code: 'SERVICE_UNAVAILABLE', message: '停止结果尚未确认。' }, receive, true)
      return { confirmed: false, message: '停止结果尚未确认，请核对原回执。' }
    } finally {
      if (!pendingMutation.current) { transition.current = false; setBusy(false) }
    }
  }

  async function stopCenterImage(target: Extract<TaskStopTarget, { kind: 'image' }>, current: () => boolean): Promise<TaskStopResult> {
    if (!api) return { confirmed: false, message: '桌面桥接未加载，未发送停止请求。' }
    const { bookId, task } = target, input = { bookId, runId: task.runId }
    transition.current = true; setBusy(true); setMessage(null)
    try {
      const original = await request(() => api.getImageGeneration(input))
      if (!current() || !original.ok) return { confirmed: false, message: original.ok ? '作品库或恢复会话已变化，未发送停止请求。' : original.error.message }
      if (!isTaskImageRun(original.data, bookId, task)) return { confirmed: false, message: '原图片任务身份与列表不符，未发送停止请求。请刷新后核对。' }
      if (original.data.state !== 'running') return { confirmed: true, message: '原图片任务已有终态，未重复停止。' }
      // 图片命令没有 service 请求回执；只保留原输入与摘要，失联后按原编号核对终态。
      const fixedInput = JSON.stringify(original.data.input), contextHash = original.data.contextHash
      const accept = (value: unknown) => isTaskImageRun(value, bookId, task) && value.contextHash === contextHash &&
        JSON.stringify(value.input) === fixedInput && value.state !== 'running'
      const pending = { read: async () => {
        const result = await request(() => api.getImageGeneration(input))
        if (!current()) { setPendingMessage('图片停止的作品库或恢复会话已变化，请保留原任务并进入恢复核对。'); return false }
        if (!result.ok) { setPendingMessage(`图片停止结果尚未确认：${result.error.message} 请查询原回执，不会重发取消。`); return false }
        if (!accept(result.data)) { setPendingMessage('图片仍在生成，或原任务身份／终态尚未核对。请稍后查询原回执，不会重发取消。'); return false }
        setMessage('原图片任务终态已确认；可从任务中心查看结果。')
        return true
      } }
      // 发送前留存只读核对入口，关闭抽屉也不会丢失这次停止的身份。
      pendingMutation.current = pending
      const result = await request(() => api.cancelImageGeneration(input))
      if (!current()) { setPendingMessage('图片停止的作品库或恢复会话已变化，请保留原任务并进入恢复核对。'); return { confirmed: false, message: '请核对原图片任务。' } }
      if (!result.ok && !['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'STORAGE_ERROR'].includes(result.error.code)) {
        pendingMutation.current = null
        return { confirmed: false, message: result.error.message }
      }
      if ((result.ok && accept(result.data)) || await pending.read()) {
        pendingMutation.current = null; setPendingMessage(null)
        return { confirmed: true, message: '原图片任务终态已确认。' }
      }
      return { confirmed: false, message: '停止结果尚未确认，请查询原回执。' }
    } catch {
      if (pendingMutation.current) setPendingMessage('图片停止结果尚未确认，请查询原回执或进入恢复；不会自动重发。')
      return { confirmed: false, message: '图片操作未完成，请核对原任务。' }
    } finally {
      if (!pendingMutation.current) { transition.current = false; setBusy(false) }
    }
  }

  async function stopCenterVector(target: Extract<TaskStopTarget, { kind: 'vector' }>, current: () => boolean): Promise<TaskStopResult> {
    if (!api) return { confirmed: false, message: '桌面桥接未加载，未发送停止请求。' }
    const { task } = target, input = { bookId: task.bookId, runId: task.id }
    transition.current = true; setBusy(true); setMessage(null)
    try {
      const original = await request(() => api.getMemoryVectorRun(input))
      if (!current() || !original.ok) return { confirmed: false, message: original.ok ? '作品库或恢复会话已变化，未发送停止请求。' : original.error.message }
      if (!isTaskVectorRun(original.data, task) || original.data.version < task.version) {
        return { confirmed: false, message: '原向量任务身份或版本与列表不符，未发送停止请求。' }
      }
      const before = original.data
      if (before.state !== 'prepared' && before.state !== 'running') return { confirmed: true, message: '原向量任务已有终态，未重复停止。' }
      // 确认时的“取消网络”和“中断孤立记录”不能在回读后悄悄互换。
      if (before.version !== task.version || before.state !== task.state || typeof before.active !== 'boolean' || before.active !== task.active) {
        return { confirmed: false, message: '向量任务版本或本机请求状态已变化，请刷新后重新确认。' }
      }
      const fixedContext = JSON.stringify(before.context)
      const accept = (value: unknown) => isTaskVectorRun(value, task) && JSON.stringify(value.context) === fixedContext &&
        value.version > before.version && value.state !== 'prepared' && value.state !== 'running'
      const pending = { read: async () => {
        const result = await request(() => api.getMemoryVectorRun(input))
        if (!current()) { setPendingMessage('向量停止的书库或恢复会话已变化，请进入恢复核对原任务。'); return false }
        if (!result.ok) { setPendingMessage(`向量停止结果尚未确认：${result.error.message} 请继续核对原任务。`); return false }
        if (!accept(result.data)) { setPendingMessage('原向量任务身份或终态尚未确认，请稍后核对；不会重发停止操作。'); return false }
        setMessage('原向量任务终态已确认；可从任务中心查看记录。')
        return true
      } }
      // 发送前固定身份与上下文；未知结果只回读原任务，关闭抽屉也保留入口。
      pendingMutation.current = pending
      const interrupt = before.state === 'running' && !before.active
      const result = await request(() => (interrupt ? api.interruptMemoryVectorRun : api.cancelMemoryVectorRun)({
        ...input, expectedVersion: before.version,
      }))
      if (!current()) { setPendingMessage('向量停止的书库或恢复会话已变化，请进入恢复核对原任务。'); return { confirmed: false, message: '请核对原向量任务。' } }
      if (!result.ok && !result.error.requestId && !['REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'STORAGE_ERROR'].includes(result.error.code)) {
        pendingMutation.current = null
        return { confirmed: false, message: result.error.message }
      }
      if ((result.ok && accept(result.data)) || await pending.read()) {
        pendingMutation.current = null; setPendingMessage(null)
        return { confirmed: true, message: '原向量任务终态已确认。' }
      }
      return { confirmed: false, message: '向量停止结果尚未确认，请核对原任务。' }
    } catch {
      if (pendingMutation.current) setPendingMessage('向量停止结果尚未确认，请核对原任务或进入恢复；不会自动重发。')
      return { confirmed: false, message: '向量操作未完成，请核对原任务。' }
    } finally {
      if (!pendingMutation.current) { transition.current = false; setBusy(false) }
    }
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

  async function openWorkspace(next?: 'kickstart' | 'import', genre?: string) {
    if (!api) return
    await changeView(async () => {
      await mutate('workspace.open', () => api.selectWorkspace(), (snapshot) => {
        session.load(null); setWorkspace(snapshot); updateCurrentBook(null); setViewState('ready'); setSurface('home'); setFocused(false)
        setReturnLocation(null)
        setModal(snapshot.rootPath && next ? next === 'kickstart' ? { kind: next, genre } : { kind: next } : null)
      })
    })
  }

  async function openBook(bookId: string, chapterId?: string) {
    if (!api) return
    await changeView(async () => {
      const origin = workspaceRef.current
      const result = await request(() => api.getBook({ bookId }))
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.book.id !== bookId) { setMessage('返回的作品与所选作品不一致，请重新打开。'); return }
      if (result.data.book.lifecycle === 'kickstarting') {
        session.load(null); updateCurrentBook(null); upsertShelf(result.data.book); setReturnLocation(null)
        setModal({ kind: 'kickstart', bookId }); recordBookOpen(origin, bookId); return
      }
      const last = writingPosition(workspaceRef.current.rootPath, bookId)
      const targetChapter = chapterId ? result.data.chapters.find((item) => item.id === chapterId)
        : result.data.chapters.find((item) => item.id === last?.chapterId) ?? result.data.chapters[0]
      if (chapterId && !targetChapter) { setMessage('所选章节已不在作品目录中，请刷新工作台后重试。'); return }
      const current = session.getCurrent().chapter
      if (current?.bookId !== bookId) setReturnLocation(null)
      // 同一章且目录版本未变化时只恢复页面，保留正文选区和撤销栈。
      if (current?.bookId === bookId && current.id === targetChapter?.id && current.revisionId === targetChapter.revisionId && current.bookRevision === result.data.book.revision) {
        updateCurrentBook(result.data); upsertShelf(result.data.book); setModal(null); setSurface('write'); recordBookOpen(origin, bookId); return
      }
      let first: ChapterSnapshot | null = null
      if (targetChapter) {
        const read = await request(() => api.readChapter({ bookId, chapterId: targetChapter.id }))
        if (!read.ok) { setMessage(read.error.message); return }
        if (read.data.bookId !== bookId || read.data.id !== targetChapter.id) { setMessage('返回的正文与所选章节不一致，请重新打开。'); return }
        first = read.data
      }
      session.load(first); updateCurrentBook(result.data); upsertShelf(result.data.book); setModal(null); setSurface('write')
      recordBookOpen(origin, bookId)
    })
  }

  async function openChapter(chapterId: string) {
    if (!bookRef.current) return
    // 创作面板也使用本入口；复用完整开章流程，同章返回时保留编辑实例并切回正文画布。
    await openBook(bookRef.current.book.id, chapterId)
  }

  async function openSavedNote(bookId: string, noteId: string) {
    if (!api) return
    await changeView(async () => {
      const origin = workspaceRef.current
      const result = await request(() => api.getBook({ bookId }))
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.book.id !== bookId || bookRef.current?.book.id === bookId && bookRef.current.book.revision > result.data.book.revision) {
        setMessage('目标作品身份或版本与当前目录不符，请重新读取后再查看素材。'); return
      }
      if (session.getCurrent().chapter?.bookId !== bookId) { session.load(null); setReturnLocation(null) }
      upsertShelf(result.data.book); updateCurrentBook(result.data); setSurface('book')
      setModal({ kind: 'notes', initialId: noteId })
      recordBookOpen(origin, bookId)
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

  async function openBookOverview(bookId: string) {
    if (!api) return
    await changeView(async () => {
      const origin = workspaceRef.current
      const result = await request(() => api.getBook({ bookId }))
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.book.id !== bookId) { setMessage('作品身份不匹配，请重新打开。'); return }
      if (result.data.book.lifecycle === 'kickstarting') {
        session.load(null); updateCurrentBook(null); setReturnLocation(null)
        setModal({ kind: 'kickstart', bookId }); recordBookOpen(origin, bookId); return
      }
      // 总览只切换呈现；同书正文实例留在原位置，保留撤销栈与光标。
      if (bookRef.current?.book.id !== bookId) { session.load(null); setReturnLocation(null) }
      updateCurrentBook(result.data); upsertShelf(result.data.book); setSurface('book'); setModal(null); setFocused(false)
      recordBookOpen(origin, bookId)
    })
  }

  function navigateBook(destination: BookDestination, targetId?: string) {
    if (!book) return
    if (destination === 'write') { resumeWriting(); return }
    if (destination === 'bookDetails') { showDialog({ kind: 'bookDetails', book: book.book }); return }
    if (destination === 'world') { showDialog({ kind: 'galaxy', view: 'world' }); return }
    if (destination === 'living' && targetId) { showDialog({ kind: 'living', initialId: targetId }); return }
    if (destination === 'workbench' && targetId) {
      if (!api || !book.chapters.some((item) => item.id === targetId)) return
      const bookId = book.book.id
      void changeView(async () => {
        const result = await request(() => api.readChapter({ bookId, chapterId: targetId }))
        if (!result.ok) { setMessage(result.error.message); return }
        if (result.data.bookId !== bookId || result.data.id !== targetId || result.data.bookRevision !== bookRef.current?.book.revision) {
          setMessage('待办对应章节或作品版本已变化，请刷新总览后重新核对。'); return
        }
        // 待办显式指定审稿章节，避免沿用上次写作章节准备另一章的审稿。
        if (session.getCurrent().chapter?.revisionId !== result.data.revisionId) session.load(result.data)
        setModal({ kind: 'workbench', tab: 'review' })
      })
      return
    }
    showDialog({ kind: destination })
  }

  function startBook(kind: 'newBook' | 'import', genre?: string) {
    const target = kind === 'newBook' ? 'kickstart' : 'import'
    if (workspace.rootPath) showDialog(target === 'kickstart' ? { kind: target, genre } : { kind: target })
    else void openWorkspace(target, genre)
  }

  async function enterKickstart(snapshot: KickstartSnapshot): Promise<boolean> {
    if (!api || !snapshot.adoption || transition.current || recoveryLock.current) return false
    transition.current = true; setBusy(true)
    const origin = workspaceRef.current
    const root = workspaceRef.current.rootPath, bookId = snapshot.book.book.id, chapterId = snapshot.adoption.firstChapterId
    try {
      const read = await request(() => api.readChapter({ bookId, chapterId }))
      if (!read.ok) { setMessage(read.error.message); return false }
      if (workspaceRef.current.rootPath !== root || read.data.bookId !== bookId || read.data.id !== chapterId || read.data.bookRevision !== snapshot.book.book.revision) {
        setMessage('首章或作品版本已变化，请从书架重新打开。'); return false
      }
      auxiliaryDirty.current = false
      applyBook(snapshot.book, true); session.load(read.data); setModal(null); setSurface('write'); setMessage(null)
      recordBookOpen(origin, bookId)
      return true
    } finally { transition.current = false; setBusy(false) }
  }

  async function openWorkspaceTool(bookId: string, kind: WorkspaceTool) {
    if (!api) return
    await changeView(async () => {
      const origin = workspaceRef.current
      // 工具只需要作品目录。跨作品时等新目录读取成功后再释放旧章节。
      if (bookRef.current?.book.id !== bookId) {
        const result = await request(() => api.getBook({ bookId }))
        if (!result.ok) { setMessage(result.error.message); return }
        if (result.data.book.id !== bookId) { setMessage('返回的作品与所选作品不一致，请重新打开。'); return }
        session.load(null); updateCurrentBook(result.data); upsertShelf(result.data.book)
      }
      setModal({ kind })
      recordBookOpen(origin, bookId)
    })
  }

  function openToolFromNav(kind: WorkspaceTool) {
    if (book) showDialog({ kind })
    else if (featuredBook) void openWorkspaceTool(featuredBook.id, kind)
    else startBook('newBook')
  }

  function useForeshadow(ref: CreativeResourceRef) {
    if (!chapter || !book || archived) { setMessage('请先打开可编辑章节，再选择本章的待回收伏笔。'); return }
    showDialog({ kind: 'ai', resources: [ref] })
  }
  function useStudyMaterials(chapterId: string, refs: CreativeResourceRef[]) {
    if (!api || !book || archived || !book.chapters.some((item) => item.id === chapterId) || !refs.length || refs.some((ref) => ref.source !== 'inspiration')) return
    const bookId = book.book.id
    void changeView(async () => {
      const result = await request(() => api.readChapter({ bookId, chapterId }))
      if (!result.ok) { setMessage(result.error.message); return }
      if (result.data.bookId !== bookId || result.data.id !== chapterId || result.data.bookRevision !== bookRef.current?.book.revision) {
        setMessage('目标章节或作品版本已变化，请重新读取后选择。'); return
      }
      // 只准备目标章的手选方法和创作要求；生成仍要经过固定预览和作者明确发送。
      session.load(result.data); setSurface('write'); setWriteAsideMode('ai')
      setModal({ kind: 'ai', initialTask: 'plan', resources: refs, initialInstruction: '请借用所选方法的抽象结构，为本章设计场景节拍。使用本书人物、地点与设定，不复制参考原文；资料不足处明确标注待确认。' })
    })
  }
  function openReviewChecklist(issueId?: string) { showDialog({ kind: 'workbench', tab: 'review', issueId }) }

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
      if (next.kind === 'export') setExportReceipt(null)
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
        if (next.kind === 'ai') {
          const currentBook = bookRef.current
          if (!api || !currentBook) { setMessage('请先打开作品，再进入 AI 协作。'); return }
          const currentChapter = session.getCurrent().chapter
          if (!currentChapter || currentChapter.bookId !== currentBook.book.id) {
            const first = currentBook.chapters[0]
            if (!first) { setMessage('请先建立章节，再进入 AI 协作。'); return }
            const result = await request(() => api.readChapter({ bookId: currentBook.book.id, chapterId: first.id }))
            if (!result.ok) { setMessage(result.error.message); return }
            if (result.data.bookId !== currentBook.book.id || result.data.id !== first.id) { setMessage('章节身份不符，请重新打开作品。'); return }
            session.load(result.data)
          }
        }
        if (next.kind === 'ai' && surface === 'write') {
          setAiWideMode(false)
          setWriteAsideMode('ai')
          setCompanionOpen(false)
        }
        setModal(next)
      }
    })
  }

  function switchWriteAside(next: WriteAsideMode | 'review') {
    if (next === 'ai' || next === 'review') {
      showDialog({ kind: 'ai', ...(next === 'review' ? { purpose: 'review' as const } : {}) })
      return
    }
    void changeView(async () => { setModal(null); setCompanionOpen(next === 'companion'); setWriteAsideMode(next) })
  }

  function closeInspector() {
    if (isAiInWriteDrawer) aiDrawerClose.current?.()
    else switchWriteAside('collapsed')
  }

  function openBookAi(initialPreset?: AiPreset, target?: TaskAiTarget) {
    if (!api || !book) return
    if (initialPreset?.kind === 'summarize') { showDialog({ kind: 'aiSummary', initialPreset }); return }
    const composerPreset: AiComposerPreset | undefined = initialPreset ? { ...initialPreset, kind: initialPreset.kind } : undefined
    void changeView(async () => {
      if (target || !session.getCurrent().chapter || session.getCurrent().chapter?.bookId !== book.book.id) {
        const first = target ? book.chapters.find((item) => item.id === target.chapterId) : book.chapters[0]
        if (target && !first) { setMessage('任务对应章节已不在当前目录中，请刷新作品后核对。'); return }
        if (!first) { setMessage('请先为这部作品建立章节，再配置书内协作。'); return }
        const result = await request(() => api.readChapter({ bookId: book.book.id, chapterId: first.id }))
        if (!result.ok) { setMessage(result.error.message); return }
        if (result.data.bookId !== book.book.id || result.data.id !== first.id) { setMessage('章节身份不匹配，请重新打开。'); return }
        // 任务切章也先经过 changeView 保存门禁，再核对固定章节身份。
        if (session.getCurrent().chapter?.id !== first.id || session.getCurrent().chapter?.revisionId !== result.data.revisionId) session.load(result.data)
      }
      setSurface('write'); setAiWideMode(true); setWriteAsideMode('ai'); setCompanionOpen(false); setModal({ kind: 'ai', initialPreset: composerPreset, initialRunId: target?.runId })
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
      await mutate('import.commit', () => api.commitTextImport({ token, title }), (snapshot) => { applyBook(snapshot, true); setModal(null); setMessageState({ text: '导入完成。请选择目录中的章节开始检查与编辑。', tone: 'success' }) })
    }, false, false, false, true)
  }

  async function commitDraftImport(token: string, title: string) {
    if (!api || !workspace.recoveryScope) return
    const scope = workspace.recoveryScope
    await changeView(async () => {
      await mutate('draft.import', () => api.commitDraftImport({ scope, token, title }), async (saved) => {
        await acceptChapter(saved, true)
        setMessageState({ text: '草稿已恢复为新章节，原章和原始副本已保留。请核对新章正文与来源记录。', tone: 'success' })
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
      await mutate('knowledge.update', () => api.updateKnowledgeItem(input), (saved) => {
        const current = bookRef.current
        if (input.adjudication && (!isKnowledgeAdjudicationReceiptFor(input, saved) ||
            current?.book.id !== input.bookId || current.book.revision > saved.bookRevision)) return false
        return acceptKnowledge(saved, accept)
      })
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

  async function writeNote(command: 'notes.create' | 'notes.update' | 'notes.promote' | 'notes.chapters', input: CreateNoteInput | UpdateNoteInput | PromoteNoteInput | SetNoteChaptersInput,
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

  async function createStory(input: CreateStoryRecordInput, accept: (saved: StoryRecordDetail) => boolean) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('story.create', () => api.createStoryRecord(input), (saved) => {
        if (!accept(saved)) return false
        return acceptKnowledge(saved, () => {})
      })
    }, false, false, false, true)
  }

  async function updateStory(input: UpdateStoryRecordInput, accept: (saved: StoryRecordDetail) => boolean) {
    if (!api || bookRef.current?.book.id !== input.bookId) return
    await changeView(async () => {
      await mutate('story.update', () => api.updateStoryRecord(input), (saved) => {
        if (!accept(saved)) return false
        return acceptKnowledge(saved, () => {})
      })
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
      const previous = session.getCurrent().chapter
      if (!previous || previous.bookId !== input.bookId || previous.id !== source.chapterId || previous.revisionId !== source.context.chapterRevisionId) {
        setMessage('正文版本已变化，请保留提议并按当前正文重新预览。'); return
      }
      const root = workspaceRef.current.rootPath
      await mutate('ai.adopt', () => api.adoptAiRun(input), async (saved) => {
        if (!isAiAdoptReceiptFor(input, source, saved)) { setMessage('采用回执与固定提议不符，请保留改稿并核对记录。'); return false }
        if (!accept(saved)) return false
        // 采用回执推进正文与目录版本；候选面板继续保留原输出和采用记录。
        onSaved(saved.chapter); session.load(saved.chapter); setMessage(null)
        setAiWritingReceipt(source.kind === 'plan' ? null : { root, previous, adoptedRevisionId: saved.chapter.revisionId, undone: false })
        await refreshCurrentBook(saved.bookId)
      })
    }, false, false, false, true)
  }

  async function undoAiWriting() {
    const receipt = aiWritingReceipt
    const current = session.getCurrent()
    if (!api || !receipt || receipt.undone || receipt.root !== workspaceRef.current.rootPath || current.dirty || current.composing ||
      current.chapter?.bookId !== receipt.previous.bookId || current.chapter.id !== receipt.previous.id || current.chapter.revisionId !== receipt.adoptedRevisionId) return
    await changeView(async () => {
      const latest = session.getCurrent().chapter
      // 仅撤销尚未被继续编辑的采用版本；CAS 同时保护其他窗口刚保存的新稿。
      if (!latest || latest.bookId !== receipt.previous.bookId || latest.id !== receipt.previous.id || latest.revisionId !== receipt.adoptedRevisionId || bookRef.current?.book.archivedAt) return
      await mutate('revision.restore', () => api.restoreRevision({ bookId: latest.bookId, chapterId: latest.id,
        revisionId: receipt.previous.revisionId, expectedRevisionId: receipt.adoptedRevisionId }), async (saved) => {
        if (saved.bookId !== latest.bookId || saved.id !== latest.id || saved.revisionId === receipt.adoptedRevisionId ||
          JSON.stringify(saved.document) !== JSON.stringify(receipt.previous.document)) return false
        onSaved(saved); session.load(saved); setAiWritingReceipt({ ...receipt, undone: true }); setMessage(null)
        await refreshCurrentBook(saved.bookId)
        return true
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

  async function exportBook(input: BookExportFileInput) {
    if (!api) return
    await changeView(async () => {
      const current = bookRef.current
      if (!current) return
      if (input.bookId !== current.book.id || input.expectedBookRevision !== current.book.revision) { setMessage('作品已更新，请重新生成导出预览。'); return }
      await mutate('book.export.commit', () => api.commitBookExport(input), (receipt) => {
        if (receipt.bookId !== input.bookId || receipt.bookRevision !== input.expectedBookRevision || receipt.exportId !== input.token || receipt.manifestHash !== input.manifestHash) return false
        setExportReceipt(receipt); setMessage(null)
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
    const onFocusShortcut = (event: KeyboardEvent) => {
      const exiting = event.key === 'Escape'
      if (exiting) {
        if (document.querySelector('[data-stellar-tooltip]:popover-open, [data-reader-annotation][open]')) return
        if (!focused || document.querySelector('[aria-label="选区 AI 改写"], section[aria-label="当前章节查找与替换"]') || (event.target instanceof Element && event.target.closest('details[open]'))) return
      } else if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key !== 'Enter') return
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || session.isComposing()) return
      if (!exiting && (busy || transition.current || recoveryLock.current)) return
      if (studioView !== 'write' || isCanvasView || hasBlockingDialog || navigationOpen || taskCenterOpen || commandOpen || !chapter || document.querySelector('dialog[open]')) return
      // 专注快捷键先于编辑器键位执行，防止被换行命令消费或修改正文。
      event.preventDefault()
      if (!event.repeat) setFocused((value) => exiting ? false : !value)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (document.querySelector('dialog[open]')) return
      if (taskCenterOpen) return
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
    }
    window.addEventListener('keydown', onFocusShortcut, true)
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onFocusShortcut, true); window.removeEventListener('keydown', onKeyDown) }
  }, [session.flush, session.isComposing, isCanvasView, hasBlockingDialog, modal?.kind, navigationOpen, busy, chapter, focused, studioView, commandOpen, taskCenterOpen])

  useEffect(() => { if (!chapter) setFocused(false) }, [chapter])

  useEffect(() => {
    if (!api) return
    const cancelClose = api.onCloseCancelled(() => {
      if (!closeLocked.current) return
      closeLocked.current = false; transition.current = false; setBusy(false)
    })
    const requestClose = api.onCloseRequested(async () => {
      if (transition.current || recoveryLock.current || session.isComposing()) return false
      if (panelLeaveGuard.current && !await panelLeaveGuard.current('window')) return false
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
  // 已确认完成的工作室提示单独呈现，不作为各业务面板的错误回传。
  const modalError = (messageState?.tone === 'success' ? null : message) ?? session.session.error?.message
  const detailsRecovery = pendingMessage ? { message: pendingMessage, checking: checkingReceipt,
    onCheck: () => void checkMutationReceipt(), onRecover: () => openRecovery(true) } : undefined
  const closeModal = async () => {
    if (recoveryLock.current) return
    if (panelLeaveGuard.current && !await panelLeaveGuard.current('navigation')) return
    if (recoveryLock.current) return
    if ((modal?.kind === 'bookDetails' || modal?.kind === 'chapterDetails' || modal?.kind === 'newBook') && detailsDirty.current) { setDetailsCloseRequested(true); return }
    if (modal?.kind === 'knowledge' && knowledgeDirty.current) return
    if (modal?.kind === 'story' && storyDirty.current) return
    if (modal?.kind === 'notes' && notesDirty.current) return
    if ((modal?.kind === 'workbench' || modal?.kind === 'living' || modal?.kind === 'forge') && workbenchDirty.current) {
      setMessage('创作工具有未保存修改或待核对请求，请先在面板内保存、明确放弃或核对回执后再返回。'); return
    }
    if (modal?.kind === 'inspiration' && inspirationDirty.current) return
    if ((modal?.kind === 'calendar' || modal?.kind === 'galaxy' || modal?.kind === 'media' || modal?.kind === 'kickstart' || modal?.kind === 'models' || modal?.kind === 'weave') && auxiliaryDirty.current) return
    if (modal?.kind === 'memory' && memoryWorking.current) return
    if ((isAiInWriteDrawer || modal?.kind === 'ai' || modal?.kind === 'aiMemoryTasks' || modal?.kind === 'aiSummary') && aiDirty.current) {
      setMessage('AI 面板仍有未确认请求或未保存修改，请先在面板内处理。'); return
    }
    if (modal?.kind === 'bookRecovery' && bookRecoveryDirty.current) return
    if (modal?.kind === 'recovery') session.pauseAutoSave(false)
    if (modal?.kind === 'recovery' && bookRecoveryDirty.current) { setModal({ kind: 'bookRecovery' }); setMessage(null); return }
    if (!pendingMutation.current) {
      if (isAiInWriteDrawer) setWriteAsideMode('collapsed')
      setModal(null); setMessage(null)
    }
    else if (modal?.kind === 'recovery') setModal(null)
  }

  const activeCanvasKey = isCanvasView && modal ? modal.kind : studioView
  const worldMapVisible = isCanvasView && modal?.kind === 'galaxy' && modal.view === 'world'
  const matrixVisible = isCanvasView && modal?.kind === 'galaxy' && modal.view === 'matrix'
  const bookMediaVisible = isCanvasView && modal?.kind === 'media' && modal.scenePlaceId === undefined
  const bookToolsVisible = Boolean(book && modal?.kind !== 'preferences' && modal?.kind !== 'models' && modal?.kind !== 'bookRecovery' && (studioView === 'book' || isCanvasView))
  const headerInfo = worldMapVisible ? { title: '世界星域地图', subtitle: '世界地点与已登记航道' }
    : matrixVisible ? { title: '章节出场矩阵', subtitle: '实体与章节的已登记出场' }
    : modal?.kind === 'media' && modal.scenePlaceId ? { title: '地点场景图', subtitle: '地点关联与图片版本' }
    : SURFACE_TITLES[activeCanvasKey] ?? SURFACE_TITLES.home

  const primaryNav = [
    { id: 'home', label: '书桌', icon: 'home' as const, active: !isCanvasView && studioView === 'home', run: () => void showHome() },
    { id: 'shelf', label: '作品', icon: 'books' as const, active: (!isCanvasView && studioView !== 'home') || Boolean(book && isCanvasView && !['inspiration', 'notes', 'calendar', 'preferences', 'models'].includes(modal!.kind)), run: () => workspace.rootPath ? void showShelf() : void openWorkspace() },
    { id: 'inspiration', label: '拆书', icon: 'layers' as const, active: modal?.kind === 'inspiration', run: () => workspace.rootPath ? showDialog({ kind: 'inspiration' }) : void openWorkspace() },
    { id: 'notes', label: '灵感', icon: 'notes' as const, active: modal?.kind === 'notes', run: () => openToolFromNav('notes') },
    { id: 'calendar', label: '统计', icon: 'chart' as const, active: modal?.kind === 'calendar', run: () => openToolFromNav('calendar') },
    { id: 'preferences', label: '设置', icon: 'settings' as const, active: modal?.kind === 'preferences' || modal?.kind === 'models', run: () => showDialog({ kind: 'preferences' }) },
  ]
  const busyReason = busy ? pendingMessage ? '原操作尚未确认，请先核对回执' : '工作区正在处理其他操作，请稍候' : undefined
  const workspaceLockedReason = busyReason ?? (bookRecoveryLocked ? '恢复操作尚未确认，请先完成核对' : undefined)
  const composingReason = session.session.composing ? '输入法处理中，请先完成当前输入' : undefined
  const savingReason = session.session.saving ? '正在保存当前章节，请稍候' : undefined
  const archivedReason = archived ? '归档作品仅供查阅，请先在作品资料中解除归档' : undefined
  const recoveryActionReason = !api ? '本地服务未连接' : savingReason ?? composingReason
    ?? (recoveryBusy ? '正在处理草稿恢复，请稍候' : checkingReceipt ? '正在核对原请求，请稍候' : busy && !pendingMessage ? busyReason : undefined)
  // 两处保存入口共用当前会话的提示；待确认时仍沿原保存流程核对，不能误导作者重新发送。
  const saveHint = composingReason ?? savingReason ?? busyReason
    ?? (!session.session.dirty ? '当前章节已保存，无需重复保存'
      : session.session.error?.code === 'REVISION_CONFLICT' ? '正文版本冲突，请打开草稿与服务恢复'
        : session.session.error?.code === 'REQUEST_TIMEOUT' || session.session.error?.code === 'SERVICE_UNAVAILABLE' ? '核对上次保存回执 · Ctrl+S'
          : session.session.error ? '重试保存当前章节 · Ctrl+S' : '保存 · Ctrl+S')
  const navigation = <>
    <nav className={styles.nav} aria-label="工作室主导航">{primaryNav.map((item) => <StellarTooltip key={item.id} placement="right"><button className={`${styles.navItem} ${item.active ? styles.navItemActive : ''}`} type="button"
      title={workspaceLockedReason ?? (!api && item.id !== 'home' && item.id !== 'preferences' ? '本地服务未连接' : item.label)} aria-label={item.label} aria-current={item.active ? 'page' : undefined} disabled={busy || bookRecoveryLocked || (!api && item.id !== 'home' && item.id !== 'preferences')} onClick={item.run}><StudioIcon name={item.icon} size={20} /><span>{item.label}</span></button></StellarTooltip>)}</nav>
    <div className={styles.navBottom}><StellarTooltip placement="right"><button className={styles.iconButton} type="button" title={!api ? '本地服务未连接' : workspaceLockedReason ?? '切换作品库'} aria-label="切换作品库" onClick={() => void openWorkspace()} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="folder" size={20} /></button></StellarTooltip>
      <StellarTooltip placement="right"><button className={styles.iconButton} type="button" title={recoveryActionReason ?? '草稿与服务恢复'} aria-label="草稿与服务恢复" onClick={() => openRecovery()} disabled={!api || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt || (busy && !pendingMessage)}><StudioIcon name="history" size={20} /></button></StellarTooltip></div>
  </>

  const rightAsideExpanded = companionOpen || modal?.kind === 'ai' || writeAsideMode !== 'collapsed'
  const inspectorTabs = <div className={styles.copilotToolbar}>
    <div className={styles.copilotTabs} aria-label="写作辅助">
      <button type="button" title={busyReason ?? (!chapter ? '请先打开章节' : undefined)} aria-pressed={isAiInWriteDrawer && (modal?.kind !== 'ai' || modal.purpose !== 'review')} disabled={busy || !chapter} onClick={() => switchWriteAside('ai')}><StudioIcon name="spark" size={16} />共写</button>
      <button type="button" title={busyReason} aria-pressed={companionOpen} disabled={busy} onClick={() => switchWriteAside('companion')}><StudioIcon name="read" size={16} />设定</button>
      <button type="button" title={busyReason ?? (!chapter ? '请先打开章节' : undefined)} aria-pressed={isAiInWriteDrawer && modal?.kind === 'ai' && modal.purpose === 'review'} disabled={busy || !chapter} onClick={() => switchWriteAside('review')}><StudioIcon name="check" size={16} />审稿</button>
    </div>
    <div className={styles.copilotActions}>{isAiInWriteDrawer && <StellarTooltip><button type="button" className={styles.iconButton} disabled={busy} title={busyReason ?? '宽屏审阅'} aria-label="宽屏审阅" onClick={() => void changeView(async () => setAiWideMode(true))}><StudioIcon name="focus" size={16} /></button></StellarTooltip>}
      <StellarTooltip><button type="button" className={styles.iconButton} disabled={busy} title={busyReason ?? '收起辅助栏'} aria-label="收起辅助栏" onClick={closeInspector}><StudioIcon name="close" size={16} /></button></StellarTooltip></div>
  </div>
  const commandUnavailable = !api ? '本地服务未连接' : busy || bookRecoveryLocked || pendingMessage ? '请先完成或核对当前操作' : undefined
  const needsBook = commandUnavailable ?? (!book ? '请先打开作品' : undefined)
  const needsChapter = needsBook ?? (!chapter ? '请先打开章节' : undefined)
  const editableChapter = needsChapter ?? (archived ? '归档作品仅供查阅' : undefined)
  const currentNotices: StudioNotice[] = [
    ...(message ? [{ id: `message:${book?.book.id}:${message}`, title: '工作室提示', detail: message, tone: 'info' as const }] : []),
    ...(pendingMessage ? [{ id: `pending:${pendingMutation.current?.requestId}:${pendingMessage}`, title: '操作等待确认', detail: pendingMessage, tone: 'warning' as const }] : []),
    ...(session.session.error ? [{ id: `save:${chapter?.id}:${session.session.error.message}`, title: '正文保存需要处理', detail: session.session.error.message, tone: 'danger' as const }] : []),
    ...(display.warning ? [{ id: `display:${display.warning}`, title: '显示偏好尚未保存', detail: display.warning, tone: 'warning' as const }] : []),
    ...(protection.state.error ? [{ id: `checkpoint:${chapter?.id}:${protection.state.error}`, title: '草稿检查点需要处理', detail: protection.state.error, tone: 'warning' as const }] : []),
  ]
  const commandItems: StudioCommand[] = [
    { id: 'world', label: '世界星域与地点关联', group: '故事', disabledReason: needsBook, run: () => showDialog({ kind: 'galaxy', view: 'world' }) },
    { id: 'abilities', label: '境界与战力', group: '故事', disabledReason: needsBook, run: () => showDialog({ kind: 'abilities' }) },
    { id: 'weave', label: '织星系统', group: '故事', disabledReason: needsBook, run: () => showDialog({ kind: 'weave' }) },
    { id: 'tasks', label: '通知与任务中心', group: '工作室', run: () => setTaskCenterOpen(true) },
    { id: 'home', label: '返回今日书桌', group: '工作室', disabledReason: commandUnavailable, run: showHome },
    { id: 'shelf', label: '打开作品书架', group: '工作室', disabledReason: commandUnavailable ?? (!workspace.rootPath ? '请先打开作品库' : undefined), run: showShelf },
    { id: 'overview', label: '作品总览', group: '作品', disabledReason: needsBook, run: () => book ? openBookOverview(book.book.id) : undefined },
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
    { id: 'review', label: '审稿与虚拟读者', group: 'AI', disabledReason: needsBook, run: () => openReviewChecklist() },
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
    { id: 'aiMemoryTasks', label: '逐章整理任务', group: 'AI', disabledReason: needsBook, run: () => showDialog({ kind: 'aiMemoryTasks' }) },
    { id: 'aiSummary', label: '全书分层汇总', group: 'AI', disabledReason: needsBook, run: () => showDialog({ kind: 'aiSummary' }) },
    { id: 'publishedMemory', label: '定稿记忆与依赖复核', group: '资料', disabledReason: needsBook, run: () => showDialog({ kind: 'living', tab: 'memory' }) },
    { id: 'bookDetails', label: '作品资料与归档', group: '作品', disabledReason: needsBook, run: () => { if (book) showDialog({ kind: 'bookDetails', book: book.book }) } },
    { id: 'recovery', label: '草稿与服务恢复', group: '工作室', disabledReason: !api || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt ? '请先完成当前操作' : undefined, run: () => openRecovery() },
    { id: 'preferences', label: '阅读与显示设置', group: '显示', disabledReason: commandUnavailable, run: () => showDialog({ kind: 'preferences' }) },
    { id: 'models', label: '模型连接与任务路由', group: '设置', disabledReason: commandUnavailable ?? (!workspace.rootPath ? '请先选择作品库' : undefined), run: () => showDialog({ kind: 'models' }) },
    { id: 'focus', label: focused ? '退出专注模式' : '进入专注模式', group: '显示', shortcut: 'Ctrl+Shift+Enter', disabledReason: needsChapter,
      run: () => changeView(async () => { setSurface('write'); setModal(null); setFocused((value) => !value) }) },
    ...STUDIO_THEMES.map((theme): StudioCommand => ({ id: `theme:${theme}`, label: `切换主题 · ${STUDIO_THEME_META[theme].label}`, group: '显示',
      keywords: theme === 'night' ? '夜间 暗色 dark' : '日间 明亮 light', disabledReason: commandUnavailable,
      run: () => { display.update({ studioTheme: theme }) } })),
    ...(book?.chapters.map((item): StudioCommand => ({ id: `chapter:${item.id}`, label: `第 ${item.position + 1} 章 · ${item.title}`, group: '跳转章节',
      disabledReason: needsBook, run: () => openBook(book.book.id, item.id) })) ?? []),
  ]

  const writingVisible = studioView === 'write' && !isCanvasView && Boolean(book)
  const homeVisible = studioView === 'home' && !isCanvasView
  const toggleOutline = () => {
    if (outlineDrawer.current?.getClientRects().length) setOutlineOpen(false)
    else void changeView(async () => { setModal(null); setCompanionOpen(false); setWriteAsideMode('collapsed'); setOutlineOpen(true) })
  }
  const writingTools = book && <details className={styles.chapterTools}
    onClick={(event) => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.open = false }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false }}>
    <StellarTooltip><summary ref={chapterToolsTrigger} title="章节与作品工具" aria-label="章节与作品工具"><StudioIcon name={chapter ? 'down' : 'more'} size={20} /></summary></StellarTooltip>
    <div className={styles.chapterToolItems}>
      <button type="button" title={busyReason ?? composingReason} onClick={toggleOutline} disabled={busy || session.session.composing}>章节目录 · {book.chapters.length} 章</button>
      <button type="button" title={busyReason} onClick={() => switchWriteAside(companionOpen ? 'collapsed' : 'companion')} disabled={busy}>伴随资料</button>
      {chapter && <button type="button" title={busyReason} onClick={() => isAiInWriteDrawer ? closeInspector() : switchWriteAside('ai')} disabled={busy}>{isAiInWriteDrawer ? '收起 AI 副驾驶' : 'AI 协作'}</button>}
      <button type="button" title={busyReason} onClick={() => openToolFromNav('workbench')} disabled={busy}>章节规划</button>
      {chapter && <>
        <button type="button" title={busyReason ?? archivedReason} onClick={() => showDialog({ kind: 'chapterDetails' })} disabled={busy || archived}>{chapter.status === 'finalized' ? '资料 / 重开工作稿' : '本章资料'}</button>
        <button type="button" title={busyReason} onClick={() => showDialog({ kind: 'history' })} disabled={busy}>版本历史与对比</button>
        <button type="button" title={busyReason ?? archivedReason ?? (chapter.status === 'finalized' && !session.session.dirty ? '当前章节已定稿，无需重复确认' : undefined)} onClick={() => showDialog({ kind: 'finalize' })} disabled={busy || archived || chapter.status === 'finalized' && !session.session.dirty}>作者定稿</button>
      </>}
      <button type="button" title={busyReason} onClick={() => void changeView(async () => { await refreshCurrentBook(book.book.id) })} disabled={busy}>刷新目录</button>
      <button type="button" title={busyReason ?? archivedReason ?? (!workspace.recoveryScope ? '当前书库尚未取得草稿恢复范围，请先核对书库' : undefined)} onClick={() => showDialog({ kind: 'draftImport' })} disabled={busy || archived || !workspace.recoveryScope}>从草稿恢复新章</button>
      {BOOK_DESTINATIONS.map((item) => <button type="button" key={item.id} title={workspaceLockedReason} disabled={busy || bookRecoveryLocked} onClick={() => navigateBook(item.id)}>{item.label}</button>)}
    </div>
  </details>
  const saveAction = <StellarTooltip><button className={`${styles.iconButton} ${styles.topbarSave} ${styles.saveButton}`} type="button" title={saveHint} aria-label="保存当前章节"
    aria-busy={session.session.saving} onClick={() => void session.flush()} disabled={busy || !session.session.dirty || session.session.saving || session.session.composing}>
    <StudioIcon name="save" size={20} />{!focused && <span>保存</span>}
  </button></StellarTooltip>

  return <div className={`${styles.appShell} ${sidebarCollapsed ? styles.sidebarCollapsed : ''} ${modal?.kind === 'reader' && api && book ? styles.readerMode : ''} ${studioView === 'write' && !isCanvasView && focused && chapter ? styles.focusMode : ''}`}>
    {taskCenterOpen && <TaskCenter key={`${workspace.rootPath}:${book?.book.id}`} api={api} bookId={book?.book.id} notices={currentNotices} seen={seenNotices}
      onSeen={(ids) => setSeenNotices((current) => new Set([...current, ...ids].slice(-500)))} onClose={() => setTaskCenterOpen(false)}
      onStop={stopCenterTask} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()}
      onRecover={() => { setTaskCenterOpen(false); openRecovery(true) }}
      disabled={busy || bookRecoveryLocked} onNavigate={(destination, target, taskId) => {
        setTaskCenterOpen(false)
        if (destination === 'ai') openBookAi(undefined, target)
        else if (destination === 'media') showDialog({ kind: 'media', initialRunId: taskId })
        else if (destination === 'vector') showDialog({ kind: 'memory', initialVectorRunId: taskId })
        else showDialog({ kind: destination, initialTaskId: taskId })
      }} />}
    {commandOpen && <CommandPalette commands={commandItems} onClose={() => setCommandOpen(false)} />}
    <aside id="studio-sidebar" className={styles.sidebar} aria-label="工作室导航">{navigation}</aside>
      <header className={`${styles.topbar} ${homeVisible ? styles.homeTopbar : ''} ${writingVisible ? styles.writingTopbar : ''}`}>
        <button className={styles.topBrand} type="button" title={workspaceLockedReason ?? '织章 · 今日书桌'} aria-label="织章 · 今日书桌" disabled={busy || bookRecoveryLocked} onClick={() => void showHome()}>
          <StudioIcon name="planet" size={28} /><span>织章{homeVisible && <small>StoryWeave</small>}</span>
        </button>
        {homeVisible ? <button type="button" className={styles.topSearch} disabled={busy || hasBlockingDialog || bookRecoveryLocked}
          onClick={() => { setNavigationOpen(false); setCommandOpen(true) }} aria-label="搜索作品、章节、人物或命令"><StudioIcon name="search" size={20} /><span>搜索作品、章节、人物或命令</span><kbd>Ctrl K</kbd></button>
          : writingVisible && book ? <div className={styles.writingBreadcrumb}>
            <StellarTooltip><button type="button" className={styles.iconButton} title={workspaceLockedReason ?? '返回作品总览'} aria-label="返回作品总览" disabled={busy || bookRecoveryLocked} onClick={() => void openBookOverview(book.book.id)}><StudioIcon name="arrow" size={20} style={{ transform: 'rotate(180deg)' }} /></button></StellarTooltip>
            <button type="button" className={styles.writingBookTitle} disabled={busy || bookRecoveryLocked} title={workspaceLockedReason ?? book.book.title} onClick={() => void openBookOverview(book.book.id)}>《{book.book.title}》</button>
            <select value={chapter?.id ?? ''} title={workspaceLockedReason ?? composingReason} aria-label="选择章节" disabled={busy || session.session.composing || bookRecoveryLocked} onChange={(event) => { if (event.target.value) void openChapter(event.target.value) }}>
              {!chapter && <option value="">选择章节</option>}{book.chapters.map((item) => <option key={item.id} value={item.id}>第 {item.position + 1} 章 · {item.title}</option>)}
            </select>
          </div> : <div className={styles.breadcrumb}>
          <span className={styles.topbarPage}>{headerInfo.title}</span>
          <span className={styles.crumbSlash}>/</span>
          <span className={styles.crumb} title={book?.book.title ?? headerInfo.subtitle}>
            {book ? book.book.title : headerInfo.subtitle}
          </span>
        </div>}
        {book && !matrixVisible && !bookMediaVisible && modal?.kind !== 'weave' && modal?.kind !== 'export' && modal?.kind !== 'history' && modal?.kind !== 'calendar' && studioView !== 'home' && (studioView !== 'book' || isCanvasView) && <div className={styles.domainRail}><CreativeSpine snapshot={creative.snapshot} reading={creative.reading} error={creative.error} disabled={busy || bookRecoveryLocked || hasBlockingDialog} onNavigate={openCreativeDomain} onReload={creative.reload} /></div>}
        <div className={styles.topActions}>
          {bookToolsVisible && book && <label className={styles.canvasTools} title="更多作品工具"><StudioIcon name="more" size={20} />
            <select aria-label="更多作品工具" value="" disabled={busy || bookRecoveryLocked} onChange={(event) => {
              if (event.target.value === 'overview') void openBookOverview(book.book.id)
              else if (event.target.value) navigateBook(event.target.value as BookDestination)
            }}>
              <option value="">更多作品工具</option><option value="overview">总览</option>{BOOK_DESTINATIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>}
          {writingVisible && chapter && <span className={styles.chapterCount}>{session.session.characterCount.toLocaleString()}{chapter.targetCharacters !== null ? ` / ${chapter.targetCharacters.toLocaleString()}` : ' 字'}</span>}
          {writingVisible && <button type="button" className={styles.modelPicker} aria-label="选择模型" disabled={busy || bookRecoveryLocked} onClick={() => switchWriteAside('ai')} title={workspaceLockedReason ?? '打开共写面板选择模型'}><StudioIcon name="spark" size={16} /><span>选择模型</span><StudioIcon name="down" size={14} /></button>}
          <StellarTooltip><button className={styles.iconButton} type="button" title={hasBlockingDialog ? '请先关闭当前对话框' : commandOpen ? '请先关闭搜索与命令' : composingReason ?? '通知与任务'} aria-label={`通知与任务${currentNotices.some((item) => !seenNotices.has(item.id)) ? '，有未读提示' : ''}`} disabled={hasBlockingDialog || commandOpen || session.session.composing} onClick={() => setTaskCenterOpen(true)}><StudioIcon name="bell" size={20} />{currentNotices.some((item) => !seenNotices.has(item.id)) && <i className={styles.unreadDot} />}</button></StellarTooltip>
          <StellarTooltip><button className={styles.iconButton} type="button" aria-label="搜索命令与章节" aria-keyshortcuts="Control+k Meta+k" disabled={busy || hasBlockingDialog || bookRecoveryLocked} onClick={() => { setNavigationOpen(false); setCommandOpen(true) }} title={workspaceLockedReason ?? (hasBlockingDialog ? '请先关闭当前对话框' : '搜索命令与章节 · Ctrl+K')}><StudioIcon name="search" size={20} /></button></StellarTooltip>
          {studioView === 'write' && !isCanvasView && chapter && <>
            <div className={focused ? styles.standaloneSave : styles.saveActions} role="group" aria-label={focused ? '章节保存' : '章节保存与工具'}>{saveAction}{!focused && writingTools}</div>
            <StellarTooltip><button className={`${styles.iconButton} ${styles.focusButton}`} type="button" aria-label="专注写作" aria-pressed={focused} title={composingReason ?? (busy && !focused ? busyReason : undefined) ?? (focused ? '退出专注写作 · Ctrl+Shift+Enter' : '专注写作 · Ctrl+Shift+Enter')} onClick={() => setFocused(!focused)} disabled={session.session.composing || (busy && !focused)}>
              <StudioIcon name="focus" size={20} />
            </button></StellarTooltip>
          </>}
          {studioView === 'write' && !isCanvasView && book ? focused ? <>
            <button className={styles.button} type="button" title={workspaceLockedReason ?? savingReason ?? composingReason} aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked || session.session.saving || session.session.composing}><StudioIcon name="settings" size={14} />外观</button>
            <button className={styles.button} type="button" title={recoveryActionReason} onClick={() => openRecovery()} disabled={!api || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt || (busy && !pendingMessage)}><StudioIcon name="history" size={14} />恢复</button>
          </> : !chapter && writingTools : <>
            <span className={styles.localBadge}><span className={styles.statusDot} />{workspace.rootPath ? '仅本机 · 已连接' : '仅本机'}</span>
            <StellarTooltip><button className={styles.profileButton} type="button" aria-label="外观与显示偏好" title={workspaceLockedReason ?? '工作室配色与稿纸偏好'} aria-haspopup="dialog" onClick={() => showDialog({ kind: 'preferences' })} disabled={busy || bookRecoveryLocked}><StudioIcon name="user" size={20} /></button></StellarTooltip>
          </>}
          <StellarTooltip><button className={styles.sidebarToggle} type="button" title={sidebarCollapsed ? '显示导航栏' : '隐藏导航栏'} aria-label={sidebarCollapsed ? '显示导航栏' : '隐藏导航栏'} aria-expanded={!sidebarCollapsed} aria-controls="studio-sidebar" onClick={() => setSidebarCollapsed((value) => !value)}><StudioIcon name="sidebar" size={18} /></button></StellarTooltip>
        </div>
      </header>
    <main className={`${styles.main} ${studioView !== 'write' || isCanvasView ? styles.homeMain : ''}`}>
      {message && !hasBlockingDialog && <div className={`${styles.notice} ${messageState?.tone === 'success' ? styles.noticeSuccess : ''}`} role={messageState?.tone === 'success' ? 'status' : 'alert'}><span>{message}</span><button type="button" onClick={() => setMessage(null)} aria-label="关闭提示">×</button></div>}
      {display.warning && !hasBlockingDialog && <div className={styles.notice} role="status"><span>{display.warning}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing} onClick={display.retrySave}>保存当前显示偏好</button></div>}
      {pendingMessage && <div className={styles.notice} role="alert"><span>{pendingMessage}</span><button className={styles.receiptButton} type="button" onClick={() => void checkMutationReceipt()} disabled={checkingReceipt || recoveryBusy}>{checkingReceipt ? '正在核对…' : '核对回执'}</button></div>}
      {session.session.error && <StellarEmpty compact role="alert" heading="h2" icon={storageReason ? 'database' : 'warning'} hintIcon="refresh"
        tone={storageReason ? 'default' : ['REVISION_CONFLICT', 'REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(session.session.error.code) ? 'warning' : 'danger'}
        title={storageReason === 'disk-full' ? '磁盘空间不足' : storageReason === 'database-full' ? '数据库可用空间不足' : saveLabel(session.session)} description={session.session.error.message}
        hint={storageReason === 'disk-full' ? '请保留窗口；检查书库所在磁盘的可用空间，或将草稿副本另存到其他本地磁盘。'
          : storageReason === 'database-full' ? '请保留窗口；检查数据库容量限制及临时存储空间，或将草稿副本另存到其他本地磁盘。'
          : session.session.error.code === 'REVISION_CONFLICT' ? '请从“草稿与恢复”另存后重载磁盘版本。'
          : session.session.error.code === 'REQUEST_TIMEOUT' || session.session.error.code === 'SERVICE_UNAVAILABLE' ? '先核对原保存回执，未获确认前请保留窗口和草稿。' : '当前草稿仍在窗口中，可重试保存或另存草稿副本。'}>
        {session.session.error.code !== 'REVISION_CONFLICT' && <button className={styles.primaryButton} type="button" aria-busy={session.session.saving}
          onClick={() => void session.flush()} disabled={!api || busy || archived || bookRecoveryLocked || hasBlockingDialog || !session.session.dirty || session.session.saving || session.session.composing}>
          <StudioIcon name="refresh" size={20} />{storageReason ? '处理空间后重试' : session.session.error.code === 'REQUEST_TIMEOUT' || session.session.error.code === 'SERVICE_UNAVAILABLE' ? '核对保存回执' : '重试'}
        </button>}
        <button className={session.session.error.code === 'REVISION_CONFLICT' ? styles.primaryButton : styles.button} type="button"
          onClick={() => openRecovery()} disabled={!api || hasBlockingDialog || session.session.saving || session.session.composing || recoveryBusy || checkingReceipt || (busy && !pendingMessage)}>
          <StudioIcon name="copy" size={20} />{storageReason ? '另存草稿副本' : session.session.error.code === 'REVISION_CONFLICT' ? '草稿与恢复' : '另存为草稿'}
        </button>
      </StellarEmpty>}
      {session.session.dirty && protection.state.error && <div className={`${styles.notice} ${styles.noticeError}`} role="alert"><span>恢复检查点未更新：{protection.state.error}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing} onClick={protection.retry}>重试留存</button><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing || hasBlockingDialog} onClick={showDraftProtection}>查看容量与分代</button></div>}
      {protection.state.warning && <div className={styles.notice} role="status"><span>{protection.state.warning}</span><button className={styles.receiptButton} type="button" disabled={busy || session.session.composing || hasBlockingDialog} onClick={showDraftProtection}>查看容量与分代</button></div>}
      {archived && book && <StellarEmpty compact role="status" heading="h2" icon="lock" tone="warning" title="归档只读"
        description="此作品已归档，可阅读和导出。继续编辑前请在作品资料中解除归档。"
        hint="在作品资料中取消“归档作品”并保存后，即可继续编辑。">
        <button className={styles.primaryButton} type="button" title="打开作品资料解除归档"
          onClick={() => showDialog({ kind: 'bookDetails', book: book.book })} disabled={!api || busy || bookRecoveryLocked || hasBlockingDialog || session.session.saving || session.session.composing}>
          <StudioIcon name="archive" size={20} />解除归档
        </button>
      </StellarEmpty>}

      {/* 全画布一级功能视图：取代旧版模态弹窗地狱，直接在主画布内平铺展开 */}
      {isCanvasView && modal?.kind !== 'bookRecovery' && <DialogDisplayContext.Provider value="canvas">
        <div className={styles.canvasViewport}>
          {modal?.kind === 'preferences' && <DisplayPreferencesPanel preferences={display.preferences} warning={display.warning} busy={busy} onChange={display.update} onReset={display.reset} onRetrySave={display.retrySave} onClose={closeModal}
            focused={focused} onFocusChange={chapter ? setFocused : undefined} saveStatus={chapter ? saveLabel(session.session) : '未打开章节'}
            workspacePath={workspace.rootPath} onChooseWorkspace={() => void openWorkspace()} onBackup={() => showDialog({ kind: 'bookRecovery' })} onRecovery={() => openRecovery()} onModels={() => workspace.rootPath ? showDialog({ kind: 'models' }) : void openWorkspace()} />}
          {modal?.kind === 'models' && api && <ModelConnectionsPanel key={`${workspace.rootPath}:${book?.book.id ?? ''}`} api={api} book={book} disabled={busy} onClose={closeModal} onDirtyChange={(value) => { auxiliaryDirty.current = value }} registerLeaveGuard={registerPanelLeaveGuard} onBookChange={applyBook} onApply={(preset) => openBookAi(preset)} onConfigureBook={() => openBookAi()} onSummary={(preset) => showDialog({ kind: 'aiSummary', initialPreset: preset })} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'abilities' && api && book && <CharacterComparison key={`${workspace.rootPath}:${book.book.id}`} api={api} book={book} disabled={busy} onClose={closeModal}
            onOpen={(initialId) => showDialog({ kind: 'knowledge', initialKind: 'person', initialId })} onPlan={() => showDialog({ kind: 'workbench' })}
            onBookChange={applyBook} onDirtyChange={(value) => { auxiliaryDirty.current = value }} registerLeaveGuard={registerPanelLeaveGuard}
            onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'weave' && api && book && <WeaveSystemPanel key={`${workspace.rootPath}:${book.book.id}`} api={api} book={book} disabled={busy} onClose={closeModal}
            onChapter={(id) => void openChapter(id)} onBookChange={applyBook} onDirtyChange={(value) => { auxiliaryDirty.current = value }} registerLeaveGuard={registerPanelLeaveGuard}
            onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'export' && book && api && <ExportBookPanel key={`${workspace.rootPath}:${book.book.id}`} api={api} workspaceScope={workspace.rootPath ?? undefined} receipt={exportReceipt} book={book} onExport={exportBook} onClose={closeModal} busy={busy} error={modalError} registerLeaveGuard={registerPanelLeaveGuard} />}
          {modal?.kind === 'history' && chapter && api && <RevisionHistory key={`${workspace.rootPath}:${chapter.bookId}:${chapter.id}`} api={api} chapter={chapter} archived={archived} onRestore={restoreRevision} onMerge={mergeSelectedRevision} onClose={closeModal} busy={busy} error={modalError} registerLeaveGuard={registerPanelLeaveGuard} />}
          {modal?.kind === 'forge' && book && api && <>
            <ForgePanel key={`${workspace.rootPath}:${book.book.id}:${modal.initialKind ?? 'cast'}:${modal.personId ?? ''}`} api={api} book={book} chapter={chapter} disabled={busy}
              initialKind={modal.initialKind} initialPersonId={modal.personId} onDirtyChange={(value) => { workbenchDirty.current = value }} onBookChange={applyBook}
              onClose={closeModal} onConfigure={() => showDialog({ kind: 'ai' })} onKnowledge={(initialId) => showDialog({ kind: 'knowledge', initialKind: initialId ? 'person' : undefined, initialId: initialId ?? undefined })} onRelations={() => showDialog({ kind: 'galaxy', view: 'relationships' })} onMedia={() => showDialog({ kind: 'media' })} onRecover={() => openRecovery(true)} />
          </>}
          {modal?.kind === 'living' && book && api && <Dialog title={modal.tab === 'memory' ? '定稿记忆与来源复核' : '大纲与演进沙盘'} wide inline onClose={closeModal} busy={busy}>
            <LivingPanel key={`${workspace.rootPath}:${book.book.id}:${modal.tab ?? 'outline'}:${modal.initialId ?? ''}`} api={api} book={book} chapter={chapter} disabled={busy}
              initialTab={modal.tab} initialId={modal.initialId} onDirtyChange={(value) => { workbenchDirty.current = value }} onBookChange={applyBook} onSnapshotChange={creative.receive}
              onConfigure={() => showDialog({ kind: 'ai' })} onNavigate={(id) => void openChapter(id)} onRecover={() => openRecovery(true)} />
          </Dialog>}
          {modal?.kind === 'kickstart' && api && workspace.rootPath && <KickstartPanel key={`${workspace.rootPath}:${modal.bookId ?? 'new'}:${modal.genre ?? ''}`} api={api} bookId={modal.bookId} initialGenre={modal.genre} disabled={busy}
            onDirtyChange={(value) => { auxiliaryDirty.current = value }} registerLeaveGuard={registerPanelLeaveGuard} onBookChange={upsertShelf} onAdopted={enterKickstart} onClose={closeModal}
            onManual={() => showDialog({ kind: 'newBook' })} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'workbench' && book && api && <WorkbenchPanel key={`${workspace.rootPath}:${book.book.id}:${modal.tab ?? ''}:${modal.issueId ?? ''}`} initialTab={modal.tab} initialReviewIssueId={modal.issueId} initialReviewAction={modal.reviewAction} initialAnnotation={modal.annotation} api={api} book={book} chapter={chapter} disabled={busy} onClose={closeModal} onDirtyChange={(value) => { workbenchDirty.current = value }} onBookChange={applyBook} onChapterChange={(value) => { onSaved(value); session.load(value) }} onNavigate={(id) => void changeView(async () => { const value = await api.readChapter({ bookId: book.book.id, chapterId: id }); if (value.ok && value.data.bookId === book.book.id && value.data.id === id) { session.load(value.data); setModal(null); setSurface('write') } else setMessage(value.ok ? '章节身份不匹配。' : value.error.message) })} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} onReview={(instruction) => showDialog({ kind: 'ai', purpose: 'review', initialInstruction: instruction })} />}
          {modal?.kind === 'inspiration' && workspace.rootPath && api && <Dialog title="全局灵感与拆书技能库" wide inline onClose={closeModal} busy={busy}>
            <InspirationPanel key={workspace.rootPath} api={api} books={workspace.books} activeBook={book} disabled={busy} onBookMaterials={book ? () => showDialog({ kind: 'notes' }) : undefined} onOpenNote={(bookId, noteId) => void openSavedNote(bookId, noteId)} onDirtyChange={(value) => { inspirationDirty.current = value }} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} onBookChanged={async (id) => { if (bookRef.current?.book.id === id) await refreshCurrentBook(id); else { const value = await request(() => api.getBook({ bookId: id })); if (value.ok) upsertShelf(value.data.book) } }} />
          </Dialog>}
          {modal?.kind === 'knowledge' && api && book && <KnowledgePanel key={`${book.book.id}:${modal.initialKind ?? 'all'}:${modal.initialId ?? ''}`} initialKind={modal.initialKind} initialId={modal.initialId} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(dirty) => { knowledgeDirty.current = dirty }} onUpgrade={upgradeKnowledge} onCreate={createKnowledge} onUpdate={updateKnowledge} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onForge={(personId, initialKind) => showDialog({ kind: 'forge', personId, initialKind })} />}
          {modal?.kind === 'story' && api && book && <StoryPanel key={`${book.book.id}:${modal.initialKind ?? ''}:${modal.initialId ?? ''}:${modal.initialCreate ?? false}`} api={api} book={book} initialKind={modal.initialKind} initialId={modal.initialId} initialCreate={modal.initialCreate} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(dirty) => { storyDirty.current = dirty }} onUpgrade={upgradeKnowledge} onCreate={createStory} onUpdate={updateStory} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'calendar' && api && book && <WritingCalendarPanel key={`${workspace.rootPath}:${book.book.id}`} api={api} book={book} disabled={busy} onClose={closeModal} onDirtyChange={(value) => { auxiliaryDirty.current = value }} onBookChange={applyBook} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'media' && api && book && <BookMediaPanel key={`${workspace.rootPath}:${book.book.id}:${modal.scenePlaceId ?? ''}:${modal.initialRunId ?? ''}`} api={api} book={book} disabled={busy} scenePlaceId={modal.scenePlaceId} initialRunId={modal.initialRunId}
            onDirtyChange={(value) => { auxiliaryDirty.current = value }} registerLeaveGuard={registerPanelLeaveGuard} onBookChange={applyBook} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} onClose={modal.scenePlaceId ? () => showDialog({ kind: 'galaxy', view: 'world', initialPlaceId: modal.scenePlaceId, initialMapOffset: modal.mapOffset }) : closeModal}
            onPerson={(initialId) => showDialog({ kind: 'knowledge', initialKind: 'person', initialId })} />}
          {modal?.kind === 'timeline' && api && book && <StoryTimelinePanel key={book.book.id} api={api} book={book} busy={busy} error={modalError} onClose={closeModal} onOpenRecords={(kind, initialCreate) => showDialog({ kind: 'story', initialKind: kind, initialCreate })} />}
          {modal?.kind === 'galaxy' && api && book && <StoryGalaxyPanel key={`${workspace.rootPath}:${book.book.id}`} api={api} book={book} busy={busy} error={modalError} initialView={modal.view} onViewChange={(view) => showDialog({ kind: 'galaxy', view })} chapterId={chapter?.id} onOpenChapter={(id) => void openChapter(id)} onNavigate={navigateCompanion} onUseForeshadow={chapter && !archived ? useForeshadow : undefined} onScanRelations={chapter && !archived ? () => showDialog({ kind: 'forge', initialKind: 'relations' }) : undefined} onClose={closeModal} onDirtyChange={(value) => { auxiliaryDirty.current = value }} onBookChange={applyBook} onUnknown={(error) => setMessage(error.message)} onRecover={() => openRecovery(true)} onOpenKnowledge={(initialId) => changeView(async () => { setModal({ kind: 'knowledge', initialId }) })} onOpenRecords={(initialKind, initialId, initialCreate) => changeView(async () => { setModal({ kind: 'story', initialKind, initialId, initialCreate }) })}
            initialPlaceId={modal.initialPlaceId} initialMapOffset={modal.initialMapOffset}
            onOpenScene={(scenePlaceId, mapOffset) => showDialog({ kind: 'media', scenePlaceId, mapOffset })} />}
          {modal?.kind === 'notes' && api && book && <NotesPanel key={book.book.id} api={api} book={book} initialNoteId={modal.initialId} displayPreferences={display.preferences} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onGlobalMaterials={() => showDialog({ kind: 'inspiration' })} onDirtyChange={(value) => { notesDirty.current = value }} onUpgrade={upgradeKnowledge}
            onCreate={(input, accept) => writeNote('notes.create', input, () => api.createNote(input), accept)} onUpdate={(input, accept) => writeNote('notes.update', input, () => api.updateNote(input), accept)} onPromote={(input, accept) => writeNote('notes.promote', input, () => api.promoteNote(input), accept)}
            onSetChapters={(input, accept) => writeNote('notes.chapters', input, () => api.setNoteChapters(input), accept)} onOpenChapter={(id) => void openChapter(id)} />}
          {modal?.kind === 'reader' && api && book && <BookReaderPanel key={book.book.id} api={api} book={book} initialChapterId={chapter?.id} busy={busy} error={modalError} displayPreferences={display.preferences} preferencesWarning={display.warning} onPreferencesChange={display.update} onRetryPreferencesSave={display.retrySave} onReviewIssue={(issueId, reviewAction) => showDialog({ kind: 'workbench', tab: 'review', issueId, reviewAction })} onClose={closeModal} />}
          {modal?.kind === 'memory' && api && book && <MemoryPanel key={`${workspace.rootPath}:${book.book.id}:${modal.initialTaskId ?? ''}:${modal.initialVectorRunId ?? ''}`} api={api} book={book} initialTaskId={modal.initialTaskId} initialVectorRunId={modal.initialVectorRunId} busy={busy} error={modalError} onClose={closeModal} onDirtyChange={(value) => { memoryWorking.current = value }} onUpgrade={upgradeKnowledge} onStart={startMemory} onStep={stepMemory} onControl={controlMemory} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} />}
          {modal?.kind === 'aiMemoryTasks' && api && book && <AiMemoryTasksPanel key={`${book.book.id}:${modal.initialTaskId ?? ''}`} api={api} book={book} initialTaskId={modal.initialTaskId} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdoptMemory={adoptAiMemory} />}
          {modal?.kind === 'aiSummary' && api && book && <AiSummaryPanel key={`${book.book.id}:${modal.initialTaskId ?? ''}:${modal.initialPreset?.id ?? ''}:${modal.initialPreset?.revision ?? ''}`} api={api} book={book} initialTaskId={modal.initialTaskId} initialPreset={modal.initialPreset} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onNavigate={(chapterId) => void openChapter(chapterId)} onForeshadow={() => showDialog({ kind: 'galaxy', view: 'radar' })} onDirtyChange={(value) => { aiDirty.current = value }} onUpgrade={upgradeKnowledge} onAdoptSummary={adoptAiSummary} />}
          {modal?.kind === 'ai' && api && book && chapter && <div className={styles.wideAiContainer}>
            <div className={styles.wideAiBanner}>
              <span>{chapter.title}</span>
              <button type="button" className={styles.button} disabled={busy} onClick={() => void changeView(async () => {
                setSurface('write'); setFocused(false); setAiWideMode(false); setWriteAsideMode('ai'); setCompanionOpen(false)
              })}>切回侧栏伴随模式</button>
            </div>
            <AiPanel key={`${book.book.id}:${aiPreset?.id ?? ''}:${modal?.kind === 'ai' ? `${modal.purpose ?? ''}:${modal.initialRunId ?? ''}` : ''}:${aiTask ?? ''}:${aiInstruction ?? ''}:${aiResourceKey}:${aiRewrite?.firstBlockId ?? ''}:${aiRewrite?.lastBlockId ?? ''}`} initialRunId={modal?.kind === 'ai' ? modal.initialRunId : undefined} initialTask={aiTask} initialPreset={aiPreset} initialRewrite={aiRewrite} initialResources={aiResources} initialPurpose={modal?.kind === 'ai' ? modal.purpose : undefined} initialInstruction={aiInstruction} initialLivingContext={aiLivingContext} api={api} book={book} chapter={chapter} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onBookChange={applyBook} onUpgrade={upgradeKnowledge} onAdopt={adoptAi} onAdoptMemory={adoptAiMemory} onUseStudy={useStudyMaterials} onOpenReviewChecklist={openReviewChecklist} onSummary={(preset) => showDialog({ kind: 'aiSummary', initialPreset: preset })} />
          </div>}
        </div>
      </DialogDisplayContext.Provider>}

      {/* 恢复面板持续挂载，关闭或切换画布也保留未确认请求及完成回执。 */}
      {api && <div className={styles.canvasViewport} hidden={modal?.kind !== 'bookRecovery'}><BookRecoveryPanel api={api} open={modal?.kind === 'bookRecovery'} book={book?.book ?? null} targetRoot={workspace.rootPath} draftScope={workspace.recoveryScope} bookCount={workspace.books.length} recoveryEpoch={bookRecoveryEpoch} busy={busy || recoveryBusy} error={modalError} onDirtyChange={markBookRecoveryDirty} onClose={closeModal} onRecover={() => openRecovery(true)} onChooseWorkspace={() => void openWorkspace()} onRestored={acceptBookRecovery} onRefresh={refreshRecoveryShelf} onOpenBook={(id) => void openBook(id)} /></div>}

      {!isCanvasView && studioView === 'home' && <StellarDesk
        api={api}
        workspace={workspace}
        currentBook={book}
        onOpenWorkspace={() => void openWorkspace()}
        onCreate={(genre) => startBook('newBook', genre)}
        onImport={() => startBook('import')}
        onShelf={() => workspace.rootPath ? void showShelf() : void openWorkspace()}
        onRecover={() => showDialog({ kind: 'bookRecovery' })}
        onPreferences={() => showDialog({ kind: 'preferences' })}
        onOpenBook={(id, chapterId) => void openBook(id, chapterId)}
        onOverview={(id) => void openBookOverview(id)}
        onTool={(id, kind) => void openWorkspaceTool(id, kind)}
        busy={busy || bookRecoveryLocked}
      />}
      {!isCanvasView && studioView === 'shelf' && <StellarShelf api={api} targetRoot={workspace.rootPath} scope={workspace.rootPath ? JSON.stringify([workspace.rootPath, workspace.recoveryScope]) : undefined} books={workspace.books} recentOpens={recentBookOpens(workspace)} onOpen={(id) => void openBookOverview(id)} onWrite={(id) => void openBook(id)} onEdit={(item) => showDialog({ kind: 'bookDetails', book: item })} onCreate={() => showDialog({ kind: 'kickstart' })} onImport={() => showDialog({ kind: 'import' })} onRecover={() => showDialog({ kind: 'orphans' })} busy={busy || bookRecoveryLocked} />}
      {!isCanvasView && studioView === 'book' && book && <BookOverview api={api} scope={workspace.rootPath ? JSON.stringify([workspace.rootPath, workspace.recoveryScope]) : undefined} book={book} snapshot={creative.snapshot} reading={creative.reading} error={creative.error} busy={busy || bookRecoveryLocked} onNavigate={navigateBook} onChapter={(id) => void openChapter(id)} onDomain={openCreativeDomain} onReload={creative.reload} />}
      {book && <div className={styles.editorSurface} hidden={studioView !== 'write' || isCanvasView} inert={studioView !== 'write' || isCanvasView}>
        <div className={`${styles.writeLayout} ${outlineOpen === true ? styles.outlineExpanded : outlineOpen === false ? styles.outlineCollapsed : ''} ${!rightAsideExpanded ? styles.asideCollapsed : ''} ${inspectorRequested ? styles.inspectorExpanded : ''}`}>
          {outlineOpen === true && <button type="button" className={styles.outlineBackdrop} tabIndex={-1} aria-label="关闭章节目录" onClick={() => setOutlineOpen(false)} />}
          {inspectorRequested && <button type="button" className={styles.inspectorBackdrop} tabIndex={-1} aria-label="收起辅助栏" onClick={closeInspector} />}
          <div ref={outlineDrawer} tabIndex={-1} aria-label="章节目录" className={`${styles.chapterRail} ${styles.outlineColumn}`}>
            <button type="button" className={styles.outlineClose} aria-label="关闭章节目录" title="关闭章节目录" onClick={() => setOutlineOpen(false)}><StudioIcon name="close" size={20} /></button>
            <ChapterOutline book={book} selectedId={chapter?.id} busy={busy} onOpen={(id) => void openChapter(id)} onCreate={(volumeId) => showDialog({ kind: 'newChapter', volumeId })} onVolume={(volumeId) => showDialog({ kind: 'volume', volumeId })} onMoveChapter={(id, direction) => void moveItem('chapter', id, direction)} onMoveVolume={(id, direction) => void moveItem('volume', id, direction)} />
            {chapter && <ChapterBeatStrip outline={creative.snapshot?.outlines.find((item) => item.id === chapter.id)} reading={creative.reading} disabled={busy} onOpen={() => showDialog({ kind: 'living', initialId: chapter.id })} onExpand={(instruction) => showDialog({ kind: 'ai', initialInstruction: instruction, useLivingContext: true })} />}
          </div>
          <section ref={manuscriptScroll} onScroll={(event) => { if (chapter && studioView === 'write' && !isCanvasView) rememberWritingPosition(workspace.rootPath, chapter.bookId, chapter.id, { scrollTop: event.currentTarget.scrollTop }) }} className={styles.manuscript} aria-label="正文编辑区">{chapter ? <>
            {aiWritingReceipt && aiWritingReceipt.root === workspace.rootPath && aiWritingReceipt.previous.bookId === chapter.bookId && aiWritingReceipt.previous.id === chapter.id && <div className={styles.finalizedMemory} aria-label="AI 写入回执">
              <span role="status">{aiWritingReceipt.undone ? '已撤销本次 AI 写入，采用稿保留在版本历史。' : chapter.revisionId !== aiWritingReceipt.adoptedRevisionId || session.session.dirty ? 'AI 已写入；正文已有后续修改，请在版本历史中核对。' : 'AI 已写入正文，可撤销本次写入。'}</span>
              {!aiWritingReceipt.undone && <button className={styles.button} type="button" disabled={busy || archived || bookRecoveryLocked || hasBlockingDialog || session.session.dirty || session.session.composing || chapter.revisionId !== aiWritingReceipt.adoptedRevisionId} onClick={() => void undoAiWriting()}><StudioIcon name="undo" size={16} />撤销本次 AI 写入</button>}
              <button className={styles.button} type="button" disabled={busy || bookRecoveryLocked} onClick={() => showDialog({ kind: 'history' })}>版本历史</button>
            </div>}
            {chapter.finalizedRevisionId && <p className={styles.finalizedNote}>本章已有作者定稿。继续修改将生成新工作稿，原定稿完整保留。</p>}
            {chapter.finalizedRevisionId === chapter.revisionId && <div className={styles.finalizedMemory}><span>定稿后的摘要、事件和人物状态可整理为带引文的记忆批次。</span><button className={styles.button} type="button" disabled={busy} onClick={() => showDialog({ kind: 'living', tab: 'memory', initialId: chapter.id })}>整理与复核本章记忆</button></div>}
            <ManuscriptEditor key={chapter.bookId + ':' + chapter.id + ':' + session.session.loadEpoch} title={chapter.title} document={chapter.document} disabled={studioView !== 'write' || isCanvasView || busy || bookRecoveryLocked || hasBlockingDialog} readOnly={archived} displayPreferences={display.preferences} onChange={session.changed} onComposition={session.setComposing} initialPosition={navigationPosition.current?.bookId === chapter.bookId && navigationPosition.current.chapterId === chapter.id ? navigationPosition.current.position : writingPosition(workspace.rootPath, chapter.bookId)?.chapterId === chapter.id ? writingPosition(workspace.rootPath, chapter.bookId) : null} onPositionChange={(position) => { if (studioView === 'write' && !isCanvasView) rememberWritingPosition(workspace.rootPath, chapter.bookId, chapter.id, position) }}
              onSelectionAction={(instruction, rewrite) => showDialog({ kind: 'ai', initialInstruction: instruction, rewrite })}
              onAnnotate={(selection) => showDialog({ kind: 'workbench', tab: 'review', annotation: { chapterId: chapter.id, ...selection } })}
              annotationContext={api ? { api, bookId: chapter.bookId, bookRevision: book.book.revision, chapterId: chapter.id, revisionId: chapter.revisionId,
                dirty: session.session.dirty || session.session.saving, onReviewIssue: (issueId, reviewAction) => showDialog({ kind: 'workbench', tab: 'review', issueId, reviewAction }) } : undefined}
              footer={<><span>{session.session.characterCount.toLocaleString()} 字 · {statusLabels[chapter.status]}{chapter.viewpoint ? ` · 视角 ${chapter.viewpoint}` : ''}</span><StellarTooltip><button type="button" title="本章资料与写作目标" aria-label="本章资料与写作目标" disabled={busy || archived} onClick={() => showDialog({ kind: 'chapterDetails' })}><StudioIcon name="notes" size={16} /></button></StellarTooltip></>} />
          </> : <StellarEmpty icon={archived ? 'lock' : 'list'} tone="warning" heading="h2"
            title={book.chapters.length ? '从左侧选择一章继续落笔' : archived ? '此归档作品还没有章节' : '暂无章节'}
            description={book.chapters.length ? '点击左侧卷章目录打开正文，或去「章节规划」用已有文字连接下一章。' : archived ? '此作品已归档，继续编辑前请在作品资料中解除归档。' : '为作品添加第一个章节吧'}
            hint={archived ? '归档作品保持只读' : '从章节开始，构建你的故事'}>
              {!archived && <button className={styles.primaryButton} type="button" onClick={() => showDialog({ kind: 'newChapter', volumeId: null })} disabled={busy}><StudioIcon name="pen" size={20} />{book.chapters.length ? '建立章节' : '新建第一章'}</button>}
              <button className={styles.button} type="button" onClick={() => openToolFromNav('workbench')} disabled={busy}><StudioIcon name="compass" size={15} />打开章节规划</button>
              <button className={styles.button} type="button" onClick={() => openToolFromNav('knowledge')} disabled={busy}><StudioIcon name="read" size={15} />整理故事设定</button>
          </StellarEmpty>}</section>

          {isAiInWriteDrawer && api && chapter ? (
            <aside ref={inspectorDrawer} tabIndex={-1} className={`${styles.companionAside} ${styles.aiCopilotAside}`} data-explicit={modal?.kind === 'ai'} aria-label="AI 创作副驾驶">
              {inspectorTabs}
              <DialogDisplayContext.Provider value="drawer">
                <AiPanel key={`${book.book.id}:${aiPreset?.id ?? ''}:${modal?.kind === 'ai' ? `${modal.purpose ?? ''}:${modal.initialRunId ?? ''}` : ''}:${aiTask ?? ''}:${aiInstruction ?? ''}:${aiResourceKey}:${aiRewrite?.firstBlockId ?? ''}:${aiRewrite?.lastBlockId ?? ''}`} initialRunId={modal?.kind === 'ai' ? modal.initialRunId : undefined} initialTask={aiTask} initialPreset={aiPreset} initialRewrite={aiRewrite} initialResources={aiResources} initialPurpose={modal?.kind === 'ai' ? modal.purpose : undefined} initialInstruction={aiInstruction} initialLivingContext={aiLivingContext} api={api} book={book} chapter={chapter} busy={busy} error={modalError} pendingMessage={pendingMessage} checkingReceipt={checkingReceipt} onCheckReceipt={() => void checkMutationReceipt()} onRecover={() => openRecovery(true)} onClose={closeModal} onDirtyChange={(value) => { aiDirty.current = value }} onBookChange={applyBook} onUpgrade={upgradeKnowledge} onAdopt={adoptAi} onAdoptMemory={adoptAiMemory} onRegisterClose={registerAiDrawerClose} onUseStudy={useStudyMaterials} onOpenReviewChecklist={openReviewChecklist} onSummary={(preset) => showDialog({ kind: 'aiSummary', initialPreset: preset })} />
              </DialogDisplayContext.Provider>
            </aside>
          ) : companionOpen && api ? (
            <aside ref={inspectorDrawer} tabIndex={-1} className={styles.companionAside} aria-label="伴随资料">
              {inspectorTabs}
              <CompanionPanel api={api} book={book} chapter={chapter} scopeKey={workspace.rootPath ?? ''} busy={busy || hasBlockingDialog || session.session.composing} onNavigate={navigateCompanion} onReturn={returnFromCompanion} canReturn={Boolean(returnLocation && returnLocation.root === workspace.rootPath && returnLocation.bookId === book.book.id)} onClose={() => switchWriteAside('collapsed')} />
            </aside>
          ) : rightAsideExpanded ? (
            <aside className={styles.memoryAside} aria-label="本章记录">
              {inspectorTabs}
              <div className={styles.asideHeadingRow}>
                <div className={styles.asideHeading}>本章与副驾驶</div>
                {chapter && <button type="button" className={styles.asideQuickAi} onClick={() => switchWriteAside('ai')} disabled={busy}><StudioIcon name="spark" size={13} />共写</button>}
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
                    <button type="button" onClick={() => switchWriteAside('companion')} disabled={busy}>查阅人物/伏笔</button>
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
          ) : null}
        </div>
      </div>}
    </main>
    <footer className={styles.statusbar} aria-label="工作室状态">
      <span className={`${styles.saveState} ${session.session.error ? styles.saveError : session.session.dirty || session.session.saving || session.session.composing ? styles.savePending : ''}`} role="status"><span className={styles.statusDot} />{chapter ? saveLabel(session.session) : workspace.rootPath ? '本地作品库已连接' : '未选择作品库'}</span>
      <button type="button" disabled={!api || busy || bookRecoveryLocked} onClick={() => book ? showDialog({ kind: 'aiMemoryTasks' }) : startBook('newBook')} title={!api ? '本地服务未连接' : workspaceLockedReason ?? '查看逐章整理任务'}><StudioIcon name="spark" size={14} /> 整理任务</button>
      <span>{chapter ? `${session.session.characterCount.toLocaleString()} 字 · ${statusLabels[chapter.status]}` : `${workspace.books.length} 部作品 · 本机存储`}</span>
      {focused && <button type="button" onClick={() => setFocused(false)} title="退出专注 · Esc"><StudioIcon name="focus" size={16} />退出专注</button>}
      {chapter && <StellarTooltip><button className={styles.saveButton} type="button" aria-label="保存当前章节" title={saveHint} aria-busy={session.session.saving} onClick={() => void session.flush()} disabled={busy || !session.session.dirty || session.session.saving || session.session.composing}><StudioIcon name="save" size={16} /></button></StellarTooltip>}
    </footer>
    <nav className={styles.mobileTabs} aria-label="主要页面">
      <button type="button" aria-current={!isCanvasView && studioView === 'home' ? 'page' : undefined} onClick={() => void showHome()} disabled={busy || bookRecoveryLocked}><StudioIcon name="home" size={21} /><span>工作台</span></button>
      <button type="button" aria-current={!isCanvasView && studioView === 'write' ? 'page' : undefined} onClick={resumeWriting} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="pen" size={21} /><span>写作</span></button>
      <button type="button" aria-current={!isCanvasView && studioView === 'shelf' ? 'page' : undefined} onClick={() => workspace.rootPath ? void showShelf() : void openWorkspace()} disabled={!api || busy || bookRecoveryLocked}><StudioIcon name="books" size={21} /><span>书架</span></button>
      <button type="button" aria-haspopup="dialog" aria-expanded={navigationOpen} aria-disabled={hasBlockingDialog || recoveryBusy || checkingReceipt || session.session.saving || session.session.composing || (busy && !pendingMessage)} onClick={openNavigation}><StudioIcon name="more" size={21} /><span>更多</span></button>
    </nav>
    {navigationOpen && <Dialog title="工作室导航" className={`${styles.lightDialog} ${styles.navigationSheet}`} onClose={() => setNavigationOpen(false)}>{navigation}</Dialog>}
    {modal?.kind === 'newBook' && <NewBookDialog onSubmit={(input) => void createBook(input)} onImport={() => setModal({ kind: 'import' })} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmCloseRequested={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
    {modal?.kind === 'newChapter' && <NameDialog title="新建章节" submitLabel="建立章节" onSubmit={(title) => void createChapter(title, modal.volumeId)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'volume' && <NameDialog title={modal.volumeId ? '修改卷名' : '新建卷'} initialValue={book?.volumes.find((item) => item.id === modal.volumeId)?.title} submitLabel="保存卷名" onSubmit={(title) => void saveVolume(title, modal.volumeId)} onClose={closeModal} busy={busy} error={modalError} />}
    {modal?.kind === 'bookDetails' && <BookDetailsDialog key={modal.book.id} book={modal.book} onSubmit={(fields) => void updateBookDetails(modal.book, fields)} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmClose={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
    {modal?.kind === 'chapterDetails' && chapter && book && <ChapterDetailsDialog key={chapter.id} chapter={chapter} volumes={book.volumes} onSubmit={(fields) => void updateChapterDetails(fields)} onClose={closeModal} busy={busy} error={modalError} onDirtyChange={markDetailsDirty} confirmClose={detailsCloseRequested} onKeepEditing={() => setDetailsCloseRequested(false)} pendingRecovery={detailsRecovery} />}
    {modal?.kind === 'finalize' && chapter && <ConfirmDialog title="作者定稿" label="确认当前稿为定稿" onSubmit={() => void finalizeChapter()} onClose={closeModal} busy={busy} error={modalError}>当前正文会先保存，再成为本章新的作者定稿。后续编辑会生成工作稿，导出时仍可单独选择这次定稿。</ConfirmDialog>}
    {modal?.kind === 'import' && api && <TextImportDialog api={api} onCommit={(token, title) => void commitImport(token, title)} onClose={closeModal} busy={busy} error={modalError} />}
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
