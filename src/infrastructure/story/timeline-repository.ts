import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredInteger, requiredText } from '../../contracts/api'
import { AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES } from '../../contracts/knowledge'
import { MAX_STORY_RECORDS, parseDisclosure, parseStoryTime, type Disclosure } from '../../contracts/story'
import {
  MAX_TIMELINE_PAGE_SIZE, parseStoryTimelineInput,
  type StoryTimelineInput, type StoryTimelineItem, type StoryTimelinePage, type TimelineDisclosure,
} from '../../contracts/story-timeline'
import type { StudioRepository } from '../storage/studio-repository'

interface BookState { id: string; revision: number; knowledge_revision: number }
interface TimelineRow {
  id: string; book_id: string; title: string; description: string; fields_kind: string
  time_json: string | null; disclosure_json: string | null; story_order: number | null
  nature: unknown; author_decision: unknown; freshness: unknown; conflict_state: unknown
  chapter_id: string | null; chapter_title: string | null; chapter_position: number | null
  current_revision_id: string | null; registered_revision_id: string | null
}

const EVENT_FILTER = `s.book_id = @bookId AND s.kind = 'event'
  AND (@search = '' OR instr(s.title, @search) > 0 OR instr(s.description, @search) > 0)
  AND (@nature IS NULL OR json_extract(s.fields_json, '$.nature') = @nature)
  AND (@authorDecision IS NULL OR json_extract(s.fields_json, '$.authorDecision') = @authorDecision)`

const DISCLOSURE_ORDER = `CASE json_extract(s.fields_json, '$.disclosure.state')
  WHEN 'located' THEN CASE
    WHEN c.id IS NULL OR r.id IS NULL THEN 2
    WHEN c.current_revision_id = r.id THEN 0
    ELSE 1 END
  WHEN 'undisclosed' THEN 3
  ELSE 4 END, c.position IS NULL, c.position, s.id`

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '故事时间线读取失败，请检查作品文件。' })
}

function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}

function readState(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, knowledge_revision FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
      !Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 0) throw storageFailure()
  return row
}

function storedChoice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw storageFailure()
  return value as T
}

function timelineDisclosure(row: TimelineRow, disclosure: Disclosure): TimelineDisclosure {
  if (row.chapter_id === null) {
    if (row.chapter_title !== null || row.chapter_position !== null || row.current_revision_id !== null ||
        row.registered_revision_id !== null) throw storageFailure()
    return disclosure.state === 'located'
      ? { ...disclosure, chapterTitle: null, chapterPosition: null, referenceState: 'missing' }
      : disclosure
  }
  if (disclosure.state !== 'located' || requiredId(row.chapter_id) !== disclosure.chapterId) throw storageFailure()
  const chapterTitle = requiredText(row.chapter_title, '章节名称', 120)
  const chapterPosition = requiredInteger(row.chapter_position, '章节位置')
  const currentRevisionId = requiredId(row.current_revision_id)
  const revisionId = row.registered_revision_id === null ? null : requiredId(row.registered_revision_id)
  if (revisionId !== null && revisionId !== disclosure.revisionId) throw storageFailure()
  // 登记状态仅核对章节和修订元数据；段落是否存在、原文是否有效由打开原稿时另行核验。
  return { ...disclosure, chapterTitle, chapterPosition,
    referenceState: revisionId === null ? 'missing' : currentRevisionId === revisionId ? 'current' : 'historical' }
}

function timelineItem(row: TimelineRow, bookId: string): StoryTimelineItem {
  try {
    if (row.book_id !== bookId || row.fields_kind !== 'event' || typeof row.time_json !== 'string' ||
        typeof row.disclosure_json !== 'string' || typeof row.description !== 'string' ||
        Array.from(row.description).length > 240) throw storageFailure()
    const time = parseStoryTime(JSON.parse(row.time_json))
    if ((time.kind === 'unknown' ? null : time.order) !== row.story_order) throw storageFailure()
    const disclosure = timelineDisclosure(row, parseDisclosure(JSON.parse(row.disclosure_json)))
    return { id: requiredId(row.id), bookId, title: requiredText(row.title, '事件名称', 120), description: row.description,
      nature: storedChoice(row.nature, KNOWLEDGE_NATURES), authorDecision: storedChoice(row.author_decision, AUTHOR_DECISIONS),
      freshness: storedChoice(row.freshness, KNOWLEDGE_FRESHNESS), conflictState: storedChoice(row.conflict_state, CONFLICT_STATES),
      time, disclosure }
  } catch {
    // 契约解析器用于检查存储行，格式错误属于存储损坏，不应报告为调用方输入错误。
    throw storageFailure()
  }
}

