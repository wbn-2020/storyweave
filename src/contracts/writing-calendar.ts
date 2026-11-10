import { DomainError, isRecord, optionalText, requiredId, requiredInteger, requiredText, type BookInput, type BookMutationInput, type Result } from './api'
import type { WritingDay } from './workbench'

export const CALENDAR_SCHEMA_VERSION = 14
export const MAX_CALENDAR_ENTRIES = 2_000
export const MAX_CALENDAR_FIELDS_BYTES = 16 * 1024
export const MAX_CALENDAR_ENTRIES_BYTES = 8 * 1024 * 1024
export const MAX_CALENDAR_SNAPSHOT_BYTES = 10 * 1024 * 1024
export const MAX_CALENDAR_HISTORY = 100_000
export const MAX_CALENDAR_HISTORY_BYTES = 128 * 1024 * 1024
export const MIN_CALENDAR_MONTH = '1900-01'
export const MAX_CALENDAR_MONTH = '9999-12'
export const CALENDAR_KINDS = ['writing', 'deadline', 'publication', 'idea'] as const

export interface CalendarEntryFields {
  date: string
  title: string
  kind: typeof CALENDAR_KINDS[number]
  notes: string
  done: boolean
  targetCharacters?: number | null
}
export interface CalendarEntry extends CalendarEntryFields {
  id: string
  revision: number
  updatedAt: string
}
export interface CalendarStatistics {
  plannedCharacters: number
  added: number
  removed: number
  net: number
  minutes: number
  // 逐日、逐来源的改稿章次之和，不是全月去重章节数。
  revisedChapterDays: number
  scheduled: number
  completed: number
  overdue: number
}
export interface CalendarSnapshot {
  bookId: string
  bookRevision: number
  archived: boolean
  schemaVersion: number
  requiresUpgrade: boolean
  month: string
  today: string
  totalEntries: number
  events: CalendarEntry[]
  activity: WritingDay[]
  statistics: CalendarStatistics
  // 改期可移出当前查询月份；独立回显实际保存对象，避免依赖月内列表确认写入。
  savedEntry: CalendarEntry | null
}
export interface GetWritingCalendarInput extends BookInput { month: string }
export interface SaveCalendarEntryInput extends BookMutationInput {
  id: string
  expectedRevision: number
  month?: string
  fields: CalendarEntryFields
}
export interface WritingCalendarApi {
  getWritingCalendar(input: GetWritingCalendarInput): Promise<Result<CalendarSnapshot>>
  saveCalendarEntry(input: SaveCalendarEntryInput): Promise<Result<CalendarSnapshot>>
}

function invalid(message: string): never { throw new DomainError({ code: 'INVALID_INPUT', message }) }
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return invalid('创作日历参数无效。')
  return value
}
export function parseCalendarMonth(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < MIN_CALENDAR_MONTH || value > MAX_CALENDAR_MONTH) {
    return invalid('月份须为 1900-01 至 9999-12 之间的 YYYY-MM。')
  }
  return value
}
export function calendarMonthDates(value: string): string[] {
  const month = parseCalendarMonth(value)
  const year = Number(month.slice(0, 4)), index = Number(month.slice(5))
  const count = new Date(Date.UTC(year, index, 0)).getUTCDate()
  return Array.from({ length: count }, (_, day) => `${month}-${String(day + 1).padStart(2, '0')}`)
}
export function parseCalendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !calendarMonthDates(value.slice(0, 7)).includes(value)) {
    return invalid('日期须为真实存在的 YYYY-MM-DD。')
  }
  return value
}
export function parseCalendarEntryFields(value: unknown): CalendarEntryFields {
  const v = object(value)
  const title = requiredText(v.title, '日程标题', 160)
  const notes = optionalText(v.notes === undefined ? '' : v.notes, '日程备注', 4_000)
  if (title.includes('\0') || notes.includes('\0')) return invalid('日程内容含有无效字符。')
  if (typeof v.kind !== 'string' || !CALENDAR_KINDS.includes(v.kind as CalendarEntryFields['kind'])) return invalid('日程类型无效。')
  if (typeof v.done !== 'boolean') return invalid('请明确日程的完成状态。')
  return { date: parseCalendarDate(v.date), title, kind: v.kind as CalendarEntryFields['kind'], notes, done: v.done,
    targetCharacters: v.targetCharacters === undefined || v.targetCharacters === null ? null : requiredInteger(v.targetCharacters, '计划字数', 1_000_000) }
}
export function parseGetWritingCalendarInput(value: unknown): GetWritingCalendarInput {
  const v = object(value)
  return { bookId: requiredId(v.bookId).toLowerCase(), month: parseCalendarMonth(v.month) }
}
export function parseSaveCalendarEntryInput(value: unknown): SaveCalendarEntryInput & { month: string } {
  const v = object(value)
  const fields = parseCalendarEntryFields(v.fields)
  return { bookId: requiredId(v.bookId).toLowerCase(), expectedBookRevision: requiredInteger(v.expectedBookRevision, '作品版本'),
    id: requiredId(v.id).toLowerCase(), expectedRevision: requiredInteger(v.expectedRevision, '日程版本'),
    month: parseCalendarMonth(v.month === undefined ? fields.date.slice(0, 7) : v.month), fields }
}

