/** 由作品 v8 新建或显式备份后的升级事务执行，读取队列时不隐式建表。 */
export const AI_MEMORY_TASK_SCHEMA = `
  CREATE UNIQUE INDEX ai_runs_memory_task_identity ON ai_runs(id, book_id, chapter_id);
  CREATE TABLE ai_memory_tasks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
    state TEXT NOT NULL CHECK (state IN ('planning', 'ready', 'paused', 'failed', 'completed', 'superseded', 'cancelled')),
    phase TEXT NOT NULL CHECK (phase IN ('planning', 'reviewing')),
    kind TEXT NOT NULL CHECK (kind IN ('summarize', 'extract')),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('book', 'volume')),
    scope_volume_id TEXT,
    scope_title TEXT NOT NULL,
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
    total_chapters INTEGER NOT NULL CHECK (total_chapters BETWEEN 1 AND 20000),
    planned_chapters INTEGER NOT NULL DEFAULT 0 CHECK (planned_chapters BETWEEN 0 AND total_chapters),
    reviewed_chapters INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_chapters >= 0),
    skipped_chapters INTEGER NOT NULL DEFAULT 0 CHECK (skipped_chapters >= 0),
    connection_id TEXT NOT NULL,
    connection_name TEXT NOT NULL,
    model TEXT NOT NULL,
    instruction TEXT NOT NULL,
    source_book_revision INTEGER NOT NULL CHECK (source_book_revision BETWEEN 0 AND 9007199254740991),
    source_knowledge_revision INTEGER NOT NULL CHECK (source_knowledge_revision BETWEEN 0 AND 9007199254740991),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, book_id),
    FOREIGN KEY (connection_id, book_id) REFERENCES ai_connections(id, book_id),
    CHECK (scope_kind != 'book' OR scope_volume_id IS NULL),
    CHECK (reviewed_chapters + skipped_chapters <= planned_chapters),
    CHECK (phase != 'reviewing' OR planned_chapters = total_chapters),
    CHECK (state != 'planning' OR phase = 'planning'),
    CHECK (state != 'ready' OR phase = 'reviewing'),
    CHECK (state != 'completed' OR reviewed_chapters + skipped_chapters = total_chapters)
  ) STRICT;
  CREATE UNIQUE INDEX ai_memory_one_active_task ON ai_memory_tasks(book_id)
    WHERE state IN ('planning', 'ready', 'paused', 'failed');
  CREATE INDEX ai_memory_tasks_recent ON ai_memory_tasks(book_id, created_at DESC, id DESC);
  CREATE TRIGGER immutable_ai_memory_task_source BEFORE UPDATE OF id, book_id, kind, scope_kind, scope_volume_id,
    scope_title, manifest_hash, total_chapters, connection_id, connection_name, model, instruction,
    source_book_revision, source_knowledge_revision, created_at ON ai_memory_tasks
  BEGIN SELECT RAISE(ABORT, 'AI memory task sources are immutable'); END;
  CREATE TRIGGER immutable_ai_memory_task_delete BEFORE DELETE ON ai_memory_tasks
  BEGIN SELECT RAISE(ABORT, 'AI memory tasks preserve their audit'); END;

  CREATE TABLE ai_memory_task_units (
    task_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 20000),
    chapter_id TEXT NOT NULL,
    chapter_revision_id TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    volume_id TEXT,
    chapter_position INTEGER NOT NULL CHECK (chapter_position BETWEEN 0 AND 9007199254740991),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'reviewed', 'skipped')),
    run_id TEXT UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (task_id, ordinal),
    UNIQUE (task_id, chapter_id),
    UNIQUE (task_id, ordinal, book_id),
    UNIQUE (task_id, ordinal, book_id, chapter_id),
    FOREIGN KEY (task_id, book_id) REFERENCES ai_memory_tasks(id, book_id),
    FOREIGN KEY (chapter_id, chapter_revision_id) REFERENCES chapter_revisions(chapter_id, id),
    FOREIGN KEY (run_id, book_id, chapter_id) REFERENCES ai_runs(id, book_id, chapter_id),
    CHECK (run_id IS NULL OR attempts > 0),
    CHECK (state != 'reviewed' OR run_id IS NOT NULL)
  ) STRICT;
  CREATE INDEX ai_memory_task_pending ON ai_memory_task_units(task_id, state, ordinal);
  CREATE TRIGGER immutable_ai_memory_task_unit_source BEFORE UPDATE OF task_id, book_id, ordinal, chapter_id,
    chapter_revision_id, chapter_title, volume_id, chapter_position ON ai_memory_task_units
  BEGIN SELECT RAISE(ABORT, 'AI memory task unit sources are immutable'); END;
  CREATE TRIGGER immutable_ai_memory_task_unit_delete BEFORE DELETE ON ai_memory_task_units
  BEGIN SELECT RAISE(ABORT, 'AI memory task units preserve their audit'); END;

  CREATE TABLE ai_memory_task_attempts (
    task_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    unit_ordinal INTEGER NOT NULL,
    chapter_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 9007199254740991),
    run_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, unit_ordinal, attempt),
    UNIQUE (task_id, unit_ordinal, run_id),
    FOREIGN KEY (task_id, unit_ordinal, book_id, chapter_id) REFERENCES ai_memory_task_units(task_id, ordinal, book_id, chapter_id),
    FOREIGN KEY (run_id, book_id, chapter_id) REFERENCES ai_runs(id, book_id, chapter_id)
  ) STRICT;
  CREATE TRIGGER immutable_ai_memory_task_attempt_update BEFORE UPDATE ON ai_memory_task_attempts
  BEGIN SELECT RAISE(ABORT, 'AI memory task attempts are immutable'); END;
  CREATE TRIGGER immutable_ai_memory_task_attempt_delete BEFORE DELETE ON ai_memory_task_attempts
  BEGIN SELECT RAISE(ABORT, 'AI memory task attempts are immutable'); END;

  CREATE TABLE ai_memory_review_receipts (
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    consumer TEXT NOT NULL CHECK (consumer = 'chapter_model_review_v1'),
    kind TEXT NOT NULL CHECK (kind IN ('summarize', 'extract')),
    chapter_id TEXT NOT NULL,
    chapter_revision_id TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    task_id TEXT NOT NULL,
    unit_ordinal INTEGER NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    decision TEXT NOT NULL CHECK (decision IN ('adopted', 'rejected')),
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY (book_id, consumer, kind, chapter_id, chapter_revision_id, chapter_title),
    FOREIGN KEY (task_id, unit_ordinal, book_id) REFERENCES ai_memory_task_units(task_id, ordinal, book_id),
    FOREIGN KEY (task_id, unit_ordinal, run_id) REFERENCES ai_memory_task_attempts(task_id, unit_ordinal, run_id),
    FOREIGN KEY (chapter_id, chapter_revision_id) REFERENCES chapter_revisions(chapter_id, id),
    FOREIGN KEY (run_id, book_id, chapter_id) REFERENCES ai_runs(id, book_id, chapter_id)
  ) STRICT;
  CREATE TRIGGER immutable_ai_memory_review_update BEFORE UPDATE ON ai_memory_review_receipts
  BEGIN SELECT RAISE(ABORT, 'AI memory review receipts are immutable'); END;
  CREATE TRIGGER immutable_ai_memory_review_delete BEFORE DELETE ON ai_memory_review_receipts
  BEGIN SELECT RAISE(ABORT, 'AI memory review receipts are immutable'); END;
`

