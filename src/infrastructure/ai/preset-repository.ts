import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredInteger } from '../../contracts/api'
import {
  AI_PRESETS_SCHEMA_VERSION, AI_SUMMARY_PRESETS_SCHEMA_VERSION, MAX_AI_PRESETS, MAX_AI_PRESET_FIELDS_BYTES, MAX_AI_PRESETS_BYTES,
  MAX_AI_PRESET_HISTORY, MAX_AI_PRESET_HISTORY_BYTES, aiPresetFields, isAiPresetsSnapshot, isAiPresetSaveReceipt,
  parseAiPresetFields, parseGetAiPresetsInput, parseSaveAiPresetInput,
  type AiPreset, type AiPresetFields, type AiPresetsSnapshot, type AiPresetUsage, type GetAiPresetsInput, type SaveAiPresetInput,
} from '../../contracts/ai-presets'
import { BOOK_SCHEMA_VERSION } from '../storage/schema'
import type { StudioRepository } from '../storage/studio-repository'
import { AI_PRESETS_SCHEMA, AI_PRESETS_V14_SCHEMA } from './preset-schema'

interface BookState { id: string; revision: number; archived_at: string | null }
interface PresetRow { id: string; revision: number; kind: string; default_for_task: number; archived: number; fields_json: string; updated_at: string }
interface HistoryRow { id: string; preset_id: string; revision: number; book_revision: number; fields_json: string; created_at: string }
interface Budget { count: number; bytes: number; largest: number }

function fail(message: string, code: 'STORAGE_ERROR' | 'INVALID_INPUT' | 'FORBIDDEN' | 'REVISION_CONFLICT' = 'STORAGE_ERROR'): never {
  throw new DomainError({ code, message })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    return fail('任务预设或用量记录无法核对，请保留输入并检查作品文件。')
  }
}
function schemaVersion(db: Database.Database): number {
  const version = db.pragma('user_version', { simple: true })
  // 预设版本只决定功能是否可用，作品支持上限随整体存储格式推进。
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 2 || version > BOOK_SCHEMA_VERSION) return fail('作品格式版本不受支持。')
  return version
}
function bookState(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, archived_at FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0 || (row.archived_at !== null && typeof row.archived_at !== 'string')) return fail('预设所属作品状态无效。')
  return row
}
function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function storedFields(json: unknown): AiPresetFields {
  try {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_AI_PRESET_FIELDS_BYTES) return fail('预设内容超过容量限制。')
    const fields = parseAiPresetFields(JSON.parse(json))
    if (JSON.stringify(fields) !== json) return fail('预设内容格式与当前定义不一致。')
    return fields
  } catch { return fail('预设内容损坏或超过容量限制，未截断已有内容。') }
}
function preset(row: PresetRow, bookRevision: number): AiPreset {
  try {
    if (requiredId(row.id).toLowerCase() !== row.id || requiredInteger(row.revision, '预设版本', bookRevision) < 1 || !validTimestamp(row.updated_at)) return fail('预设身份或版本无效。')
    const fields = storedFields(row.fields_json)
    if (row.kind !== fields.kind || row.default_for_task !== Number(fields.defaultForTask) || row.archived !== Number(fields.archived)) return fail('预设索引与内容不一致。')
    return { ...fields, id: row.id, revision: row.revision, updatedAt: row.updated_at }
  } catch { return fail('预设记录无法核对。') }
}
function checkConnection(db: Database.Database, bookId: string, connectionId: string | null, saving = false): void {
  if (connectionId !== null && !db.prepare('SELECT id FROM ai_connections WHERE id = ? AND book_id = ?').get(connectionId, bookId)) {
    return fail('预设绑定的连接不属于本作品或已不存在，请重新选择连接。', saving ? 'INVALID_INPUT' : 'STORAGE_ERROR')
  }
}
function checkBudget(db: Database.Database, history = false): number {
  // 读取正文前先在库内统计字节，避免恢复文件中的超大 JSON 直接进入进程。
  const current = db.prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(length(CAST(fields_json AS BLOB)) + length(CAST(id AS BLOB)) + length(CAST(kind AS BLOB)) + length(CAST(updated_at AS BLOB))), 0) AS bytes,
    COALESCE(MAX(length(CAST(fields_json AS BLOB))), 0) AS largest FROM ai_presets`).get() as Budget
  if (!Number.isSafeInteger(current.count) || current.count > MAX_AI_PRESETS || !Number.isSafeInteger(current.bytes) || current.bytes > MAX_AI_PRESETS_BYTES || current.largest > MAX_AI_PRESET_FIELDS_BYTES) return fail('预设超过 200 条、当前内容 4 MiB 或单条 32 KiB 的容量限制。')
  if (history) {
    const past = db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(fields_json AS BLOB)) + length(CAST(id AS BLOB)) + length(CAST(preset_id AS BLOB)) + length(CAST(created_at AS BLOB))), 0) AS bytes,
      COALESCE(MAX(length(CAST(fields_json AS BLOB))), 0) AS largest FROM ai_preset_history`).get() as Budget
    if (!Number.isSafeInteger(past.count) || past.count > MAX_AI_PRESET_HISTORY || !Number.isSafeInteger(past.bytes) || past.bytes > MAX_AI_PRESET_HISTORY_BYTES || past.largest > MAX_AI_PRESET_FIELDS_BYTES) return fail('预设历史超过 50,000 条或 64 MiB 的容量限制，历史仍保留。')
  }
  return current.count
}
const PRESET_COLUMNS = `CASE WHEN length(CAST(id AS BLOB)) = 36 THEN id END AS id, revision,
  CASE WHEN length(CAST(kind AS BLOB)) <= 9 THEN kind END AS kind, default_for_task, archived,
  CASE WHEN length(CAST(fields_json AS BLOB)) <= ${MAX_AI_PRESET_FIELDS_BYTES} THEN fields_json END AS fields_json,
  CASE WHEN length(CAST(updated_at AS BLOB)) = 24 THEN updated_at END AS updated_at`

