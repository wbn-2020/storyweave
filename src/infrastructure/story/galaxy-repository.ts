import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredText } from '../../contracts/api'
import {
  AUTHOR_DECISIONS, CONFLICT_STATES, KNOWLEDGE_FRESHNESS, KNOWLEDGE_KINDS, KNOWLEDGE_NATURES, MAX_KNOWLEDGE_ITEMS,
} from '../../contracts/knowledge'
import { MAX_STORY_RECORDS, STORY_KINDS, parseStoryTime } from '../../contracts/story'
import {
  GALAXY_PAGE_SIZE, GALAXY_ROLES, MAX_GALAXY_EDGES, galaxyKey, parseStoryGalaxyInput,
  type GalaxyEdge, type GalaxyNode, type GalaxyRole, type GalaxyTarget, type StoryGalaxyInput, type StoryGalaxyPage,
} from '../../contracts/story-galaxy'
import type { StudioRepository } from '../storage/studio-repository'

interface BookState { id: string; revision: number; knowledge_revision: number }
interface TargetRow { source: unknown; id: unknown }
interface NodeRow extends TargetRow {
  book_id: unknown; kind: unknown; title: unknown; excerpt: unknown; metadata_valid: unknown
  nature: unknown; author_decision: unknown; freshness: unknown; conflict_state: unknown
  relation_layer: unknown; relation_from_json: unknown; relation_until_json: unknown
  relation_type: unknown; relation_direction: unknown
}
interface EdgeRow { from_id: unknown; to_source: unknown; to_id: unknown; role: unknown }

const BOOK_TARGETS = `targets AS (
  SELECT 'knowledge' AS source, k.id FROM knowledge_items k
  WHERE k.book_id = @bookId AND (@kind IS NULL OR k.kind = @kind)
    AND (@nature IS NULL OR k.nature = @nature)
    AND (@authorDecision IS NULL OR k.author_decision = @authorDecision)
    AND (@search = '' OR instr(k.name, @search) > 0 OR instr(k.summary, @search) > 0
      OR (json_type(k.aliases_json) = 'array' AND EXISTS (
        SELECT 1 FROM json_each(k.aliases_json) a WHERE a.type = 'text' AND instr(a.value, @search) > 0)))
  UNION ALL
  SELECT 'story' AS source, s.id FROM story_records s
  WHERE s.book_id = @bookId AND (@kind IS NULL OR s.kind = @kind)
    AND (@nature IS NULL OR json_extract(s.fields_json, '$.nature') = @nature)
    AND (@authorDecision IS NULL OR json_extract(s.fields_json, '$.authorDecision') = @authorDecision)
    AND (@search = '' OR instr(s.title, @search) > 0 OR instr(s.description, @search) > 0)
)`

// UNION 仅按来源和 ID 去重：同一对象有多个引用角色仍只占一个邻居位置。
// 入向和出向都保留；引用不会沿路径继续扩展，也不推断知情、因果或关系有效期。
const FOCUS_TARGETS = `neighbors(source, id) AS (
  SELECT 'story', record_id FROM story_entity_refs
    WHERE book_id = @bookId AND @focusSource = 'knowledge' AND entity_id = @focusId
  UNION
  SELECT 'knowledge', entity_id FROM story_entity_refs
    WHERE book_id = @bookId AND @focusSource = 'story' AND record_id = @focusId
  UNION
  SELECT 'story', event_id FROM story_event_refs
    WHERE book_id = @bookId AND @focusSource = 'story' AND record_id = @focusId
  UNION
  SELECT 'story', record_id FROM story_event_refs
    WHERE book_id = @bookId AND @focusSource = 'story' AND event_id = @focusId
), targets AS (
  SELECT source, id FROM neighbors WHERE source <> @focusSource OR id <> @focusId
)`

// 参数只包含本页至多 41 个身份，不把全书资料或完整故事 JSON 装入 JS 再筛选。
const PAGE_TARGETS = `page_targets AS (
  SELECT CAST(key AS INTEGER) AS position, json_extract(value, '$.source') AS source,
    json_extract(value, '$.id') AS id FROM json_each(@targets)
)`

