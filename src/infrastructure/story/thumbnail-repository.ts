import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'
import { MAX_BOOK_MEDIA_BASE64_LENGTH, MAX_BOOK_MEDIA_ITEM_BYTES, validateBookMediaPayload } from '../../contracts/book-media'
import {
  FORESHADOW_THUMBNAIL_SCHEMA_VERSION, MAX_FORESHADOW_THUMBNAILS, MAX_FORESHADOW_THUMBNAIL_BYTES,
  parseForeshadowThumbnailFields, parseForeshadowThumbnailMetadata,
  type ForeshadowThumbnailFields, type ForeshadowThumbnailImage, type ForeshadowThumbnailMetadata, type ReadForeshadowThumbnailInput,
} from '../../contracts/foreshadow-thumbnail'

interface Row { bookId: unknown; recordId: unknown; knowledgeRevision: unknown; mime: unknown; byteLength: unknown; sha256: unknown; alt: unknown; createdAt: unknown }
function fail(message = '伏笔配图数据无效，请保留当前输入并检查作品文件。'): never {
  throw new DomainError({ code: 'STORAGE_ERROR', message })
}
export function supportsForeshadowThumbnails(db: Database.Database): boolean {
  return (db.pragma('user_version', { simple: true }) as number) >= FORESHADOW_THUMBNAIL_SCHEMA_VERSION
}
const COLUMNS = `CASE WHEN length(CAST(book_id AS BLOB)) = 36 THEN book_id END AS bookId,
  CASE WHEN length(CAST(record_id AS BLOB)) = 36 THEN record_id END AS recordId, knowledge_revision AS knowledgeRevision,
  CASE WHEN length(CAST(mime AS BLOB)) <= 10 THEN mime END AS mime, byte_length AS byteLength,
  CASE WHEN length(CAST(sha256 AS BLOB)) = 64 THEN sha256 END AS sha256,
  CASE WHEN length(CAST(alt AS BLOB)) <= 8000 THEN alt END AS alt,
  CASE WHEN length(CAST(created_at AS BLOB)) = 24 THEN created_at END AS createdAt`
