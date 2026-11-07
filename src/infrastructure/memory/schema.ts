export const MEMORY_SCHEMA = `
  CREATE TABLE memory_tasks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    state TEXT NOT NULL CHECK (state IN ('planning', 'running', 'paused', 'completed', 'superseded', 'cancelled', 'failed')),
    phase TEXT NOT NULL CHECK (phase IN ('planning', 'indexing', 'publishing')),
    target_book_revision INTEGER NOT NULL CHECK (target_book_revision >= 0),
    target_knowledge_revision INTEGER NOT NULL CHECK (target_knowledge_revision >= 0),
    expected_publication_version INTEGER NOT NULL CHECK (expected_publication_version >= 0),
    planning_kind INTEGER NOT NULL DEFAULT 0 CHECK (planning_kind BETWEEN 0 AND 3),
    planning_after_id TEXT NOT NULL DEFAULT '',
    planned_sources INTEGER NOT NULL DEFAULT 0 CHECK (planned_sources >= 0),
    completed_sources INTEGER NOT NULL DEFAULT 0 CHECK (completed_sources >= 0 AND completed_sources <= planned_sources),
    processed_chunks INTEGER NOT NULL DEFAULT 0 CHECK (processed_chunks >= 0),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX memory_tasks_recent ON memory_tasks(updated_at DESC, id);
  CREATE UNIQUE INDEX memory_one_active_task ON memory_tasks(book_id)
    WHERE state IN ('planning', 'running', 'paused', 'failed');
  CREATE TABLE memory_artifacts (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('chapter', 'knowledge', 'story')),
    source_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_search_text TEXT NOT NULL,
    projection_version INTEGER NOT NULL CHECK (projection_version > 0),
    content_hash TEXT NOT NULL,
    nature TEXT NOT NULL CHECK (nature IN ('author_setting', 'future_plan', 'narrative_claim', 'character_belief', 'ai_derived', 'ai_inference', 'external_reference')),
    author_decision TEXT CHECK (author_decision IN ('unreviewed', 'adopted', 'rejected', 'review_later')),
    freshness TEXT NOT NULL CHECK (freshness IN ('current', 'affected', 'updating', 'failed')),
    conflict_state TEXT NOT NULL CHECK (conflict_state IN ('unchecked', 'clear', 'candidate', 'explained')),
    complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
    chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    created_at TEXT NOT NULL,
    CHECK ((source_kind = 'chapter' AND author_decision IS NULL) OR
      (source_kind != 'chapter' AND author_decision IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX memory_reusable_artifact ON memory_artifacts(source_kind, source_id, revision_id, title, projection_version)
    WHERE complete = 1;
  CREATE TABLE memory_task_units (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES memory_tasks(id),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('chapter', 'knowledge', 'story')),
    source_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artifact_id TEXT REFERENCES memory_artifacts(id),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed')),
    block_index INTEGER NOT NULL DEFAULT 0 CHECK (block_index >= 0),
    block_offset INTEGER NOT NULL DEFAULT 0 CHECK (block_offset >= 0),
    next_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
    UNIQUE (task_id, source_kind, source_id)
  ) STRICT;
  CREATE INDEX memory_units_by_state ON memory_task_units(task_id, state, id);
  CREATE TABLE memory_chunks (
    id INTEGER PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES memory_artifacts(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    block_id TEXT,
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
    text TEXT NOT NULL,
    search_text TEXT NOT NULL,
    UNIQUE (artifact_id, ordinal)
  ) STRICT;
  CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(search_text, content='memory_chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TABLE memory_artifact_entities (
    artifact_id TEXT NOT NULL REFERENCES memory_artifacts(id),
    entity_id TEXT NOT NULL REFERENCES knowledge_items(id),
    PRIMARY KEY (artifact_id, entity_id)
  ) STRICT;
  CREATE INDEX memory_artifacts_by_entity ON memory_artifact_entities(entity_id, artifact_id);
  CREATE TABLE memory_artifact_dependencies (
    artifact_id TEXT NOT NULL REFERENCES memory_artifacts(id),
    chapter_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    PRIMARY KEY (artifact_id, chapter_id, revision_id),
    FOREIGN KEY (chapter_id, revision_id) REFERENCES chapter_revisions(chapter_id, id)
  ) STRICT;
  CREATE INDEX memory_dependencies_by_chapter ON memory_artifact_dependencies(chapter_id, revision_id, artifact_id);
  CREATE TABLE memory_publications (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    task_id TEXT NOT NULL UNIQUE REFERENCES memory_tasks(id),
    book_revision INTEGER NOT NULL CHECK (book_revision >= 0),
    knowledge_revision INTEGER NOT NULL CHECK (knowledge_revision >= 0),
    source_count INTEGER NOT NULL CHECK (source_count >= 0),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE memory_heads (
    publication_version INTEGER NOT NULL REFERENCES memory_publications(version),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('chapter', 'knowledge', 'story')),
    source_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL REFERENCES memory_artifacts(id),
    PRIMARY KEY (publication_version, source_kind, source_id)
  ) STRICT;
  CREATE INDEX memory_heads_by_artifact ON memory_heads(artifact_id, publication_version);
  CREATE TABLE memory_event_receipts (
    consumer TEXT NOT NULL CHECK (consumer = 'local_keyword_entity_v1'),
    queue TEXT NOT NULL CHECK (queue IN ('outbox', 'knowledge_outbox', 'story_outbox')),
    event_id TEXT NOT NULL,
    book_revision INTEGER NOT NULL CHECK (book_revision >= 0),
    task_id TEXT NOT NULL REFERENCES memory_tasks(id),
    publication_version INTEGER NOT NULL REFERENCES memory_publications(version),
    PRIMARY KEY (consumer, queue, event_id)
  ) STRICT;
`
