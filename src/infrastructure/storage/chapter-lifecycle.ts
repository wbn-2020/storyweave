import type Database from 'better-sqlite3'
import { DomainError } from '../../contracts/api'

export const CHAPTER_ARCHIVE_SCHEMA = `
  ALTER TABLE chapters ADD COLUMN archived_at TEXT;
  ALTER TABLE volumes ADD COLUMN archived_at TEXT;
  CREATE TRIGGER archived_chapter_readonly BEFORE UPDATE OF title, volume_id, goal, viewpoint, notes, status, current_revision_id, finalized_revision_id, finalized_at, target_characters, conflict, hook, tension, beats_json ON chapters
    WHEN OLD.archived_at IS NOT NULL OR EXISTS (SELECT 1 FROM volumes WHERE id = OLD.volume_id AND archived_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'archived chapter is read only'); END;
  CREATE TRIGGER archived_volume_readonly BEFORE UPDATE OF title, goal, conflict, climax ON volumes WHEN OLD.archived_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'archived volume is read only'); END;
`
export function supportsChapterArchive(db: Database.Database): boolean { return Number(db.pragma('user_version', { simple: true })) >= 28 }
export function activeChapterSql(db: Database.Database, alias = 'c'): string {
  return supportsChapterArchive(db) ? `${alias}.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM volumes archived_volume WHERE archived_volume.id = ${alias}.volume_id AND archived_volume.archived_at IS NOT NULL)` : '1 = 1'
}
export function requireActiveChapter(db: Database.Database, id: string): void {
  if (!db.prepare(`SELECT 1 FROM chapters c WHERE c.id = ? AND ${activeChapterSql(db)}`).get(id)) {
    throw new DomainError({ code: 'FORBIDDEN', message: '该章节已归档或不存在，请先在章节目录恢复后再编辑、生成或采用。' })
  }
}
