import type { ManuscriptDocument } from './manuscript'
import type { AiConnectionProbeInput, AiConnectionProbeResult } from './ai-connection-probe'
import type { AiKeySessionInput, AiKeySessionReceipt } from './ai-key-session'
import type { ImageGenerationApi } from './image-generation'
import type { LivingApi, LivingReadInput, LivingSnapshot, LivingRunDetail, LivingPrepareInput, LivingRunInput, LivingAdoptInput, LivingAdoptReceipt, SaveOutlineInput, OutlineHistoryInput, OutlineHistoryPage, RestoreOutlineInput, MemoryArchiveInput, MemoryArchivePage } from './living'
import type { SyncLivingMemoryInput } from './living'
import type { ForgeApi, ForgeSnapshot, ForgeReadInput, ForgePrepareInput, ForgeRunInput, ForgeRunDetail, ForgeAdoptInput, ForgeAdoptReceipt } from './forge'
import type { GenerationApi, StudioAiConnections, StudioAiConnection, StudioAiConnectionInput, KickstartDraftInput, KickstartSnapshot, GenerationReadInput, GenerationPrepareInput, GenerationRun, GenerationStartInput, GenerationVersionInput, GenerationCheckpointInput, GenerationFinishInput, GenerationSelectionInput, GenerationAdoptInput } from './generation'
import type { CreateKnowledgeItemInput, KnowledgeItemDetail, KnowledgeItemInput, KnowledgeItemPage, KnowledgeStatus, ListKnowledgeItemsInput, UpdateKnowledgeItemInput, UpgradeKnowledgeInput } from './knowledge'
import type { CreateStoryRecordInput, ListStoryRecordsInput, StoryRecordDetail, StoryRecordInput, StoryRecordPage, StoryRevision, StoryRevisionInput, UpdateStoryRecordInput } from './story'
import type { StoryTimelineInput, StoryTimelinePage } from './story-timeline'
import type { StoryGalaxyInput, StoryGalaxyPage } from './story-galaxy'
import type { WorldMapInput, WorldMapPage } from './world-map'
import type { AppearanceMatrixInput, AppearanceMatrixPage, ForeshadowRadarInput, ForeshadowRadarPage } from './story-control'
import type { CreateNoteInput, ListNotesInput, NoteDetail, NoteInput, NotePage, PromoteNoteInput, SetNoteChaptersInput, UpdateNoteInput } from './notes'
import type { NoteThumbnailImage, ReadNoteThumbnailInput } from './note-thumbnail'
import type { ForeshadowThumbnailImage, ReadForeshadowThumbnailInput } from './foreshadow-thumbnail'
import type { InspirationThumbnailImage, ReadInspirationThumbnailInput, UpgradeInspirationsInput, UpgradeInspirationsReceipt } from './inspiration-thumbnail'
import type { MemoryBookInput, MemoryControlInput, MemoryEvidence, MemoryEvidenceInput, MemorySearchInput, MemorySearchPage, MemoryStartInput, MemoryStatus, MemoryTaskInput, MemoryTaskReceipt } from './memory'
import type { AiAdoptInput, AiAdoptReceipt, AiBookInput, AiCheckpointInput, AiConfigureInput, AiConnection, AiConnectionPage, AiConnectionSaveInput, AiFinishInput, AiListInput, AiMemoryAdoptInput, AiMemoryAdoptReceipt, AiPrepareInput, AiPrepareServiceInput, AiRun, AiRunInput, AiRunPage, AiStartInput, AiVersionInput } from './ai'
import type { AiMemoryTaskControlInput, AiMemoryTaskDetail, AiMemoryTaskInput, AiMemoryTaskReadInput, AiMemoryTaskReceipt, AiMemoryTaskStartInput, AiMemoryTaskStatus } from './ai-memory-task'
import type { AiMemoryMaintenanceInput, AiMemoryMaintenancePage } from './ai-memory-maintenance'
import type { AiSummaryAdoptInput, AiSummaryAdoptReceipt, AiSummaryControlInput, AiSummaryNodeDetail, AiSummaryNodeInput, AiSummaryReadInput, AiSummaryReceipt, AiSummaryStartInput, AiSummaryStatus, AiSummaryTaskDetail, AiSummaryTaskInput } from './ai-summary'
import type { AiContextSummaryInput, AiContextSummaryPage } from './ai-context-summary'
import type { AiContextRecommendationInput, AiContextRecommendationPage } from './ai-context-recommendation'
import type { MemoryVectorFinishInput, MemoryVectorPrepareInput, MemoryVectorPrepareServiceInput, MemoryVectorProfileInput, MemoryVectorProfileServiceInput, MemoryVectorReadInput, MemoryVectorRun, MemoryVectorRunPage, MemoryVectorStartInput, MemoryVectorStatus, MemoryVectorVersionInput } from './memory-vector'
import type { BookRecoveryCatalog, BookRecoveryExportInput, BookRecoveryExportServiceInput, BookRecoveryExportReceipt, BookRecoveryPrepareInput, BookRecoveryPreview, BookRecoveryRestoreInput, BookRecoveryRestoreReceipt } from './book-recovery'
import type { RecoveryDraftInventory, RecoveryDraftListInput, RecoveryDraftRotateInput } from './book-recovery'
import type { CopyInspirationInput, InspirationItem, InspirationPage, ListInspirationInput, LogWritingSessionInput, ReorderScenesInput, SaveBriefInput, SaveInspirationInput, SaveReviewIssueInput, SaveSceneInput, SaveWritingGoalInput, WorkbenchSnapshot } from './workbench'
import type { ApplyReviewIssueInput, ApplyReviewIssueReceipt } from './workbench'
import type { ImportInspirationsInput, ImportInspirationsReceipt } from './workbench'
import type { GetWritingCalendarInput, SaveCalendarEntryInput, CalendarSnapshot } from './writing-calendar'
import type { WeaveSystemApi, WeaveMutationInput, WeaveSnapshot } from './weave-system'
import type { RealmApi, RealmMutationInput, RealmSimulationInput, RealmSimulation, RealmSnapshot } from './realm'
import type { StudyAdoptInput, StudyAdoptReceipt, StudySavedInput, StudySavedResults } from './study'
import type { AiPresetsApi, AiPresetsSnapshot, GetAiPresetsInput, SaveAiPresetInput } from './ai-presets'
import type { BookMediaApi, BookMediaImage, BookMediaSnapshot, GetBookMediaInput, ReadBookMediaInput, SaveBookMediaInput, ExportBookMediaServiceInput, BookMediaExportReceipt } from './book-media'
import type { RevisionMergeInput, RevisionMergeOutput } from './revision-merge'
import type { BookExportPrepareInput, BookExportPreview, BookExportChapterInput, BookExportChapterPreview, BookExportFileInput, BookExportDirectory, BookExportCommitServiceInput, BookExportReceipt } from './export'