export function calendarStatistics(events: readonly CalendarEntry[], activity: readonly WritingDay[], today: string): CalendarStatistics {
  return {
    plannedCharacters: events.reduce((sum, entry) => sum + (entry.targetCharacters ?? 0), 0),
    added: activity.reduce((sum, day) => sum + day.added, 0),
    removed: activity.reduce((sum, day) => sum + day.removed, 0),
    net: activity.reduce((sum, day) => sum + day.net, 0),
    minutes: activity.reduce((sum, day) => sum + day.minutes, 0),
    revisedChapterDays: activity.reduce((sum, day) => sum + day.revisedChapters, 0),
    scheduled: events.length,
    completed: events.filter((entry) => entry.done).length,
    overdue: events.filter((entry) => !entry.done && entry.date < today).length,
  }
}

export function isCalendarSnapshot(value: unknown, bookId: string, month: string): value is CalendarSnapshot {
  try {
    const v = object(value)
    if (v.bookId !== bookId || v.month !== parseCalendarMonth(month) || typeof v.archived !== 'boolean' || typeof v.requiresUpgrade !== 'boolean') return false
    const revision = requiredInteger(v.bookRevision, '作品版本')
    const schemaVersion = requiredInteger(v.schemaVersion, '数据版本')
    if (v.requiresUpgrade !== (schemaVersion < CALENDAR_SCHEMA_VERSION)) return false
    const today = parseCalendarDate(v.today)
    const total = requiredInteger(v.totalEntries, '日程数量', MAX_CALENDAR_ENTRIES)
    if (!Array.isArray(v.events) || v.events.length > total || !Array.isArray(v.activity) || v.activity.length > 31 * 4) return false
    const validEntry = (entry: unknown) => {
      const row = object(entry)
      if (requiredId(row.id).toLowerCase() !== row.id || requiredInteger(row.revision, '日程版本', revision) < 1) return false
      if (typeof row.updatedAt !== 'string' || row.updatedAt.length !== 24 || new Date(row.updatedAt).toISOString() !== row.updatedAt) return false
      const fields = parseCalendarEntryFields(row)
      return Object.entries(fields).every(([key, field]) => row[key] === field)
    }
    if (v.events.some((entry) => !validEntry(entry) || entry.date.slice(0, 7) !== month) || new Set(v.events.map((entry) => entry.id)).size !== v.events.length) return false
    if (v.savedEntry !== null) {
      if (!validEntry(v.savedEntry) || total === 0) return false
      const saved = object(v.savedEntry)
      const listed = v.events.find((entry) => entry.id === saved.id)
      if (String(saved.date).slice(0, 7) === month) {
        if (!listed || Object.entries(saved).some(([key, field]) => listed[key] !== field)) return false
      } else if (listed) return false
    }
    const seen = new Set<string>()
    for (const item of v.activity) {
      const day = object(item)
      if (parseCalendarDate(day.date).slice(0, 7) !== month || typeof day.source !== 'string' || !['manual', 'ai', 'import', 'restore'].includes(day.source)) return false
      const key = `${day.date}:${day.source}`
      if (seen.has(key)) return false
      seen.add(key)
      for (const field of ['added', 'removed', 'minutes', 'revisedChapters']) requiredInteger(day[field], '写作统计')
      if (!Number.isSafeInteger(day.net) || day.net !== Number(day.added) - Number(day.removed)) return false
    }
    const expected = calendarStatistics(v.events as CalendarEntry[], v.activity as WritingDay[], today)
    const statistics = v.statistics
    if (!isRecord(statistics) || Object.entries(expected).some(([key, count]) => !Number.isSafeInteger(count) || statistics[key] !== count)) return false
    return !v.requiresUpgrade || (total === 0 && v.events.length === 0 && v.activity.length === 0 && v.savedEntry === null)
  } catch { return false }
}