export class StoryTimelineRepository {
  constructor(private readonly studio: StudioRepository) {}

  list(input: StoryTimelineInput): StoryTimelinePage {
    return perform(() => {
      const data = parseStoryTimelineInput(input)
      const { db } = this.studio.getStoryDatabase(data.bookId)
      return db.transaction(() => {
        // 版本、总数与分页来自同一只读快照，翻页同时约束目录正文和知识资料的版本。
        const state = readState(db, data.bookId)
        if (data.expectedBookRevision !== undefined && (state.revision !== data.expectedBookRevision ||
            state.knowledge_revision !== data.expectedKnowledgeRevision)) throw new DomainError({
          code: 'REVISION_CONFLICT', message: '作品或知识库版本已变化，请重新读取时间线第一页。',
        })
        const params = { bookId: data.bookId, search: data.search ?? '',
          nature: data.nature ?? null, authorDecision: data.authorDecision ?? null }
        const { total } = db.prepare(`SELECT COUNT(*) AS total FROM story_records s WHERE ${EVENT_FILTER}`).get(params) as { total: number }
        if (!Number.isSafeInteger(total) || total < 0 || total > MAX_STORY_RECORDS) throw storageFailure()
        const limit = data.limit ?? MAX_TIMELINE_PAGE_SIZE
        const offset = data.offset ?? 0
        // 故事顺序只取作者的排序值；披露按当前登记稿、历史登记稿、缺失登记、未披露、未知分组。
        // 组内取当前章节位置，同章由事件 ID 稳定排序，不推测日期或段落先后。
        const order = data.order === 'story' ? 's.story_order IS NULL, s.story_order, s.id' : DISCLOSURE_ORDER
        // 只返回本页必要字段和摘要，章节联接只读取元数据，不装载正文或完整故事字段。
        const rows = db.prepare(`SELECT s.id, s.book_id, s.title, substr(s.description, 1, 240) AS description,
          json_extract(s.fields_json, '$.kind') AS fields_kind,
          CASE WHEN json_type(s.fields_json, '$.storyTime') = 'object'
            THEN json_extract(s.fields_json, '$.storyTime') END AS time_json,
          CASE WHEN json_type(s.fields_json, '$.disclosure') = 'object'
            THEN json_extract(s.fields_json, '$.disclosure') END AS disclosure_json,
          s.story_order, json_extract(s.fields_json, '$.nature') AS nature,
          json_extract(s.fields_json, '$.authorDecision') AS author_decision,
          json_extract(s.fields_json, '$.freshness') AS freshness,
          json_extract(s.fields_json, '$.conflictState') AS conflict_state,
          c.id AS chapter_id, c.title AS chapter_title, c.position AS chapter_position,
          c.current_revision_id, r.id AS registered_revision_id
          FROM story_records s
          LEFT JOIN chapters c ON json_extract(s.fields_json, '$.disclosure.state') = 'located'
            AND c.id = json_extract(s.fields_json, '$.disclosure.chapterId')
          LEFT JOIN chapter_revisions r ON r.chapter_id = c.id
            AND r.id = json_extract(s.fields_json, '$.disclosure.revisionId')
          WHERE ${EVENT_FILTER} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
          .all({ ...params, limit, offset }) as TimelineRow[]
        const items = rows.map((row) => timelineItem(row, data.bookId))
        return { bookId: data.bookId, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
          order: data.order, items, total, nextOffset: offset + items.length < total ? offset + items.length : null }
      })()
    })
  }
}
