import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredInteger, requiredText } from '../../contracts/api'
import { AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_NATURES } from '../../contracts/knowledge'
import {
  WORLD_MAP_LINK_LIMIT, WORLD_MAP_PAGE_SIZE, WORLD_MAP_RELATED_LIMIT, WORLD_ROUTE_TYPE, WORLD_TERRITORY_TYPE, parseWorldMapInput,
  type WorldMapInput, type WorldMapPage, type WorldMapPlace, type WorldMapSource, type WorldMapStatus,
} from '../../contracts/world-map'
import type { StudioRepository } from '../storage/studio-repository'

interface State { id: string; revision: number; knowledge_revision: number }
interface StatusRow { nature: unknown; author_decision: unknown; freshness: unknown; conflict_state: unknown }
interface PlaceRow extends StatusRow { id: string; name: string; summary: string }
interface SourceRow {
  item_id: string; chapter_id: string; chapter_title: string; chapter_position: number
  revision_id: string; block_id: string; quote: string
}
interface LinkRow extends StatusRow {
  id: string; title: string; relation_type: string; direction: string
  from_id: string; to_id: string; to_name: string
}
interface EventRow {
  place_id: string; id: string; name: string; chapter_id: string | null; chapter_title: string | null
  chapter_position: number | null; revision_id: string | null; block_id: string | null; quote: string | null
}

const SOURCE_COLUMNS = `s.item_id, s.chapter_id, c.title AS chapter_title, c.position AS chapter_position,
  s.revision_id, s.block_id, s.quote`
// 章节模式只接纳当前稿已登记、名称在引文中出现的对象；无出处、旧稿与未来计划不能补成已知。
const KNOWN_ITEM = `k.nature IN ('author_setting', 'narrative_claim') AND k.author_decision = 'adopted'
  AND k.freshness = 'current' AND k.conflict_state IN ('clear', 'explained')
  AND EXISTS (SELECT 1 FROM knowledge_sources ks JOIN chapters kc ON kc.id = ks.chapter_id
    JOIN chapter_revisions kr ON kr.id = ks.revision_id AND kr.chapter_id = kc.id
    WHERE ks.book_id = k.book_id AND ks.item_id = k.id AND ks.source_type = 'chapter_text'
      AND kc.current_revision_id = ks.revision_id AND kc.position <= @cutoff AND instr(ks.quote, k.name) > 0)`
const PLACE_FILTER = `k.book_id = @bookId AND k.kind = 'place' AND (@cutoff IS NULL OR (${KNOWN_ITEM}))`
const STORY_VISIBLE = `s.book_id = @bookId AND (@cutoff IS NULL OR (
  json_extract(s.fields_json, '$.nature') IN ('author_setting', 'narrative_claim')
  AND json_extract(s.fields_json, '$.authorDecision') = 'adopted'
  AND json_extract(s.fields_json, '$.freshness') = 'current'
  AND json_extract(s.fields_json, '$.conflictState') IN ('clear', 'explained')
  AND json_extract(s.fields_json, '$.disclosure.state') = 'located'
  AND EXISTS (SELECT 1 FROM chapters dc JOIN chapter_revisions dr ON dr.chapter_id = dc.id
    AND dr.id = json_extract(s.fields_json, '$.disclosure.revisionId')
    WHERE dc.id = json_extract(s.fields_json, '$.disclosure.chapterId')
      AND dc.current_revision_id = dr.id AND dc.position <= @cutoff)))`
const PAGE_IDS = `SELECT value FROM json_each(@ids)`

