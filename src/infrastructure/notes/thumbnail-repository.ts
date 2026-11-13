import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'
import { MAX_BOOK_MEDIA_BASE64_LENGTH, MAX_BOOK_MEDIA_ITEM_BYTES, validateBookMediaPayload } from '../../contracts/book-media'
import {
  MAX_NOTE_THUMBNAILS, MAX_NOTE_THUMBNAIL_BYTES, NOTE_THUMBNAIL_SCHEMA_VERSION, parseNoteThumbnailFields, parseNoteThumbnailMetadata,
  type NoteThumbnailFields, type NoteThumbnailImage, type NoteThumbnailMetadata, type ReadNoteThumbnailInput,
} from '../../contracts/note-thumbnail'

interface NoteIdentity { id: string; bookId: string; revision: number; createdAt: string; updatedAt: string }
interface Row {
  bookId: unknown; noteId: unknown; noteRevision: unknown; mime: unknown; byteLength: unknown; sha256: unknown; alt: unknown; createdAt: unknown
}
function fail(message = '素材缩略图数据无效，请保留当前输入并检查作品文件。'): never {
  throw new DomainError({ code: 'STORAGE_ERROR', message })
}
export function supportsNoteThumbnails(db: Database.Database): boolean {
  return (db.pragma('user_version', { simple: true }) as number) >= NOTE_THUMBNAIL_SCHEMA_VERSION
}
const COLUMNS = `CASE WHEN length(CAST(book_id AS BLOB)) = 36 THEN book_id END AS bookId,
  CASE WHEN length(CAST(note_id AS BLOB)) = 36 THEN note_id END AS noteId, note_revision AS noteRevision,
  CASE WHEN length(CAST(mime AS BLOB)) <= 10 THEN mime END AS mime, byte_length AS byteLength,
  CASE WHEN length(CAST(sha256 AS BLOB)) <= 64 THEN sha256 END AS sha256,
  CASE WHEN length(CAST(alt AS BLOB)) <= 8000 THEN alt END AS alt,
  CASE WHEN length(CAST(created_at AS BLOB)) = 24 THEN created_at END AS createdAt`
