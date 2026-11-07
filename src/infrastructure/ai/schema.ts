const CONNECTION_SCHEMA = `
  CREATE TABLE ai_connections (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    context_window INTEGER NOT NULL CHECK (context_window >= 1024),
    max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0 AND max_output_tokens < context_window),
    updated_at TEXT NOT NULL,
    UNIQUE (id, book_id)
  ) STRICT;
`

function runSchema(table: 'ai_runs' | 'ai_runs_v7'): string {
  return `
  CREATE TABLE ${table} (
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    chapter_id TEXT NOT NULL REFERENCES chapters(id),
    chapter_title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('plan', 'continue', 'rewrite', 'summarize', 'extract')),
    state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'rejected', 'adopted')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    connection_id TEXT NOT NULL,
    connection_name TEXT NOT NULL,
    model TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    context_integrity_hash TEXT NOT NULL,
    context_json TEXT NOT NULL,
    output_text TEXT NOT NULL DEFAULT '',
    accepted_text TEXT,
    adopted_revision_id TEXT,
    usage_json TEXT,
    finish_reason TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (connection_id, book_id) REFERENCES ai_connections(id, book_id),
    FOREIGN KEY (chapter_id, adopted_revision_id) REFERENCES chapter_revisions(chapter_id, id),
    CHECK ((state = 'adopted' AND accepted_text IS NOT NULL AND adopted_revision_id IS NOT NULL) OR
      (state != 'adopted' AND accepted_text IS NULL AND adopted_revision_id IS NULL))
  ) STRICT;
`
}

const RUN_INDEXES_AND_TRIGGERS = `
  CREATE INDEX ai_runs_recent ON ai_runs(book_id, sequence DESC);
  CREATE UNIQUE INDEX ai_one_running_per_book ON ai_runs(book_id) WHERE state = 'running';
  CREATE TRIGGER immutable_ai_run_context BEFORE UPDATE OF book_id, chapter_id, chapter_title, kind,
    connection_id, connection_name, model, context_hash, context_integrity_hash, context_json, created_at ON ai_runs
  BEGIN SELECT RAISE(ABORT, 'AI run context is immutable'); END;
`

function adoptionSchema(table: 'ai_adoptions' | 'ai_adoptions_v7', runTable: 'ai_runs' | 'ai_runs_v7'): string {
  return `
  CREATE TABLE ${table} (
    run_id TEXT PRIMARY KEY REFERENCES ${runTable}(id),
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    chapter_id TEXT NOT NULL REFERENCES chapters(id),
    original_output TEXT NOT NULL,
    accepted_text TEXT NOT NULL,
    previous_revision_id TEXT NOT NULL,
    adopted_revision_id TEXT NOT NULL,
    previous_notes TEXT,
    adopted_notes TEXT,
    book_revision INTEGER NOT NULL CHECK (book_revision >= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (chapter_id, previous_revision_id) REFERENCES chapter_revisions(chapter_id, id),
    FOREIGN KEY (chapter_id, adopted_revision_id) REFERENCES chapter_revisions(chapter_id, id)
  ) STRICT;
`
}

const ADOPTION_TRIGGERS = `
  CREATE TRIGGER immutable_ai_adoption_update BEFORE UPDATE ON ai_adoptions
  BEGIN SELECT RAISE(ABORT, 'AI adoptions are immutable'); END;
  CREATE TRIGGER immutable_ai_adoption_delete BEFORE DELETE ON ai_adoptions
  BEGIN SELECT RAISE(ABORT, 'AI adoptions are immutable'); END;
`

const MEMORY_ADOPTION_SCHEMA = `
  CREATE TABLE ai_memory_adoptions (
    run_id TEXT PRIMARY KEY REFERENCES ai_runs(id),
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    review_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER immutable_ai_memory_adoption_update BEFORE UPDATE ON ai_memory_adoptions
  BEGIN SELECT RAISE(ABORT, 'AI memory adoptions are immutable'); END;
  CREATE TRIGGER immutable_ai_memory_adoption_delete BEFORE DELETE ON ai_memory_adoptions
  BEGIN SELECT RAISE(ABORT, 'AI memory adoptions are immutable'); END;
`

export const AI_SCHEMA = `${CONNECTION_SCHEMA}${runSchema('ai_runs')}${RUN_INDEXES_AND_TRIGGERS}
  ${adoptionSchema('ai_adoptions', 'ai_runs')}${ADOPTION_TRIGGERS}${MEMORY_ADOPTION_SCHEMA}`

const RUN_COLUMNS = `sequence, id, book_id, chapter_id, chapter_title, kind, state, version,
  connection_id, connection_name, model, context_hash, context_integrity_hash, context_json,
  output_text, accepted_text, adopted_revision_id, usage_json, finish_reason, error, created_at, updated_at`
const ADOPTION_COLUMNS = `run_id, book_id, chapter_id, original_output, accepted_text, previous_revision_id,
  adopted_revision_id, previous_notes, adopted_notes, book_revision, created_at`

// 仅由显式备份后的升级事务执行；逐列复制原值，保留固定上下文、候选顺序与采用审计。
export const AI_V6_TO_V7_SCHEMA = `
  ${runSchema('ai_runs_v7')}
  ${adoptionSchema('ai_adoptions_v7', 'ai_runs_v7')}
  INSERT INTO ai_runs_v7 (${RUN_COLUMNS}) SELECT ${RUN_COLUMNS} FROM ai_runs;
  INSERT INTO ai_adoptions_v7 (${ADOPTION_COLUMNS}) SELECT ${ADOPTION_COLUMNS} FROM ai_adoptions;
  -- 先替换引用方，使外键始终指向完整的新运行表；表更名同步更新新采用表的引用。
  DROP TABLE ai_adoptions;
  DROP TABLE ai_runs;
  ALTER TABLE ai_runs_v7 RENAME TO ai_runs;
  ALTER TABLE ai_adoptions_v7 RENAME TO ai_adoptions;
  ${RUN_INDEXES_AND_TRIGGERS}
  ${ADOPTION_TRIGGERS}
  ${MEMORY_ADOPTION_SCHEMA}
`
