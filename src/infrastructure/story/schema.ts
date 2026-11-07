export const STORY_SCHEMA = `
  CREATE TABLE story_records (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    kind TEXT NOT NULL CHECK (kind IN ('relation', 'event', 'foreshadow', 'cognition')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    story_order INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, book_id),
    UNIQUE (id, book_id, kind)
  ) STRICT;
  CREATE INDEX story_records_by_kind ON story_records(kind, story_order, id);
  CREATE INDEX story_records_by_update ON story_records(updated_at DESC, id);
  CREATE TRIGGER immutable_story_kind BEFORE UPDATE OF kind ON story_records
    WHEN NEW.kind != OLD.kind
  BEGIN SELECT RAISE(ABORT, 'Story record kind is immutable'); END;
  CREATE TABLE story_entity_refs (
    record_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('relation_from', 'relation_to', 'participant', 'mentioned', 'state_change', 'foreshadow_entity', 'cognition_subject')),
    PRIMARY KEY (record_id, entity_id, role),
    FOREIGN KEY (record_id, book_id) REFERENCES story_records(id, book_id),
    FOREIGN KEY (entity_id, book_id) REFERENCES knowledge_items(id, book_id)
  ) STRICT;
  CREATE INDEX story_entity_refs_by_entity ON story_entity_refs(entity_id, role, record_id);
  CREATE TRIGGER require_cognition_person_insert BEFORE INSERT ON story_entity_refs
    WHEN NEW.role = 'cognition_subject' AND NOT EXISTS (
      SELECT 1 FROM knowledge_items WHERE id = NEW.entity_id AND book_id = NEW.book_id AND kind = 'person')
  BEGIN SELECT RAISE(ABORT, 'Cognition subject must be a person'); END;
  CREATE TRIGGER protect_cognition_person BEFORE UPDATE OF kind ON knowledge_items
    WHEN NEW.kind != 'person' AND EXISTS (
      SELECT 1 FROM story_entity_refs WHERE entity_id = OLD.id AND role = 'cognition_subject')
  BEGIN SELECT RAISE(ABORT, 'Referenced cognition subject must remain a person'); END;
  CREATE TABLE story_event_refs (
    record_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_kind TEXT NOT NULL DEFAULT 'event' CHECK (event_kind = 'event'),
    role TEXT NOT NULL CHECK (role IN ('relation_start', 'relation_end', 'foreshadow_event', 'acquisition')),
    PRIMARY KEY (record_id, event_id, role),
    FOREIGN KEY (record_id, book_id) REFERENCES story_records(id, book_id),
    FOREIGN KEY (event_id, book_id, event_kind) REFERENCES story_records(id, book_id, kind)
  ) STRICT;
  CREATE INDEX story_event_refs_by_event ON story_event_refs(event_id, record_id);
  CREATE TABLE story_sources (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('author_input', 'chapter_text', 'external')),
    book_id TEXT NOT NULL,
    chapter_id TEXT,
    revision_id TEXT,
    block_id TEXT,
    quote TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (record_id, book_id) REFERENCES story_records(id, book_id),
    FOREIGN KEY (chapter_id, revision_id) REFERENCES chapter_revisions(chapter_id, id),
    CHECK ((source_type = 'chapter_text' AND chapter_id IS NOT NULL AND revision_id IS NOT NULL AND block_id IS NOT NULL)
      OR (source_type != 'chapter_text' AND chapter_id IS NULL AND revision_id IS NULL AND block_id IS NULL))
  ) STRICT;
  CREATE INDEX story_sources_by_record ON story_sources(record_id, created_at, id);
  CREATE TRIGGER immutable_story_source_update BEFORE UPDATE ON story_sources
  BEGIN SELECT RAISE(ABORT, 'Story sources are immutable'); END;
  CREATE TRIGGER immutable_story_source_delete BEFORE DELETE ON story_sources
  BEGIN SELECT RAISE(ABORT, 'Story sources are immutable'); END;
  CREATE TABLE story_record_revisions (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES story_records(id),
    knowledge_revision INTEGER NOT NULL UNIQUE CHECK (knowledge_revision > 0),
    fields_json TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('created', 'updated')),
    created_at TEXT NOT NULL,
    UNIQUE (record_id, id)
  ) STRICT;
  CREATE INDEX story_revisions_by_record ON story_record_revisions(record_id, knowledge_revision DESC);
  CREATE TRIGGER immutable_story_revision_update BEFORE UPDATE ON story_record_revisions
  BEGIN SELECT RAISE(ABORT, 'Story revisions are immutable'); END;
  CREATE TRIGGER immutable_story_revision_delete BEFORE DELETE ON story_record_revisions
  BEGIN SELECT RAISE(ABORT, 'Story revisions are immutable'); END;
  CREATE TABLE story_outbox (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES story_records(id),
    story_revision_id TEXT NOT NULL UNIQUE,
    book_revision INTEGER NOT NULL CHECK (book_revision > 0),
    knowledge_revision INTEGER NOT NULL CHECK (knowledge_revision > 0),
    created_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processed')),
    FOREIGN KEY (record_id, story_revision_id) REFERENCES story_record_revisions(record_id, id)
  ) STRICT;
  CREATE INDEX story_outbox_pending ON story_outbox(state, created_at, id);
`
