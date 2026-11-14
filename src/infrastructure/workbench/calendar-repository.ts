import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredInteger } from '../../contracts/api'
import {
  CALENDAR_SCHEMA_VERSION, MAX_CALENDAR_ENTRIES, MAX_CALENDAR_ENTRIES_BYTES, MAX_CALENDAR_FIELDS_BYTES,
  MAX_CALENDAR_HISTORY, MAX_CALENDAR_HISTORY_BYTES, MAX_CALENDAR_SNAPSHOT_BYTES,
  calendarMonthDates, calendarStatistics, isCalendarSnapshot, parseCalendarDate, parseCalendarEntryFields,
  parseGetWritingCalendarInput, parseSaveCalendarEntryInput,
  type CalendarCreationMetrics, type CalendarEntry, type CalendarEntryFields, type CalendarSnapshot, type GetWritingCalendarInput, type SaveCalendarEntryInput,
} from '../../contracts/writing-calendar'
import type { WritingDay } from '../../contracts/workbench'
import type { StudioRepository } from '../storage/studio-repository'
import { CALENDAR_SCHEMA } from './calendar-schema'
import { localWritingDate } from './writing-activity'

interface State { id: string; revision: number; archived_at: string | null }
interface EntryRow { id: string; revision: number; date: string; fields_json: string; updated_at: string }
interface HistoryRow { id: string; entry_id: string; revision: number; book_revision: number; fields_json: string; created_at: string }
interface Budget { count: number; bytes: number; largest: number }

function fail(message: string, code: 'STORAGE_ERROR' | 'FORBIDDEN' | 'REVISION_CONFLICT' | 'INVALID_INPUT' = 'STORAGE_ERROR'): never {
  throw new DomainError({ code, message })
}
function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    return fail('创作日历读写失败，请保留输入并检查作品文件。')
  }
}
function state(db: Database.Database, bookId: string): State {
  const row = db.prepare('SELECT id, revision, archived_at FROM book_meta WHERE singleton = 1').get() as State | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0 || (row.archived_at !== null && typeof row.archived_at !== 'string')) return fail('日历所属作品状态无效。')
  return row
}
function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function storedFields(json: unknown): CalendarEntryFields {
  try {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_CALENDAR_FIELDS_BYTES) return fail('日程内容超过容量限制。')
    const fields = parseCalendarEntryFields(JSON.parse(json))
    if (JSON.stringify(fields) !== json) return fail('日程内容不符合当前格式。')
    return fields
  } catch { return fail('日程内容、日期或计划字数无效。') }
}
function entry(row: EntryRow, bookRevision: number): CalendarEntry {
  try {
    if (requiredId(row.id).toLowerCase() !== row.id || requiredInteger(row.revision, '日程版本', bookRevision) < 1 || !validTimestamp(row.updated_at)) return fail('日程身份或版本无效。')
    const fields = storedFields(row.fields_json)
    if (row.date !== fields.date) return fail('日程日期索引与内容不一致。')
    return { ...fields, id: row.id, revision: row.revision, updatedAt: row.updated_at }
  } catch { return fail('日程条目损坏，未截断或替换已有记录。') }
}
function checkBudget(db: Database.Database, history = false): number {
  // 先汇总字节与数量，再读取正文；恢复包中的超大字段也不能直接载入进程。
  const current = db.prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(length(CAST(fields_json AS BLOB)) + length(CAST(id AS BLOB)) + length(CAST(date AS BLOB)) + length(CAST(updated_at AS BLOB))), 0) AS bytes,
    COALESCE(MAX(length(CAST(fields_json AS BLOB))), 0) AS largest FROM calendar_entries`).get() as Budget
  if (!Number.isSafeInteger(current.count) || current.count > MAX_CALENDAR_ENTRIES || !Number.isSafeInteger(current.bytes) || current.bytes > MAX_CALENDAR_ENTRIES_BYTES || current.largest > MAX_CALENDAR_FIELDS_BYTES) {
    return fail('日历超出 2,000 条、当前内容 8 MiB 或单条 16 KiB 的容量限制。')
  }
  if (history) {
    const archived = db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(fields_json AS BLOB)) + length(CAST(id AS BLOB)) + length(CAST(entry_id AS BLOB)) + length(CAST(created_at AS BLOB))), 0) AS bytes,
      COALESCE(MAX(length(CAST(fields_json AS BLOB))), 0) AS largest FROM calendar_entry_history`).get() as Budget
    if (!Number.isSafeInteger(archived.count) || archived.count > MAX_CALENDAR_HISTORY || !Number.isSafeInteger(archived.bytes) || archived.bytes > MAX_CALENDAR_HISTORY_BYTES || archived.largest > MAX_CALENDAR_FIELDS_BYTES) {
      return fail('日程历史超出 100,000 次修订或 128 MiB 的容量限制，已有历史仍保留。')
    }
  }
  return current.count
}
const ENTRY_COLUMNS = `CASE WHEN length(CAST(id AS BLOB)) = 36 THEN id END AS id, revision,
  CASE WHEN length(CAST(date AS BLOB)) = 10 THEN date END AS date,
  CASE WHEN length(CAST(fields_json AS BLOB)) <= ${MAX_CALENDAR_FIELDS_BYTES} THEN fields_json END AS fields_json,
  CASE WHEN length(CAST(updated_at AS BLOB)) = 24 THEN updated_at END AS updated_at`

