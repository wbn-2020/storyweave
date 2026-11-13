import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredInteger, requiredText } from '../../contracts/api'
import { AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES } from '../../contracts/knowledge'
import { COGNITION_CHANGES, FORESHADOW_STAGES, MAX_FORESHADOW_MILESTONES, MAX_STORY_LINKS, MAX_STORY_RECORDS, parseDisclosure, parseStoryTime, type Disclosure } from '../../contracts/story'
import {
  MAX_TIMELINE_ITEMS, MAX_TIMELINE_PAGE_SIZE, TIMELINE_TRACKS, parseStoryTimelineInput, timelineItemId,
  type StoryTimelineInput, type StoryTimelineItem, type StoryTimelinePage, type TimelineDisclosure,
} from '../../contracts/story-timeline'
import type { StudioRepository } from '../storage/studio-repository'

interface BookState { id: string; revision: number; knowledge_revision: number }
interface TimelineRow {
  source_record_id: string; milestone_id: string | null; kind: string; point: string
  book_id: string; title: string; description: string; fields_kind: string
  time_json: string | null; disclosure_json: string | null; story_order: number | null
  nature: unknown; author_decision: unknown; freshness: unknown; conflict_state: unknown
  stage: unknown; cognition_change: unknown
  chapter_id: string | null; chapter_title: string | null; chapter_position: number | null
  current_revision_id: string | null; registered_revision_id: string | null
}

const RECORD_FILTER = `s.book_id = @bookId AND s.kind IN (SELECT value FROM json_each(@tracks))
  AND (@nature IS NULL OR json_extract(s.fields_json, '$.nature') = @nature)
  AND (@authorDecision IS NULL OR json_extract(s.fields_json, '$.authorDecision') = @authorDecision)`

const RECORD_SEARCH = `@search = '' OR instr(s.title, @search) > 0 OR instr(s.description, @search) > 0`
const COMMON_COLUMNS = `s.id AS source_record_id, s.book_id, s.kind, s.title,
  json_extract(s.fields_json, '$.kind') AS fields_kind,
  json_extract(s.fields_json, '$.nature') AS nature,
  json_extract(s.fields_json, '$.authorDecision') AS author_decision,
  json_extract(s.fields_json, '$.freshness') AS freshness,
  json_extract(s.fields_json, '$.conflictState') AS conflict_state`

// 只投影已登记的时点；结束事件不代填关系结束时间，也不代填该变化的读者披露。
// 计数与分页复用同一展开集合，里程碑按持久 ID 定位，数组下标不参与身份。
const TIMELINE_ENTRIES = `WITH entries AS (
  SELECT ${COMMON_COLUMNS}, substr(s.description, 1, 240) AS description,
    CASE s.kind WHEN 'relation' THEN 'relation_start' ELSE 'record' END AS point,
    NULL AS milestone_id,
    json_extract(s.fields_json, CASE s.kind WHEN 'relation' THEN '$.validFrom' ELSE '$.storyTime' END) AS time_json,
    json_extract(s.fields_json, '$.disclosure') AS disclosure_json, s.story_order,
    CASE WHEN s.kind = 'foreshadow' THEN json_extract(s.fields_json, '$.stage') END AS stage,
    CASE WHEN s.kind = 'cognition' THEN json_extract(s.fields_json, '$.evolution.kind') END AS cognition_change
    FROM story_records s WHERE ${RECORD_FILTER} AND (${RECORD_SEARCH})
  UNION ALL
  SELECT ${COMMON_COLUMNS}, substr(s.description, 1, 240), 'relation_end', NULL,
    json_extract(s.fields_json, '$.validUntil'), '{"state":"unknown"}',
    json_extract(s.fields_json, '$.validUntil.order'), NULL, NULL
    FROM story_records s WHERE ${RECORD_FILTER} AND s.kind = 'relation' AND (${RECORD_SEARCH})
      AND (json_extract(s.fields_json, '$.validUntil.kind') <> 'unknown'
        OR json_extract(s.fields_json, '$.endEventId') IS NOT NULL)
  UNION ALL
  SELECT ${COMMON_COLUMNS}, substr(json_extract(m.value, '$.note'), 1, 240), 'foreshadow_milestone',
    json_extract(m.value, '$.id'), json_extract(m.value, '$.storyTime'),
    json_extract(m.value, '$.disclosure'), json_extract(m.value, '$.storyTime.order'),
    json_extract(m.value, '$.stage'), NULL
    FROM story_records s JOIN json_each(s.fields_json, '$.milestones') m
    WHERE ${RECORD_FILTER} AND s.kind = 'foreshadow'
      AND (${RECORD_SEARCH} OR instr(json_extract(m.value, '$.note'), @search) > 0)
)`