function readUsage(db: Database.Database, bookId: string, version: number): AiPresetUsage {
  if (version < 6) return { runCount: 0, knownUsageRuns: 0, unknownUsageRuns: 0, inputTokens: 0, outputTokens: 0, unknownInputRuns: 0, unknownOutputRuns: 0 }
  // prepared 为未发送预览，直接拒绝它只会推进到 version=1；这两类不计入运行。
  // 缺项、畸形 JSON、负数及非安全整数均为未知，不用估算值或 totalTokens 反推。
  const result = db.prepare(`WITH raw AS (
    SELECT CASE WHEN length(CAST(usage_json AS BLOB)) <= 1024 AND json_valid(usage_json) THEN usage_json ELSE '{}' END AS usage
    FROM ai_runs WHERE book_id = ? AND state <> 'prepared' AND NOT (state = 'rejected' AND version = 1)
    ${version >= 15 ? `UNION ALL SELECT CASE WHEN length(CAST(usage_json AS BLOB)) <= 1024 AND json_valid(usage_json) THEN usage_json ELSE '{}' END AS usage
      FROM generation_runs WHERE book_id = ? AND state <> 'prepared'` : ''}
  ), counts AS (
    SELECT CASE WHEN json_type(usage, '$.inputTokens') = 'integer' AND json_extract(usage, '$.inputTokens') BETWEEN 0 AND 9007199254740991
      THEN json_extract(usage, '$.inputTokens') END AS input_tokens,
    CASE WHEN json_type(usage, '$.outputTokens') = 'integer' AND json_extract(usage, '$.outputTokens') BETWEEN 0 AND 9007199254740991
      THEN json_extract(usage, '$.outputTokens') END AS output_tokens FROM raw
  ) SELECT COUNT(*) AS runCount,
    COUNT(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 1 END) AS knownUsageRuns,
    COUNT(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 END) AS unknownUsageRuns,
    COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COUNT(CASE WHEN input_tokens IS NULL THEN 1 END) AS unknownInputRuns,
    COUNT(CASE WHEN output_tokens IS NULL THEN 1 END) AS unknownOutputRuns FROM counts`).get(...(version >= 15 ? [bookId, bookId] : [bookId])) as AiPresetUsage
  if (Object.values(result).some((value) => !Number.isSafeInteger(value) || value < 0)) return fail('累计用量超出可精确表示的范围，未返回近似值。')
  return result
}
function readSnapshot(db: Database.Database, bookId: string): AiPresetsSnapshot {
  const current = bookState(db, bookId), version = schemaVersion(db)
  const snapshot: AiPresetsSnapshot = { bookId, bookRevision: current.revision, archived: current.archived_at !== null,
    requiresUpgrade: version < AI_PRESETS_SCHEMA_VERSION, supportsSummary: version >= AI_SUMMARY_PRESETS_SCHEMA_VERSION,
    presets: [], usage: readUsage(db, bookId, version) }
  if (!snapshot.requiresUpgrade) {
    checkBudget(db)
    snapshot.presets = (db.prepare(`SELECT ${PRESET_COLUMNS} FROM ai_presets ORDER BY archived, kind, default_for_task DESC, updated_at DESC, id LIMIT ?`).all(MAX_AI_PRESETS + 1) as PresetRow[])
      .map((row) => preset(row, current.revision))
    for (const item of snapshot.presets) checkConnection(db, bookId, item.connectionId)
  }
  if (!isAiPresetsSnapshot(snapshot, bookId)) return fail('预设快照或用量合计无法核对。')
  return snapshot
}
function checkLatest(db: Database.Database, row: PresetRow): void {
  const latest = db.prepare('SELECT revision, fields_json, created_at FROM ai_preset_history WHERE preset_id = ? ORDER BY revision DESC LIMIT 1').get(row.id) as
    { revision: number; fields_json: string; created_at: string } | undefined
  if (!latest || latest.revision !== row.revision || latest.fields_json !== row.fields_json || latest.created_at !== row.updated_at) return fail('预设当前值缺少匹配的不可变历史，保存已停止。')
}

