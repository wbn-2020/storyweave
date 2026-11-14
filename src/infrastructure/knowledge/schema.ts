export const KNOWLEDGE_SCHEMA = `
  CREATE TABLE knowledge_items (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    kind TEXT NOT NULL CHECK (kind IN ('person', 'place', 'organization', 'object', 'rule', 'theme', 'other')),
    name TEXT NOT NULL,
    aliases_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    nature TEXT NOT NULL CHECK (nature IN ('author_setting', 'future_plan', 'narrative_claim', 'character_belief', 'ai_derived', 'ai_inference', 'external_reference')),
    author_decision TEXT NOT NULL CHECK (author_decision IN ('unreviewed', 'adopted', 'rejected', 'review_later')),
    freshness TEXT NOT NULL CHECK (freshness IN ('current', 'affected', 'updating', 'failed')),
    conflict_state TEXT NOT NULL CHECK (conflict_state IN ('unchecked', 'clear', 'candidate', 'explained')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, book_id)
  ) STRICT;
  CREATE INDEX knowledge_items_by_kind ON knowledge_items(kind, updated_at DESC, id);
  CREATE INDEX knowledge_items_by_update ON knowledge_items(updated_at DESC, id);
  CREATE TABLE knowledge_sources (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('author_input', 'chapter_text', 'external')),
    book_id TEXT NOT NULL,
    chapter_id TEXT,
    revision_id TEXT,
    block_id TEXT,
    quote TEXT NOT NULL,
    validity TEXT NOT NULL CHECK (validity IN ('valid', 'partial', 'missing')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (item_id, book_id) REFERENCES knowledge_items(id, book_id),
    FOREIGN KEY (chapter_id, revision_id) REFERENCES chapter_revisions(chapter_id, id),
    CHECK ((source_type = 'chapter_text' AND chapter_id IS NOT NULL AND revision_id IS NOT NULL AND block_id IS NOT NULL)
      OR (source_type != 'chapter_text' AND chapter_id IS NULL AND revision_id IS NULL AND block_id IS NULL))
  ) STRICT;
  CREATE INDEX knowledge_sources_by_item ON knowledge_sources(item_id, created_at, id);
  CREATE TRIGGER immutable_knowledge_source_update BEFORE UPDATE ON knowledge_sources
  BEGIN SELECT RAISE(ABORT, 'Knowledge sources are immutable'); END;
  CREATE TRIGGER immutable_knowledge_source_delete BEFORE DELETE ON knowledge_sources
  BEGIN SELECT RAISE(ABORT, 'Knowledge sources are immutable'); END;
  CREATE TABLE knowledge_item_revisions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES knowledge_items(id),
    knowledge_revision INTEGER NOT NULL UNIQUE CHECK (knowledge_revision > 0),
    fields_json TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('created', 'updated')),
    created_at TEXT NOT NULL,
    UNIQUE (item_id, id)
  ) STRICT;
  CREATE INDEX knowledge_revisions_by_item ON knowledge_item_revisions(item_id, knowledge_revision DESC);
  CREATE TRIGGER immutable_knowledge_revision_update BEFORE UPDATE ON knowledge_item_revisions
  BEGIN SELECT RAISE(ABORT, 'Knowledge revisions are immutable'); END;
  CREATE TRIGGER immutable_knowledge_revision_delete BEFORE DELETE ON knowledge_item_revisions
  BEGIN SELECT RAISE(ABORT, 'Knowledge revisions are immutable'); END;
  CREATE TABLE knowledge_outbox (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES knowledge_items(id),
    knowledge_revision_id TEXT NOT NULL UNIQUE,
    book_revision INTEGER NOT NULL CHECK (book_revision > 0),
    knowledge_revision INTEGER NOT NULL CHECK (knowledge_revision > 0),
    created_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processed')),
    FOREIGN KEY (item_id, knowledge_revision_id) REFERENCES knowledge_item_revisions(item_id, id)
  ) STRICT;
  CREATE INDEX knowledge_outbox_pending ON knowledge_outbox(state, created_at, id);
`

// 新建作品与旧书备份升级均由 storage 在 book v14 统一追加，基础知识表保留原有版本结构。
export const CHARACTER_PROFILE_SCHEMA = `
  ALTER TABLE knowledge_items ADD COLUMN character_profile_json TEXT
    CHECK (character_profile_json IS NULL OR
      (kind = 'person' AND json_valid(character_profile_json) AND json_type(character_profile_json) = 'object'));
`

// 裁决仅追加：两侧来源和前后修订受同一条目身份外键约束，不改写既有证据。
export const KNOWLEDGE_ADJUDICATION_SCHEMA = `
  CREATE UNIQUE INDEX knowledge_sources_adjudication_identity ON knowledge_sources(item_id, id);
  CREATE TABLE knowledge_adjudications (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES knowledge_items(id),
    source_a_id TEXT NOT NULL,
    source_b_id TEXT NOT NULL,
    previous_revision_id TEXT NOT NULL,
    revision_id TEXT NOT NULL UNIQUE,
    book_revision INTEGER NOT NULL CHECK (book_revision > 0),
    resolution TEXT NOT NULL CHECK (resolution IN ('keep_a', 'keep_b', 'intentional')),
    note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (item_id, source_a_id) REFERENCES knowledge_sources(item_id, id),
    FOREIGN KEY (item_id, source_b_id) REFERENCES knowledge_sources(item_id, id),
    FOREIGN KEY (item_id, previous_revision_id) REFERENCES knowledge_item_revisions(item_id, id),
    FOREIGN KEY (item_id, revision_id) REFERENCES knowledge_item_revisions(item_id, id),
    CHECK (source_a_id <> source_b_id),
    CHECK (previous_revision_id <> revision_id)
  ) STRICT;
  CREATE INDEX knowledge_adjudications_by_item ON knowledge_adjudications(item_id, book_revision DESC);
  CREATE TRIGGER immutable_knowledge_adjudication_update BEFORE UPDATE ON knowledge_adjudications
  BEGIN SELECT RAISE(ABORT, 'Knowledge adjudications are immutable'); END;
  CREATE TRIGGER immutable_knowledge_adjudication_delete BEFORE DELETE ON knowledge_adjudications
  BEGIN SELECT RAISE(ABORT, 'Knowledge adjudications are immutable'); END;
`