const ROLE_TARGETS: Record<GalaxyRole, GalaxyTarget['source']> = {
  relation_from: 'knowledge', relation_to: 'knowledge', participant: 'knowledge', mentioned: 'knowledge',
  state_change: 'knowledge', foreshadow_entity: 'knowledge', cognition_subject: 'knowledge',
  relation_start: 'story', relation_end: 'story', foreshadow_event: 'story', acquisition: 'story',
}

function storageFailure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '故事星海读取失败，请检查作品文件。' })
}

function perform<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof DomainError) throw error
    throw storageFailure()
  }
}

function storedChoice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw storageFailure()
  return value as T
}

function storedTarget(row: TargetRow): GalaxyTarget {
  try { return { source: storedChoice(row.source, ['knowledge', 'story'] as const), id: requiredId(row.id) } }
  catch { throw storageFailure() }
}

function readState(db: Database.Database, bookId: string): BookState {
  const row = db.prepare('SELECT id, revision, knowledge_revision FROM book_meta WHERE singleton = 1').get() as BookState | undefined
  if (!row || row.id !== bookId || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
      !Number.isSafeInteger(row.knowledge_revision) || row.knowledge_revision < 0) throw storageFailure()
  return row
}

function storedNode(row: NodeRow, bookId: string): GalaxyNode {
  try {
    const target = storedTarget(row)
    if (row.book_id !== bookId || row.metadata_valid !== 1 || typeof row.excerpt !== 'string' ||
        Array.from(row.excerpt).length > 240 || row.relation_layer != null && (target.source !== 'story' || row.kind !== 'relation')) throw storageFailure()
    return { ...target, bookId,
      kind: target.source === 'knowledge' ? storedChoice(row.kind, KNOWLEDGE_KINDS) : storedChoice(row.kind, STORY_KINDS),
      title: requiredText(row.title, '星海对象名称', 120), excerpt: row.excerpt,
      nature: storedChoice(row.nature, KNOWLEDGE_NATURES), authorDecision: storedChoice(row.author_decision, AUTHOR_DECISIONS),
      freshness: storedChoice(row.freshness, KNOWLEDGE_FRESHNESS), conflictState: storedChoice(row.conflict_state, CONFLICT_STATES),
      ...(row.relation_layer == null ? {} : { relationLayer: storedChoice(row.relation_layer, ['surface', 'hidden'] as const) }),
      ...(target.source === 'story' && row.kind === 'relation' ? {
        relationType: requiredText(row.relation_type, '关系类型', 120),
        relationDirection: storedChoice(row.relation_direction, ['directed', 'mutual'] as const),
        relationTime: {
        from: parseStoryTime(JSON.parse(requiredText(row.relation_from_json, '关系开始时间', 1000))),
        until: parseStoryTime(JSON.parse(requiredText(row.relation_until_json, '关系结束时间', 1000))),
      } } : {}) }
  } catch {
    // 存储行复用契约校验时，格式错误属于存储损坏，不能冒充调用方输入错误。
    throw storageFailure()
  }
}

