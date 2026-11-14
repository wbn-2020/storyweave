import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredText } from '../../contracts/api'
import { AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_KINDS, type KnowledgeKind } from '../../contracts/knowledge'
import { FORESHADOW_STAGES, parseDisclosure, parsePlannedPayoff } from '../../contracts/story'
import {
  APPEARANCE_CHAPTER_PAGE, APPEARANCE_ENTITY_PAGE, FORESHADOW_RADAR_PAGE, parseAppearanceMatrixInput, parseForeshadowRadarInput,
  type AppearanceCell, type AppearanceMatrixInput, type AppearanceMatrixPage, type ControlVersions,
  type ForeshadowRadarInput, type ForeshadowRadarItem, type ForeshadowRadarPage, type RadarDue,
} from '../../contracts/story-control'
import type { StudioRepository } from '../storage/studio-repository'
import { readForeshadowThumbnailMetadata, validateForeshadowThumbnailBudget } from './thumbnail-repository'
import { APPEARANCE_ASSERTIONS_CTE } from './appearance-projection'

function failure(): DomainError { return new DomainError({ code: 'STORAGE_ERROR', message: '出场矩阵或伏笔雷达读取失败，请检查作品资料。' }) }
function perform<T>(read: () => T): T { try { return read() } catch (error) { if (error instanceof DomainError) throw error; throw failure() } }
function state(db: Database.Database, input: { bookId: string; expectedBookRevision?: number; expectedKnowledgeRevision?: number }): ControlVersions {
  const row = db.prepare('SELECT id, revision, knowledge_revision FROM book_meta WHERE singleton = 1').get() as
    { id: string; revision: number; knowledge_revision: number } | undefined
  if (!row || row.id !== input.bookId || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
      !Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 0) throw failure()
  if (input.expectedBookRevision !== undefined && (row.revision !== input.expectedBookRevision || row.knowledge_revision !== input.expectedKnowledgeRevision)) {
    throw new DomainError({ code: 'REVISION_CONFLICT', message: '作品或知识资料已变化，请刷新控盘视图第一页。' })
  }
  return { bookRevision: row.revision, knowledgeRevision: row.knowledge_revision }
}
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw failure(); return value as number }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) throw failure(); return value as T }

const ENTITY_FILTER = `book_id = @bookId AND (@kind IS NULL OR kind = @kind)
  AND author_decision <> 'rejected' AND (@search = '' OR instr(name, @search) > 0
    OR EXISTS (SELECT 1 FROM json_each(aliases_json) a WHERE a.type = 'text' AND instr(a.value, @search) > 0))`

const APPEARANCE_CTE = `entities AS (SELECT value AS id FROM json_each(@entities)),
  chapters_page AS (SELECT value AS id FROM json_each(@chapters)),
  ${APPEARANCE_ASSERTIONS_CTE}`

const DUE_VALUES = ['overdue', 'due', 'upcoming', 'unplaced', 'unconfirmed', 'closed'] as const
const RADAR_SCOPE = `(@scope = 'all' OR @scope = 'open' AND due <> 'closed' AND author_decision <> 'rejected'
  OR @scope = 'due' AND due IN ('due', 'overdue') OR @scope = 'closed' AND due = 'closed')`

