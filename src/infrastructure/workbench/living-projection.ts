import type Database from 'better-sqlite3'
import { activeChapterSql, supportsChapterArchive } from '../storage/chapter-lifecycle'

export const LIVING_MEMORY_PROJECTION_SCHEMA = `
  CREATE TABLE living_memory_knowledge (
    batch_id TEXT NOT NULL REFERENCES living_memory_batches(id),
    item_id TEXT NOT NULL UNIQUE REFERENCES knowledge_items(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (batch_id, ordinal)
  ) STRICT;
  CREATE TRIGGER living_memory_knowledge_immutable_update BEFORE UPDATE ON living_memory_knowledge
    BEGIN SELECT RAISE(ABORT, 'memory projection is immutable'); END;
  CREATE TRIGGER living_memory_knowledge_immutable_delete BEFORE DELETE ON living_memory_knowledge
    BEGIN SELECT RAISE(ABORT, 'memory projection is immutable'); END;
`

/** 投影沿用发布批次的有效期；正文未改但批次已替换时，也不能再用于新任务。 */
export function currentLivingProjectionSql(db: Database.Database, itemAlias: string): string {
  if (!supportsChapterArchive(db)) return '1 = 1'
  return `NOT EXISTS (SELECT 1 FROM living_memory_knowledge projection
    WHERE projection.item_id = ${itemAlias}.id AND NOT EXISTS (
      SELECT 1 FROM living_memory_batches batch
      JOIN living_memory_publications publication ON publication.batch_id = batch.id AND publication.chapter_id = batch.chapter_id
      JOIN chapters memory_chapter ON memory_chapter.id = batch.chapter_id
      WHERE batch.id = projection.batch_id AND batch.state = 'published'
        AND memory_chapter.current_revision_id = batch.chapter_revision_id
        AND memory_chapter.finalized_revision_id = batch.chapter_revision_id AND memory_chapter.status = 'finalized'
        AND ${activeChapterSql(db, 'memory_chapter')}
        AND NOT EXISTS (SELECT 1 FROM living_dependencies dependency
          WHERE dependency.target_kind = 'memory' AND dependency.target_id = batch.id AND dependency.source_kind = 'knowledge'
            AND NOT EXISTS (SELECT 1 FROM knowledge_items entity
              WHERE entity.id = dependency.source_id AND entity.author_decision = 'adopted' AND entity.freshness = 'current'
                AND entity.conflict_state IN ('clear', 'explained') AND dependency.source_revision =
                  (SELECT id FROM knowledge_item_revisions WHERE item_id = entity.id ORDER BY knowledge_revision DESC LIMIT 1)
                AND NOT EXISTS (SELECT 1 FROM knowledge_sources cited
                  JOIN chapter_revisions cited_revision ON cited_revision.id = cited.revision_id AND cited_revision.chapter_id = cited.chapter_id
                  JOIN chapters cited_chapter ON cited_chapter.id = cited.chapter_id
                  WHERE cited.item_id = entity.id AND cited.source_type = 'chapter_text'
                    AND (cited_chapter.current_revision_id != cited.revision_id OR NOT (${activeChapterSql(db, 'cited_chapter')}))
                    AND NOT EXISTS (SELECT 1 FROM knowledge_sources newer_source JOIN chapter_revisions newer_revision
                      ON newer_revision.id = newer_source.revision_id AND newer_revision.chapter_id = newer_source.chapter_id
                      WHERE newer_source.item_id = entity.id AND newer_source.chapter_id = cited.chapter_id
                        AND newer_source.source_type = 'chapter_text' AND newer_revision.sequence > cited_revision.sequence))))
    ))`
}