function readNodes(db: Database.Database, bookId: string, targets: GalaxyTarget[]): GalaxyNode[] {
  if (targets.length === 0) return []
  if (targets.length > GALAXY_PAGE_SIZE + 1 || new Set(targets.map(galaxyKey)).size !== targets.length) throw storageFailure()
  // 摘要在 SQLite 内按 Unicode 字符截取；其余仅投影必要标签和元数据一致性标记。
  const rows = db.prepare(`WITH ${PAGE_TARGETS}
    SELECT p.position, 'knowledge' AS source, k.id, k.book_id, k.kind, k.name AS title,
      substr(k.summary, 1, 240) AS excerpt, k.nature, k.author_decision, k.freshness, k.conflict_state,
      NULL AS relation_layer, NULL AS relation_from_json, NULL AS relation_until_json,
      NULL AS relation_type, NULL AS relation_direction,
      CASE WHEN json_type(k.aliases_json) = 'array' AND json_array_length(k.aliases_json) <= 50
        AND NOT EXISTS (SELECT 1 FROM json_each(k.aliases_json) a WHERE a.type <> 'text')
        THEN 1 ELSE 0 END AS metadata_valid
      FROM page_targets p JOIN knowledge_items k ON p.source = 'knowledge' AND k.id = p.id AND k.book_id = @bookId
    UNION ALL
    SELECT p.position, 'story' AS source, s.id, s.book_id, s.kind, s.title,
      substr(s.description, 1, 240) AS excerpt,
      json_extract(s.fields_json, '$.nature') AS nature,
      json_extract(s.fields_json, '$.authorDecision') AS author_decision,
      json_extract(s.fields_json, '$.freshness') AS freshness,
      json_extract(s.fields_json, '$.conflictState') AS conflict_state,
      json_extract(s.fields_json, '$.layer') AS relation_layer,
      json_extract(s.fields_json, '$.validFrom') AS relation_from_json,
      json_extract(s.fields_json, '$.validUntil') AS relation_until_json,
      substr(json_extract(s.fields_json, '$.relationType'), 1, 121) AS relation_type,
      substr(json_extract(s.fields_json, '$.direction'), 1, 9) AS relation_direction,
      CASE WHEN json_type(s.fields_json) = 'object'
        AND json_type(s.fields_json, '$.kind') = 'text' AND json_extract(s.fields_json, '$.kind') = s.kind
        AND json_type(s.fields_json, '$.title') = 'text' AND json_extract(s.fields_json, '$.title') = s.title
        AND json_type(s.fields_json, '$.description') = 'text' AND json_extract(s.fields_json, '$.description') = s.description
        THEN 1 ELSE 0 END AS metadata_valid
      FROM page_targets p JOIN story_records s ON p.source = 'story' AND s.id = p.id AND s.book_id = @bookId
    ORDER BY position LIMIT @limit`).all({ bookId, targets: JSON.stringify(targets), limit: targets.length + 1 }) as NodeRow[]
  if (rows.length !== targets.length) throw storageFailure()
  return rows.map((row, index) => {
    const node = storedNode(row, bookId)
    if (galaxyKey(node) !== galaxyKey(targets[index]!)) throw storageFailure()
    return node
  })
}

function readEdges(db: Database.Database, bookId: string, nodes: GalaxyNode[]): Pick<StoryGalaxyPage, 'edges' | 'edgesTruncated'> {
  if (nodes.length === 0) return { edges: [], edgesTruncated: false }
  const targets = nodes.map(({ source, id }): GalaxyTarget => ({ source, id }))
  // 两端都必须在本页，且按命名空间联接；自引用只从邻居计数排除，显式连线仍保留。
  // 多取一条检测截断，不额外读取整张引用图。
  const rows = db.prepare(`WITH ${PAGE_TARGETS}
    SELECT r.record_id AS from_id, 'knowledge' AS to_source, r.entity_id AS to_id, r.role
      FROM story_entity_refs r
      JOIN page_targets a ON a.source = 'story' AND a.id = r.record_id
      JOIN page_targets b ON b.source = 'knowledge' AND b.id = r.entity_id
      WHERE r.book_id = @bookId
    UNION ALL
    SELECT r.record_id AS from_id, 'story' AS to_source, r.event_id AS to_id, r.role
      FROM story_event_refs r
      JOIN page_targets a ON a.source = 'story' AND a.id = r.record_id
      JOIN page_targets b ON b.source = 'story' AND b.id = r.event_id
      WHERE r.book_id = @bookId
    ORDER BY from_id, to_source, to_id, role LIMIT @limit`)
    .all({ bookId, targets: JSON.stringify(targets), limit: MAX_GALAXY_EDGES + 1 }) as EdgeRow[]
  if (rows.length > MAX_GALAXY_EDGES + 1) throw storageFailure()
  const byKey = new Map(nodes.map((node) => [galaxyKey(node), node]))
  const edges = rows.map((row): GalaxyEdge => {
    const from = storedTarget({ source: 'story', id: row.from_id })
    const to = storedTarget({ source: row.to_source, id: row.to_id })
    const role = storedChoice(row.role, GALAXY_ROLES)
    const fromNode = byKey.get(galaxyKey(from))
    const toNode = byKey.get(galaxyKey(to))
    if (!fromNode || !toNode || to.source !== ROLE_TARGETS[role] ||
        (to.source === 'story' && toNode.kind !== 'event') ||
        (role === 'cognition_subject' && toNode.kind !== 'person')) throw storageFailure()
    return { id: `${galaxyKey(from)}>${galaxyKey(to)}:${role}`, from, to, role }
  })
  return { edges: edges.slice(0, MAX_GALAXY_EDGES), edgesTruncated: edges.length > MAX_GALAXY_EDGES }
}