export const IPC_CHANNEL = 'storyweave:request'
export const CLOSE_REQUEST_CHANNEL = 'storyweave:close-request'
export const CLOSE_RESPONSE_CHANNEL = 'storyweave:close-response'
export const CLOSE_CANCELLED_CHANNEL = 'storyweave:close-cancelled'
export const INTERFACE_FAULT_CHANNEL = 'storyweave:interface-fault'
export const INTERFACE_RECOVERY_CHANNEL = 'storyweave:interface-recovery'

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'WORKSPACE_REQUIRED'
  | 'WORKSPACE_BUSY'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'STORAGE_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'FORBIDDEN'

export interface AppError {
  code: ErrorCode
  message: string
  storageReason?: 'disk-full' | 'database-full'
  currentRevisionId?: string
  requestId?: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

export interface BookSummary {
  id: string
  title: string
  genre: string
  synopsis: string
  archivedAt: string | null
  revision: number
  createdAt: string
  updatedAt: string
  lifecycle?: 'kickstarting' | 'active' | 'finished'
}

export interface WorkspaceSnapshot {
  rootPath: string | null
  books: BookSummary[]
  recoveryScope?: string
}

export interface ChapterSummary {
  id: string
  title: string
  position: number
  revisionId: string
  characterCount: number
  updatedAt: string
  volumeId: string | null
  goal: string
  viewpoint: string
  targetCharacters: number | null
  notes: string
  status: ChapterStatus
  finalizedRevisionId: string | null
  finalizedAt: string | null
}

export type ChapterStatus = 'planned' | 'writing' | 'review' | 'finalized'
export interface VolumeSummary { id: string; title: string; position: number }

export interface BookSnapshot {
  book: BookSummary
  chapters: ChapterSummary[]
  volumes: VolumeSummary[]
  archivedChapters?: ChapterSummary[]
  archivedVolumes?: VolumeSummary[]
  chapterArchiveSupported?: boolean
}

export interface ChapterSnapshot extends ChapterSummary {
  archived?: boolean
  bookId: string
  document: ManuscriptDocument
  plainText: string
  bookRevision: number
}

export interface BookStarter { firstChapterTitle: string; protagonist: string; desire: string; obstacle: string }
export interface CreateBookInput { title: string; starter?: BookStarter }
export interface BookInput { bookId: string }
export interface CreateChapterInput extends BookInput { title: string; volumeId?: string | null }
export interface ChapterInput extends BookInput { chapterId: string }
export interface SaveChapterInput extends ChapterInput {
  expectedRevisionId: string
  document: ManuscriptDocument
}
export interface SaveChapterOutput {
  chapter: ChapterSnapshot
  changed: boolean
}

export interface BookMutationInput extends BookInput { expectedBookRevision: number }
export interface ArchiveStructureInput extends BookMutationInput { kind: 'chapter' | 'volume'; id: string; archived: boolean }
export interface UpdateBookInput extends BookMutationInput { title: string; genre: string; synopsis: string; archived: boolean }
export interface CreateVolumeInput extends BookMutationInput { title: string }
export interface RenameVolumeInput extends CreateVolumeInput { volumeId: string }
export interface ReorderVolumesInput extends BookMutationInput { volumeIds: string[] }
export interface ReorderChaptersInput extends BookMutationInput { chapterIds: string[] }
export interface UpdateChapterInput extends BookMutationInput, ChapterInput {
  title: string
  volumeId: string | null
  goal: string
  viewpoint: string
  targetCharacters: number | null
  notes: string
  status: Exclude<ChapterStatus, 'finalized'>
}
export interface FinalizeChapterInput extends BookMutationInput, ChapterInput { expectedRevisionId: string }
export interface RevisionInput extends ChapterInput { revisionId: string }
export interface ListRevisionsInput extends ChapterInput { beforeSequence?: number }
export interface RestoreRevisionInput extends RevisionInput { expectedRevisionId: string }
export interface RevisionSummary {
  id: string
  sequence: number
  parentRevisionId: string | null
  restoredFromRevisionId: string | null
  reason: 'created' | 'saved' | 'restored' | 'imported'
  characterCount: number
  createdAt: string
}
export interface RevisionPage { items: RevisionSummary[]; nextBeforeSequence: number | null }
export interface RevisionSnapshot extends RevisionSummary { bookId: string; chapterId: string; document: ManuscriptDocument; plainText: string }
export interface OrphanBook { book: BookSummary; chapterCount: number }
export interface OrphanScan { books: OrphanBook[]; skipped: number }

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
export type TextSplitMode = 'none' | 'headings'
export type TextExportFormat = 'txt' | 'markdown'
export interface TextImportOptions { encoding: TextEncoding; splitMode: TextSplitMode }
export interface ImportTokenInput { token: string }
export interface ReparseImportInput extends ImportTokenInput, TextImportOptions {}
export interface ImportChapterInput extends ImportTokenInput { index: number }
export interface ImportChapterPreview { index: number; title: string; plainText: string }
export interface TextImportPreview extends TextImportOptions {
  token: string
  sourceName: string
  sourceBytes: number
  totalCharacters: number
  chapters: { index: number; title: string; characterCount: number }[]
  warnings: string[]
}
export interface CommitImportInput extends ImportTokenInput { title: string }
export interface ExportBookInput extends BookMutationInput {
  format: TextExportFormat
  scope: 'working' | 'finalized'
  includeChapterTitles: boolean
}
export interface FileWriteReceipt { filePath: string; bytes: number }
export interface ExportBookReceipt extends FileWriteReceipt { chapterCount: number; characterCount: number; bookRevision: number }
export interface SaveDraftCopyInput extends ChapterInput { title: string; baseRevisionId: string; document: ManuscriptDocument }
export interface DraftImportData extends BookMutationInput { title: string; sourceName: string; sourceBytes: Uint8Array }
export interface DraftScopeInput { scope: string }
export interface DraftCheckpointInput extends SaveDraftCopyInput, DraftScopeInput { editorSessionId: string; editSequence: number }
export interface DraftCheckpointReceipt { checkpointId: string; createdAt: string; warning?: string }
export interface RecoveryDraftSummary extends ChapterInput {
  checkpointId: string
  title: string
  baseRevisionId: string
  createdAt: string
  characterCount: number
}
export interface RecoveryDraftList extends RecoveryDraftInventory { items: RecoveryDraftSummary[]; skipped: number; warnings: string[] }
export interface DraftPreviewInput extends BookMutationInput, DraftScopeInput {}
export interface RecoveryDraftInput extends DraftPreviewInput { checkpointId: string; generationId?: string }
export interface DraftImportPreview extends SaveDraftCopyInput {
  token: string
  sourceName: string
  createdAt: string
  characterCount: number
  plainText: string
  targetBookId: string
  expectedBookRevision: number
}
export interface CommitDraftImportInput extends DraftScopeInput { token: string; title: string }

export interface CommandMap {
  'living.get': { input: LivingReadInput; output: LivingSnapshot }
  'living.archive': { input: MemoryArchiveInput; output: MemoryArchivePage }
  'living.syncMemory': { input: SyncLivingMemoryInput; output: LivingSnapshot }
  'living.save': { input: SaveOutlineInput; output: LivingSnapshot }
  'living.history': { input: OutlineHistoryInput; output: OutlineHistoryPage }
  'living.restore': { input: RestoreOutlineInput; output: LivingSnapshot }
  'living.prepare': { input: LivingPrepareInput; output: LivingRunDetail }
  'living.run': { input: LivingRunInput; output: LivingRunDetail }
  'living.adopt': { input: LivingAdoptInput; output: LivingAdoptReceipt }
  'forge.get': { input: ForgeReadInput; output: ForgeSnapshot }
  'forge.prepare': { input: ForgePrepareInput; output: ForgeRunDetail }
  'forge.run': { input: ForgeRunInput; output: ForgeRunDetail }
  'forge.adopt': { input: ForgeAdoptInput; output: ForgeAdoptReceipt }
  'generation.connections': { input: undefined; output: StudioAiConnections }
  'generation.connection.save': { input: StudioAiConnectionInput; output: StudioAiConnection }
  'generation.draft': { input: KickstartDraftInput; output: KickstartSnapshot }
  'generation.get': { input: GenerationReadInput; output: KickstartSnapshot }
  'generation.prepare': { input: GenerationPrepareInput; output: GenerationRun }
  'generation.claim': { input: GenerationStartInput; output: GenerationRun }
  'generation.checkpoint': { input: GenerationCheckpointInput; output: GenerationRun }
  'generation.finish': { input: GenerationFinishInput; output: GenerationRun }
  'generation.interrupt': { input: GenerationVersionInput; output: GenerationRun }
  'generation.select': { input: GenerationSelectionInput; output: GenerationRun }
  'generation.adopt': { input: GenerationAdoptInput; output: KickstartSnapshot }
  'revision.merge': { input: RevisionMergeInput; output: RevisionMergeOutput }
  'book.export.prepare': { input: BookExportPrepareInput; output: BookExportPreview }
  'book.export.chapter': { input: BookExportChapterInput; output: BookExportChapterPreview }
  'book.export.commit': { input: BookExportCommitServiceInput; output: BookExportReceipt }
  'workbench.get': { input: BookInput; output: WorkbenchSnapshot }
  'workbench.brief': { input: SaveBriefInput; output: WorkbenchSnapshot }
  'workbench.scene': { input: SaveSceneInput; output: WorkbenchSnapshot }
  'workbench.scenes.reorder': { input: ReorderScenesInput; output: WorkbenchSnapshot }
  'workbench.issue': { input: SaveReviewIssueInput; output: WorkbenchSnapshot }
  'workbench.applyIssue': { input: ApplyReviewIssueInput; output: ApplyReviewIssueReceipt }
  'workbench.goal': { input: SaveWritingGoalInput; output: WorkbenchSnapshot }
  'workbench.session': { input: LogWritingSessionInput; output: WorkbenchSnapshot }
  'inspiration.list': { input: ListInspirationInput; output: InspirationPage }
  'inspiration.thumbnail': { input: ReadInspirationThumbnailInput; output: InspirationThumbnailImage }
  'inspiration.upgrade': { input: UpgradeInspirationsInput; output: UpgradeInspirationsReceipt }
  'inspiration.save': { input: SaveInspirationInput; output: InspirationItem }
  'inspiration.copy': { input: CopyInspirationInput; output: NoteDetail }
  'inspiration.import': { input: ImportInspirationsInput; output: ImportInspirationsReceipt }
  'calendar.get': { input: GetWritingCalendarInput; output: CalendarSnapshot }
  'calendar.save': { input: SaveCalendarEntryInput; output: CalendarSnapshot }
  'weave.get': { input: BookInput; output: WeaveSnapshot }
  'weave.mutate': { input: WeaveMutationInput; output: WeaveSnapshot }
  'realm.get': { input: BookInput; output: RealmSnapshot }
  'realm.mutate': { input: RealmMutationInput; output: RealmSnapshot }
  'realm.simulate': { input: RealmSimulationInput; output: RealmSimulation }
  'study.adopt': { input: StudyAdoptInput; output: StudyAdoptReceipt }
  'study.saved': { input: StudySavedInput; output: StudySavedResults }
  'ai.presets.get': { input: GetAiPresetsInput; output: AiPresetsSnapshot }
  'ai.presets.save': { input: SaveAiPresetInput; output: AiPresetsSnapshot }
  'book.media.get': { input: GetBookMediaInput; output: BookMediaSnapshot }
  'book.media.read': { input: ReadBookMediaInput; output: BookMediaImage }
  'book.media.save': { input: SaveBookMediaInput; output: BookMediaSnapshot }
  'book.media.export': { input: ExportBookMediaServiceInput; output: BookMediaExportReceipt }
  'workspace.get': { input: undefined; output: WorkspaceSnapshot }
  'workspace.open': { input: { rootPath: string }; output: WorkspaceSnapshot }
  'book.create': { input: CreateBookInput; output: BookSnapshot }
  'book.get': { input: BookInput; output: BookSnapshot }
  'book.summary': { input: BookInput; output: BookSummary }
  'book.update': { input: UpdateBookInput; output: BookSnapshot }
  'book.archiveStructure': { input: ArchiveStructureInput; output: BookSnapshot }
  'volume.create': { input: CreateVolumeInput; output: BookSnapshot }
  'volume.rename': { input: RenameVolumeInput; output: BookSnapshot }
  'volume.reorder': { input: ReorderVolumesInput; output: BookSnapshot }
  'chapter.reorder': { input: ReorderChaptersInput; output: BookSnapshot }
  'chapter.update': { input: UpdateChapterInput; output: ChapterSnapshot }
  'chapter.finalize': { input: FinalizeChapterInput; output: ChapterSnapshot }
  'chapter.create': { input: CreateChapterInput; output: ChapterSnapshot }
  'chapter.read': { input: ChapterInput; output: ChapterSnapshot }
  'chapter.save': { input: SaveChapterInput; output: SaveChapterOutput }
  'draft.import': { input: DraftImportData; output: ChapterSnapshot }
  'revision.list': { input: ListRevisionsInput; output: RevisionPage }
  'revision.read': { input: RevisionInput; output: RevisionSnapshot }
  'revision.restore': { input: RestoreRevisionInput; output: ChapterSnapshot }
  'workspace.orphans': { input: undefined; output: OrphanScan }
  'workspace.register': { input: BookInput; output: BookSnapshot }
  'import.prepare': { input: TextImportOptions & { filePath: string }; output: TextImportPreview }
  'import.reparse': { input: ReparseImportInput; output: TextImportPreview }
  'import.chapter': { input: ImportChapterInput; output: ImportChapterPreview }
  'import.commit': { input: CommitImportInput; output: BookSnapshot }
  'book.export': { input: ExportBookInput & { filePath: string }; output: ExportBookReceipt }
  'recovery.export': { input: BookRecoveryExportServiceInput; output: BookRecoveryExportReceipt }
  'recovery.catalog': { input: undefined; output: BookRecoveryCatalog }
  'recovery.prepare': { input: BookRecoveryPrepareInput; output: BookRecoveryPreview }
  'recovery.restore': { input: BookRecoveryRestoreInput; output: BookRecoveryRestoreReceipt }
  'knowledge.status': { input: BookInput; output: KnowledgeStatus }
  'knowledge.upgrade': { input: UpgradeKnowledgeInput; output: KnowledgeStatus }
  'knowledge.list': { input: ListKnowledgeItemsInput; output: KnowledgeItemPage }
  'knowledge.get': { input: KnowledgeItemInput; output: KnowledgeItemDetail }
  'knowledge.create': { input: CreateKnowledgeItemInput; output: KnowledgeItemDetail }
  'knowledge.update': { input: UpdateKnowledgeItemInput; output: KnowledgeItemDetail }
  'notes.list': { input: ListNotesInput; output: NotePage }
  'notes.get': { input: NoteInput; output: NoteDetail }
  'notes.thumbnail': { input: ReadNoteThumbnailInput; output: NoteThumbnailImage }
  'notes.create': { input: CreateNoteInput; output: NoteDetail }
  'notes.update': { input: UpdateNoteInput; output: NoteDetail }
  'notes.promote': { input: PromoteNoteInput; output: NoteDetail }
  'notes.chapters': { input: SetNoteChaptersInput; output: NoteDetail }
  'story.list': { input: ListStoryRecordsInput; output: StoryRecordPage }
  'story.timeline': { input: StoryTimelineInput; output: StoryTimelinePage }
  'story.galaxy': { input: StoryGalaxyInput; output: StoryGalaxyPage }
  'story.worldMap': { input: WorldMapInput; output: WorldMapPage }
  'story.matrix': { input: AppearanceMatrixInput; output: AppearanceMatrixPage }
  'story.radar': { input: ForeshadowRadarInput; output: ForeshadowRadarPage }
  'story.get': { input: StoryRecordInput; output: StoryRecordDetail }
  'story.thumbnail': { input: ReadForeshadowThumbnailInput; output: ForeshadowThumbnailImage }
  'story.revision': { input: StoryRevisionInput; output: StoryRevision }
  'story.create': { input: CreateStoryRecordInput; output: StoryRecordDetail }
  'story.update': { input: UpdateStoryRecordInput; output: StoryRecordDetail }
  'memory.status': { input: MemoryBookInput; output: MemoryStatus }
  'memory.start': { input: MemoryStartInput; output: MemoryTaskReceipt }
  'memory.step': { input: MemoryTaskInput; output: MemoryTaskReceipt }
  'memory.control': { input: MemoryControlInput; output: MemoryTaskReceipt }
  'memory.search': { input: MemorySearchInput; output: MemorySearchPage }
  'memory.evidence': { input: MemoryEvidenceInput; output: MemoryEvidence }
  'memory.vector.list': { input: MemoryBookInput; output: MemoryVectorRunPage }
  'memory.vector.status': { input: MemoryVectorProfileServiceInput; output: MemoryVectorStatus }
  'memory.vector.get': { input: MemoryVectorReadInput; output: MemoryVectorRun }
  'memory.vector.prepare': { input: MemoryVectorPrepareServiceInput; output: MemoryVectorRun }
  'memory.vector.claim': { input: MemoryVectorStartInput; output: MemoryVectorRun }
  'memory.vector.finish': { input: MemoryVectorFinishInput; output: MemoryVectorRun }
  'memory.vector.cancel': { input: MemoryVectorVersionInput; output: MemoryVectorRun }
  'memory.vector.interrupt': { input: MemoryVectorVersionInput; output: MemoryVectorRun }
  'ai.connection.list': { input: AiBookInput; output: AiConnectionPage }
  'ai.connection.save': { input: AiConnectionSaveInput; output: AiConnection }
  'ai.list': { input: AiListInput; output: AiRunPage }
  'ai.get': { input: AiRunInput; output: AiRun }
  'ai.prepare': { input: AiPrepareServiceInput; output: AiRun }
  'ai.context.summaries': { input: AiContextSummaryInput; output: AiContextSummaryPage }
  'ai.context.recommend': { input: AiContextRecommendationInput; output: AiContextRecommendationPage }
  'ai.claim': { input: AiStartInput; output: AiRun }
  'ai.checkpoint': { input: AiCheckpointInput; output: AiRun }
  'ai.finish': { input: AiFinishInput; output: AiRun }
  'ai.reject': { input: AiVersionInput; output: AiRun }
  'ai.interrupt': { input: AiVersionInput; output: AiRun }
  'ai.adopt': { input: AiAdoptInput; output: AiAdoptReceipt }
  'ai.memory.adopt': { input: AiMemoryAdoptInput; output: AiMemoryAdoptReceipt }
  'ai.task.status': { input: AiBookInput; output: AiMemoryTaskStatus }
  'ai.task.maintenance': { input: AiMemoryMaintenanceInput; output: AiMemoryMaintenancePage }
  'ai.task.get': { input: AiMemoryTaskReadInput; output: AiMemoryTaskDetail }
  'ai.task.start': { input: AiMemoryTaskStartInput; output: AiMemoryTaskReceipt }
  'ai.task.step': { input: AiMemoryTaskInput; output: AiMemoryTaskReceipt }
  'ai.task.control': { input: AiMemoryTaskControlInput; output: AiMemoryTaskReceipt }
  'ai.summary.status': { input: AiBookInput; output: AiSummaryStatus }
  'ai.summary.get': { input: AiSummaryReadInput; output: AiSummaryTaskDetail }
  'ai.summary.node': { input: AiSummaryNodeInput; output: AiSummaryNodeDetail }
  'ai.summary.start': { input: AiSummaryStartInput; output: AiSummaryReceipt }
  'ai.summary.step': { input: AiSummaryTaskInput; output: AiSummaryReceipt }
  'ai.summary.control': { input: AiSummaryControlInput; output: AiSummaryReceipt }
  'ai.summary.adopt': { input: AiSummaryAdoptInput; output: AiSummaryAdoptReceipt }
  'service.close': { input: undefined; output: null }
}

export type ServiceCommand = keyof CommandMap
export type ServiceRequest = {
  [K in ServiceCommand]: { id: string; command: K; payload: CommandMap[K]['input'] }
}[ServiceCommand]

export interface ServiceResponse {
  id: string
  result: Result<CommandMap[ServiceCommand]['output']>
}

export type CompletedRequest = {
  [K in ServiceCommand]: { command: K; result: Result<CommandMap[K]['output']> }
}[ServiceCommand]

export type RequestStatus =
  | { state: 'pending' }
  | { state: 'unknown' }
  | { state: 'completed'; response: CompletedRequest }

// renderer 只能选择目录并调用领域命令，不能传入任意磁盘路径或 SQL。
export interface StudioApi extends AiPresetsApi, BookMediaApi, GenerationApi, ImageGenerationApi, LivingApi, ForgeApi, WeaveSystemApi, RealmApi {
  mergeRevision(input: RevisionMergeInput): Promise<Result<RevisionMergeOutput>>
  prepareBookExport(input: BookExportPrepareInput): Promise<Result<BookExportPreview>>
  readBookExportChapter(input: BookExportChapterInput): Promise<Result<BookExportChapterPreview>>
  chooseBookExportDirectory(): Promise<Result<BookExportDirectory | null>>
  commitBookExport(input: BookExportFileInput): Promise<Result<BookExportReceipt | null>>
  revealBookExport(input: { exportId: string }): Promise<Result<null>>
  getWorkbench(input: BookInput): Promise<Result<WorkbenchSnapshot>>
  saveWritingBrief(input: SaveBriefInput): Promise<Result<WorkbenchSnapshot>>
  saveScene(input: SaveSceneInput): Promise<Result<WorkbenchSnapshot>>
  reorderScenes(input: ReorderScenesInput): Promise<Result<WorkbenchSnapshot>>
  saveReviewIssue(input: SaveReviewIssueInput): Promise<Result<WorkbenchSnapshot>>
  applyReviewIssue(input: ApplyReviewIssueInput): Promise<Result<ApplyReviewIssueReceipt>>
  saveWritingGoal(input: SaveWritingGoalInput): Promise<Result<WorkbenchSnapshot>>
  logWritingSession(input: LogWritingSessionInput): Promise<Result<WorkbenchSnapshot>>
  listInspirations(input: ListInspirationInput): Promise<Result<InspirationPage>>
  readInspirationThumbnail(input: ReadInspirationThumbnailInput): Promise<Result<InspirationThumbnailImage>>
  upgradeInspirations(input: UpgradeInspirationsInput): Promise<Result<UpgradeInspirationsReceipt>>
  saveInspiration(input: SaveInspirationInput): Promise<Result<InspirationItem>>
  copyInspirationToNote(input: CopyInspirationInput): Promise<Result<NoteDetail>>
  importInspirations(input: ImportInspirationsInput): Promise<Result<ImportInspirationsReceipt>>
  getWritingCalendar(input: GetWritingCalendarInput): Promise<Result<CalendarSnapshot>>
  saveCalendarEntry(input: SaveCalendarEntryInput): Promise<Result<CalendarSnapshot>>
  adoptStudyResults(input: StudyAdoptInput): Promise<Result<StudyAdoptReceipt>>
  readSavedStudyResults(input: StudySavedInput): Promise<Result<StudySavedResults>>
  getWorkspace(): Promise<Result<WorkspaceSnapshot>>
  selectWorkspace(): Promise<Result<WorkspaceSnapshot | null>>
  createBook(input: CreateBookInput): Promise<Result<BookSnapshot>>
  getBook(input: BookInput): Promise<Result<BookSnapshot>>
  getBookSummary(input: BookInput): Promise<Result<BookSummary>>
  updateBook(input: UpdateBookInput): Promise<Result<BookSnapshot>>
  archiveStructure(input: ArchiveStructureInput): Promise<Result<BookSnapshot>>
  createVolume(input: CreateVolumeInput): Promise<Result<BookSnapshot>>
  renameVolume(input: RenameVolumeInput): Promise<Result<BookSnapshot>>
  reorderVolumes(input: ReorderVolumesInput): Promise<Result<BookSnapshot>>
  reorderChapters(input: ReorderChaptersInput): Promise<Result<BookSnapshot>>
  updateChapter(input: UpdateChapterInput): Promise<Result<ChapterSnapshot>>
  finalizeChapter(input: FinalizeChapterInput): Promise<Result<ChapterSnapshot>>
  createChapter(input: CreateChapterInput): Promise<Result<ChapterSnapshot>>
  readChapter(input: ChapterInput): Promise<Result<ChapterSnapshot>>
  saveChapter(input: SaveChapterInput): Promise<Result<SaveChapterOutput>>
  listRevisions(input: ListRevisionsInput): Promise<Result<RevisionPage>>
  readRevision(input: RevisionInput): Promise<Result<RevisionSnapshot>>
  restoreRevision(input: RestoreRevisionInput): Promise<Result<ChapterSnapshot>>
  findOrphanBooks(): Promise<Result<OrphanScan>>
  registerOrphanBook(input: BookInput): Promise<Result<BookSnapshot>>
  selectTextImport(input: TextImportOptions): Promise<Result<TextImportPreview | null>>
  reparseTextImport(input: ReparseImportInput): Promise<Result<TextImportPreview>>
  readImportChapter(input: ImportChapterInput): Promise<Result<ImportChapterPreview>>
  commitTextImport(input: CommitImportInput): Promise<Result<BookSnapshot>>
  exportBook(input: ExportBookInput): Promise<Result<ExportBookReceipt | null>>
  exportBookRecovery(input: BookRecoveryExportInput): Promise<Result<BookRecoveryExportReceipt | null>>
  listBookRecoveries(): Promise<Result<BookRecoveryCatalog>>
  selectBookRecovery(): Promise<Result<BookRecoveryPreview | null>>
  restoreBookRecovery(input: BookRecoveryRestoreInput): Promise<Result<BookRecoveryRestoreReceipt>>
  saveDraftCopy(input: SaveDraftCopyInput): Promise<Result<FileWriteReceipt | null>>
  checkpointDraft(input: DraftCheckpointInput): Promise<Result<DraftCheckpointReceipt>>
  listRecoveryDrafts(input: RecoveryDraftListInput): Promise<Result<RecoveryDraftList>>
  rotateRecoveryDrafts(input: RecoveryDraftRotateInput): Promise<Result<RecoveryDraftList>>
  selectDraftImport(input: DraftPreviewInput): Promise<Result<DraftImportPreview | null>>
  previewRecoveryDraft(input: RecoveryDraftInput): Promise<Result<DraftImportPreview>>
  commitDraftImport(input: CommitDraftImportInput): Promise<Result<ChapterSnapshot>>
  getKnowledgeStatus(input: BookInput): Promise<Result<KnowledgeStatus>>
  upgradeKnowledge(input: UpgradeKnowledgeInput): Promise<Result<KnowledgeStatus>>
  listKnowledgeItems(input: ListKnowledgeItemsInput): Promise<Result<KnowledgeItemPage>>
  getKnowledgeItem(input: KnowledgeItemInput): Promise<Result<KnowledgeItemDetail>>
  createKnowledgeItem(input: CreateKnowledgeItemInput): Promise<Result<KnowledgeItemDetail>>
  updateKnowledgeItem(input: UpdateKnowledgeItemInput): Promise<Result<KnowledgeItemDetail>>
  listNotes(input: ListNotesInput): Promise<Result<NotePage>>
  getNote(input: NoteInput): Promise<Result<NoteDetail>>
  readNoteThumbnail(input: ReadNoteThumbnailInput): Promise<Result<NoteThumbnailImage>>
  createNote(input: CreateNoteInput): Promise<Result<NoteDetail>>
  updateNote(input: UpdateNoteInput): Promise<Result<NoteDetail>>
  promoteNote(input: PromoteNoteInput): Promise<Result<NoteDetail>>
  setNoteChapters(input: SetNoteChaptersInput): Promise<Result<NoteDetail>>
  listStoryRecords(input: ListStoryRecordsInput): Promise<Result<StoryRecordPage>>
  listStoryTimeline(input: StoryTimelineInput): Promise<Result<StoryTimelinePage>>
  listStoryGalaxy(input: StoryGalaxyInput): Promise<Result<StoryGalaxyPage>>
  getWorldMap(input: WorldMapInput): Promise<Result<WorldMapPage>>
  readAppearanceMatrix(input: AppearanceMatrixInput): Promise<Result<AppearanceMatrixPage>>
  listForeshadowRadar(input: ForeshadowRadarInput): Promise<Result<ForeshadowRadarPage>>
  getStoryRecord(input: StoryRecordInput): Promise<Result<StoryRecordDetail>>
  readForeshadowThumbnail(input: ReadForeshadowThumbnailInput): Promise<Result<ForeshadowThumbnailImage>>
  readStoryRevision(input: StoryRevisionInput): Promise<Result<StoryRevision>>
  createStoryRecord(input: CreateStoryRecordInput): Promise<Result<StoryRecordDetail>>
  updateStoryRecord(input: UpdateStoryRecordInput): Promise<Result<StoryRecordDetail>>
  getMemoryStatus(input: MemoryBookInput): Promise<Result<MemoryStatus>>
  startMemoryTask(input: MemoryStartInput): Promise<Result<MemoryTaskReceipt>>
  stepMemoryTask(input: MemoryTaskInput): Promise<Result<MemoryTaskReceipt>>
  controlMemoryTask(input: MemoryControlInput): Promise<Result<MemoryTaskReceipt>>
  searchMemory(input: MemorySearchInput): Promise<Result<MemorySearchPage>>
  readMemoryEvidence(input: MemoryEvidenceInput): Promise<Result<MemoryEvidence>>
  listMemoryVectorRuns(input: MemoryBookInput): Promise<Result<MemoryVectorRunPage>>
  getMemoryVectorStatus(input: MemoryVectorProfileInput): Promise<Result<MemoryVectorStatus>>
  getMemoryVectorRun(input: MemoryVectorReadInput): Promise<Result<MemoryVectorRun>>
  prepareMemoryVectorRun(input: MemoryVectorPrepareInput): Promise<Result<MemoryVectorRun>>
  startMemoryVectorRun(input: MemoryVectorStartInput): Promise<Result<MemoryVectorRun>>
  cancelMemoryVectorRun(input: MemoryVectorVersionInput): Promise<Result<MemoryVectorRun>>
  interruptMemoryVectorRun(input: MemoryVectorVersionInput): Promise<Result<MemoryVectorRun>>
  listAiConnections(input: AiBookInput): Promise<Result<AiConnectionPage>>
  configureAiConnection(input: AiConfigureInput): Promise<Result<AiConnectionPage>>
  testAiConnection(input: AiConnectionProbeInput): Promise<Result<AiConnectionProbeResult>>
  cancelAiConnectionTest(input: { requestId: string }): Promise<Result<null>>
  openAiKeySession(input: AiKeySessionInput): Promise<Result<AiKeySessionReceipt>>
  closeAiKeySession(input: AiKeySessionReceipt): Promise<Result<AiKeySessionReceipt>>
  listAiRuns(input: AiListInput): Promise<Result<AiRunPage>>
  getAiRun(input: AiRunInput): Promise<Result<AiRun>>
  prepareAiRun(input: AiPrepareInput): Promise<Result<AiRun>>
  listAiContextSummaries(input: AiContextSummaryInput): Promise<Result<AiContextSummaryPage>>
  recommendAiContext(input: AiContextRecommendationInput): Promise<Result<AiContextRecommendationPage>>
  startAiRun(input: AiStartInput): Promise<Result<AiRun>>
  cancelAiRun(input: AiRunInput): Promise<Result<AiRun>>
  rejectAiRun(input: AiVersionInput): Promise<Result<AiRun>>
  interruptAiRun(input: AiVersionInput): Promise<Result<AiRun>>
  adoptAiRun(input: AiAdoptInput): Promise<Result<AiAdoptReceipt>>
  adoptAiMemory(input: AiMemoryAdoptInput): Promise<Result<AiMemoryAdoptReceipt>>
  getAiMemoryTaskStatus(input: AiBookInput): Promise<Result<AiMemoryTaskStatus>>
  listAiMemoryMaintenance(input: AiMemoryMaintenanceInput): Promise<Result<AiMemoryMaintenancePage>>
  getAiMemoryTask(input: AiMemoryTaskReadInput): Promise<Result<AiMemoryTaskDetail>>
  startAiMemoryTask(input: AiMemoryTaskStartInput): Promise<Result<AiMemoryTaskReceipt>>
  stepAiMemoryTask(input: AiMemoryTaskInput): Promise<Result<AiMemoryTaskReceipt>>
  controlAiMemoryTask(input: AiMemoryTaskControlInput): Promise<Result<AiMemoryTaskReceipt>>
  getAiSummaryStatus(input: AiBookInput): Promise<Result<AiSummaryStatus>>
  getAiSummaryTask(input: AiSummaryReadInput): Promise<Result<AiSummaryTaskDetail>>
  getAiSummaryNode(input: AiSummaryNodeInput): Promise<Result<AiSummaryNodeDetail>>
  startAiSummaryTask(input: AiSummaryStartInput): Promise<Result<AiSummaryReceipt>>
  stepAiSummaryTask(input: AiSummaryTaskInput): Promise<Result<AiSummaryReceipt>>
  controlAiSummaryTask(input: AiSummaryControlInput): Promise<Result<AiSummaryReceipt>>
  adoptAiSummary(input: AiSummaryAdoptInput): Promise<Result<AiSummaryAdoptReceipt>>
  restartService(): Promise<Result<WorkspaceSnapshot>>
  getRequestStatus(input: { requestId: string }): Promise<Result<RequestStatus>>
  onCloseRequested(handler: () => Promise<boolean>): () => void
  onCloseCancelled(handler: () => void): () => void
  reportInterfaceFault?(): void
  recoverInterface?(action: 'reload' | 'reveal'): Promise<Result<null>>
}

export type RendererCommand = Exclude<ServiceCommand, 'workspace.open' | 'service.close' | 'import.prepare' | 'book.export' | 'book.export.commit' | 'book.media.export' | 'draft.import' | 'ai.connection.save' | 'ai.claim' | 'ai.checkpoint' | 'ai.finish' | 'memory.vector.claim' | 'memory.vector.finish' | 'recovery.export' | 'recovery.prepare' | 'generation.connection.save' | 'generation.claim' | 'generation.checkpoint' | 'generation.finish' | 'generation.interrupt'>
  | 'workspace.select' | 'request.status' | 'import.select' | 'book.exportFile' | 'draft.copy' | 'service.restart'
  | 'recovery.exportFile' | 'recovery.select'
  | 'book.export.directory' | 'book.export.commitFile' | 'book.export.reveal'
  | 'book.media.exportFile'
  | 'book.image.connections' | 'book.image.list' | 'book.image.get' | 'book.image.start' | 'book.image.cancel' | 'book.image.jpeg' | 'book.image.discard'
  | 'draft.checkpoint' | 'draft.list' | 'draft.rotate' | 'draft.select' | 'draft.preview' | 'draft.commit'
  | 'ai.configure' | 'ai.start' | 'ai.cancel'
  | 'connection.probe' | 'connection.probe.cancel'
  | 'connection.keys.open' | 'connection.keys.close'
  | 'generation.configure' | 'generation.start' | 'generation.cancel'
  | 'memory.vector.start'

export class DomainError extends Error {
  constructor(readonly detail: AppError) {
    super(detail.message)
    this.name = 'DomainError'
  }
}

export function failure(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new DomainError({ code: 'INVALID_INPUT', message: `${label}不能为空，且不能超过 ${maxLength} 个字符。` })
  }
  return value.trim()
}

export function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '作品、章节或版本标识无效。' })
  }
  return value
}

export function requiredInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new DomainError({ code: 'INVALID_INPUT', message: `${label}必须是有效的非负整数。` })
  }
  return value
}

export function optionalText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new DomainError({ code: 'INVALID_INPUT', message: `${label}不能超过 ${maxLength} 个字符。` })
  }
  return value.trim()
}

export function parseCreateBookInput(value: unknown): CreateBookInput {
  if (!isRecord(value)) throw new DomainError({ code: 'INVALID_INPUT', message: '新作品参数无效。' })
  const title = requiredText(value.title, '作品名称', 120)
  if (value.starter === undefined) return { title }
  if (!isRecord(value.starter)) throw new DomainError({ code: 'INVALID_INPUT', message: '故事种子无效。' })
  return { title, starter: { firstChapterTitle: requiredText(value.starter.firstChapterTitle, '第一章名称', 120),
    protagonist: optionalText(value.starter.protagonist, '主角', 500), desire: optionalText(value.starter.desire, '主角的愿望', 2_000),
    obstacle: optionalText(value.starter.obstacle, '主要阻碍', 2_000) } }
}