function storageError(): DomainError { return new DomainError({ code: 'STORAGE_ERROR', message: '世界地图资料读取失败，请检查作品文件。' }) }
function storedChoice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw storageError()
  return value as T
}
function status(row: StatusRow): WorldMapStatus {
  return { nature: storedChoice(row.nature, KNOWLEDGE_NATURES), authorDecision: storedChoice(row.author_decision, AUTHOR_DECISIONS),
    freshness: storedChoice(row.freshness, KNOWLEDGE_FRESHNESS), conflictState: storedChoice(row.conflict_state, CONFLICT_STATES) }
}
function source(row: Omit<SourceRow, 'item_id'>): WorldMapSource {
  if (typeof row.quote !== 'string' || !row.quote.trim() || row.quote.length > 2000) throw storageError()
  return { chapterId: requiredId(row.chapter_id), chapterTitle: requiredText(row.chapter_title, '出处章节', 120),
    chapterPosition: requiredInteger(row.chapter_position, '出处章节位置'), revisionId: requiredId(row.revision_id),
    blockId: requiredId(row.block_id), quote: row.quote }
}

export class WorldMapRepository {
  constructor(private readonly studio: StudioRepository) {}

  get(input: WorldMapInput): WorldMapPage {
    const data = parseWorldMapInput(input)
    try {
      const { db } = this.studio.getStoryDatabase(data.bookId)
      return db.transaction(() => this.read(db, data))()
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw storageError()
    }
  }