export class StoryGalaxyRepository {
  constructor(private readonly studio: StudioRepository) {}

  list(input: StoryGalaxyInput): StoryGalaxyPage {
    return perform(() => {
      const data = parseStoryGalaxyInput(input)
      const { db } = this.studio.getStoryDatabase(data.bookId)
      return db.transaction(() => {
        // 版本、中心、总数、分页节点与连线来自同一只读快照；翻页同时约束两个版本。
        const state = readState(db, data.bookId)
        if (data.expectedBookRevision !== undefined && (state.revision !== data.expectedBookRevision ||
            state.knowledge_revision !== data.expectedKnowledgeRevision)) throw new DomainError({
          code: 'REVISION_CONFLICT', message: '作品或知识库版本已变化，请重新读取故事星海第一页。',
        })
        if (data.focus) {
          const table = data.focus.source === 'knowledge' ? 'knowledge_items' : 'story_records'
          if (!db.prepare(`SELECT id FROM ${table} WHERE book_id = ? AND id = ?`).get(data.bookId, data.focus.id)) {
            throw new DomainError({ code: 'NOT_FOUND', message: '当前作品中不存在这个星海聚焦对象。' })
          }
        }
        const scope = data.focus ? FOCUS_TARGETS : BOOK_TARGETS
        const params = data.focus
          ? { bookId: data.bookId, focusSource: data.focus.source, focusId: data.focus.id }
          : { bookId: data.bookId, kind: data.kind ?? null, nature: data.nature ?? null,
            authorDecision: data.authorDecision ?? null, search: data.search ?? '' }
        const { total } = db.prepare(`WITH ${scope} SELECT COUNT(*) AS total FROM targets`).get(params) as { total: number }
        if (!Number.isSafeInteger(total) || total < 0 ||
            total > MAX_KNOWLEDGE_ITEMS + MAX_STORY_RECORDS - (data.focus ? 1 : 0)) throw storageFailure()
        const offset = data.offset ?? 0
        // 排序字段固定，身份带来源命名空间；同名或跨表同 UUID 都不影响翻页稳定性。
        const rows = db.prepare(`WITH ${scope} SELECT source, id FROM targets
          ORDER BY source, id LIMIT @limit OFFSET @offset`).all({ ...params, limit: GALAXY_PAGE_SIZE, offset }) as TargetRow[]
        if (rows.length !== Math.min(GALAXY_PAGE_SIZE, Math.max(0, total - offset))) throw storageFailure()
        const pageTargets = rows.map(storedTarget)
        const nodes = readNodes(db, data.bookId, data.focus ? [data.focus, ...pageTargets] : pageTargets)
        const edges = readEdges(db, data.bookId, nodes)
        return { bookId: data.bookId, bookRevision: state.revision, knowledgeRevision: state.knowledge_revision,
          focus: data.focus ?? null, offset, nodes, ...edges, total,
          nextOffset: offset + pageTargets.length < total ? offset + pageTargets.length : null }
      })()
    })
  }
}