function radarCte(hasScenes: boolean): string {
  return `scene_targets AS (${hasScenes ? "SELECT id, chapter_id FROM scene_cards WHERE json_extract(fields_json, '$.archived') = 0" : 'SELECT NULL AS id, NULL AS chapter_id WHERE 0'}),
    plans AS (SELECT s.id, s.title, substr(s.description, 1, 400) AS description,
      (SELECT MAX(r.knowledge_revision) FROM story_record_revisions r WHERE r.record_id = s.id) AS revision,
      json_extract(s.fields_json, '$.stage') AS stage,
      json_extract(s.fields_json, '$.authorDecision') AS author_decision,
      json_extract(s.fields_json, '$.freshness') AS freshness,
      json_extract(s.fields_json, '$.conflictState') AS conflict_state,
      json_extract(s.fields_json, '$.plannedPayoff') AS plan_json,
      json_extract(s.fields_json, '$.actualPayoff') AS actual_json,
      json_extract(s.fields_json, '$.plannedPayoff.state') AS target_type,
      CASE WHEN json_extract(s.fields_json, '$.plannedPayoff.state') = 'scene'
        AND json_extract(s.fields_json, '$.plannedPayoff.sceneId') IS NOT NULL
        AND (scene.id IS NULL OR (json_extract(s.fields_json, '$.plannedPayoff.chapterId') IS NOT NULL
          AND scene.chapter_id IS NOT json_extract(s.fields_json, '$.plannedPayoff.chapterId'))) THEN NULL
        WHEN json_extract(s.fields_json, '$.plannedPayoff.state') = 'volume'
        THEN COALESCE(v.position + 1, CASE WHEN json_extract(s.fields_json, '$.plannedPayoff.volumeId') IS NULL
          THEN json_extract(s.fields_json, '$.plannedPayoff.targetNumber') END)
        ELSE COALESCE(c.position + 1, CASE WHEN json_extract(s.fields_json, '$.plannedPayoff.state') = 'chapter'
          AND json_extract(s.fields_json, '$.plannedPayoff.chapterId') IS NULL
          THEN json_extract(s.fields_json, '$.plannedPayoff.targetNumber') END) END AS target_number
      FROM story_records s LEFT JOIN scene_targets scene ON scene.id = json_extract(s.fields_json, '$.plannedPayoff.sceneId')
      LEFT JOIN chapters c ON c.id = COALESCE(json_extract(s.fields_json, '$.plannedPayoff.chapterId'), scene.chapter_id)
      LEFT JOIN volumes v ON v.id = json_extract(s.fields_json, '$.plannedPayoff.volumeId')
      WHERE s.book_id = @bookId AND s.kind = 'foreshadow'
        AND (@search = '' OR instr(s.title, @search) > 0 OR instr(s.description, @search) > 0)),
    progress AS (SELECT *, CASE WHEN target_type = 'volume' THEN @volumeNumber ELSE @chapterNumber END AS progress_number FROM plans),
    classified AS (SELECT *, CASE WHEN stage IN ('resolved', 'abandoned') THEN 'closed'
      WHEN author_decision <> 'adopted' OR freshness <> 'current' OR conflict_state = 'candidate' THEN 'unconfirmed'
      WHEN target_number IS NULL OR progress_number IS NULL THEN 'unplaced'
      WHEN target_number < progress_number THEN 'overdue'
      WHEN target_number = progress_number THEN 'due' ELSE 'upcoming' END AS due FROM progress),
    scoped AS (SELECT * FROM classified WHERE ${RADAR_SCOPE})`
}

export class StoryControlRepository {
  constructor(private readonly studio: StudioRepository) {}