function budget(db: Database.Database): { images: number; bytes: number } {
  const value = db.prepare(`SELECT COUNT(*) AS records, COUNT(mime) AS images, COALESCE(SUM(byte_length), 0) AS bytes,
    COALESCE(SUM(CASE WHEN (mime IS NULL AND (byte_length IS NOT NULL OR data_base64 IS NOT NULL OR sha256 IS NOT NULL OR alt IS NOT NULL))
      OR (mime IS NOT NULL AND (typeof(byte_length) != 'integer' OR typeof(data_base64) != 'text'
      OR byte_length < 4 OR byte_length > ?)) THEN 1 ELSE 0 END), 0) AS invalid FROM note_thumbnails`)
    .get(MAX_BOOK_MEDIA_ITEM_BYTES) as { records: number; images: number; bytes: number; invalid: number }
  if (![value.records, value.images, value.bytes].every((number) => Number.isSafeInteger(number) && number >= 0)
    || value.records > MAX_NOTE_THUMBNAILS * 2 || value.images > MAX_NOTE_THUMBNAILS || value.bytes > MAX_NOTE_THUMBNAIL_BYTES || value.invalid) fail()
  return value
}
export function validateNoteThumbnailBudget(db: Database.Database): void {
  // 列表快照只核对一次数量和声明大小，不为每张卡片反复遍历原图内容。
  if (supportsNoteThumbnails(db)) budget(db)
}
function metadata(row: Row, note: NoteIdentity): NoteThumbnailMetadata | null {
  if (row.bookId !== note.bookId || row.noteId !== note.id || !Number.isSafeInteger(row.noteRevision) || Number(row.noteRevision) < 1
    || Number(row.noteRevision) > note.revision || typeof row.createdAt !== 'string' || row.createdAt.length !== 24
    || !Number.isFinite(Date.parse(row.createdAt)) || new Date(row.createdAt).toISOString() !== row.createdAt
    || row.createdAt < note.createdAt || row.createdAt > note.updatedAt) fail()
  if (row.mime === null) {
    if ([row.byteLength, row.sha256, row.alt].some((value) => value !== null)) fail()
    return null
  }
  try {
    const { bookId: _bookId, ...fields } = row
    return parseNoteThumbnailMetadata(fields)
  } catch { return fail() }
}
export function readNoteThumbnailMetadata(db: Database.Database, note: NoteIdentity): NoteThumbnailMetadata | null {
  if (!supportsNoteThumbnails(db)) return null
  const row = db.prepare(`SELECT ${COLUMNS} FROM note_thumbnails WHERE note_id = ? ORDER BY note_revision DESC LIMIT 1`).get(note.id) as Row | undefined
  return row ? metadata(row, note) : null
}
export function validateNoteThumbnailContent(fields: NoteThumbnailFields): number {
  const parsed = parseNoteThumbnailFields(fields), bytes = Buffer.from(parsed.dataBase64, 'base64')
  const length = validateBookMediaPayload(parsed.mime, parsed.dataBase64)
  if (bytes.byteLength !== length || bytes.toString('base64') !== parsed.dataBase64 || createHash('sha256').update(bytes).digest('hex') !== parsed.sha256) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '缩略图原图与长度或摘要不一致，当前笔记未保存。' })
  }
  return length
}
export function writeNoteThumbnail(db: Database.Database, note: NoteIdentity, fields: NoteThumbnailFields | null, now: string): void {
  if (!supportsNoteThumbnails(db)) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级作品，再保存素材缩略图；原有笔记仍可编辑。' })
  const current = budget(db)
  if (fields === null) {
    db.prepare(`INSERT INTO note_thumbnails (note_id, book_id, note_revision, mime, byte_length, data_base64, sha256, alt, created_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`).run(note.id, note.bookId, note.revision, now)
    return
  }
  const parsed = parseNoteThumbnailFields(fields), length = validateNoteThumbnailContent(parsed)
  if (current.images >= MAX_NOTE_THUMBNAILS || current.bytes + length > MAX_NOTE_THUMBNAIL_BYTES) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '本书素材缩略图（含旧图）最多 100 张、合计 64 MiB，与封面、立绘和场景图的共享预算分开计算。' })
  }
  // 追加图片或清除标记，旧图不覆盖；与笔记及作品修订共用外层事务。
  db.prepare(`INSERT INTO note_thumbnails (note_id, book_id, note_revision, mime, byte_length, data_base64, sha256, alt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(note.id, note.bookId, note.revision, parsed.mime, length, parsed.dataBase64, parsed.sha256, parsed.alt, now)
}
export function readNoteThumbnail(db: Database.Database, input: ReadNoteThumbnailInput, note: NoteIdentity): NoteThumbnailImage {
  if (!supportsNoteThumbnails(db)) throw new DomainError({ code: 'FORBIDDEN', message: '当前作品格式尚未启用素材缩略图。' })
  budget(db)
  const row = db.prepare(`SELECT ${COLUMNS} FROM note_thumbnails WHERE note_id = ? AND note_revision = ?`).get(input.id, input.imageRevision) as Row | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '未找到这份素材的指定缩略图版本。' })
  const item = metadata(row, note)
  if (!item) throw new DomainError({ code: 'NOT_FOUND', message: '这个笔记版本已明确移除缩略图。' })
  const data = db.prepare(`SELECT CASE WHEN length(CAST(data_base64 AS BLOB)) <= ? THEN data_base64 END AS dataBase64
    FROM note_thumbnails WHERE note_id = ? AND note_revision = ?`).get(MAX_BOOK_MEDIA_BASE64_LENGTH, input.id, input.imageRevision) as { dataBase64: unknown } | undefined
  try {
    if (!data || validateBookMediaPayload(item.mime, data.dataBase64) !== item.byteLength) fail()
    const dataBase64 = data.dataBase64 as string, bytes = Buffer.from(dataBase64, 'base64')
    if (bytes.byteLength !== item.byteLength || bytes.toString('base64') !== dataBase64 || createHash('sha256').update(bytes).digest('hex') !== item.sha256) fail()
    return { ...item, bookId: note.bookId, dataBase64 }
  } catch { return fail('素材缩略图的原图校验失败；旧记录保留，请核对作品文件。') }
}
export function validateNoteThumbnails(db: Database.Database, bookId: string): void {
  if (!supportsNoteThumbnails(db)) return
  budget(db)
  const rows = db.prepare(`SELECT ${COLUMNS} FROM note_thumbnails ORDER BY note_id, note_revision`).all() as Row[]
  const previous = new Map<string, boolean>()
  for (const row of rows) {
    const note = db.prepare(`SELECT id, book_id AS bookId, revision, created_at AS createdAt, updated_at AS updatedAt FROM notes WHERE id = ?`)
      .get(row.noteId) as NoteIdentity | undefined
    if (!note || note.bookId !== bookId) fail()
    const item = metadata(row, note)
    if (item) readNoteThumbnail(db, { bookId, id: note.id, imageRevision: item.noteRevision }, note)
    else {
      if (!previous.get(note.id)) fail('素材缩略图移除记录没有可核对的此前图片。')
    }
    previous.set(note.id, item !== null)
  }
}
