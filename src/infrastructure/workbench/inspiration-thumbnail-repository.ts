import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'
import { MAX_BOOK_MEDIA_BASE64_LENGTH, MAX_BOOK_MEDIA_ITEM_BYTES, validateBookMediaPayload } from '../../contracts/book-media'
import {
  INSPIRATION_THUMBNAIL_SCHEMA_VERSION, MAX_INSPIRATION_THUMBNAILS, MAX_INSPIRATION_THUMBNAIL_BYTES, parseInspirationThumbnailMetadata,
  type InspirationThumbnailImage, type InspirationThumbnailMetadata, type ReadInspirationThumbnailInput,
} from '../../contracts/inspiration-thumbnail'
import type { NoteThumbnailFields } from '../../contracts/note-thumbnail'
import { validateNoteThumbnailContent } from '../notes/thumbnail-repository'

interface Identity { id: string; revision: number; createdAt: string; updatedAt: string }
interface Row {
  inspirationId: unknown; inspirationRevision: unknown; mime: unknown; byteLength: unknown; sha256: unknown; alt: unknown; createdAt: unknown
}
function failure(): never { throw new DomainError({ code: 'STORAGE_ERROR', message: '全局灵感图片数据不一致，请保留原库和当前输入。' }) }
export function supportsInspirationThumbnails(db: Database.Database): boolean {
  return db.pragma('user_version', { simple: true }) === INSPIRATION_THUMBNAIL_SCHEMA_VERSION
}
const COLUMNS = `CASE WHEN length(CAST(inspiration_id AS BLOB)) = 36 THEN inspiration_id END AS inspirationId,
  inspiration_revision AS inspirationRevision,
  CASE WHEN length(CAST(mime AS BLOB)) <= 10 THEN mime END AS mime, byte_length AS byteLength,
  CASE WHEN length(CAST(sha256 AS BLOB)) <= 64 THEN sha256 END AS sha256,
  CASE WHEN length(CAST(alt AS BLOB)) <= 8000 THEN alt END AS alt,
  CASE WHEN length(CAST(created_at AS BLOB)) = 24 THEN created_at END AS createdAt`
export function inspirationThumbnailBudget(db: Database.Database): { images: number; bytes: number } {
  if (!supportsInspirationThumbnails(db)) return { images: 0, bytes: 0 }
  const value = db.prepare(`SELECT COUNT(*) AS records, COUNT(mime) AS images, COALESCE(SUM(byte_length), 0) AS bytes,
    COALESCE(SUM(CASE WHEN (mime IS NULL AND (byte_length IS NOT NULL OR data_base64 IS NOT NULL OR sha256 IS NOT NULL OR alt IS NOT NULL))
      OR (mime IS NOT NULL AND (typeof(byte_length) != 'integer' OR typeof(data_base64) != 'text'
        OR byte_length < 4 OR byte_length > ?)) THEN 1 ELSE 0 END), 0) AS invalid FROM inspiration_thumbnails`)
    .get(MAX_BOOK_MEDIA_ITEM_BYTES) as { records: number; images: number; bytes: number; invalid: number }
  if (![value.records, value.images, value.bytes].every((number) => Number.isSafeInteger(number) && number >= 0)
    || value.records > MAX_INSPIRATION_THUMBNAILS * 2 || value.images > MAX_INSPIRATION_THUMBNAILS
    || value.bytes > MAX_INSPIRATION_THUMBNAIL_BYTES || value.invalid) failure()
  return value
}
function metadata(row: Row, item: Identity): InspirationThumbnailMetadata | null {
  if (row.inspirationId !== item.id || !Number.isSafeInteger(row.inspirationRevision) || Number(row.inspirationRevision) < 1
    || Number(row.inspirationRevision) > item.revision || typeof row.createdAt !== 'string'
    || !Number.isFinite(Date.parse(row.createdAt)) || new Date(row.createdAt).toISOString() !== row.createdAt
    || row.createdAt < item.createdAt || row.createdAt > item.updatedAt) failure()
  if (row.mime === null) {
    if ([row.byteLength, row.sha256, row.alt].some((value) => value !== null)) failure()
    return null
  }
  try { return parseInspirationThumbnailMetadata(row) } catch { return failure() }
}
export function readInspirationThumbnailMetadata(db: Database.Database, item: Identity): InspirationThumbnailMetadata | null {
  if (!supportsInspirationThumbnails(db)) return null
  const row = db.prepare(`SELECT ${COLUMNS} FROM inspiration_thumbnails
    WHERE inspiration_id = ? ORDER BY inspiration_revision DESC LIMIT 1`).get(item.id) as Row | undefined
  return row ? metadata(row, item) : null
}
export function writeInspirationThumbnail(db: Database.Database, item: Identity, fields: NoteThumbnailFields | null, now: string): void {
  if (!supportsInspirationThumbnails(db)) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并启用全局灵感配图；原文字条目仍可编辑。' })
  const budget = inspirationThumbnailBudget(db)
  if (fields === null) {
    db.prepare(`INSERT INTO inspiration_thumbnails (inspiration_id, inspiration_revision, mime, byte_length, data_base64, sha256, alt, created_at)
      VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?)`).run(item.id, item.revision, now)
    return
  }
  const length = validateNoteThumbnailContent(fields)
  if (budget.images >= MAX_INSPIRATION_THUMBNAILS || budget.bytes + length > MAX_INSPIRATION_THUMBNAIL_BYTES) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '全局灵感图片（含旧图）最多 100 张、合计 64 MiB，与各本书的图片预算分开计算。' })
  }
  db.prepare(`INSERT INTO inspiration_thumbnails (inspiration_id, inspiration_revision, mime, byte_length, data_base64, sha256, alt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(item.id, item.revision, fields.mime, length, fields.dataBase64, fields.sha256, fields.alt, now)
}
export function readInspirationThumbnail(db: Database.Database, input: ReadInspirationThumbnailInput, item: Identity): InspirationThumbnailImage {
  if (!supportsInspirationThumbnails(db)) throw new DomainError({ code: 'FORBIDDEN', message: '当前全局灵感库尚未启用图片。' })
  inspirationThumbnailBudget(db)
  const row = db.prepare(`SELECT ${COLUMNS} FROM inspiration_thumbnails WHERE inspiration_id = ? AND inspiration_revision = ?`)
    .get(input.id, input.imageRevision) as Row | undefined
  const image = row ? metadata(row, item) : null
  if (!image) throw new DomainError({ code: 'NOT_FOUND', message: '未找到这个灵感版本的原图，原记录仍保留。' })
  const raw = db.prepare(`SELECT CASE WHEN length(CAST(data_base64 AS BLOB)) <= ? THEN data_base64 END AS dataBase64
    FROM inspiration_thumbnails WHERE inspiration_id = ? AND inspiration_revision = ?`)
    .get(MAX_BOOK_MEDIA_BASE64_LENGTH, input.id, input.imageRevision) as { dataBase64: unknown } | undefined
  try {
    if (!raw || validateBookMediaPayload(image.mime, raw.dataBase64) !== image.byteLength) failure()
    const dataBase64 = raw.dataBase64 as string, bytes = Buffer.from(dataBase64, 'base64')
    if (bytes.toString('base64') !== dataBase64 || createHash('sha256').update(bytes).digest('hex') !== image.sha256) failure()
    return { ...image, dataBase64 }
  } catch { return failure() }
}
