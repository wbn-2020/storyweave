import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId, type ErrorCode } from '../../contracts/api'
import {
  MEDIA_SCHEMA_VERSION, SCENE_MEDIA_SCHEMA_VERSION, MAX_BOOK_MEDIA_BASE64_LENGTH, MAX_BOOK_MEDIA_BYTES, MAX_BOOK_MEDIA_ITEM_BYTES, MAX_BOOK_MEDIA_ITEMS,
  isBookMediaSnapshot, parseBookMediaMetadata, parseGetBookMediaInput, parseReadBookMediaInput, parseSaveBookMediaInput, validateBookMediaPayload,
  type BookMediaImage, type BookMediaMetadata, type BookMediaSnapshot, type GetBookMediaInput, type ReadBookMediaInput, type SaveBookMediaInput,
} from '../../contracts/book-media'
import type { StudioRepository } from '../storage/studio-repository'
import { MEDIA_SCHEMA, SCENE_MEDIA_SCHEMA } from './media-schema'

interface State { id: string; revision: number; archived_at: string | null }
interface Budget { count: number; bytes: number; encoded: number; invalid: number }
function fail(message: string, code: ErrorCode = 'STORAGE_ERROR'): never { throw new DomainError({ code, message }) }
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    return fail('图片资料读写失败，请保留当前输入并检查作品文件。')
  }
}
function state(db: Database.Database, bookId: string): State {
  const row = db.prepare('SELECT id, revision, archived_at FROM book_meta WHERE singleton = 1').get() as State | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0
    || (row.archived_at !== null && typeof row.archived_at !== 'string')) return fail('图片所属作品状态无效。')
  return row
}
function schemaVersion(db: Database.Database): number {
  const version = Number(db.pragma('user_version', { simple: true }))
  if (!Number.isSafeInteger(version) || version < 1) return fail('图片所属作品格式无效。')
  return version
}
function checkBudget(db: Database.Database, version: number): Budget {
  // 只在 SQLite 内汇总长度；拒绝损坏或超限数据后才允许读取一张原图。
  const budget = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes,
    COALESCE(SUM(length(CAST(data_base64 AS BLOB))), 0) AS encoded,
    COALESCE(SUM(CASE WHEN typeof(byte_length) != 'integer' OR byte_length < 4 OR byte_length > ${MAX_BOOK_MEDIA_ITEM_BYTES}
      OR typeof(data_base64) != 'text' OR length(CAST(data_base64 AS BLOB)) != ((byte_length + 2) / 3) * 4
      OR length(CAST(data_base64 AS BLOB)) > ${MAX_BOOK_MEDIA_BASE64_LENGTH} THEN 1 ELSE 0 END), 0) AS invalid
    FROM (SELECT byte_length, data_base64 FROM book_media${version >= SCENE_MEDIA_SCHEMA_VERSION
      ? ' UNION ALL SELECT byte_length, data_base64 FROM book_scene_media' : ''})`).get() as Budget
  if (!Number.isSafeInteger(budget.count) || budget.count < 0 || budget.count > MAX_BOOK_MEDIA_ITEMS
    || !Number.isSafeInteger(budget.bytes) || budget.bytes < 0 || budget.bytes > MAX_BOOK_MEDIA_BYTES
    || !Number.isSafeInteger(budget.encoded) || budget.encoded < 0 || budget.encoded > Math.ceil((MAX_BOOK_MEDIA_BYTES + 2 * MAX_BOOK_MEDIA_ITEMS) / 3) * 4
    || budget.invalid !== 0) return fail('本书图片数据无效或超出单张 2 MiB、100 张 / 64 MiB 原图预算。旧资产未被截断。')
  return budget
}
// CASE 限制字段穿过数据库边界的大小，恢复包即使缺失约束也不会让列表携带图片正文。
const META_COLUMNS = `CASE WHEN length(CAST(id AS BLOB)) = 36 THEN id END AS id, book_revision AS bookRevision,
  CASE WHEN length(CAST(kind AS BLOB)) <= 8 THEN kind END AS kind,
  CASE WHEN person_id IS NULL OR length(CAST(person_id AS BLOB)) = 36 THEN person_id ELSE '' END AS personId,
  CASE WHEN length(CAST(title AS BLOB)) <= 480 THEN title END AS title,
  CASE WHEN length(CAST(alt AS BLOB)) <= 8000 THEN alt END AS alt,
  CASE WHEN length(CAST(mime AS BLOB)) <= 10 THEN mime END AS mime, byte_length AS byteLength,
  CASE WHEN length(CAST(sha256 AS BLOB)) = 64 THEN sha256 END AS sha256,
  CASE WHEN length(CAST(created_at AS BLOB)) = 24 THEN created_at END AS createdAt`
function metadata(raw: unknown, revision: number): BookMediaMetadata {
  try {
    const item = parseBookMediaMetadata(raw)
    if (item.bookRevision > revision) return fail('图片创建版本超过当前作品版本。')
    return item
  } catch { return fail('图片元信息损坏，未替换或忽略已有记录。') }
}
function checkPerson(db: Database.Database, bookId: string, personId: string | null, code: ErrorCode = 'STORAGE_ERROR'): void {
  if (personId !== null && !db.prepare("SELECT 1 FROM knowledge_items WHERE id = ? AND book_id = ? AND kind = 'person'").get(personId, bookId)) {
    return fail('立绘关联的人物不存在于本书，或条目已不再是人物。请先选择已有的人物。', code)
  }
}
function checkPlace(db: Database.Database, bookId: string, placeId: string | undefined, code: ErrorCode = 'STORAGE_ERROR'): void {
  if (placeId !== undefined && !db.prepare("SELECT 1 FROM knowledge_items WHERE id = ? AND book_id = ? AND kind = 'place'").get(placeId, bookId)) {
    return fail('场景关联的地点不存在于本书，或条目已不再是地点。请先核对地点设定。', code)
  }
}
function readSnapshot(db: Database.Database, bookId: string): BookMediaSnapshot {
  const current = state(db, bookId), version = schemaVersion(db)
  const snapshot: BookMediaSnapshot = { bookId, bookRevision: current.revision, archived: current.archived_at !== null,
    schemaVersion: version, requiresUpgrade: version < MEDIA_SCHEMA_VERSION, items: [], people: [], activeCoverId: null,
    totalBytes: 0, totalBase64Bytes: 0, savedMedia: null }
  if (snapshot.requiresUpgrade) return snapshot
  const budget = checkBudget(db, version)
  snapshot.items = db.prepare(`SELECT ${META_COLUMNS} FROM book_media ORDER BY book_revision DESC LIMIT ?`).all(MAX_BOOK_MEDIA_ITEMS + 1)
    .map((raw) => metadata(raw, current.revision))
  if (version >= SCENE_MEDIA_SCHEMA_VERSION) {
    const scenes = db.prepare(`SELECT ${META_COLUMNS},
      CASE WHEN length(CAST(place_id AS BLOB)) = 36 THEN place_id END AS placeId
      FROM book_scene_media ORDER BY book_revision DESC LIMIT ?`).all(MAX_BOOK_MEDIA_ITEMS + 1)
      .map((raw) => metadata(raw, current.revision))
    snapshot.items = [...snapshot.items, ...scenes].sort((a, b) => b.bookRevision - a.bookRevision)
  }
  for (const item of snapshot.items) { checkPerson(db, bookId, item.personId); checkPlace(db, bookId, item.placeId) }
  const people = db.prepare(`SELECT p.id, p.name,
    CASE WHEN (SELECT COUNT(*) FROM knowledge_items AS named WHERE named.book_id = p.book_id AND named.kind = 'person' AND named.name = p.name) = 1
      AND EXISTS (SELECT 1 FROM chapters AS c WHERE c.viewpoint = p.name) THEN 1 ELSE 0 END AS isViewpoint,
    CASE WHEN p.author_decision != 'adopted' OR p.freshness != 'current' OR p.conflict_state NOT IN ('clear', 'explained')
      OR p.nature IN ('ai_inference', 'future_plan') THEN 1 ELSE 0 END AS needsReview
    FROM knowledge_items AS p WHERE p.book_id = ? AND p.kind = 'person'
      AND EXISTS (SELECT 1 FROM book_media AS m WHERE m.person_id = p.id)
    ORDER BY p.name, p.id LIMIT ?`).all(bookId, MAX_BOOK_MEDIA_ITEMS + 1) as { id: string; name: string; isViewpoint: number; needsReview: number }[]
  snapshot.people = people.map((person) => ({ id: person.id, name: person.name, isViewpoint: person.isViewpoint === 1, needsReview: person.needsReview === 1 }))
  snapshot.totalBytes = budget.bytes; snapshot.totalBase64Bytes = budget.encoded
  snapshot.activeCoverId = snapshot.items.find((item) => item.kind === 'cover')?.id ?? null
  if (snapshot.items.length !== budget.count || !isBookMediaSnapshot(snapshot, bookId)) return fail('图片列表与容量统计不一致，或元信息快照超过 1 MiB。')
  return snapshot
}
function readImage(db: Database.Database, bookId: string, item: BookMediaMetadata): BookMediaImage {
  const table = item.kind === 'scene' ? 'book_scene_media' : 'book_media'
  const row = db.prepare(`SELECT CASE WHEN length(CAST(data_base64 AS BLOB)) <= ? THEN data_base64 END AS dataBase64 FROM ${table} WHERE id = ?`)
    .get(MAX_BOOK_MEDIA_BASE64_LENGTH, item.id) as { dataBase64: unknown } | undefined
  try {
    if (!row || validateBookMediaPayload(item.mime, row.dataBase64) !== item.byteLength) return fail('图片长度与元信息不一致。')
    const dataBase64 = row.dataBase64 as string, bytes = Buffer.from(dataBase64, 'base64')
    if (bytes.byteLength !== item.byteLength || bytes.toString('base64') !== dataBase64 || createHash('sha256').update(bytes).digest('hex') !== item.sha256) return fail('图片内容校验失败。')
    return { ...item, bookId, dataBase64 }
  } catch { return fail('原图损坏或 MIME、签名、Base64、长度、摘要不匹配；元信息和旧资产仍保留。') }
}

/** 在恢复包只读连接上逐张校验，最多只载入一张原图；v14 以前不要求素材表。 */
export function validateMediaDatabase(db: Database.Database, bookId: string): void {
  perform(() => {
    if (schemaVersion(db) < MEDIA_SCHEMA_VERSION) return
    const id = requiredId(bookId).toLowerCase()
    const scenes = schemaVersion(db) >= SCENE_MEDIA_SCHEMA_VERSION
    const definitions = (MEDIA_SCHEMA + (scenes ? SCENE_MEDIA_SCHEMA : '')).match(/CREATE TABLE[\s\S]+?\) STRICT;|CREATE INDEX[^;]+;|CREATE TRIGGER[\s\S]+?END;/g) ?? []
    if (definitions.length !== (scenes ? 15 : 7)) return fail('图片结构校验定义不完整。')
    const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ')
    for (const definition of definitions) {
      const name = /CREATE (?:TABLE|INDEX|TRIGGER) (\w+)/.exec(definition)?.[1]
      if (!name) return fail('图片结构名称无效。')
      const actual = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | undefined
      if (!actual || typeof actual.sql !== 'string' || normalize(actual.sql) !== normalize(definition)) return fail('图片表、索引或不可变保护结构不匹配。')
    }
    const snapshot = readSnapshot(db, id)
    for (const item of snapshot.items) readImage(db, id, item)
  })
}

export class BookMediaRepository {
  constructor(private readonly studio: StudioRepository) {}

  getBookMedia(input: GetBookMediaInput): BookMediaSnapshot {
    return perform(() => {
      const data = parseGetBookMediaInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => readSnapshot(db, data.bookId))()
    })
  }

  readBookMedia(input: ReadBookMediaInput): BookMediaImage {
    return perform(() => {
      const data = parseReadBookMediaInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => {
        const snapshot = readSnapshot(db, data.bookId)
        if (snapshot.requiresUpgrade) return fail('请先备份并升级作品，再读取图片资料。', 'FORBIDDEN')
        const item = snapshot.items.find((value) => value.id === data.id)
        if (!item) return fail('未找到这张图片。', 'NOT_FOUND')
        return readImage(db, data.bookId, item)
      })()
    })
  }

  saveBookMedia(input: SaveBookMediaInput): BookMediaSnapshot {
    return perform(() => {
      const data = parseSaveBookMediaInput(input), fields = data.fields
      const byteLength = validateBookMediaPayload(fields.mime, fields.dataBase64)
      const bytes = Buffer.from(fields.dataBase64, 'base64')
      if (bytes.byteLength !== byteLength || bytes.toString('base64') !== fields.dataBase64) return fail('图片 Base64 内容不规范。', 'INVALID_INPUT')
      const sha256 = createHash('sha256').update(bytes).digest('hex'), db = this.studio.getMemoryDatabase(data.bookId)
      const snapshot = db.transaction(() => {
        const before = readSnapshot(db, data.bookId)
        if (before.requiresUpgrade) return fail('请先备份并升级作品，再保存图片。', 'FORBIDDEN')
        if (fields.kind === 'scene' && before.schemaVersion < SCENE_MEDIA_SCHEMA_VERSION) return fail('请先备份并升级作品，再保存地点场景图。', 'FORBIDDEN')
        const previous = before.items.find((item) => item.id === data.id)
        // 相同 ID 只有原始版本与完整内容都一致才是重试；即使作品后来推进也返回已保存的原回执元信息。
        if (previous) {
          const original = readImage(db, data.bookId, previous)
          if (previous.bookRevision !== data.expectedBookRevision + 1 || previous.kind !== fields.kind || previous.personId !== fields.personId || previous.placeId !== fields.placeId
            || previous.title !== fields.title || previous.alt !== fields.alt || previous.mime !== fields.mime
            || previous.byteLength !== byteLength || previous.sha256 !== sha256 || original.dataBase64 !== fields.dataBase64) {
            return fail('图片 ID 已被不同内容或版本使用；旧资产保持不变，请核对原请求。', 'REVISION_CONFLICT')
          }
          before.savedMedia = previous
          return before
        }
        if (before.archived) return fail('作品已归档，图片资料仅供查看。', 'FORBIDDEN')
        if (before.bookRevision !== data.expectedBookRevision) return fail('作品已有新版本；图片和输入已保留，请读取最新版本并核对后保存。', 'REVISION_CONFLICT')
        if (before.items.length >= MAX_BOOK_MEDIA_ITEMS || before.totalBytes + byteLength > MAX_BOOK_MEDIA_BYTES) return fail('本书最多保存 100 张、合计 64 MiB 原图；旧封面、立绘和场景也计入预算。', 'INVALID_INPUT')
        checkPerson(db, data.bookId, fields.personId, 'INVALID_INPUT')
        checkPlace(db, data.bookId, fields.placeId, 'INVALID_INPUT')
        const now = new Date().toISOString(), revision = before.bookRevision + 1
        if (fields.kind === 'scene') {
          db.prepare(`INSERT INTO book_scene_media (id, book_revision, kind, person_id, place_id, title, alt, mime, byte_length, data_base64, sha256, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(data.id, revision, fields.kind, fields.personId, fields.placeId, fields.title, fields.alt, fields.mime, byteLength, fields.dataBase64, sha256, now)
        } else {
          db.prepare(`INSERT INTO book_media (id, book_revision, kind, person_id, title, alt, mime, byte_length, data_base64, sha256, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(data.id, revision, fields.kind, fields.personId, fields.title, fields.alt, fields.mime, byteLength, fields.dataBase64, sha256, now)
        }
        // 图片、当前用途选择和作品版本同事务提交，回执核验失败时一并回滚。
        const advanced = db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1 AND id = ? AND revision = ? AND archived_at IS NULL')
          .run(now, data.bookId, before.bookRevision)
        if (advanced.changes !== 1) return fail('保存期间作品版本发生变化。', 'REVISION_CONFLICT')
        const result = readSnapshot(db, data.bookId)
        result.savedMedia = result.items.find((item) => item.id === data.id) ?? null
        if (!result.savedMedia || !isBookMediaSnapshot(result, data.bookId)) return fail('图片保存回执无效。')
        return result
      }).immediate()
      this.studio.refreshKnowledgeCatalog(data.bookId)
      return snapshot
    })
  }
}
