import { DomainError, isRecord, requiredId, requiredInteger, type ChapterStatus, type FileWriteReceipt } from './api'
import type { ManuscriptDocument } from './manuscript'

export const MAX_EXPORT_CHAPTERS = 20_000
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024
export const BOOK_EXPORT_PREVIEW_TTL = 30 * 60 * 1000
export const MAX_EXPORT_NOTE_LENGTH = 20_000

export type BookExportFormat = 'txt' | 'markdown' | 'epub' | 'docx'
export type BookExportScope = 'working' | 'finalized'
export type BookExportChapterState = 'included' | 'not_selected' | 'not_finalized' | 'unavailable'

export interface BookExportDocxOptions {
  submissionLayout: boolean
  preface: string
  afterword: string
}

export interface BookExportOptions {
  format: BookExportFormat
  scope: BookExportScope
  includeChapterTitles: boolean
  chapterIds: string[]
  author: string
  language: string
  docx?: BookExportDocxOptions
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
  docx?: BookExportDocxOptions
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
export interface BookExportDirectory { id: string; directoryPath: string }
export interface BookExportFileInput extends BookExportCommitInput {
  destination?: { directoryId: string; fileName: string }
}
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
  const data = record(value, ['bookId', 'expectedBookRevision', 'format', 'scope', 'includeChapterTitles', 'chapterIds', 'author', 'language', 'docx'])
  if ((data.format !== 'txt' && data.format !== 'markdown' && data.format !== 'epub' && data.format !== 'docx') ||
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
  let docx: BookExportDocxOptions | undefined
  if (data.docx !== undefined) {
    if (data.format !== 'docx') return invalid('投稿排版与前言后记仅用于 DOCX，请重新选择导出格式。')
    const options = record(data.docx, ['submissionLayout', 'preface', 'afterword'])
    if (typeof options.submissionLayout !== 'boolean' || typeof options.preface !== 'string' || typeof options.afterword !== 'string' ||
        options.preface.length > MAX_EXPORT_NOTE_LENGTH || options.afterword.length > MAX_EXPORT_NOTE_LENGTH) {
      return invalid(`DOCX 排版选项无效，前言与后记各不能超过 ${MAX_EXPORT_NOTE_LENGTH.toLocaleString()} 个字符。`)
    }
    docx = { submissionLayout: options.submissionLayout, preface: options.preface, afterword: options.afterword }
  }
  return {
    bookId: requiredId(data.bookId).toLowerCase(), expectedBookRevision: requiredInteger(data.expectedBookRevision, '作品版本'),
    format: data.format, scope: data.scope, includeChapterTitles: data.includeChapterTitles, chapterIds,
    author: data.author.trim(), language, ...(docx ? { docx } : {}),
  }
}

export function parseBookExportChapterInput(value: unknown): BookExportChapterInput {
  const data = record(value, [...referenceKeys, 'chapterId'])
  return { ...reference(data), chapterId: requiredId(data.chapterId).toLowerCase() }
}

export function parseBookExportCommitInput(value: unknown): BookExportCommitInput {
  const data = record(value, [...referenceKeys, 'format', 'acknowledgeOmissions'])
  if ((data.format !== 'txt' && data.format !== 'markdown' && data.format !== 'epub' && data.format !== 'docx') || typeof data.acknowledgeOmissions !== 'boolean') return invalid()
  return { ...reference(data), format: data.format, acknowledgeOmissions: data.acknowledgeOmissions }
}

export function bookExportFileNameProblem(value: string, format: BookExportFormat): string | null {
  if (!value || value.length > 200) return '文件名须为 1 至 200 个字符。'
  if (value !== value.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[ .]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(value)) {
    return '请使用普通文件名，不含路径、特殊字符、保留名称或首尾空格。'
  }
  const extension = `.${bookExportExtension(format)}`
  return value.length > extension.length && value.toLowerCase().endsWith(extension) ? null : `文件名须包含名称并以 ${extension} 结尾。`
}

export function parseBookExportFileInput(value: unknown): BookExportFileInput {
  const data = record(value, [...referenceKeys, 'format', 'acknowledgeOmissions', 'destination'])
  const input = parseBookExportCommitInput({ ...reference(data), format: data.format, acknowledgeOmissions: data.acknowledgeOmissions })
  if (data.destination === undefined) return input
  const destination = record(data.destination, ['directoryId', 'fileName'])
  if (typeof destination.fileName !== 'string') return invalid('请填写导出文件名。')
  const problem = bookExportFileNameProblem(destination.fileName, input.format)
  if (problem) return invalid(problem)
  return { ...input, destination: { directoryId: requiredId(destination.directoryId).toLowerCase(), fileName: destination.fileName } }
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
