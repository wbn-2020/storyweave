import { DomainError, isRecord, requiredId, requiredInteger, type ChapterStatus, type FileWriteReceipt } from './api'
import type { ManuscriptDocument } from './manuscript'

export const MAX_EXPORT_CHAPTERS = 20_000
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024
export const BOOK_EXPORT_PREVIEW_TTL = 30 * 60 * 1000

export type BookExportFormat = 'txt' | 'markdown' | 'epub'
export type BookExportScope = 'working' | 'finalized'
export type BookExportChapterState = 'included' | 'not_selected' | 'not_finalized' | 'unavailable'

export interface BookExportOptions {
  format: BookExportFormat
  scope: BookExportScope
  includeChapterTitles: boolean
  chapterIds: string[]
  author: string
  language: string
}

export interface BookExportPrepareInput extends BookExportOptions {
  bookId: string
  expectedBookRevision: number
}

export interface BookExportChapterEntry {
  chapterId: string
  title: string
  position: number
  volumeId: string | null
  volumeTitle: string | null
  status: ChapterStatus
  selected: boolean
  state: BookExportChapterState
  reason: string | null
  revisionId: string | null
  revisionSequence: number | null
  revisionCreatedAt: string | null
  contentHash: string | null
  characterCount: number | null
  contentBytes: number | null
}

export interface BookExportManifest {
  format: 'storyweave-book-export'
  version: 1
  exportId: string
  createdAt: string
  bookId: string
  bookTitle: string
  bookRevision: number
  outputFormat: BookExportFormat
  scope: BookExportScope
  includeChapterTitles: boolean
  author: string
  language: string
  chapters: BookExportChapterEntry[]
}

export interface BookExportPreview {
  token: string
  manifestHash: string
  manifest: BookExportManifest
  expiresAt: string
  chapterCount: number
  characterCount: number
  skippedCount: number
  emptyCount: number
  estimatedBytes: number
  requiresAcknowledgement: boolean
  canExport: boolean
  warnings: string[]
  blockingReasons: string[]
}

export interface BookExportReference {
  bookId: string
  expectedBookRevision: number
  token: string
  manifestHash: string
}

export interface BookExportChapterInput extends BookExportReference { chapterId: string }
export interface BookExportChapterPreview {
  bookId: string
  chapterId: string
  revisionId: string
  title: string
  format: BookExportFormat
  language: string
  includeChapterTitles: boolean
  document: ManuscriptDocument
  text: string
}

export interface BookExportCommitInput extends BookExportReference { format: BookExportFormat; acknowledgeOmissions: boolean }
export interface BookExportCommitServiceInput extends BookExportCommitInput { filePath: string }
export interface BookExportReceipt extends FileWriteReceipt {
  exportId: string
  bookId: string
  bookRevision: number
  chapterCount: number
  characterCount: number
  skippedCount: number
  manifestPath: string
  manifestBytes: number
  manifestHash: string
  sha256: string
}

function invalid(message = '导出选项无效，请重新生成预览。'): never {
  throw new DomainError({ code: 'INVALID_INPUT', message })
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) return invalid()
  return value
}

const referenceKeys = ['bookId', 'expectedBookRevision', 'token', 'manifestHash'] as const

function reference(data: Record<string, unknown>): BookExportReference {
  if (typeof data.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.manifestHash)) return invalid()
  return {
    bookId: requiredId(data.bookId).toLowerCase(), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    token: requiredId(data.token).toLowerCase(), manifestHash: data.manifestHash,
  }
}

export function parseBookExportPrepareInput(value: unknown): BookExportPrepareInput {
  const data = record(value, ['bookId', 'expectedBookRevision', 'format', 'scope', 'includeChapterTitles', 'chapterIds', 'author', 'language'])
  if ((data.format !== 'txt' && data.format !== 'markdown' && data.format !== 'epub') ||
      (data.scope !== 'working' && data.scope !== 'finalized') || typeof data.includeChapterTitles !== 'boolean') return invalid()
  if (!Array.isArray(data.chapterIds) || data.chapterIds.length === 0 || data.chapterIds.length > MAX_EXPORT_CHAPTERS) {
    return invalid(`请明确选择 1 至 ${MAX_EXPORT_CHAPTERS.toLocaleString()} 个章节。`)
  }
  const chapterIds = Array.from(data.chapterIds, (id) => requiredId(id).toLowerCase())
  if (new Set(chapterIds).size !== chapterIds.length) return invalid('章节选择存在重复，请重新勾选。')
  if (typeof data.author !== 'string' || data.author.length > 120) return invalid('署名不能超过 120 个字符。')
  if (typeof data.language !== 'string' || data.language.length > 64 || !data.language.trim()) return invalid('请填写正文语言，例如 zh-CN 或 en。')
  let language: string
  try { language = new Intl.Locale(data.language.trim()).baseName } catch { return invalid('正文语言无效，请使用 zh-CN、en 等语言标签。') }
  return {
    bookId: requiredId(data.bookId).toLowerCase(), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    format: data.format, scope: data.scope, includeChapterTitles: data.includeChapterTitles, chapterIds,
    author: data.author.trim(), language,
  }
}

export function parseBookExportChapterInput(value: unknown): BookExportChapterInput {
  const data = record(value, [...referenceKeys, 'chapterId'])
  return { ...reference(data), chapterId: requiredId(data.chapterId).toLowerCase() }
}

export function parseBookExportCommitInput(value: unknown): BookExportCommitInput {
  const data = record(value, [...referenceKeys, 'format', 'acknowledgeOmissions'])
  if ((data.format !== 'txt' && data.format !== 'markdown' && data.format !== 'epub') || typeof data.acknowledgeOmissions !== 'boolean') return invalid()
  return { ...reference(data), format: data.format, acknowledgeOmissions: data.acknowledgeOmissions }
}

export function parseBookExportCommitServiceInput(value: unknown): BookExportCommitServiceInput {
  const data = record(value, [...referenceKeys, 'format', 'acknowledgeOmissions', 'filePath'])
  if (typeof data.filePath !== 'string' || !data.filePath || data.filePath.length > 32767 || data.filePath.includes('\0')) return invalid('导出文件路径无效。')
  return {
    ...parseBookExportCommitInput({ ...reference(data), format: data.format, acknowledgeOmissions: data.acknowledgeOmissions }),
    filePath: data.filePath,
  }
}

export function bookExportExtension(format: BookExportFormat): string {
  return format === 'markdown' ? 'md' : format
}

export function bookExportReference(preview: BookExportPreview): BookExportReference {
  return { bookId: preview.manifest.bookId, expectedBookRevision: preview.manifest.bookRevision,
    token: preview.token, manifestHash: preview.manifestHash }
}