function readCreationMetrics(db: Database.Database, today: string): CalendarCreationMetrics {
  // 日历日期用 UTC 平移，避免本地夏令时把相邻日期算成 23 或 25 小时。
  const shift = (date: string, offset: number) => {
    const value = new Date(`${date}T12:00:00Z`)
    value.setUTCDate(value.getUTCDate() + offset)
    return value.toISOString().slice(0, 10)
  }
  const yesterday = shift(today, -1)
  const weekStart = shift(today, -(new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7)
  const previousWeekStart = shift(weekStart, -7), previousWeekEnd = shift(today, -7)
  const result: CalendarCreationMetrics = { todayAdded: 0, yesterdayAdded: 0, weekAdded: 0, previousWeekAdded: 0, streak: 0, previousStreak: 0 }
  const cursors = [
    { next: today, fallback: yesterday, count: 0, open: true },
    { next: yesterday, fallback: shift(today, -2), count: 0, open: true },
  ]
  // 仅累计有新增的日期；导入与恢复按原来源计入，不把计划完成或登记时长算作新增。
  // 按日期倒序流式读：两段连续记录均已断开且早于对比周即可停止，不按年截断连续天数。
  const records = db.prepare(`SELECT CASE WHEN length(CAST(date AS BLOB)) = 10 THEN date END AS date, SUM(added) AS added
    FROM writing_activity WHERE date <= ? AND added > 0 GROUP BY date ORDER BY date DESC`).iterate(today)
  for (const raw of records) {
    const row = raw as { date: string; added: number }
    try { parseCalendarDate(row.date) } catch { return fail('创作指标包含无效的写作日期。') }
    if (!Number.isSafeInteger(row.added) || row.added <= 0) return fail('创作指标新增字数无效或超过安全整数范围。')
    if (row.date === today) result.todayAdded = row.added
    if (row.date === yesterday) result.yesterdayAdded = row.added
    if (row.date >= weekStart) result.weekAdded += row.added
    if (row.date >= previousWeekStart && row.date <= previousWeekEnd) result.previousWeekAdded += row.added
    for (const cursor of cursors) {
      if (!cursor.open || row.date > cursor.next) continue
      // 当天尚未新增时保留截至前一天的连续天数，不能向更早的任意日期寻找起点。
      if (cursor.count === 0 && row.date === cursor.fallback) cursor.next = cursor.fallback
      if (row.date === cursor.next) { cursor.count += 1; cursor.next = shift(row.date, -1) }
      else cursor.open = false
    }
    if (row.date < previousWeekStart && cursors.every((cursor) => !cursor.open)) break
  }
  result.streak = cursors[0].count; result.previousStreak = cursors[1].count
  if (!Number.isSafeInteger(result.weekAdded) || !Number.isSafeInteger(result.previousWeekAdded)) return fail('创作指标周累计超过安全整数范围。')
  return result
}

function readSnapshot(db: Database.Database, input: GetWritingCalendarInput): CalendarSnapshot {
  const current = state(db, input.bookId)
  const schemaVersion = Number(db.pragma('user_version', { simple: true }))
  const today = localWritingDate(new Date())
  const snapshot: CalendarSnapshot = { bookId: input.bookId, bookRevision: current.revision, archived: current.archived_at !== null,
    schemaVersion, requiresUpgrade: schemaVersion < CALENDAR_SCHEMA_VERSION, month: input.month, today,
    totalEntries: 0, events: [], activity: [], statistics: calendarStatistics([], [], today), savedEntry: null }
  if (snapshot.requiresUpgrade) return snapshot
  snapshot.totalEntries = checkBudget(db)
  const dates = calendarMonthDates(input.month)
  snapshot.events = (db.prepare(`SELECT ${ENTRY_COLUMNS} FROM calendar_entries WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT ?`)
    .all(dates[0], dates[dates.length - 1], MAX_CALENDAR_ENTRIES + 1) as EntryRow[]).map((row) => entry(row, current.revision))
  // 只读取目标月的日/来源聚合，最多 31×4 行；旧月份可查询，不套用工作台最近一年的显示窗口。
  snapshot.activity = db.prepare(`SELECT CASE WHEN length(CAST(date AS BLOB)) = 10 THEN date END AS date,
    CASE WHEN length(CAST(source AS BLOB)) <= 7 THEN source END AS source,
    SUM(added) AS added, SUM(removed) AS removed, SUM(added - removed) AS net, SUM(minutes) AS minutes,
    COUNT(DISTINCT CASE WHEN revised = 1 THEN chapter_id END) AS revisedChapters
    FROM writing_activity WHERE date BETWEEN ? AND ? GROUP BY date, source ORDER BY date, source LIMIT 125`)
    .all(dates[0], dates[dates.length - 1]) as WritingDay[]
  snapshot.statistics = calendarStatistics(snapshot.events, snapshot.activity, today)
  if (input.includeCreationMetrics) snapshot.creationMetrics = readCreationMetrics(db, today)
  if (!isCalendarSnapshot(snapshot, input.bookId, input.month) || Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_CALENDAR_SNAPSHOT_BYTES) {
    return fail('日历快照无效或超过 10 MiB，未截断记录。')
  }
  return snapshot
}

/** 在恢复包只读连接上校验 v14 日历；旧版不要求存在日历表。 */
export function validateCalendarDatabase(db: Database.Database, bookId: string): void {
  perform(() => {
    if (Number(db.pragma('user_version', { simple: true })) < CALENDAR_SCHEMA_VERSION) return
    const current = state(db, requiredId(bookId).toLowerCase())
    // 同时核对表约束和不可变触发器，避免恢复后历史可以被更新或删除。
    const definitions = CALENDAR_SCHEMA.match(/CREATE TABLE[\s\S]+?\) STRICT;|CREATE INDEX[^;]+;|CREATE TRIGGER[\s\S]+?END;/g) ?? []
    if (definitions.length !== 5) return fail('日历结构校验定义不完整。')
    const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ')
    for (const definition of definitions) {
      const name = /CREATE (?:TABLE|INDEX|TRIGGER) (\w+)/.exec(definition)?.[1]
      const actual = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | undefined
      if (!actual || normalize(actual.sql) !== normalize(definition)) return fail('日历数据表、索引或历史保护结构不匹配。')
    }
    checkBudget(db, true)
    const entries = new Map<string, EntryRow>()
    for (const row of db.prepare(`SELECT ${ENTRY_COLUMNS} FROM calendar_entries ORDER BY id LIMIT ?`).all(MAX_CALENDAR_ENTRIES + 1) as EntryRow[]) {
      entry(row, current.revision)
      if (entries.has(row.id)) return fail('日程身份重复。')
      entries.set(row.id, row)
    }
    const revisions = new Map<string, number>()
    let previousBookRevision = 0
    const history = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB)) = 36 THEN id END AS id,
      CASE WHEN length(CAST(entry_id AS BLOB)) = 36 THEN entry_id END AS entry_id, revision, book_revision,
      CASE WHEN length(CAST(fields_json AS BLOB)) <= ? THEN fields_json END AS fields_json,
      CASE WHEN length(CAST(created_at AS BLOB)) = 24 THEN created_at END AS created_at
      FROM calendar_entry_history ORDER BY book_revision LIMIT ?`).iterate(MAX_CALENDAR_FIELDS_BYTES, MAX_CALENDAR_HISTORY + 1)
    for (const raw of history) {
      const row = raw as HistoryRow
      const owner = entries.get(row.entry_id)
      if (requiredId(row.id).toLowerCase() !== row.id || !owner || !Number.isSafeInteger(row.book_revision) || row.book_revision <= previousBookRevision || row.book_revision > current.revision || row.revision !== (revisions.get(row.entry_id) ?? 0) + 1 || !validTimestamp(row.created_at)) {
        return fail('日程历史身份、连续版本或作品版本不一致。')
      }
      storedFields(row.fields_json)
      if (row.revision > owner.revision || (row.revision === owner.revision && (row.fields_json !== owner.fields_json || row.created_at !== owner.updated_at))) return fail('日程当前值与最新不可变历史不一致。')
      previousBookRevision = row.book_revision
      revisions.set(row.entry_id, row.revision)
    }
    for (const row of entries.values()) if (revisions.get(row.id) !== row.revision) return fail('日程缺少完整的不可变历史。')
  })
}

export class WritingCalendarRepository {
  constructor(private readonly studio: StudioRepository) {}

  getWritingCalendar(input: GetWritingCalendarInput): CalendarSnapshot {
    return perform(() => {
      const data = parseGetWritingCalendarInput(input)
      const db = this.studio.getMemoryDatabase(data.bookId)
      return db.transaction(() => readSnapshot(db, data))()
    })
  }

  saveCalendarEntry(input: SaveCalendarEntryInput): CalendarSnapshot {
    return perform(() => {
      const data = parseSaveCalendarEntryInput(input)
      const db = this.studio.getMemoryDatabase(data.bookId)
      const snapshot = db.transaction(() => {
        if (Number(db.pragma('user_version', { simple: true })) < CALENDAR_SCHEMA_VERSION) return fail('请先备份并升级作品，再保存创作日历。', 'FORBIDDEN')
        const current = state(db, data.bookId)
        if (current.archived_at !== null) return fail('作品已归档，创作日历仅供查看。', 'FORBIDDEN')
        if (current.revision !== data.expectedBookRevision) return fail('作品已有新版本；当前输入已保留，请重新读取并比较后保存。', 'REVISION_CONFLICT')
        if (current.revision >= Number.MAX_SAFE_INTEGER || data.expectedRevision >= Number.MAX_SAFE_INTEGER) return fail('日历版本已超出支持范围。')
        const count = checkBudget(db, true)
        const previous = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM calendar_entries WHERE id = ?`).get(data.id) as EntryRow | undefined
        if ((previous?.revision ?? 0) !== data.expectedRevision) return fail('日程已有新版本；当前输入已保留，请核对后保存。', 'REVISION_CONFLICT')
        if (previous) {
          entry(previous, current.revision)
          const latest = db.prepare('SELECT revision, fields_json, created_at FROM calendar_entry_history WHERE entry_id = ? ORDER BY revision DESC LIMIT 1').get(data.id) as
            { revision: number; fields_json: string; created_at: string } | undefined
          if (!latest || latest.revision !== previous.revision || latest.fields_json !== previous.fields_json || latest.created_at !== previous.updated_at) return fail('日程当前值缺少匹配的历史，保存已停止。')
        } else if (count >= MAX_CALENDAR_ENTRIES) return fail('每部作品最多保存 2,000 条日程，可以继续编辑已有日程。', 'INVALID_INPUT')
        const json = JSON.stringify(data.fields)
        if (Buffer.byteLength(json, 'utf8') > MAX_CALENDAR_FIELDS_BYTES) return fail('单条日程内容不得超过 16 KiB，请缩短备注。', 'INVALID_INPUT')
        const now = new Date().toISOString(), revision = data.expectedRevision + 1
        if (previous) {
          const updated = db.prepare('UPDATE calendar_entries SET revision = ?, date = ?, fields_json = ?, updated_at = ? WHERE id = ? AND revision = ?')
            .run(revision, data.fields.date, json, now, data.id, data.expectedRevision)
          if (updated.changes !== 1) return fail('日程版本发生变化。', 'REVISION_CONFLICT')
        } else db.prepare('INSERT INTO calendar_entries (id, revision, date, fields_json, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(data.id, revision, data.fields.date, json, now)
        // 当前值、历史和作品版本同事务提交；回执及容量检查失败时全部回滚。
        db.prepare('INSERT INTO calendar_entry_history (id, entry_id, revision, book_revision, fields_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), data.id, revision, current.revision + 1, json, now)
        const advanced = db.prepare('UPDATE book_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1 AND id = ? AND revision = ? AND archived_at IS NULL')
          .run(now, data.bookId, current.revision)
        if (advanced.changes !== 1) return fail('作品版本发生变化。', 'REVISION_CONFLICT')
        checkBudget(db, true)
        const result = readSnapshot(db, data)
        result.savedEntry = { ...data.fields, id: data.id, revision, updatedAt: now }
        if (!isCalendarSnapshot(result, data.bookId, data.month) || Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_CALENDAR_SNAPSHOT_BYTES) return fail('保存回执超出容量或与日程不匹配。')
        return result
      }).immediate()
      this.studio.refreshKnowledgeCatalog(data.bookId)
      return snapshot
    })
  }
}
