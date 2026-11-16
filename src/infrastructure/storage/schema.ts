import { KNOWLEDGE_SCHEMA, CHARACTER_PROFILE_SCHEMA, KNOWLEDGE_ADJUDICATION_SCHEMA } from '../knowledge/schema'
import { STORY_SCHEMA } from '../story/schema'
import { FORESHADOW_THUMBNAIL_SCHEMA } from '../story/thumbnail-schema'
import { MEMORY_SCHEMA } from '../memory/schema'
import { AI_SCHEMA } from '../ai/schema'
import { GENERATION_BOOK_UPGRADE, STUDIO_GENERATION_SCHEMA } from '../ai/generation-schema'
import { AI_MEMORY_MAINTENANCE_SCHEMA, AI_MEMORY_TASK_SCHEMA } from '../ai/memory-task-schema'
import { AI_SUMMARY_SCHEMA } from '../ai/summary-schema'
import { MEMORY_VECTOR_SCHEMA } from '../memory/vector-schema'
import { NOTES_SCHEMA, NOTE_CHAPTER_SCHEMA, NOTE_MATERIAL_SCHEMA, NOTE_THUMBNAIL_SCHEMA } from '../notes/schema'
import { WORKBENCH_SCHEMA } from '../workbench/schema'
import { CALENDAR_SCHEMA } from '../workbench/calendar-schema'
import { AI_PRESETS_V14_SCHEMA, AI_PRESETS_V25_UPGRADE } from '../ai/preset-schema'
import { MEDIA_SCHEMA, SCENE_MEDIA_SCHEMA } from '../workbench/media-schema'
import { LIVING_SCHEMA } from '../workbench/living-schema'
import { FORGE_SCHEMA } from '../workbench/forge-schema'
import { WEAVE_SCHEMA } from '../workbench/weave-schema'
import { REALM_SCHEMA } from '../workbench/realm-schema'

export const STUDIO_SCHEMA_VERSION = 3
export const BOOK_SCHEMA_VERSION = 27
export const STUDIO_APPLICATION_ID = 0x53545753
export const BOOK_APPLICATION_ID = 0x53545742

export const STUDIO_SCHEMA = `
  CREATE TABLE studio_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    format TEXT NOT NULL CHECK (format = 'storyweave-studio')
  ) STRICT;
  INSERT INTO studio_meta (singleton, format) VALUES (1, 'storyweave-studio');
  CREATE TABLE books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT '',
    synopsis TEXT NOT NULL DEFAULT '',
    archived_at TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  ${STUDIO_GENERATION_SCHEMA}
`

// 历史基础结构保持原样，恢复包按其真实版本校验；新格式统一追加同一份升级 DDL。
export const BOOK_BASE_SCHEMA = `
  CREATE TABLE book_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT '',
    synopsis TEXT NOT NULL DEFAULT '',
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    knowledge_revision INTEGER NOT NULL DEFAULT 0 CHECK (knowledge_revision >= 0),
    index_publication_version INTEGER NOT NULL DEFAULT 0 CHECK (index_publication_version >= 0)
  ) STRICT;
  CREATE TABLE volumes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
    volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL,
    goal TEXT NOT NULL DEFAULT '',
    viewpoint TEXT NOT NULL DEFAULT '',
    target_characters INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'writing', 'review', 'finalized')),
    current_revision_id TEXT NOT NULL,
    finalized_revision_id TEXT,
    finalized_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (id, current_revision_id) REFERENCES chapter_revisions(chapter_id, id)
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (id, finalized_revision_id) REFERENCES chapter_revisions(chapter_id, id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (target_characters IS NULL OR target_characters >= 0),
    CHECK ((finalized_revision_id IS NULL) = (finalized_at IS NULL))
  ) STRICT;
  CREATE TABLE chapter_revisions (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id),
    parent_revision_id TEXT,
    document_json TEXT NOT NULL,
    plain_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    character_count INTEGER NOT NULL CHECK (character_count >= 0),
    sequence INTEGER NOT NULL UNIQUE,
    reason TEXT NOT NULL CHECK (reason IN ('created', 'saved', 'restored', 'imported')),
    restored_from_revision_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (chapter_id, id),
    FOREIGN KEY (chapter_id, parent_revision_id) REFERENCES chapter_revisions(chapter_id, id),
    FOREIGN KEY (chapter_id, restored_from_revision_id) REFERENCES chapter_revisions(chapter_id, id)
  ) STRICT;
  CREATE INDEX revisions_by_chapter ON chapter_revisions(chapter_id, sequence DESC);
  CREATE TRIGGER immutable_revision_update BEFORE UPDATE ON chapter_revisions
  BEGIN SELECT RAISE(ABORT, 'Chapter revisions are immutable'); END;
  CREATE TRIGGER immutable_revision_delete BEFORE DELETE ON chapter_revisions
  BEGIN SELECT RAISE(ABORT, 'Chapter revisions are immutable'); END;
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('chapter.changed', 'book.metadata', 'book.structure', 'chapter.metadata', 'chapter.finalized')),
    chapter_id TEXT REFERENCES chapters(id),
    revision_id TEXT REFERENCES chapter_revisions(id),
    book_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processed'))
  ) STRICT;
  CREATE INDEX outbox_pending ON outbox(state, created_at, id);
  CREATE UNIQUE INDEX outbox_chapter_changed_once ON outbox(chapter_id, revision_id) WHERE kind = 'chapter.changed';
  CREATE TABLE import_sources (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    encoding TEXT NOT NULL CHECK (encoding IN ('utf-8', 'utf-16le', 'utf-16be', 'gb18030')),
    relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    created_at TEXT NOT NULL
  ) STRICT;
`

