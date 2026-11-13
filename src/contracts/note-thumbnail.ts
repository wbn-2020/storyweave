import { DomainError, isRecord, requiredId, requiredInteger } from './api'
import { BOOK_MEDIA_MIMES, MAX_BOOK_MEDIA_ITEM_BYTES, validateBookMediaPayload, type BookMediaMime } from './book-media'

export const NOTE_THUMBNAIL_SCHEMA_VERSION = 23
export const MAX_NOTE_THUMBNAILS = 100
export const MAX_NOTE_THUMBNAIL_BYTES = 64 * 1024 * 1024
export interface NoteThumbnailFields { mime: BookMediaMime; dataBase64: string; sha256: string; alt: string }
export interface NoteThumbnailMetadata {
  noteId: string; noteRevision: number; mime: BookMediaMime; byteLength: number; sha256: string; alt: string; createdAt: string
}
export interface ReadNoteThumbnailInput { bookId: string; id: string; imageRevision: number }
export interface NoteThumbnailImage extends NoteThumbnailMetadata { bookId: string; dataBase64: string }

function invalid(): never { throw new DomainError({ code: 'INVALID_INPUT', message: '素材缩略图的身份、格式或内容无效。' }) }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid()
  return value
}
function labels(value: Record<string, unknown>): { mime: BookMediaMime; sha256: string; alt: string } {
  if (!BOOK_MEDIA_MIMES.includes(value.mime as BookMediaMime) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.alt !== 'string' || value.alt.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.alt)) invalid()
  return { mime: value.mime as BookMediaMime, sha256: value.sha256, alt: value.alt }
}
export function parseNoteThumbnailFields(value: unknown): NoteThumbnailFields {
  const data = record(value, ['mime', 'dataBase64', 'sha256', 'alt']), parsed = labels(data)
  validateBookMediaPayload(parsed.mime, data.dataBase64)
  return { ...parsed, dataBase64: data.dataBase64 as string }
}
export function parseNoteThumbnailMetadata(value: unknown): NoteThumbnailMetadata {
  const data = record(value, ['noteId', 'noteRevision', 'mime', 'byteLength', 'sha256', 'alt', 'createdAt'])
  const parsed = labels(data), noteId = requiredId(data.noteId).toLowerCase()
  const noteRevision = requiredInteger(data.noteRevision, '缩略图笔记版本'), byteLength = requiredInteger(data.byteLength, '缩略图大小', MAX_BOOK_MEDIA_ITEM_BYTES)
  if (noteId !== data.noteId || noteRevision < 1 || byteLength < 4 || typeof data.createdAt !== 'string' || data.createdAt.length !== 24
    || !Number.isFinite(Date.parse(data.createdAt)) || new Date(data.createdAt).toISOString() !== data.createdAt) invalid()
  return { ...parsed, noteId, noteRevision, byteLength, createdAt: data.createdAt }
}
export function sameNoteThumbnail(left: NoteThumbnailMetadata | null, right: NoteThumbnailMetadata | null): boolean {
  return left === null || right === null ? left === right : left.noteId === right.noteId && left.noteRevision === right.noteRevision
    && left.mime === right.mime && left.byteLength === right.byteLength && left.sha256 === right.sha256 && left.alt === right.alt && left.createdAt === right.createdAt
}
export function matchesNoteThumbnail(metadata: NoteThumbnailMetadata | null, fields: NoteThumbnailFields | null): boolean {
  return metadata === null ? fields === null : fields !== null && metadata.mime === fields.mime && metadata.alt === fields.alt
    && metadata.sha256 === fields.sha256 && metadata.byteLength === validateBookMediaPayload(fields.mime, fields.dataBase64)
}
export function parseReadNoteThumbnailInput(value: unknown): ReadNoteThumbnailInput {
  const data = record(value, ['bookId', 'id', 'imageRevision'])
  const imageRevision = requiredInteger(data.imageRevision, '缩略图笔记版本')
  if (imageRevision < 1) invalid()
  return { bookId: requiredId(data.bookId).toLowerCase(), id: requiredId(data.id).toLowerCase(), imageRevision }
}
export function isNoteThumbnailImage(value: unknown, input: ReadNoteThumbnailInput): value is NoteThumbnailImage {
  try {
    const data = record(value, ['noteId', 'noteRevision', 'mime', 'byteLength', 'sha256', 'alt', 'createdAt', 'bookId', 'dataBase64'])
    const { bookId, dataBase64, ...rest } = data, metadata = parseNoteThumbnailMetadata(rest)
    return bookId === input.bookId && metadata.noteId === input.id && metadata.noteRevision === input.imageRevision
      && validateBookMediaPayload(metadata.mime, dataBase64) === metadata.byteLength
  } catch { return false }
}
