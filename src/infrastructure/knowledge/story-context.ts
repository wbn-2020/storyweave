import type Database from 'better-sqlite3'
import { DomainError, requiredId, requiredInteger, requiredText } from '../../contracts/api'
import {
  KNOWLEDGE_RELATED_LIMIT, isKnowledgeStoryContextFor,
  type KnowledgeAppearance, type KnowledgeRelatedItem, type KnowledgeStoryContext,
} from '../../contracts/knowledge'
import { parseStoryFields } from '../../contracts/story'
import { APPEARANCE_ASSERTIONS_CTE } from '../story/appearance-projection'

function failure(): DomainError {
  return new DomainError({ code: 'STORAGE_ERROR', message: '登场或关联登记读取失败，请核对故事记录后重新读取条目。' })
}

/** 调用方已开启知识详情只读事务；不迁移旧书，也不写入来源、修订或回执。 */
export function readKnowledgeStoryContext(db: Database.Database, bookId: string, itemId: string): KnowledgeStoryContext {
  if ((db.pragma('user_version', { simple: true }) as number) < 4) return { state: 'requires_upgrade' }
  try {
    const appearances = db.prepare(`WITH entities AS (SELECT @itemId AS id),
      chapters_page AS (SELECT id FROM chapters), ${APPEARANCE_ASSERTIONS_CTE},
      registered AS (SELECT chapter_id,
        MIN(CASE WHEN current = 1 AND role = 'participant' THEN record_id END) AS event_id
        FROM assertions GROUP BY chapter_id
        HAVING SUM(CASE WHEN current = 1 AND role = 'participant' THEN 1 ELSE 0 END) > 0
          AND SUM(CASE WHEN current = 1 AND role = 'absent' THEN 1 ELSE 0 END) = 0),
      appearances AS (SELECT c.id, c.title, c.position, c.current_revision_id AS revision_id, r.event_id
        FROM registered r JOIN chapters c ON c.id = r.chapter_id)
      SELECT 0 AS boundary, * FROM (SELECT * FROM appearances ORDER BY position, id LIMIT 1)
      UNION ALL
      SELECT 1 AS boundary, * FROM (SELECT * FROM appearances ORDER BY position DESC, id DESC LIMIT 1)
      ORDER BY boundary`).all({ bookId, itemId }) as {
        boundary: number; id: string; title: string; position: number; revision_id: string; event_id: string
      }[]
    // 最多返回首末两行；同一章节也保留两侧身份，避免把缺失的最近登场解释为空登记。
    if (appearances.length !== 0 && (appearances.length !== 2 || appearances[0]!.boundary !== 0 || appearances[1]!.boundary !== 1)) throw failure()
    const [first, last] = appearances.map((row): KnowledgeAppearance => ({
      chapterId: requiredId(row.id), chapterTitle: requiredText(row.title, '登场章节', 120),
      chapterPosition: requiredInteger(row.position, '登场章节位置', Number.MAX_SAFE_INTEGER - 1),
      revisionId: requiredId(row.revision_id), eventId: requiredId(row.event_id),
    }))
    // 只沿明确关系端点查询；作者的未处理、否决和隐藏标记保留，不将同章共现当作关系。
    const rows = db.prepare(`SELECT s.id, s.fields_json, a.entity_id AS from_id, b.entity_id AS to_id,
        k.id AS entity_id, k.name, k.kind
      FROM story_records s
      JOIN story_entity_refs a ON a.record_id = s.id AND a.book_id = s.book_id AND a.role = 'relation_from'
      JOIN story_entity_refs b ON b.record_id = s.id AND b.book_id = s.book_id AND b.role = 'relation_to'
      JOIN knowledge_items k ON k.book_id = s.book_id
        AND k.id = CASE WHEN a.entity_id = @itemId THEN b.entity_id ELSE a.entity_id END
      WHERE s.book_id = @bookId AND s.kind = 'relation'
        AND (a.entity_id = @itemId OR b.entity_id = @itemId) AND a.entity_id <> b.entity_id
      ORDER BY s.updated_at DESC, s.id LIMIT @limit`)
      .all({ bookId, itemId, limit: KNOWLEDGE_RELATED_LIMIT + 1 }) as {
        id: string; fields_json: string; from_id: string; to_id: string; entity_id: string; name: string; kind: KnowledgeRelatedItem['kind']
      }[]
    const relations = rows.slice(0, KNOWLEDGE_RELATED_LIMIT).map((row): KnowledgeRelatedItem => {
      const fields = parseStoryFields(JSON.parse(row.fields_json), bookId)
      if (fields.kind !== 'relation' || fields.fromEntityId !== row.from_id || fields.toEntityId !== row.to_id) throw failure()
      return { recordId: requiredId(row.id), entityId: requiredId(row.entity_id), name: requiredText(row.name, '关联对象', 120), kind: row.kind,
        title: fields.title, relationType: fields.relationType,
        direction: fields.direction === 'mutual' ? 'mutual' : fields.fromEntityId === itemId ? 'outgoing' : 'incoming',
        ...(fields.layer === undefined ? {} : { layer: fields.layer }),
        nature: fields.nature, authorDecision: fields.authorDecision, freshness: fields.freshness, conflictState: fields.conflictState }
    })
    const context: KnowledgeStoryContext = { state: 'ready', firstAppearance: first ?? null, lastAppearance: last ?? null,
      relations, relationsTruncated: rows.length > KNOWLEDGE_RELATED_LIMIT }
    if (!isKnowledgeStoryContextFor(context, itemId)) throw failure()
    return context
  } catch { throw failure() }
}