  matrix(input: AppearanceMatrixInput): AppearanceMatrixPage {
    return perform(() => {
      const data = parseAppearanceMatrixInput(input), { db } = this.studio.getStoryDatabase(data.bookId)
      return db.transaction(() => {
        const snapshot = state(db, data), entityOffset = data.entityOffset ?? 0, chapterOffset = data.chapterOffset ?? 0
        const params = { bookId: data.bookId, kind: data.kind ?? null, search: data.search ?? '' }
        const entityTotal = count((db.prepare(`SELECT COUNT(*) AS count FROM knowledge_items WHERE ${ENTITY_FILTER}`).get(params) as { count: number }).count)
        const chapterTotal = count((db.prepare('SELECT COUNT(*) AS count FROM chapters').get() as { count: number }).count)
        const entities = (db.prepare(`SELECT id, name, kind FROM knowledge_items WHERE ${ENTITY_FILTER}
          ORDER BY name, id LIMIT @limit OFFSET @offset`).all({ ...params, limit: APPEARANCE_ENTITY_PAGE, offset: entityOffset }) as { id: string; name: string; kind: KnowledgeKind }[])
          .map((row) => ({ id: requiredId(row.id), name: requiredText(row.name, '实体名称', 120), kind: choice(row.kind, KNOWLEDGE_KINDS) }))
        const chapters = (db.prepare(`SELECT id, title, position, current_revision_id AS revisionId FROM chapters
          ORDER BY position, id LIMIT ? OFFSET ?`).all(APPEARANCE_CHAPTER_PAGE, chapterOffset) as AppearanceMatrixPage['chapters'])
          .map((row) => ({ id: requiredId(row.id), title: requiredText(row.title, '章节名称', 120), position: count(row.position), revisionId: requiredId(row.revisionId) }))
        const cells = !entities.length || !chapters.length ? [] : (db.prepare(`WITH ${APPEARANCE_CTE}
          SELECT entity_id, chapter_id,
            SUM(CASE WHEN current = 1 AND role = 'participant' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN current = 1 AND role = 'mentioned' THEN 1 ELSE 0 END) AS mentioned,
            SUM(CASE WHEN current = 1 AND role = 'absent' THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN current = 0 THEN 1 ELSE 0 END) AS stale,
            MIN(CASE WHEN current = 1 AND role = 'participant' THEN record_id END) AS present_record,
            MIN(CASE WHEN current = 1 AND role = 'mentioned' THEN record_id END) AS mentioned_record,
            MIN(CASE WHEN current = 1 AND role = 'absent' THEN record_id END) AS absent_record,
            MIN(CASE WHEN current = 0 THEN record_id END) AS stale_record
          FROM assertions GROUP BY entity_id, chapter_id ORDER BY entity_id, chapter_id`).all({
            bookId: data.bookId, entities: JSON.stringify(entities.map((row) => row.id)), chapters: JSON.stringify(chapters.map((row) => row.id)),
          }) as { entity_id: string; chapter_id: string; present: number; mentioned: number; absent: number; stale: number;
            present_record: string | null; mentioned_record: string | null; absent_record: string | null; stale_record: string | null }[])
          .map((row): AppearanceCell => ({ entityId: requiredId(row.entity_id), chapterId: requiredId(row.chapter_id),
            present: count(row.present), mentioned: count(row.mentioned), absent: count(row.absent), stale: count(row.stale),
            recordIds: [...new Set([row.present_record, row.mentioned_record, row.absent_record, row.stale_record].filter((id): id is string => id !== null).map(requiredId))] }))
        if (entities.length !== Math.min(APPEARANCE_ENTITY_PAGE, Math.max(0, entityTotal - entityOffset)) ||
            chapters.length !== Math.min(APPEARANCE_CHAPTER_PAGE, Math.max(0, chapterTotal - chapterOffset)) ||
            cells.length > entities.length * chapters.length) throw failure()
        return { bookId: data.bookId, ...snapshot, entityOffset, chapterOffset, entities, chapters, cells, entityTotal, chapterTotal,
          nextEntityOffset: entityOffset + entities.length < entityTotal ? entityOffset + entities.length : null,
          nextChapterOffset: chapterOffset + chapters.length < chapterTotal ? chapterOffset + chapters.length : null }
      })()
    })
  }