/** 供恢复预览的只读连接调用；同时检查当前值、完整历史、连接归属及历史保护结构。 */
export function validateAiPresetsDatabase(db: Database.Database, bookId: string): void {
  perform(() => {
    const version = schemaVersion(db)
    if (version < AI_PRESETS_SCHEMA_VERSION) return
    const id = requiredId(bookId).toLowerCase(), current = bookState(db, id)
    const schema = version >= AI_SUMMARY_PRESETS_SCHEMA_VERSION ? AI_PRESETS_SCHEMA : AI_PRESETS_V14_SCHEMA
    const definitions = schema.match(/CREATE TABLE[\s\S]+?\) STRICT;|CREATE UNIQUE INDEX[^;]+;|CREATE TRIGGER[\s\S]+?END;/g) ?? []
    if (definitions.length !== 5) return fail('预设结构校验定义不完整。')
    const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/"(ai_presets|ai_preset_history)"/g, '$1').replace(/\s+/g, ' ')
    for (const definition of definitions) {
      const name = /CREATE (?:TABLE|UNIQUE INDEX|TRIGGER) (\w+)/.exec(definition)?.[1]
      const actual = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | undefined
      if (!actual || normalize(actual.sql) !== normalize(definition)) return fail('预设数据表、默认唯一索引或历史保护结构不匹配。')
    }
    checkBudget(db, true)
    const snapshot = readSnapshot(db, id)
    const entries = new Map(snapshot.presets.map((item) => [item.id, item]))
    const seen = new Map<string, { revision: number; bookRevision: number; fields: AiPresetFields }>()
    let groupRevision = 0
    const checkDefaults = () => {
      const kinds = new Set<string>()
      for (const { fields } of seen.values()) if (fields.defaultForTask) {
        if (kinds.has(fields.kind)) return fail('预设历史在同一任务上存在多个默认项。')
        kinds.add(fields.kind)
      }
    }
    const rows = db.prepare(`SELECT id, preset_id, revision, book_revision, fields_json, created_at
      FROM ai_preset_history ORDER BY book_revision, preset_id LIMIT ?`).iterate(MAX_AI_PRESET_HISTORY + 1)
    for (const raw of rows) {
      const row = raw as HistoryRow, owner = entries.get(row.preset_id), previous = seen.get(row.preset_id)
      if (requiredId(row.id).toLowerCase() !== row.id || !owner || !Number.isSafeInteger(row.book_revision) ||
        row.book_revision <= (previous?.bookRevision ?? 0) || row.book_revision > current.revision ||
        row.revision !== (previous?.revision ?? 0) + 1 || row.revision > owner.revision || !validTimestamp(row.created_at)) return fail('预设历史的身份、连续版本或作品版本不一致。')
      const fields = storedFields(row.fields_json)
      if (version < AI_SUMMARY_PRESETS_SCHEMA_VERSION && fields.kind === 'summarize') return fail('旧格式预设历史不能包含摘要任务。')
      checkConnection(db, id, fields.connectionId)
      if (row.revision === owner.revision && (row.fields_json !== JSON.stringify(aiPresetFields(owner)) || row.created_at !== owner.updatedAt)) return fail('预设当前值与最新历史不一致。')
      // 同一保存可同时撤下旧默认、写入新默认；只在事务版本的边界核对唯一性。
      if (row.book_revision !== groupRevision) { checkDefaults(); groupRevision = row.book_revision }
      seen.set(row.preset_id, { revision: row.revision, bookRevision: row.book_revision, fields })
    }
    checkDefaults()
    for (const item of entries.values()) if (seen.get(item.id)?.revision !== item.revision) return fail('预设缺少完整的不可变历史。')
  })
}

