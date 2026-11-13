import type Database from 'better-sqlite3'
import { DomainError, type BookInput } from '../../contracts/api'
import {
  MAX_WEAVE_FIELDS_BYTES, MAX_WEAVE_HISTORY, MAX_WEAVE_HISTORY_BYTES, WEAVE_SCHEMA_VERSION,
  applyWeaveAction, isWeaveSnapshot, parseWeaveMutationInput, parseWeaveReadInput, parseWeaveState,
  type WeaveMutationInput, type WeaveSnapshot, type WeaveState,
} from '../../contracts/weave-system'
import type { StudioRepository } from '../storage/studio-repository'
import { WEAVE_SCHEMA } from './weave-schema'

interface BookState { id: string; revision: number; archived_at: string | null }
interface StateRow { revision: number; fields_json: string; updated_at: string }
interface HistoryRow { id: string; revision: number; book_revision: number; action_json: string; fields_json: string; created_at: string }
function fail(message: string, code: 'STORAGE_ERROR' | 'FORBIDDEN' | 'REVISION_CONFLICT' | 'INVALID_INPUT' = 'STORAGE_ERROR'): never {
  throw new DomainError({ code, message })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    return fail('织星系统读写失败，请保留当前输入并检查作品文件。')
  }
}
function bookState(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, archived_at FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0
    || row.archived_at !== null && typeof row.archived_at !== 'string') return fail('织星系统所属作品身份或版本无效。')
  return row
}
function fieldsOf(json: string): WeaveState {
  try {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_WEAVE_FIELDS_BYTES) return fail('织星系统内容超过 256 KiB。')
    const fields = parseWeaveState(JSON.parse(json))
    if (JSON.stringify(fields) !== json) return fail('织星系统内容格式不一致。')
    return fields
  } catch { return fail('织星系统内容损坏，未替换或截断已有数据。') }
}
function budget(db: Database.Database) {
  const row = db.prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(length(CAST(action_json AS BLOB)) + length(CAST(fields_json AS BLOB)) + 128), 0) AS bytes,
    COALESCE(MAX(length(CAST(action_json AS BLOB))), 0) AS action_max,
    COALESCE(MAX(length(CAST(fields_json AS BLOB))), 0) AS fields_max FROM weave_history`).get() as
    { count: number; bytes: number; action_max: number; fields_max: number }
  if (!Number.isSafeInteger(row.count) || row.count > MAX_WEAVE_HISTORY || !Number.isSafeInteger(row.bytes) || row.bytes > MAX_WEAVE_HISTORY_BYTES
    || row.action_max > MAX_WEAVE_FIELDS_BYTES + 8192 || row.fields_max > MAX_WEAVE_FIELDS_BYTES) return fail('织星系统历史达到 10,000 次或 64 MiB 上限，已有记录保留。')
  return row.count
}
function snapshot(db: Database.Database, bookId: string): WeaveSnapshot {
  const book = bookState(db, bookId), schemaVersion = Number(db.pragma('user_version', { simple: true }))
  const result: WeaveSnapshot = { bookId, bookRevision: book.revision, archived: book.archived_at !== null, schemaVersion,
    requiresUpgrade: schemaVersion < WEAVE_SCHEMA_VERSION, revision: 0, fields: null, updatedAt: null, operationId: null }
  if (result.requiresUpgrade) return result
  const row = db.prepare(`SELECT revision,
    CASE WHEN length(CAST(fields_json AS BLOB)) <= ${MAX_WEAVE_FIELDS_BYTES} THEN fields_json END AS fields_json,
    updated_at FROM weave_state WHERE singleton = 1`).get() as StateRow | undefined
  const latest = db.prepare(`SELECT id, revision, book_revision,
    CASE WHEN length(CAST(fields_json AS BLOB)) <= ${MAX_WEAVE_FIELDS_BYTES} THEN fields_json END AS fields_json,
    created_at FROM weave_history ORDER BY revision DESC LIMIT 1`).get() as HistoryRow | undefined
  if (!row) {
    if (latest) return fail('织星系统当前值缺失，历史仍保留。')
    return result
  }
  if (!latest || latest.revision !== row.revision || !Number.isSafeInteger(latest.book_revision) || latest.book_revision < 1 || latest.book_revision > book.revision
    || latest.fields_json !== row.fields_json || latest.created_at !== row.updated_at) return fail('织星系统当前值与不可变历史不一致。')
  Object.assign(result, { revision: row.revision, fields: fieldsOf(row.fields_json), updatedAt: row.updated_at, operationId: latest.id })
  if (!isWeaveSnapshot(result, bookId)) return fail('织星系统快照身份或版本不匹配。')
  return result
}
/** 恢复在只读连接校验结构、连续历史及每次扣款/奖励的重放结果。 */
export function validateWeaveDatabase(db: Database.Database, bookId: string): void {
  perform(() => {
    if (Number(db.pragma('user_version', { simple: true })) < WEAVE_SCHEMA_VERSION) return
    const book = bookState(db, bookId)
    const definitions = WEAVE_SCHEMA.match(/CREATE TABLE[\s\S]+?\) STRICT;|CREATE TRIGGER[\s\S]+?END;/g) ?? []
    if (definitions.length !== 4) return fail('织星系统结构参照不完整。')
    const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ')
    for (const definition of definitions) {
      const name = /CREATE (?:TABLE|TRIGGER) (\w+)/.exec(definition)?.[1]
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | undefined
      if (!row || normalize(row.sql) !== normalize(definition)) return fail('织星系统结构或历史保护不匹配。')
    }
    budget(db)
    let fields: WeaveState | null = null, revision = 0, bookRevision = 0
    const chapters = new Set<string>()
    for (const raw of db.prepare('SELECT * FROM weave_history ORDER BY revision LIMIT ?').iterate(MAX_WEAVE_HISTORY + 1)) {
      const row = raw as HistoryRow
      try {
        const input = parseWeaveMutationInput(JSON.parse(row.action_json))
        if (JSON.stringify(input) !== row.action_json || input.bookId !== bookId || input.operationId !== row.id
          || input.expectedRevision !== revision || row.revision !== revision + 1 || input.expectedBookRevision + 1 !== row.book_revision
          || row.book_revision <= bookRevision || row.book_revision > book.revision || new Date(row.created_at).toISOString() !== row.created_at) return fail('织星系统历史身份、时间或连续版本无效。')
        const next = applyWeaveAction(fields, input.action)
        if (JSON.stringify(next) !== row.fields_json) return fail('织星系统历史与奖励、扣款或刷新规则不一致。')
        fields = fieldsOf(row.fields_json); revision = row.revision; bookRevision = row.book_revision
        for (const task of fields.tasks) if (task.chapterId && !chapters.has(task.chapterId)) {
          if (!db.prepare('SELECT 1 FROM chapters WHERE id = ?').get(task.chapterId)) return fail('系统历史关联章节不属于当前作品。')
          chapters.add(task.chapterId)
        }
      } catch { return fail('织星系统历史无法完整重放，恢复已停止。') }
    }
    const current = snapshot(db, bookId)
    if (current.revision !== revision || JSON.stringify(current.fields) !== JSON.stringify(fields)) return fail('织星系统缺少完整历史。')
  })
}
export class WeaveSystemRepository {
  constructor(private readonly studio: StudioRepository) {}
  get(input: BookInput): WeaveSnapshot {
    return perform(() => {
      const data = parseWeaveReadInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => snapshot(db, data.bookId))()
    })
  }
  mutate(input: WeaveMutationInput): WeaveSnapshot {
    return perform(() => {
      const data = parseWeaveMutationInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      const receipt = db.transaction(() => {
        const current = snapshot(db, data.bookId)
        if (current.requiresUpgrade) return fail('请先备份并升级作品，再录入织星系统。', 'FORBIDDEN')
        const count = budget(db)
        const json = JSON.stringify(data)
        if (Buffer.byteLength(json, 'utf8') > MAX_WEAVE_FIELDS_BYTES + 8192) return fail('织星系统提交内容超出容量。', 'INVALID_INPUT')
        // 操作身份跨服务重启保留；相同操作返回原回执，不能再次发奖或扣款。
        const previous = db.prepare('SELECT * FROM weave_history WHERE id = ?').get(data.operationId) as HistoryRow | undefined
        if (previous) {
          if (previous.action_json !== json) return fail('该操作编号已用于不同的提交，请核对原回执。', 'REVISION_CONFLICT')
          return { ...current, bookRevision: previous.book_revision, revision: previous.revision,
            fields: fieldsOf(previous.fields_json), operationId: previous.id, updatedAt: previous.created_at }
        }
        if (current.archived) return fail('作品已归档，织星系统仅供查看。', 'FORBIDDEN')
        if (current.bookRevision !== data.expectedBookRevision || current.revision !== data.expectedRevision) return fail('作品或系统已有新版本；输入保留，请重新读取并比较。', 'REVISION_CONFLICT')
        if (current.bookRevision >= Number.MAX_SAFE_INTEGER || current.revision >= Number.MAX_SAFE_INTEGER) return fail('系统版本超出支持范围。')
        if (count >= MAX_WEAVE_HISTORY) return fail('系统历史达到 10,000 次上限，已有记录保留。', 'FORBIDDEN')
        const fields = applyWeaveAction(current.fields, data.action), fieldsJson = JSON.stringify(fields)
        if (Buffer.byteLength(fieldsJson, 'utf8') > MAX_WEAVE_FIELDS_BYTES) return fail('系统设定超过 256 KiB，未保存。', 'INVALID_INPUT')
        if (data.action.kind === 'configure') for (const task of fields.tasks) {
          if (task.chapterId && !db.prepare('SELECT 1 FROM chapters WHERE id = ?').get(task.chapterId)) return fail('关联章节不属于当前作品。', 'INVALID_INPUT')
        }
        const now = new Date().toISOString(), revision = current.revision + 1
        if (current.revision === 0) db.prepare('INSERT INTO weave_state (singleton, revision, fields_json, updated_at) VALUES (1, ?, ?, ?)').run(revision, fieldsJson, now)
        else if (db.prepare('UPDATE weave_state SET revision = ?, fields_json = ?, updated_at = ? WHERE singleton = 1 AND revision = ?')
          .run(revision, fieldsJson, now, current.revision).changes !== 1) return fail('系统版本变化，保存已停止。', 'REVISION_CONFLICT')
        db.prepare('INSERT INTO weave_history (id, revision, book_revision, action_json, fields_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(data.operationId, revision, current.bookRevision + 1, json, fieldsJson, now)
        if (db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1 AND id = ? AND revision = ? AND archived_at IS NULL')
          .run(now, data.bookId, current.bookRevision).changes !== 1) return fail('作品版本变化，保存已停止。', 'REVISION_CONFLICT')
        budget(db)
        return snapshot(db, data.bookId)
      }).immediate()
      this.studio.refreshKnowledgeCatalog(data.bookId)
      return receipt
    })
  }
}