  private read(db: Database.Database, data: WorldMapInput): WorldMapPage {
    const state = db.prepare('SELECT id, revision, knowledge_revision FROM book_meta WHERE singleton = 1').get() as State | undefined
    if (!state || state.id !== data.bookId || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Number.isSafeInteger(state.knowledge_revision) || state.knowledge_revision < 0) throw storageError()
    if (data.expectedBookRevision !== undefined && (data.expectedBookRevision !== state.revision || data.expectedKnowledgeRevision !== state.knowledge_revision)) {
      throw new DomainError({ code: 'REVISION_CONFLICT', message: '作品或知识版本已变化，请重新读取地图第一页。' })
    }
    let cutoff: number | null = null
    if (data.asOfChapterId) {
      const chapter = db.prepare('SELECT position FROM chapters WHERE id = ?').get(data.asOfChapterId) as { position: number } | undefined
      if (!chapter) throw new DomainError({ code: 'NOT_FOUND', message: '筛选章节不属于当前作品。' })
      cutoff = requiredInteger(chapter.position, '筛选章节位置')
    }
    const scope = { bookId: data.bookId, cutoff }
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM knowledge_items k WHERE ${PLACE_FILTER}`).get(scope) as { total: number }
    if (!Number.isSafeInteger(total) || total < 0 || total > 100_000) throw storageError()
    const offset = data.offset ?? 0
    const rows = db.prepare(`SELECT k.id, k.name, substr(k.summary, 1, 240) AS summary,
      k.nature, k.author_decision, k.freshness, k.conflict_state FROM knowledge_items k WHERE ${PLACE_FILTER}
      ORDER BY k.name, k.id LIMIT @limit OFFSET @offset`).all({ ...scope, limit: WORLD_MAP_PAGE_SIZE, offset }) as PlaceRow[]
    if (rows.length !== Math.min(WORLD_MAP_PAGE_SIZE, Math.max(0, total - offset))) throw storageError()
    const ids = JSON.stringify(rows.map((row) => requiredId(row.id)))
    const params = { ...scope, ids }
    const places: WorldMapPlace[] = rows.map((row) => ({ id: requiredId(row.id), name: requiredText(row.name, '地点名', 120),
      excerpt: cutoff === null ? row.summary : '', ...status(row), firstAppearance: null, people: [], events: [], relatedTruncated: false }))
    const byId = new Map(places.map((place) => [place.id, place]))
    if (places.length) {
      const sources = db.prepare(`WITH ranked AS (
        SELECT ${SOURCE_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY s.item_id ORDER BY c.position, s.id) AS n
        FROM knowledge_sources s JOIN chapters c ON c.id = s.chapter_id
        JOIN chapter_revisions r ON r.id = s.revision_id AND r.chapter_id = c.id
        JOIN knowledge_items k ON k.id = s.item_id AND k.book_id = s.book_id
        WHERE s.book_id = @bookId AND s.item_id IN (${PAGE_IDS}) AND s.source_type = 'chapter_text'
          AND c.current_revision_id = s.revision_id AND (@cutoff IS NULL OR c.position <= @cutoff AND instr(s.quote, k.name) > 0))
        SELECT * FROM ranked WHERE n = 1`).all(params) as SourceRow[]
      for (const row of sources) {
        const place = byId.get(row.item_id)
        if (!place || place.firstAppearance) throw storageError()
        place.firstAppearance = source(row)
        if (cutoff !== null) place.excerpt = row.quote
      }
    }

    // 航道只认地点到地点的“航道”；领属只认地点到组织的“领属”，不把普通关联画成道路或疆界。
    const linkRows = places.length ? db.prepare(`SELECT s.id,
      substr(s.title, 1, 120) AS title, json_extract(s.fields_json, '$.relationType') AS relation_type,
      json_extract(s.fields_json, '$.direction') AS direction, a.entity_id AS from_id, b.entity_id AS to_id, k.name AS to_name,
      json_extract(s.fields_json, '$.nature') AS nature, json_extract(s.fields_json, '$.authorDecision') AS author_decision,
      json_extract(s.fields_json, '$.freshness') AS freshness, json_extract(s.fields_json, '$.conflictState') AS conflict_state
      FROM story_records s JOIN story_entity_refs a ON a.record_id = s.id AND a.book_id = s.book_id AND a.role = 'relation_from'
      JOIN story_entity_refs b ON b.record_id = s.id AND b.book_id = s.book_id AND b.role = 'relation_to'
      JOIN knowledge_items k ON k.id = b.entity_id AND k.book_id = s.book_id
      WHERE ${STORY_VISIBLE} AND s.kind = 'relation' AND a.entity_id IN (${PAGE_IDS})
        AND (json_extract(s.fields_json, '$.relationType') = @route AND k.kind = 'place' AND b.entity_id IN (${PAGE_IDS})
          OR json_extract(s.fields_json, '$.relationType') = @territory AND k.kind = 'organization'
            AND json_extract(s.fields_json, '$.direction') = 'directed' AND (@cutoff IS NULL OR (${KNOWN_ITEM})))
      ORDER BY s.id LIMIT @limit`).all({ ...params, route: WORLD_ROUTE_TYPE, territory: WORLD_TERRITORY_TYPE, limit: WORLD_MAP_LINK_LIMIT + 1 }) as LinkRow[] : []
    const routes: WorldMapPage['routes'] = []
    const territories = new Map<string, WorldMapPage['territories'][number]>()
    for (const row of linkRows.slice(0, WORLD_MAP_LINK_LIMIT)) {
      const fields = status(row), id = requiredId(row.id), fromId = requiredId(row.from_id), toId = requiredId(row.to_id)
      if (!byId.has(fromId)) throw storageError()
      if (row.relation_type === WORLD_ROUTE_TYPE) {
        if (!byId.has(toId)) throw storageError()
        routes.push({ id, title: cutoff === null ? requiredText(row.title, '航道名', 120) : WORLD_ROUTE_TYPE, fromId, toId,
          direction: storedChoice(row.direction, ['directed', 'mutual'] as const), ...fields })
      } else if (fields.authorDecision === 'adopted' && fields.freshness === 'current' &&
        ['clear', 'explained'].includes(fields.conflictState) && ['author_setting', 'narrative_claim'].includes(fields.nature)) {
        const territory = territories.get(toId) ?? { id: toId, name: requiredText(row.to_name, '势力名', 120), placeIds: [] }
        if (!territory.placeIds.includes(fromId)) territory.placeIds.push(fromId)
        territories.set(toId, territory)
      }
    }
    if (places.length) this.related(db, params, byId)
    return { bookId: data.bookId, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
      asOfChapterId: data.asOfChapterId ?? null, offset, total, places, routes, territories: [...territories.values()],
      linksTruncated: linkRows.length > WORLD_MAP_LINK_LIMIT, nextOffset: offset + places.length < total ? offset + places.length : null }
  }

  private related(db: Database.Database, params: { bookId: string; cutoff: number | null; ids: string }, byId: Map<string, WorldMapPlace>) {
    const rankedEvents = `WITH candidates AS (
      SELECT DISTINCT ref.entity_id AS place_id, s.id, s.title,
        json_extract(s.fields_json, '$.disclosure.chapterId') AS chapter_id,
        json_extract(s.fields_json, '$.disclosure.revisionId') AS revision_id,
        json_extract(s.fields_json, '$.disclosure.blockId') AS block_id
      FROM story_entity_refs ref JOIN story_records s ON s.id = ref.record_id AND s.book_id = ref.book_id
      WHERE ${STORY_VISIBLE} AND s.kind = 'event' AND ref.entity_id IN (${PAGE_IDS})),
      ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY place_id ORDER BY id) AS n FROM candidates)`
    const events = db.prepare(`${rankedEvents}
      SELECT e.place_id, e.id, e.title AS name, c.id AS chapter_id, c.title AS chapter_title, c.position AS chapter_position,
        CASE WHEN c.id IS NOT NULL THEN e.revision_id END AS revision_id,
        CASE WHEN c.id IS NOT NULL THEN e.block_id END AS block_id,
        (SELECT substr(ss.quote, 1, 2000) FROM story_sources ss WHERE ss.book_id = @bookId AND ss.record_id = e.id
          AND ss.source_type = 'chapter_text' AND ss.chapter_id = c.id AND ss.revision_id = e.revision_id
          AND ss.block_id = e.block_id ORDER BY ss.id LIMIT 1) AS quote
      FROM ranked e LEFT JOIN chapters c ON c.id = e.chapter_id AND c.current_revision_id = e.revision_id
      WHERE e.n <= @limit ORDER BY e.place_id, e.id`).all({ ...params, limit: WORLD_MAP_RELATED_LIMIT + 1 }) as EventRow[]
    const eventCount = new Map<string, number>()
    for (const row of events) {
      const place = byId.get(row.place_id)
      if (!place) throw storageError()
      const count = (eventCount.get(row.place_id) ?? 0) + 1
      eventCount.set(row.place_id, count)
      if (count > WORLD_MAP_RELATED_LIMIT) { place.relatedTruncated = true; continue }
      const original = row.chapter_id && row.revision_id && row.block_id && row.quote ? source({
        chapter_id: row.chapter_id, chapter_title: row.chapter_title!, chapter_position: row.chapter_position!,
        revision_id: row.revision_id, block_id: row.block_id, quote: row.quote,
      }) : null
      place.events.push({ id: requiredId(row.id), name: params.cutoff === null ? requiredText(row.name, '事件名', 120)
        : `${row.chapter_title ?? '当前章节范围'} · 已登记事件`, source: original })
    }
    const people = db.prepare(`${rankedEvents}, people AS (
      SELECT DISTINCT e.place_id, k.id, k.name FROM ranked e
      JOIN story_entity_refs ref ON ref.record_id = e.id AND ref.book_id = @bookId AND ref.role = 'participant'
      JOIN knowledge_items k ON k.id = ref.entity_id AND k.book_id = ref.book_id AND k.kind = 'person'
      WHERE e.n <= @eventLimit AND (@cutoff IS NULL OR (${KNOWN_ITEM}))),
      ranked_people AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY place_id ORDER BY name, id) AS n FROM people)
      SELECT place_id, id, name FROM ranked_people WHERE n <= @limit ORDER BY place_id, name, id`)
      .all({ ...params, eventLimit: WORLD_MAP_RELATED_LIMIT, limit: WORLD_MAP_RELATED_LIMIT + 1 }) as { place_id: string; id: string; name: string }[]
    for (const row of people) {
      const place = byId.get(row.place_id)
      if (!place) throw storageError()
      if (place.people.length >= WORLD_MAP_RELATED_LIMIT) { place.relatedTruncated = true; continue }
      place.people.push({ id: requiredId(row.id), name: requiredText(row.name, '人物名', 120) })
    }
  }
}