export class AiPresetRepository {
  constructor(private readonly studio: StudioRepository) {}

  getAiPresets(input: GetAiPresetsInput): AiPresetsSnapshot {
    return perform(() => {
      const data = parseGetAiPresetsInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => readSnapshot(db, data.bookId))()
    })
  }

  saveAiPreset(input: SaveAiPresetInput): AiPresetsSnapshot {
    return perform(() => {
      const data = parseSaveAiPresetInput(input), db = this.studio.getMemoryDatabase(data.bookId)
      const snapshot = db.transaction(() => {
        const version = schemaVersion(db)
        if (version < AI_PRESETS_SCHEMA_VERSION) return fail('请先备份并升级作品，再保存任务预设。', 'FORBIDDEN')
        if (data.fields.kind === 'summarize' && version < AI_SUMMARY_PRESETS_SCHEMA_VERSION) return fail('请先备份并升级作品，再保存摘要预设；原五类预设仍可使用。', 'FORBIDDEN')
        const current = bookState(db, data.bookId)
        if (current.archived_at !== null) return fail('作品已归档，任务预设仅供查看。', 'FORBIDDEN')
        if (current.revision !== data.expectedBookRevision) return fail('作品已有新版本，当前输入已保留，请读取最新内容并比较。', 'REVISION_CONFLICT')
        const count = checkBudget(db, true)
        const previous = db.prepare(`SELECT ${PRESET_COLUMNS} FROM ai_presets WHERE id = ?`).get(data.id) as PresetRow | undefined
        if ((previous?.revision ?? 0) !== data.expectedRevision) return fail('预设已有新版本，请核对后再保存。', 'REVISION_CONFLICT')
        if (previous) { preset(previous, current.revision); checkLatest(db, previous) }
        else if (count >= MAX_AI_PRESETS) return fail('本书最多保存 200 条预设（含归档），可继续编辑已有预设。', 'INVALID_INPUT')
        checkConnection(db, data.bookId, data.fields.connectionId, true)
        const now = new Date().toISOString(), nextBookRevision = current.revision + 1
        const write = (id: string, revision: number, fields: AiPresetFields, exists: boolean) => {
          const json = JSON.stringify(fields)
          if (Buffer.byteLength(json, 'utf8') > MAX_AI_PRESET_FIELDS_BYTES) return fail('单条预设超过 32 KiB，请缩短协作要求。', 'INVALID_INPUT')
          if (exists) {
            const changed = db.prepare('UPDATE ai_presets SET revision = ?, kind = ?, default_for_task = ?, archived = ?, fields_json = ?, updated_at = ? WHERE id = ? AND revision = ?')
              .run(revision, fields.kind, Number(fields.defaultForTask), Number(fields.archived), json, now, id, revision - 1)
            if (changed.changes !== 1) return fail('预设版本发生变化，保存已回滚。', 'REVISION_CONFLICT')
          } else db.prepare('INSERT INTO ai_presets (id, revision, kind, default_for_task, archived, fields_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, revision, fields.kind, Number(fields.defaultForTask), Number(fields.archived), json, now)
          db.prepare('INSERT INTO ai_preset_history (id, preset_id, revision, book_revision, fields_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), id, revision, nextBookRevision, json, now)
        }
        if (data.fields.defaultForTask) {
          const oldDefault = db.prepare(`SELECT ${PRESET_COLUMNS} FROM ai_presets WHERE kind = ? AND default_for_task = 1 AND archived = 0 AND id <> ?`).get(data.fields.kind, data.id) as PresetRow | undefined
          if (oldDefault) {
            const old = preset(oldDefault, current.revision)
            checkLatest(db, oldDefault)
            write(old.id, old.revision + 1, { ...aiPresetFields(old), defaultForTask: false }, true)
          }
        }
        // 默认替换、条目、不可变历史和作品版本同事务提交；回执或容量检查失败则全部回滚。
        write(data.id, data.expectedRevision + 1, data.fields, Boolean(previous))
        const updated = db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1 AND id = ? AND revision = ? AND archived_at IS NULL')
          .run(now, data.bookId, current.revision)
        if (updated.changes !== 1) return fail('作品版本发生变化。', 'REVISION_CONFLICT')
        checkBudget(db, true)
        const result = readSnapshot(db, data.bookId)
        if (!isAiPresetSaveReceipt(result, data)) return fail('预设保存回执与提交内容不一致。')
        return result
      }).immediate()
      this.studio.refreshKnowledgeCatalog(data.bookId)
      return snapshot
    })
  }
}
