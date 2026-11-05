import type { ManuscriptDocument } from './manuscript'

export const IPC_CHANNEL = 'storyweave:request'
export const CLOSE_REQUEST_CHANNEL = 'storyweave:close-request'
export const CLOSE_RESPONSE_CHANNEL = 'storyweave:close-response'
export const CLOSE_CANCELLED_CHANNEL = 'storyweave:close-cancelled'

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
}

export interface WorkspaceSnapshot {
  rootPath: string | null
  books: BookSummary[]
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
}

export interface ChapterSnapshot extends ChapterSummary {
  bookId: string
  document: ManuscriptDocument
  plainText: string
  bookRevision: number
}

export interface CreateBookInput { title: string }
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

export interface CommandMap {
  'workspace.get': { input: undefined; output: WorkspaceSnapshot }
  'workspace.open': { input: { rootPath: string }; output: WorkspaceSnapshot }
  'book.create': { input: CreateBookInput; output: BookSnapshot }
  'book.get': { input: BookInput; output: BookSnapshot }
  'book.update': { input: UpdateBookInput; output: BookSnapshot }
  'volume.create': { input: CreateVolumeInput; output: BookSnapshot }
  'volume.rename': { input: RenameVolumeInput; output: BookSnapshot }
  'volume.reorder': { input: ReorderVolumesInput; output: BookSnapshot }
  'chapter.reorder': { input: ReorderChaptersInput; output: BookSnapshot }
  'chapter.update': { input: UpdateChapterInput; output: ChapterSnapshot }
  'chapter.finalize': { input: FinalizeChapterInput; output: ChapterSnapshot }
  'chapter.create': { input: CreateChapterInput; output: ChapterSnapshot }
  'chapter.read': { input: ChapterInput; output: ChapterSnapshot }
  'chapter.save': { input: SaveChapterInput; output: SaveChapterOutput }
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
export interface StudioApi {
  getWorkspace(): Promise<Result<WorkspaceSnapshot>>
  selectWorkspace(): Promise<Result<WorkspaceSnapshot | null>>
  createBook(input: CreateBookInput): Promise<Result<BookSnapshot>>
  getBook(input: BookInput): Promise<Result<BookSnapshot>>
  updateBook(input: UpdateBookInput): Promise<Result<BookSnapshot>>
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
  saveDraftCopy(input: SaveDraftCopyInput): Promise<Result<FileWriteReceipt | null>>
  restartService(): Promise<Result<WorkspaceSnapshot>>
  getRequestStatus(input: { requestId: string }): Promise<Result<RequestStatus>>
  onCloseRequested(handler: () => Promise<boolean>): () => void
  onCloseCancelled(handler: () => void): () => void
}

export type RendererCommand = Exclude<ServiceCommand, 'workspace.open' | 'service.close' | 'import.prepare' | 'book.export'>
  | 'workspace.select' | 'request.status' | 'import.select' | 'book.exportFile' | 'draft.copy' | 'service.restart'

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
