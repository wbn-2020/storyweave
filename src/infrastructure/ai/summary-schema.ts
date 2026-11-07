/** 作品 v9 只追加汇总资料；v8 逐章任务和原候选表均保留。 */
export const AI_SUMMARY_SCHEMA = `
  CREATE INDEX ai_summary_chapter_candidates ON ai_runs(book_id, chapter_id, sequence DESC)
    WHERE kind = 'summarize' AND state = 'adopted';
  CREATE TABLE ai_summary_tasks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
    state TEXT NOT NULL CHECK (state IN ('planning', 'ready', 'paused', 'failed', 'completed', 'superseded', 'cancelled')),
    phase TEXT NOT NULL CHECK (phase IN ('planning', 'reviewing')),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('book', 'volume')),
    scope_volume_id TEXT,
    scope_title TEXT NOT NULL,
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
    manifest_json TEXT NOT NULL,
    fan_in INTEGER NOT NULL CHECK (fan_in IN (2, 4, 8)),
    total_chapters INTEGER NOT NULL CHECK (total_chapters BETWEEN 1 AND 20000),
    total_nodes INTEGER NOT NULL CHECK (total_nodes BETWEEN 1 AND 40000),
    planned_nodes INTEGER NOT NULL DEFAULT 0 CHECK (planned_nodes BETWEEN 0 AND total_nodes),
    approved_nodes INTEGER NOT NULL DEFAULT 0 CHECK (approved_nodes BETWEEN 0 AND planned_nodes),
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
    CHECK (phase != 'reviewing' OR planned_nodes = total_nodes),
    CHECK (phase != 'planning' OR approved_nodes = 0),
    CHECK (state != 'planning' OR phase = 'planning'),
    CHECK (state != 'ready' OR phase = 'reviewing'),
    CHECK (state != 'completed' OR approved_nodes = total_nodes)
  ) STRICT;
  CREATE UNIQUE INDEX ai_summary_one_active_task ON ai_summary_tasks(book_id)
    WHERE state IN ('planning', 'ready', 'paused', 'failed');
  CREATE INDEX ai_summary_tasks_recent ON ai_summary_tasks(book_id, created_at DESC, id DESC);
  CREATE TRIGGER immutable_ai_summary_task_source BEFORE UPDATE OF id, book_id, scope_kind, scope_volume_id,
    scope_title, manifest_hash, manifest_json, fan_in, total_chapters, total_nodes, connection_id, connection_name,
    model, instruction, source_book_revision, source_knowledge_revision, created_at ON ai_summary_tasks
  BEGIN SELECT RAISE(ABORT, 'Summary task sources are immutable'); END;
  CREATE TRIGGER immutable_ai_summary_task_delete BEFORE DELETE ON ai_summary_tasks
  BEGIN SELECT RAISE(ABORT, 'Summary tasks preserve their audit'); END;

  CREATE TABLE ai_summary_nodes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 40000),
    level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 30),
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 20000),
    title TEXT NOT NULL,
    first_chapter_ordinal INTEGER NOT NULL CHECK (first_chapter_ordinal BETWEEN 1 AND 20000),
    last_chapter_ordinal INTEGER NOT NULL CHECK (last_chapter_ordinal BETWEEN first_chapter_ordinal AND 20000),
    chapter_count INTEGER NOT NULL CHECK (chapter_count = last_chapter_ordinal - first_chapter_ordinal + 1),
    anchor_chapter_id TEXT NOT NULL,
    anchor_revision_id TEXT NOT NULL,
    anchor_chapter_title TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved')),
    run_id TEXT UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 9007199254740991),
    accepted_text TEXT,
    approved_at TEXT,
    UNIQUE (task_id, ordinal),
    UNIQUE (task_id, level, position),
    UNIQUE (id, task_id, book_id, anchor_chapter_id),
    FOREIGN KEY (task_id, book_id) REFERENCES ai_summary_tasks(id, book_id),
    FOREIGN KEY (anchor_chapter_id, anchor_revision_id) REFERENCES chapter_revisions(chapter_id, id),
    FOREIGN KEY (run_id, book_id, anchor_chapter_id) REFERENCES ai_runs(id, book_id, chapter_id),
    CHECK (run_id IS NULL OR attempts > 0),
    CHECK ((state = 'approved' AND run_id IS NOT NULL AND accepted_text IS NOT NULL AND approved_at IS NOT NULL)
      OR (state = 'pending' AND accepted_text IS NULL AND approved_at IS NULL))
  ) STRICT;
  CREATE INDEX ai_summary_nodes_pending ON ai_summary_nodes(task_id, state, ordinal);
  CREATE TRIGGER immutable_ai_summary_node_source BEFORE UPDATE OF id, task_id, book_id, ordinal, level, position,
    title, first_chapter_ordinal, last_chapter_ordinal, chapter_count, anchor_chapter_id, anchor_revision_id,
    anchor_chapter_title, sources_json ON ai_summary_nodes
  BEGIN SELECT RAISE(ABORT, 'Summary node sources are immutable'); END;
  CREATE TRIGGER immutable_ai_summary_approved_node BEFORE UPDATE ON ai_summary_nodes WHEN OLD.state = 'approved'
  BEGIN SELECT RAISE(ABORT, 'Approved summary nodes are immutable'); END;
  CREATE TRIGGER immutable_ai_summary_node_delete BEFORE DELETE ON ai_summary_nodes
  BEGIN SELECT RAISE(ABORT, 'Summary nodes preserve their audit'); END;

  CREATE TABLE ai_summary_attempts (
    node_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    anchor_chapter_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 9007199254740991),
    run_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (node_id, attempt),
    FOREIGN KEY (node_id, task_id, book_id, anchor_chapter_id) REFERENCES ai_summary_nodes(id, task_id, book_id, anchor_chapter_id),
    FOREIGN KEY (run_id, book_id, anchor_chapter_id) REFERENCES ai_runs(id, book_id, chapter_id)
  ) STRICT;
  CREATE TRIGGER immutable_ai_summary_attempt_update BEFORE UPDATE ON ai_summary_attempts
  BEGIN SELECT RAISE(ABORT, 'Summary attempts are immutable'); END;
  CREATE TRIGGER immutable_ai_summary_attempt_delete BEFORE DELETE ON ai_summary_attempts
  BEGIN SELECT RAISE(ABORT, 'Summary attempts are immutable'); END;
`