  radar(input: ForeshadowRadarInput): ForeshadowRadarPage {
    return perform(() => {
      const data = parseForeshadowRadarInput(input), { db } = this.studio.getStoryDatabase(data.bookId)
      return db.transaction(() => {
        const snapshot = state(db, data), scope = data.scope ?? 'open', offset = data.offset ?? 0
        const progress = data.asOfChapterId ? db.prepare(`SELECT c.position + 1 AS chapterNumber, v.position + 1 AS volumeNumber
          FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id WHERE c.id = ?`).get(data.asOfChapterId) as
          { chapterNumber: number; volumeNumber: number | null } | undefined : undefined
        if (data.asOfChapterId && !progress) throw new DomainError({ code: 'NOT_FOUND', message: '核对进度对应的章节不存在，请重新选择。' })
        const hasScenes = Boolean(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'scene_cards'").get())
        const cte = radarCte(hasScenes), params = { bookId: data.bookId, search: data.search ?? '', scope,
          chapterNumber: progress?.chapterNumber ?? null, volumeNumber: progress?.volumeNumber ?? null }
        const counts: ForeshadowRadarPage['counts'] = { overdue: 0, due: 0, upcoming: 0, unplaced: 0, unconfirmed: 0, closed: 0 }
        for (const row of db.prepare(`WITH ${cte} SELECT due, COUNT(*) AS count FROM scoped GROUP BY due`).all(params) as { due: RadarDue; count: number }[]) {
          counts[choice(row.due, DUE_VALUES)] = count(row.count)
        }
        const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
        validateForeshadowThumbnailBudget(db)
        // 每页最多 20 条、每条最多一段节选；只投影原登记，不把说明文本当作正文引文。
        const sourceStatement = db.prepare(`SELECT src.source_type AS sourceType, substr(src.quote, 1, 240) AS quote,
          CASE WHEN src.source_type <> 'chapter_text' THEN NULL WHEN src.revision_id = c.current_revision_id THEN 'current' ELSE 'historical' END AS referenceState
          FROM story_sources src LEFT JOIN chapters c ON c.id = src.chapter_id
          WHERE src.book_id = ? AND src.record_id = ?
          ORDER BY CASE WHEN src.revision_id = c.current_revision_id THEN 0 WHEN src.source_type = 'chapter_text' THEN 1 ELSE 2 END,
            src.created_at DESC, src.id LIMIT 1`)
        const items = (db.prepare(`WITH ${cte} SELECT id, revision, title, description, stage, author_decision, freshness, conflict_state,
          plan_json, actual_json, due, CASE WHEN due = 'overdue' AND target_type <> 'volume'
            THEN progress_number - target_number END AS overdue_chapters FROM scoped
          ORDER BY CASE due WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 WHEN 'upcoming' THEN 2
            WHEN 'unplaced' THEN 3 WHEN 'unconfirmed' THEN 4 ELSE 5 END, target_number, id LIMIT @limit OFFSET @offset`)
          .all({ ...params, limit: FORESHADOW_RADAR_PAGE, offset }) as { id: string; revision: number; title: string; description: string; stage: string;
            author_decision: string; freshness: string; conflict_state: string; plan_json: string; actual_json: string; due: string; overdue_chapters: number | null }[])
          .map((row): ForeshadowRadarItem => {
            const source = sourceStatement.get(data.bookId, row.id) as ForeshadowRadarItem['source'] | undefined
            if (source && (typeof source.quote !== 'string' || !['chapter_text', 'author_input', 'external'].includes(source.sourceType) ||
              (source.sourceType === 'chapter_text' ? !['current', 'historical'].includes(source.referenceState ?? '') : source.referenceState !== null))) throw failure()
            return { id: requiredId(row.id), revision: count(row.revision), title: requiredText(row.title, '伏笔名称', 120), description: row.description,
            stage: choice(row.stage, FORESHADOW_STAGES), authorDecision: choice(row.author_decision, AUTHOR_DECISIONS), freshness: choice(row.freshness, KNOWLEDGE_FRESHNESS),
            conflictState: choice(row.conflict_state, CONFLICT_STATES),
            plannedPayoff: parsePlannedPayoff(JSON.parse(row.plan_json)), actualPayoff: parseDisclosure(JSON.parse(row.actual_json)),
            due: choice(row.due, DUE_VALUES), overdueChapters: row.overdue_chapters === null ? null : count(row.overdue_chapters),
            thumbnail: readForeshadowThumbnailMetadata(db, data.bookId, row.id, row.revision), source: source ?? null }
          })
        if (items.length !== Math.min(FORESHADOW_RADAR_PAGE, Math.max(0, total - offset))) throw failure()
        return { bookId: data.bookId, ...snapshot, asOfChapterId: data.asOfChapterId ?? null, scope, offset, items, counts, total,
          nextOffset: offset + items.length < total ? offset + items.length : null }
      })()
    })
  }
}
