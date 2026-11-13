import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredText, type BookInput } from '../../contracts/api'
import {
  MAX_REALM_FIELDS_BYTES, MAX_REALM_HISTORY, MAX_REALM_HISTORY_BYTES, REALM_SCHEMA_VERSION,
  applyRealmAction, isRealmSnapshot, parseRealmMutationInput, parseRealmReadInput, parseRealmSimulationInput, parseRealmState, realmBreakthrough,
  type RealmMutationInput, type RealmSimulation, type RealmSimulationInput, type RealmSnapshot, type RealmState,
} from '../../contracts/realm'
import type { StudioRepository } from '../storage/studio-repository'
import { REALM_SCHEMA } from './realm-schema'

interface BookState { id: string; revision: number; knowledge_revision: number; archived_at: string | null }
interface StateRow { revision: number; fields_json: string; updated_at: string }
interface HistoryRow { id: string; revision: number; book_revision: number; action_json: string; fields_json: string; created_at: string }
function fail(message: string, code: 'STORAGE_ERROR' | 'FORBIDDEN' | 'REVISION_CONFLICT' | 'INVALID_INPUT' = 'STORAGE_ERROR'): never {
  throw new DomainError({ code, message })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    return fail('境界与战力读写失败，当前输入及已有历史保留。')
  }
}
function state(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, knowledge_revision, archived_at FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
    !Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 0 || row.archived_at !== null && typeof row.archived_at !== 'string') return fail('境界所属作品身份或版本无效。')
  return row
}
function fieldsOf(json: string): RealmState {
  try {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_REALM_FIELDS_BYTES) return fail('境界设定超出容量。')
    const fields = parseRealmState(JSON.parse(json))
    if (JSON.stringify(fields) !== json) return fail('境界设定不是规范格式。')
    return fields
  } catch { return fail('境界设定损坏，未替换或截断原记录。') }
}
function people(db: Database.Database, bookId: string, fields: RealmState): RealmSnapshot['people'] {
  if (!fields.characters.length) return []
  const rows = db.prepare(`SELECT id, name FROM knowledge_items WHERE book_id = ? AND kind = 'person'
    AND id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(bookId, JSON.stringify(fields.characters.map((item) => item.personId))) as { id: string; name: string }[]
  if (rows.length !== fields.characters.length) return fail('战力关联人物缺失或不属于当前作品。')
  return rows.map((row) => ({ id: requiredId(row.id).toLowerCase(), name: requiredText(row.name, '人物名称', 120) }))
}
function budget(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(length(CAST(action_json AS BLOB)) + length(CAST(fields_json AS BLOB)) + 128), 0) AS bytes,
    COALESCE(MAX(length(CAST(action_json AS BLOB))), 0) AS action_max,
    COALESCE(MAX(length(CAST(fields_json AS BLOB))), 0) AS fields_max FROM realm_history`).get() as
    { count: number; bytes: number; action_max: number; fields_max: number }
  if (!Number.isSafeInteger(row.count) || row.count > MAX_REALM_HISTORY || !Number.isSafeInteger(row.bytes) ||
    row.bytes > MAX_REALM_HISTORY_BYTES || row.action_max > MAX_REALM_FIELDS_BYTES + 8192 || row.fields_max > MAX_REALM_FIELDS_BYTES) return fail('境界历史达到 10,000 次或 64 MiB 上限，已有记录保留。')
  return row.count
}
function snapshot(db: Database.Database, bookId: string): RealmSnapshot {
  const book = state(db, bookId), schemaVersion = Number(db.pragma('user_version', { simple: true }))
  const result: RealmSnapshot = { bookId, bookRevision: book.revision, knowledgeRevision: book.knowledge_revision, archived: book.archived_at !== null,
    schemaVersion, requiresUpgrade: schemaVersion < REALM_SCHEMA_VERSION, revision: 0, fields: null, people: [], updatedAt: null, operationId: null }
  if (result.requiresUpgrade) return result
  const row = db.prepare(`SELECT revision, CASE WHEN length(CAST(fields_json AS BLOB)) <= ${MAX_REALM_FIELDS_BYTES}
    THEN fields_json END AS fields_json, updated_at FROM realm_state WHERE singleton = 1`).get() as StateRow | undefined
  const latest = db.prepare(`SELECT id, revision, book_revision, CASE WHEN length(CAST(fields_json AS BLOB)) <= ${MAX_REALM_FIELDS_BYTES}
    THEN fields_json END AS fields_json, created_at FROM realm_history ORDER BY revision DESC LIMIT 1`).get() as HistoryRow | undefined
  if (!row) { if (latest) return fail('境界当前值缺失，历史仍保留。'); return result }
  if (!latest || latest.revision !== row.revision || !Number.isSafeInteger(latest.book_revision) || latest.book_revision < 1 ||
    latest.book_revision > book.revision || latest.fields_json !== row.fields_json || latest.created_at !== row.updated_at) return fail('境界当前值与不可变历史不一致。')
  const fields = fieldsOf(row.fields_json)
  Object.assign(result, { revision: row.revision, fields, people: people(db, bookId, fields), updatedAt: row.updated_at, operationId: latest.id })
  if (!isRealmSnapshot(result, bookId)) return fail('境界快照身份或版本无效。')
  return result
}
export function validateRealmDatabase(db: Database.Database, bookId: string): void {
  perform(() => {
    if (Number(db.pragma('user_version', { simple: true })) < REALM_SCHEMA_VERSION) return
    const book = state(db, bookId), definitions = REALM_SCHEMA.match(/CREATE TABLE[\s\S]+?\) STRICT;|CREATE TRIGGER[\s\S]+?END;/g) ?? []
    if (definitions.length !== 4) return fail('境界内置结构参照不完整。')
    const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ')
    for (const definition of definitions) {
      const name = /CREATE (?:TABLE|TRIGGER) (\w+)/.exec(definition)?.[1]
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | undefined
      if (!row || normalize(row.sql) !== normalize(definition)) return fail('境界结构或历史保护无效。')
    }
    budget(db)
    let fields: RealmState | null = null, revision = 0, bookRevision = 0
    const checkedPeople = new Set<string>()
    for (const raw of db.prepare('SELECT * FROM realm_history ORDER BY revision LIMIT ?').iterate(MAX_REALM_HISTORY + 1)) {
      const row = raw as HistoryRow
      try {
        const input = parseRealmMutationInput(JSON.parse(row.action_json))
        if (JSON.stringify(input) !== row.action_json || input.bookId !== bookId || input.operationId !== row.id ||
          input.expectedRevision !== revision || row.revision !== revision + 1 || input.expectedBookRevision + 1 !== row.book_revision ||
          row.book_revision <= bookRevision || row.book_revision > book.revision || new Date(row.created_at).toISOString() !== row.created_at) return fail('境界历史身份、时间或连续版本无效。')
        const next = applyRealmAction(fields, input.action)
        if (JSON.stringify(next) !== row.fields_json) return fail('境界历史与条件核对或资源扣减不一致。')
        fields = fieldsOf(row.fields_json); revision = row.revision; bookRevision = row.book_revision
        for (const character of fields.characters) if (!checkedPeople.has(character.personId)) {
          if (!db.prepare("SELECT 1 FROM knowledge_items WHERE id = ? AND book_id = ? AND kind = 'person'").get(character.personId, bookId)) return fail('境界历史关联人物不属于本书。')
          checkedPeople.add(character.personId)
        }
      } catch { return fail('境界历史无法完整重放，恢复已停止。') }
    }
    const current = snapshot(db, bookId)
    if (current.revision !== revision || JSON.stringify(current.fields) !== JSON.stringify(fields)) return fail('境界当前值缺少完整历史。')
  })
}
export class RealmRepository {
  constructor(private readonly studio: StudioRepository) {}
  get(input: BookInput): RealmSnapshot {
    return perform(() => {
      const data = parseRealmReadInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => snapshot(db, data.bookId))()
    })
  }
  simulate(input: RealmSimulationInput): RealmSimulation {
    return perform(() => {
      const data = parseRealmSimulationInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => {
        const current = snapshot(db, data.bookId)
        if (current.requiresUpgrade || !current.fields) return fail('请先录入并保存境界设定。', 'FORBIDDEN')
        if (current.bookRevision !== data.expectedBookRevision || current.revision !== data.expectedRevision) return fail('推演基线已变化，请重新读取。', 'REVISION_CONFLICT')
        const result = realmBreakthrough(current.fields, data.personId)
        return { bookId: data.bookId, bookRevision: current.bookRevision, revision: current.revision, personId: data.personId, ...result }
      })()
    })
  }
  mutate(input: RealmMutationInput): RealmSnapshot {
    return perform(() => {
      const data = parseRealmMutationInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      const receipt = db.transaction(() => {
        const current = snapshot(db, data.bookId)
        if (current.requiresUpgrade) return fail('请先备份并升级作品。', 'FORBIDDEN')
        const count = budget(db), json = JSON.stringify(data)
        if (Buffer.byteLength(json, 'utf8') > MAX_REALM_FIELDS_BYTES + 8192) return fail('境界提交超过容量限制。', 'INVALID_INPUT')
        const previous = db.prepare('SELECT * FROM realm_history WHERE id = ?').get(data.operationId) as HistoryRow | undefined
        if (previous) {
          if (previous.action_json !== json) return fail('操作编号已被不同的提交使用。', 'REVISION_CONFLICT')
          const fields = fieldsOf(previous.fields_json)
          return { ...current, bookRevision: previous.book_revision, revision: previous.revision, fields, people: people(db, data.bookId, fields),
            updatedAt: previous.created_at, operationId: previous.id }
        }
        if (current.archived) return fail('归档作品仅供查看。', 'FORBIDDEN')
        if (current.bookRevision !== data.expectedBookRevision || current.revision !== data.expectedRevision) return fail('作品或境界已有新版本，输入保留，请读取后比较。', 'REVISION_CONFLICT')
        if (current.bookRevision >= Number.MAX_SAFE_INTEGER || current.revision >= Number.MAX_SAFE_INTEGER) return fail('版本已超出支持范围。')
        if (count >= MAX_REALM_HISTORY) return fail('境界历史已达上限。', 'FORBIDDEN')
        const fields = applyRealmAction(current.fields, data.action), fieldsJson = JSON.stringify(fields)
        if (Buffer.byteLength(fieldsJson, 'utf8') > MAX_REALM_FIELDS_BYTES) return fail('境界设定超过 256 KiB。', 'INVALID_INPUT')
        people(db, data.bookId, fields)
        const revision = current.revision + 1, now = new Date().toISOString()
        if (!current.revision) db.prepare('INSERT INTO realm_state (singleton, revision, fields_json, updated_at) VALUES (1, ?, ?, ?)').run(revision, fieldsJson, now)
        else if (db.prepare('UPDATE realm_state SET revision = ?, fields_json = ?, updated_at = ? WHERE singleton = 1 AND revision = ?')
          .run(revision, fieldsJson, now, current.revision).changes !== 1) return fail('境界版本发生变化。', 'REVISION_CONFLICT')
        db.prepare('INSERT INTO realm_history (id, revision, book_revision, action_json, fields_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(data.operationId, revision, current.bookRevision + 1, json, fieldsJson, now)
        if (db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1 AND id = ? AND revision = ? AND archived_at IS NULL')
          .run(now, data.bookId, current.bookRevision).changes !== 1) return fail('作品版本发生变化。', 'REVISION_CONFLICT')
        budget(db)
        return snapshot(db, data.bookId)
      }).immediate()
      this.studio.refreshKnowledgeCatalog(data.bookId)
      return receipt
    })
  }
}