/** v11 固定本批待审阅的章节元数据，避免任务写入审阅回执后改变自己的来源清单。 */
export const AI_MEMORY_MAINTENANCE_SCHEMA = `
  CREATE TABLE ai_memory_task_selections (
    task_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    source_json TEXT NOT NULL CHECK (
      length(source_json) BETWEEN 1 AND 256000 AND
      CASE WHEN json_valid(source_json) THEN COALESCE(
        json_type(source_json) = 'object' AND
        json_type(source_json, '$.bookId') = 'text' AND
        json_extract(source_json, '$.bookId') = book_id AND
        json_type(source_json, '$.bookTitle') = 'text' AND
        json_type(source_json, '$.scope') = 'object' AND
        json_extract(source_json, '$.scope.kind') IN ('book', 'volume') AND
        (json_extract(source_json, '$.scope.kind') = 'book' OR
          json_type(source_json, '$.scope.volumeId') IN ('text', 'null')) AND
        json_type(source_json, '$.scopeTitle') = 'text' AND
        json_type(source_json, '$.chapters') = 'array' AND
        json_array_length(source_json, '$.chapters') BETWEEN 1 AND 100,
        0
      ) ELSE 0 END
    ),
    FOREIGN KEY (task_id, book_id) REFERENCES ai_memory_tasks(id, book_id)
  ) STRICT;
  CREATE TRIGGER immutable_ai_memory_task_selection_update BEFORE UPDATE ON ai_memory_task_selections
  BEGIN SELECT RAISE(ABORT, 'AI memory task selections are immutable'); END;
  CREATE TRIGGER immutable_ai_memory_task_selection_delete BEFORE DELETE ON ai_memory_task_selections
  BEGIN SELECT RAISE(ABORT, 'AI memory task selections preserve their audit'); END;
`