export const BOOK_V14_SCHEMA = `
  ${BOOK_BASE_SCHEMA}
  ${KNOWLEDGE_SCHEMA}
  ${STORY_SCHEMA}
  ${MEMORY_SCHEMA}
  ${AI_SCHEMA}
  ${AI_MEMORY_TASK_SCHEMA}
  ${AI_SUMMARY_SCHEMA}
  ${MEMORY_VECTOR_SCHEMA}
  ${AI_MEMORY_MAINTENANCE_SCHEMA}
  ${NOTES_SCHEMA}
  ${WORKBENCH_SCHEMA}
  ${CHARACTER_PROFILE_SCHEMA}
  ${CALENDAR_SCHEMA}
  ${AI_PRESETS_V14_SCHEMA}
  ${MEDIA_SCHEMA}
`

export const BOOK_V15_SCHEMA = `${BOOK_V14_SCHEMA}${GENERATION_BOOK_UPGRADE}`
export const BOOK_V16_SCHEMA = `${BOOK_V15_SCHEMA}${LIVING_SCHEMA}`
export const BOOK_V17_SCHEMA = `${BOOK_V16_SCHEMA}${FORGE_SCHEMA}`
export const BOOK_V18_SCHEMA = `${BOOK_V17_SCHEMA}${WEAVE_SCHEMA}`
export const BOOK_V19_SCHEMA = `${BOOK_V18_SCHEMA}${REALM_SCHEMA}`
export const BOOK_V20_SCHEMA = `${BOOK_V19_SCHEMA}${NOTE_CHAPTER_SCHEMA}`
export const BOOK_V21_SCHEMA = `${BOOK_V20_SCHEMA}${SCENE_MEDIA_SCHEMA}`
export const BOOK_V22_SCHEMA = `${BOOK_V21_SCHEMA}${NOTE_MATERIAL_SCHEMA}`
export const BOOK_V23_SCHEMA = `${BOOK_V22_SCHEMA}${NOTE_THUMBNAIL_SCHEMA}`
export const BOOK_V24_SCHEMA = `${BOOK_V23_SCHEMA}${FORESHADOW_THUMBNAIL_SCHEMA}`
export const BOOK_V25_SCHEMA = `${BOOK_V24_SCHEMA}${AI_PRESETS_V25_UPGRADE}`
export const BOOK_V26_SCHEMA = `${BOOK_V25_SCHEMA}${KNOWLEDGE_ADJUDICATION_SCHEMA}`
// v27 沿用表结构，以格式门禁防止旧客户端在编辑 JSON 字段时丢失批注回复。
export const BOOK_SCHEMA = BOOK_V26_SCHEMA
