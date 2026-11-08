import { DomainError, isRecord, requiredId, requiredInteger, requiredText, type BookSummary } from './api'

export const MAX_RECOVERY_BYTES = 8 * 1024 * 1024 * 1024
export const MAX_RECOVERY_FILES = 20_001
export const MAX_RECOVERY_MANIFEST_BYTES = 8 * 1024 * 1024

export interface RecoveryDraftListInput { scope: string; generationId?: string }
export interface RecoveryDraftRotateInput { scope: string; expectedGenerationId: string }
export interface RecoveryDraftGeneration { id: string; createdAt: string | null; active: boolean }
export interface RecoveryDraftCapacity { generationId: string; files: number; bytes: number; maxFiles: number; maxBytes: number }
export interface RecoveryDraftInventory {
  capacity: RecoveryDraftCapacity
  generations: RecoveryDraftGeneration[]
  selectedGenerationId: string
}

export interface BookRecoveryExportInput { bookId: string; expectedBookRevision: number }
export interface BookRecoveryExportServiceInput extends BookRecoveryExportInput { directoryPath: string }
export interface BookRecoveryPrepareInput { packagePath: string }
export interface BookRecoveryRestoreInput { token: string; packageId: string; manifestHash: string; resume?: boolean }
export interface BookRecoveryFile { path: string; bytes: number; sha256: string }
export interface BookRecoveryManifest {
  format: 'storyweave-book-recovery'
  version: 1
  packageId: string
  createdAt: string
  book: BookSummary
  schemaVersion: number
  chapterCount: number
  revisionCount: number
  files: BookRecoveryFile[]
}
export interface BookRecoveryPreview {
  token: string
  packageId: string
  manifestHash: string
  createdAt: string
  book: BookSummary
  schemaVersion: number
  chapterCount: number
  revisionCount: number
  sourceCount: number
  totalBytes: number
  packagePath: string
  targetRoot: string
  conflict: boolean
  targetState: 'new' | 'resumable' | 'incomplete' | 'conflict'
  targetMessage: string
}
export interface BookRecoveryExportReceipt {
  packageId: string
  packagePath: string
  manifestHash: string
  createdAt: string
  bookId: string
  bookRevision: number
  schemaVersion: number
  chapterCount: number
  revisionCount: number
  sourceCount: number
  totalBytes: number
}
export interface BookRecoveryRestoreReceipt {
  packageId: string
  manifestHash: string
  targetRoot: string
  book: BookSummary
  chapterCount: number
  revisionCount: number
  sourceCount: number
}

function invalid(): DomainError {
  return new DomainError({ code: 'INVALID_INPUT', message: '作品恢复包格式或请求无效，请重新选择完整恢复包。' })
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) throw invalid()
  return value
}
function id(value: unknown): string {
  const result = requiredId(value)
  if (result !== result.toLowerCase()) throw invalid()
  return result
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid()
  return value
}
function time(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid()
  return value
}
function path(value: unknown): string {
  const result = requiredText(value, '本地目录', 32767)
  if (result !== value || !/^[a-z]:[\\/]/i.test(result) || result.slice(2).includes(':') || result.includes('\0')) throw invalid()
  return result
}
function book(value: unknown): BookSummary {
  const data = record(value, ['id', 'title', 'genre', 'synopsis', 'archivedAt', 'revision', 'createdAt', 'updatedAt'])
  const title = requiredText(data.title, '作品名', 120)
  if (title !== data.title || typeof data.genre !== 'string' || data.genre.length > 120 || typeof data.synopsis !== 'string' || data.synopsis.length > 20_000) throw invalid()
  return { id: id(data.id), title, genre: data.genre, synopsis: data.synopsis,
    archivedAt: data.archivedAt === null ? null : time(data.archivedAt), revision: requiredInteger(data.revision, '作品版本'),
    createdAt: time(data.createdAt), updatedAt: time(data.updatedAt) }
}
function schema(value: unknown): number {
  const version = requiredInteger(value, '作品格式版本', 13)
  if (version < 2) throw invalid()
  return version
}
function counts(value: Record<string, unknown>): void {
  const chapters = requiredInteger(value.chapterCount, '章节数', 20_000)
  const revisions = requiredInteger(value.revisionCount, '正文版本数')
  if (revisions < chapters) throw invalid()
}
function totals(value: Record<string, unknown>): void {
  counts(value)
  requiredInteger(value.sourceCount, '导入原件数', MAX_RECOVERY_FILES - 1)
  if (requiredInteger(value.totalBytes, '恢复包字节数', MAX_RECOVERY_BYTES) === 0) throw invalid()
}

