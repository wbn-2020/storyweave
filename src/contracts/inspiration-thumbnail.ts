import { DomainError, isRecord, requiredId, requiredInteger } from './api'
import { validateBookMediaPayload } from './book-media'
import {
  matchesNoteThumbnail, parseNoteThumbnailMetadata, sameNoteThumbnail,
  type NoteThumbnailFields, type NoteThumbnailMetadata,
} from './note-thumbnail'

export const INSPIRATION_THUMBNAIL_SCHEMA_VERSION = 2
export const MAX_INSPIRATION_THUMBNAILS = 100
export const MAX_INSPIRATION_THUMBNAIL_BYTES = 64 * 1024 * 1024
export interface InspirationThumbnailMetadata extends Omit<NoteThumbnailMetadata, 'noteId' | 'noteRevision'> {
  inspirationId: string; inspirationRevision: number
}
export interface ReadInspirationThumbnailInput { id: string; imageRevision: number }
export interface InspirationThumbnailImage extends InspirationThumbnailMetadata { dataBase64: string }
export interface UpgradeInspirationsInput { expectedSchemaVersion: 1 }
export interface UpgradeInspirationsReceipt { schemaVersion: 2; backupPath: string }

function invalid(): never { throw new DomainError({ code: 'INVALID_INPUT', message: '全局灵感图片的身份、格式或启用参数无效。' }) }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid()
  return value
}
function asNote(value: InspirationThumbnailMetadata): NoteThumbnailMetadata {
  const { inspirationId, inspirationRevision, ...fields } = value
  return { ...fields, noteId: inspirationId, noteRevision: inspirationRevision }
}
export function parseInspirationThumbnailMetadata(value: unknown): InspirationThumbnailMetadata {
  const data = record(value, ['inspirationId', 'inspirationRevision', 'mime', 'byteLength', 'sha256', 'alt', 'createdAt'])
  const { inspirationId, inspirationRevision, ...fields } = data
  const { noteId, noteRevision, ...parsed } = parseNoteThumbnailMetadata({ ...fields, noteId: inspirationId, noteRevision: inspirationRevision })
  return { ...parsed, inspirationId: noteId, inspirationRevision: noteRevision }
}
export function sameInspirationThumbnail(left: InspirationThumbnailMetadata | null, right: InspirationThumbnailMetadata | null): boolean {
  return left === null || right === null ? left === right : sameNoteThumbnail(asNote(left), asNote(right))
}
export function matchesInspirationThumbnail(metadata: InspirationThumbnailMetadata | null, fields: NoteThumbnailFields | null): boolean {
  return matchesNoteThumbnail(metadata === null ? null : asNote(metadata), fields)
}
export function matchesCopiedInspirationThumbnail(note: NoteThumbnailMetadata | null, source: InspirationThumbnailMetadata | null): boolean {
  return note === null || source === null ? note === null && source === null : note.mime === source.mime
    && note.byteLength === source.byteLength && note.sha256 === source.sha256 && note.alt === source.alt
}
export function parseReadInspirationThumbnailInput(value: unknown): ReadInspirationThumbnailInput {
  const data = record(value, ['id', 'imageRevision'])
  const imageRevision = requiredInteger(data.imageRevision, '灵感图片版本')
  if (imageRevision < 1) invalid()
  return { id: requiredId(data.id).toLowerCase(), imageRevision }
}
export function parseUpgradeInspirationsInput(value: unknown): UpgradeInspirationsInput {
  if (record(value, ['expectedSchemaVersion']).expectedSchemaVersion !== 1) invalid()
  return { expectedSchemaVersion: 1 }
}
export function isInspirationThumbnailImage(value: unknown, input: ReadInspirationThumbnailInput): value is InspirationThumbnailImage {
  try {
    const data = record(value, ['inspirationId', 'inspirationRevision', 'mime', 'byteLength', 'sha256', 'alt', 'createdAt', 'dataBase64'])
    const { dataBase64, ...fields } = data, metadata = parseInspirationThumbnailMetadata(fields)
    return metadata.inspirationId === input.id && metadata.inspirationRevision === input.imageRevision
      && validateBookMediaPayload(metadata.mime, dataBase64) === metadata.byteLength
  } catch { return false }
}