function budget(db: Database.Database): { records: number; images: number; bytes: number } {
  const value = db.prepare(`SELECT COUNT(*) AS records, COUNT(mime) AS images, COALESCE(SUM(byte_length), 0) AS bytes,
    COALESCE(SUM(CASE WHEN (mime IS NULL AND (byte_length IS NOT NULL OR data_base64 IS NOT NULL OR sha256 IS NOT NULL OR alt IS NOT NULL))
      OR (mime IS NOT NULL AND (typeof(byte_length) != 'integer' OR typeof(data_base64) != 'text'
        OR byte_length < 4 OR byte_length > ? OR length(CAST(data_base64 AS BLOB)) != ((byte_length + 2) / 3) * 4))
      THEN 1 ELSE 0 END), 0) AS invalid FROM foreshadow_thumbnails`).get(MAX_BOOK_MEDIA_ITEM_BYTES) as {
      records: number; images: number; bytes: number; invalid: number
    }
  if (![value.records, value.images, value.bytes].every((number) => Number.isSafeInteger(number) && number >= 0)
    || value.records > MAX_FORESHADOW_THUMBNAILS * 2 || value.images > MAX_FORESHADOW_THUMBNAILS || value.bytes > MAX_FORESHADOW_THUMBNAIL_BYTES || value.invalid) fail()
  return value
}
export function validateForeshadowThumbnailBudget(db: Database.Database): void {
  if (supportsForeshadowThumbnails(db)) budget(db)
}
function metadata(db: Database.Database, row: Row, bookId: string, id: string, maximumRevision: number): ForeshadowThumbnailMetadata | null {
  if (row.bookId !== bookId || row.recordId !== id || !Number.isSafeInteger(row.knowledgeRevision)
    || Number(row.knowledgeRevision) < 1 || Number(row.knowledgeRevision) > maximumRevision) fail()
  const revision = db.prepare(`SELECT r.created_at AS createdAt FROM story_record_revisions r JOIN story_records s ON s.id = r.record_id
    WHERE r.record_id = ? AND r.knowledge_revision = ? AND s.book_id = ? AND s.kind = 'foreshadow'`)
    .get(id, row.knowledgeRevision, bookId) as { createdAt: string } | undefined
  if (!revision || revision.createdAt !== row.createdAt) fail()
  if (row.mime === null) {
    if ([row.byteLength, row.sha256, row.alt].some((value) => value !== null) || typeof row.createdAt !== 'string'
      || row.createdAt.length !== 24 || !Number.isFinite(Date.parse(row.createdAt)) || new Date(row.createdAt).toISOString() !== row.createdAt) fail()
    return null
  }
  try { const { bookId: _owner, ...fields } = row; return parseForeshadowThumbnailMetadata(fields) } catch { return fail() }
}
export function readForeshadowThumbnailMetadata(db: Database.Database, bookId: string, id: string, maximumRevision: number): ForeshadowThumbnailMetadata | null {
  if (!supportsForeshadowThumbnails(db)) return null
  const row = db.prepare(`SELECT ${COLUMNS} FROM foreshadow_thumbnails WHERE record_id = ? AND knowledge_revision <= ?
    ORDER BY knowledge_revision DESC LIMIT 1`).get(id, maximumRevision) as Row | undefined
  return row ? metadata(db, row, bookId, id, maximumRevision) : null
}
export function validateForeshadowThumbnailContent(fields: ForeshadowThumbnailFields): number {
  const parsed = parseForeshadowThumbnailFields(fields), bytes = Buffer.from(parsed.dataBase64, 'base64')
  const length = validateBookMediaPayload(parsed.mime, parsed.dataBase64)
  if (bytes.byteLength !== length || bytes.toString('base64') !== parsed.dataBase64 || createHash('sha256').update(bytes).digest('hex') !== parsed.sha256) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '伏笔配图原图与长度或摘要不一致，本次记录未保存。' })
  }
  return length
}
export function writeForeshadowThumbnail(db: Database.Database, bookId: string, id: string, revision: number, fields: ForeshadowThumbnailFields | null, now: string): void {
  if (!supportsForeshadowThumbnails(db)) throw new DomainError({ code: 'FORBIDDEN', message: '请先备份并升级作品，再保存伏笔配图。' })
  const current = budget(db)
  const length = fields ? validateForeshadowThumbnailContent(fields) : null
  if (current.records >= MAX_FORESHADOW_THUMBNAILS * 2 || fields && (current.images >= MAX_FORESHADOW_THUMBNAILS || current.bytes + length! > MAX_FORESHADOW_THUMBNAIL_BYTES)) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '本书伏笔配图（含旧图）最多 100 张、64 MiB，图片与移除记录合计最多 200 条；已有原图保持不变。' })
  }
  // 与故事字段、出处、修订及双版本共用调用方事务；省略配图的编辑不会新增历史。
  db.prepare(`INSERT INTO foreshadow_thumbnails (record_id, book_id, knowledge_revision, mime, byte_length, data_base64, sha256, alt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, bookId, revision, fields?.mime ?? null, length, fields?.dataBase64 ?? null, fields?.sha256 ?? null, fields?.alt ?? null, now)
}
export function readForeshadowThumbnail(db: Database.Database, input: ReadForeshadowThumbnailInput): ForeshadowThumbnailImage {
  if (!supportsForeshadowThumbnails(db)) throw new DomainError({ code: 'FORBIDDEN', message: '当前作品格式尚未启用伏笔配图。' })
  budget(db)
  const row = db.prepare(`SELECT ${COLUMNS} FROM foreshadow_thumbnails WHERE record_id = ? AND knowledge_revision = ?`).get(input.id, input.imageRevision) as Row | undefined
  if (!row) throw new DomainError({ code: 'NOT_FOUND', message: '未找到这条伏笔的指定配图版本。' })
  const item = metadata(db, row, input.bookId, input.id, input.imageRevision)
  if (!item) throw new DomainError({ code: 'NOT_FOUND', message: '该伏笔修订已明确移除配图。' })
  const data = db.prepare(`SELECT CASE WHEN length(CAST(data_base64 AS BLOB)) <= ? THEN data_base64 END AS dataBase64
    FROM foreshadow_thumbnails WHERE record_id = ? AND knowledge_revision = ?`).get(MAX_BOOK_MEDIA_BASE64_LENGTH, input.id, input.imageRevision) as { dataBase64: unknown } | undefined
  try {
    if (!data || validateBookMediaPayload(item.mime, data.dataBase64) !== item.byteLength) fail()
    const dataBase64 = data.dataBase64 as string
    validateForeshadowThumbnailContent({ mime: item.mime, sha256: item.sha256, alt: item.alt, dataBase64 })
    return { ...item, bookId: input.bookId, dataBase64 }
  } catch { return fail('伏笔配图原图校验失败；旧记录保留，请核对作品文件。') }
}
export function validateForeshadowThumbnails(db: Database.Database, bookId: string): void {
  if (!supportsForeshadowThumbnails(db)) return
  budget(db)
  const rows = db.prepare(`SELECT ${COLUMNS} FROM foreshadow_thumbnails ORDER BY record_id, knowledge_revision`).all() as Row[]
  const previous = new Map<string, boolean>()
  for (const row of rows) {
    const item = metadata(db, row, bookId, String(row.recordId), Number(row.knowledgeRevision))
    if (item) readForeshadowThumbnail(db, { bookId, id: item.recordId, imageRevision: item.knowledgeRevision })
    else if (!previous.get(String(row.recordId))) fail('伏笔配图移除记录没有可核对的此前图片。')
    previous.set(String(row.recordId), item !== null)
  }
}
