import { DomainError, isRecord, requiredId, requiredInteger } from './api'
import { validateBookMediaPayload } from './book-media'
import { parseNoteThumbnailFields, parseNoteThumbnailMetadata, type NoteThumbnailFields } from './note-thumbnail'

export const FORESHADOW_THUMBNAIL_SCHEMA_VERSION = 24
export const MAX_FORESHADOW_THUMBNAILS = 100
export const MAX_FORESHADOW_THUMBNAIL_BYTES = 64 * 1024 * 1024
export type ForeshadowThumbnailFields = NoteThumbnailFields
export interface ForeshadowThumbnailMetadata extends Omit<NoteThumbnailFields, 'dataBase64'> {
  recordId: string; knowledgeRevision: number; byteLength: number; createdAt: string
}
export interface ReadForeshadowThumbnailInput { bookId: string; id: string; imageRevision: number }
export interface ForeshadowThumbnailImage extends ForeshadowThumbnailMetadata { bookId: string; dataBase64: string }

function invalid(): never { throw new DomainError({ code: 'INVALID_INPUT', message: '伏笔配图的身份、格式或内容无效。' }) }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid()
  return value
}
export function parseForeshadowThumbnailFields(value: unknown): ForeshadowThumbnailFields {
  try { return parseNoteThumbnailFields(value) } catch { return invalid() }
}
export function parseForeshadowThumbnailMetadata(value: unknown): ForeshadowThumbnailMetadata {
  const data = record(value, ['recordId', 'knowledgeRevision', 'mime', 'byteLength', 'sha256', 'alt', 'createdAt'])
  try {
    const { noteId, noteRevision, ...labels } = parseNoteThumbnailMetadata({
      noteId: data.recordId, noteRevision: data.knowledgeRevision, mime: data.mime, byteLength: data.byteLength,
      sha256: data.sha256, alt: data.alt, createdAt: data.createdAt,
    })
    return { recordId: noteId, knowledgeRevision: noteRevision, ...labels }
  } catch { return invalid() }
}
export function sameForeshadowThumbnail(left: ForeshadowThumbnailMetadata | null, right: ForeshadowThumbnailMetadata | null): boolean {
  return left === null || right === null ? left === right : left.recordId === right.recordId && left.knowledgeRevision === right.knowledgeRevision
    && left.mime === right.mime && left.byteLength === right.byteLength && left.sha256 === right.sha256 && left.alt === right.alt && left.createdAt === right.createdAt
}
export function matchesForeshadowThumbnail(metadata: ForeshadowThumbnailMetadata | null, fields: ForeshadowThumbnailFields | null): boolean {
  return metadata === null ? fields === null : fields !== null && metadata.mime === fields.mime && metadata.alt === fields.alt
    && metadata.sha256 === fields.sha256 && metadata.byteLength === validateBookMediaPayload(fields.mime, fields.dataBase64)
}
export function parseReadForeshadowThumbnailInput(value: unknown): ReadForeshadowThumbnailInput {
  const data = record(value, ['bookId', 'id', 'imageRevision']), imageRevision = requiredInteger(data.imageRevision, '伏笔配图版本')
  if (imageRevision < 1) invalid()
  return { bookId: requiredId(data.bookId).toLowerCase(), id: requiredId(data.id).toLowerCase(), imageRevision }
}
export function isForeshadowThumbnailImage(value: unknown, input: ReadForeshadowThumbnailInput): value is ForeshadowThumbnailImage {
  try {
    const data = record(value, ['recordId', 'knowledgeRevision', 'mime', 'byteLength', 'sha256', 'alt', 'createdAt', 'bookId', 'dataBase64'])
    const { bookId, dataBase64, ...rest } = data, metadata = parseForeshadowThumbnailMetadata(rest)
    return bookId === input.bookId && metadata.recordId === input.id && metadata.knowledgeRevision === input.imageRevision
      && validateBookMediaPayload(metadata.mime, dataBase64) === metadata.byteLength
  } catch { return false }
}