export function parseBookRecoveryExportInput(value: unknown): BookRecoveryExportInput {
  const data = record(value, ['bookId', 'expectedBookRevision'])
  return { bookId: requiredId(data.bookId).toLowerCase(), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本') }
}
export function parseBookRecoveryExportServiceInput(value: unknown): BookRecoveryExportServiceInput {
  const data = record(value, ['bookId', 'expectedBookRevision', 'directoryPath'])
  return { ...parseBookRecoveryExportInput({ bookId: data.bookId, expectedBookRevision: data.expectedBookRevision }), directoryPath: path(data.directoryPath) }
}
export function parseBookRecoveryPrepareInput(value: unknown): BookRecoveryPrepareInput {
  const data = record(value, ['packagePath'])
  return { packagePath: path(data.packagePath) }
}
export function parseBookRecoveryRestoreInput(value: unknown): BookRecoveryRestoreInput {
  const data = record(value, ['token', 'packageId', 'manifestHash', 'resume'])
  if (data.resume !== undefined && typeof data.resume !== 'boolean') throw invalid()
  return { token: id(data.token), packageId: id(data.packageId), manifestHash: digest(data.manifestHash), ...(data.resume === undefined ? {} : { resume: data.resume }) }
}

export function parseBookRecoveryManifest(value: unknown): BookRecoveryManifest {
  const data = record(value, ['format', 'version', 'packageId', 'createdAt', 'book', 'schemaVersion', 'chapterCount', 'revisionCount', 'files'])
  if (data.format !== 'storyweave-book-recovery' || data.version !== 1 || !Array.isArray(data.files) || data.files.length === 0 || data.files.length > MAX_RECOVERY_FILES) throw invalid()
  counts(data)
  const seen = new Set<string>()
  let total = 0
  const files = data.files.map((item: unknown, index): BookRecoveryFile => {
    const file = record(item, ['path', 'bytes', 'sha256'])
    if (typeof file.path !== 'string' || (index === 0 ? file.path !== 'book.sqlite' : !/^sources\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.original$/.test(file.path)) || seen.has(file.path)) throw invalid()
    const bytes = requiredInteger(file.bytes, '文件字节数', index === 0 ? MAX_RECOVERY_BYTES : 32 * 1024 * 1024)
    if (index === 0 && bytes < 100) throw invalid()
    total += bytes
    if (total > MAX_RECOVERY_BYTES) throw invalid()
    seen.add(file.path)
    return { path: file.path, bytes, sha256: digest(file.sha256) }
  })
  // 恢复包只能引用明确支持的作品资产，清单中的路径不能扩展到任意本地文件。
  return { format: data.format, version: data.version, packageId: id(data.packageId), createdAt: time(data.createdAt),
    book: book(data.book), schemaVersion: schema(data.schemaVersion), chapterCount: data.chapterCount as number,
    revisionCount: data.revisionCount as number, files }
}

export function isBookRecoveryPreviewFor(value: unknown, targetRoot: string): value is BookRecoveryPreview {
  try {
    const data = record(value, ['token', 'packageId', 'manifestHash', 'createdAt', 'book', 'schemaVersion', 'chapterCount', 'revisionCount', 'sourceCount', 'totalBytes', 'packagePath', 'targetRoot', 'conflict', 'targetState', 'targetMessage'])
    id(data.token); id(data.packageId); digest(data.manifestHash); time(data.createdAt); book(data.book); schema(data.schemaVersion); totals(data)
    path(data.packagePath); path(data.targetRoot)
    return data.targetRoot === targetRoot && typeof data.targetMessage === 'string' && data.targetMessage.length <= 2000 &&
      ['new', 'resumable', 'incomplete', 'conflict'].includes(String(data.targetState)) &&
      data.conflict === (data.targetState === 'incomplete' || data.targetState === 'conflict')
  } catch { return false }
}
export function isBookRecoveryExportReceiptFor(value: unknown, input: BookRecoveryExportInput): value is BookRecoveryExportReceipt {
  try {
    const data = record(value, ['packageId', 'packagePath', 'manifestHash', 'createdAt', 'bookId', 'bookRevision', 'schemaVersion', 'chapterCount', 'revisionCount', 'sourceCount', 'totalBytes'])
    id(data.packageId); digest(data.manifestHash); time(data.createdAt); path(data.packagePath); schema(data.schemaVersion); totals(data)
    return id(data.bookId) === input.bookId && requiredInteger(data.bookRevision, '作品版本') === input.expectedBookRevision
  } catch { return false }
}
export function isBookRecoveryRestoreReceiptFor(value: unknown, preview: BookRecoveryPreview): value is BookRecoveryRestoreReceipt {
  try {
    const data = record(value, ['packageId', 'manifestHash', 'targetRoot', 'book', 'chapterCount', 'revisionCount', 'sourceCount'])
    counts(data)
    requiredInteger(data.sourceCount, '导入原件数', MAX_RECOVERY_FILES - 1)
    return !preview.conflict && data.packageId === preview.packageId && data.manifestHash === preview.manifestHash &&
      data.targetRoot === preview.targetRoot && JSON.stringify(book(data.book)) === JSON.stringify(book(preview.book)) &&
      data.chapterCount === preview.chapterCount && data.revisionCount === preview.revisionCount && data.sourceCount === preview.sourceCount
  } catch { return false }
}