const STABLE_ORDER = 'e.source_record_id, e.point, e.milestone_id'
const DISCLOSURE_ORDER = `CASE json_extract(e.disclosure_json, '$.state')
  WHEN 'located' THEN CASE
    WHEN c.id IS NULL OR r.id IS NULL THEN 2
    WHEN c.current_revision_id = r.id THEN 0
    ELSE 1 END
  WHEN 'undisclosed' THEN 3
  ELSE 4 END, c.position IS NULL, c.position, ${STABLE_ORDER}`

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
    const kind = storedChoice(row.kind, TIMELINE_TRACKS)
    const point = storedChoice(row.point, ['record', 'relation_start', 'relation_end', 'foreshadow_milestone'] as const)
    if ((kind === 'relation') !== (point === 'relation_start' || point === 'relation_end') ||
        (point === 'foreshadow_milestone' && kind !== 'foreshadow')) throw storageFailure()
    const sourceRecordId = requiredId(row.source_record_id)
    const milestoneId = point === 'foreshadow_milestone' ? requiredId(row.milestone_id) : null
    if (milestoneId === null && row.milestone_id !== null) throw storageFailure()
    if (row.book_id !== bookId || row.fields_kind !== kind || typeof row.time_json !== 'string' ||
        typeof row.disclosure_json !== 'string' || typeof row.description !== 'string' ||
        Array.from(row.description).length > 240) throw storageFailure()
    const time = parseStoryTime(JSON.parse(row.time_json))
    if ((time.kind === 'unknown' ? null : time.order) !== row.story_order) throw storageFailure()
    const disclosure = timelineDisclosure(row, parseDisclosure(JSON.parse(row.disclosure_json)))
    const stage = kind === 'foreshadow' ? storedChoice(row.stage, FORESHADOW_STAGES) : undefined
    if (point === 'foreshadow_milestone' && stage === 'planned') throw storageFailure()
    const cognitionChange = row.cognition_change === null ? undefined : storedChoice(row.cognition_change, COGNITION_CHANGES)
    if (kind !== 'cognition' && cognitionChange !== undefined) throw storageFailure()
    return { id: timelineItemId(sourceRecordId, point, milestoneId), sourceRecordId, milestoneId, kind, point,
      bookId, title: requiredText(row.title, '记录名称', 120), description: row.description,
      nature: storedChoice(row.nature, KNOWLEDGE_NATURES), authorDecision: storedChoice(row.author_decision, AUTHOR_DECISIONS),
      freshness: storedChoice(row.freshness, KNOWLEDGE_FRESHNESS), conflictState: storedChoice(row.conflict_state, CONFLICT_STATES),
      time, disclosure, people: [], ...(stage === undefined ? {} : { stage }), ...(cognitionChange === undefined ? {} : { cognitionChange }) }
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
        const tracks: StoryTimelinePage['tracks'] = data.tracks ?? ['event']
        const params = { bookId: data.bookId, tracks: JSON.stringify(tracks), search: data.search ?? '',
          nature: data.nature ?? null, authorDecision: data.authorDecision ?? null }
        // 展开前检查父记录和每条伏笔的容量；不把全书 JSON 或正文加载到应用进程。
        const bounds = db.prepare(`SELECT COUNT(*) AS records,
          COALESCE(MAX(CASE WHEN kind = 'foreshadow' THEN
            CASE WHEN json_type(fields_json, '$.milestones') = 'array'
              THEN json_array_length(fields_json, '$.milestones') ELSE @overflow END ELSE 0 END), 0) AS milestones
          FROM story_records WHERE book_id = @bookId`)
          .get({ bookId: data.bookId, overflow: MAX_FORESHADOW_MILESTONES + 1 }) as { records: number; milestones: number }
        if (!Number.isSafeInteger(bounds.records) || bounds.records < 0 || bounds.records > MAX_STORY_RECORDS ||
            !Number.isSafeInteger(bounds.milestones) || bounds.milestones < 0 || bounds.milestones > MAX_FORESHADOW_MILESTONES) throw storageFailure()
        const { total } = db.prepare(`${TIMELINE_ENTRIES} SELECT COUNT(*) AS total FROM entries`).get(params) as { total: number }
        if (!Number.isSafeInteger(total) || total < 0 || total > MAX_TIMELINE_ITEMS) throw storageFailure()
        const limit = data.limit ?? MAX_TIMELINE_PAGE_SIZE
        const offset = data.offset ?? 0
        // 故事顺序只取作者的排序值；披露按当前登记稿、历史登记稿、缺失登记、未披露、未知分组。
        // 同值只按稳定身份排列，不用另一时间维度、修改日期或数组位置推测先后。
        const order = data.order === 'story' ? `e.story_order IS NULL, e.story_order, ${STABLE_ORDER}` : DISCLOSURE_ORDER
        // 只返回本页必要字段和摘要，章节联接只读取元数据，不装载正文或完整故事字段。
        const rows = db.prepare(`${TIMELINE_ENTRIES} SELECT e.*,
          c.id AS chapter_id, c.title AS chapter_title, c.position AS chapter_position,
          c.current_revision_id, r.id AS registered_revision_id
          FROM entries e
          LEFT JOIN chapters c ON json_extract(e.disclosure_json, '$.state') = 'located'
            AND c.id = json_extract(e.disclosure_json, '$.chapterId')
          LEFT JOIN chapter_revisions r ON r.chapter_id = c.id
            AND r.id = json_extract(e.disclosure_json, '$.revisionId')
          ORDER BY ${order} LIMIT @limit OFFSET @offset`)
          .all({ ...params, limit, offset }) as TimelineRow[]
        const items = rows.map((row) => timelineItem(row, data.bookId))
        if (items.length !== Math.min(limit, Math.max(0, total - offset)) ||
            new Set(items.map((item) => item.id)).size !== items.length) throw storageFailure()
        // 人物与事件顺序共用当前事务；只联接本页身份，不逐条读取完整档案或正文。
        if (items.length) {
          const maximum = items.length * MAX_STORY_LINKS
          const people = db.prepare(`SELECT DISTINCT ref.record_id, k.id, k.name
            FROM story_entity_refs ref JOIN knowledge_items k ON k.id = ref.entity_id AND k.book_id = ref.book_id AND k.kind = 'person'
            JOIN story_records s ON s.id = ref.record_id AND s.book_id = ref.book_id
            WHERE ref.book_id = @bookId AND ref.record_id IN (SELECT value FROM json_each(@ids))
              AND (s.kind = 'event' AND ref.role = 'participant'
                OR s.kind = 'cognition' AND ref.role = 'cognition_subject'
                OR s.kind = 'relation' AND ref.role IN ('relation_from', 'relation_to')
                OR s.kind = 'foreshadow' AND ref.role = 'foreshadow_entity')
            ORDER BY k.name, k.id LIMIT @maximum`)
            .all({ bookId: data.bookId, ids: JSON.stringify([...new Set(items.map((item) => item.sourceRecordId))]), maximum: maximum + 1 }) as
            { record_id: string; id: string; name: string }[]
          if (people.length > maximum) throw storageFailure()
          const byRecord = new Map<string, StoryTimelineItem['people']>()
          for (const row of people) {
            const recordId = requiredId(row.record_id)
            const entries = byRecord.get(recordId) ?? []
            entries.push({ id: requiredId(row.id), name: requiredText(row.name, '人物名称', 120) })
            byRecord.set(recordId, entries)
          }
          for (const item of items) item.people = byRecord.get(item.sourceRecordId) ?? []
        }
        return { bookId: data.bookId, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
          order: data.order, tracks, items, total, nextOffset: offset + items.length < total ? offset + items.length : null }
      })()
    })
  }
}
