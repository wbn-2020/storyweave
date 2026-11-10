export const STUDIO_GENERATION_SCHEMA = `
  CREATE TABLE studio_ai_connections (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    context_window INTEGER NOT NULL CHECK (context_window >= 1024),
    max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0 AND max_output_tokens < context_window),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX one_default_studio_connection ON studio_ai_connections(is_default) WHERE is_default = 1;
`

export const GENERATION_SCHEMA = `
  CREATE TABLE generation_runs (
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    part TEXT NOT NULL CHECK (part IN ('all', 'titles', 'cast', 'rules', 'outline')),
    parent_run_id TEXT REFERENCES generation_runs(id),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    seed_json TEXT NOT NULL,
    connection_snapshot_json TEXT NOT NULL,
    prompt_version INTEGER NOT NULL,
    messages_json TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
    proposal_json TEXT,
    selection_json TEXT NOT NULL DEFAULT '[]',
    output_text TEXT NOT NULL DEFAULT '',
    usage_json TEXT,
    book_revision INTEGER NOT NULL CHECK (book_revision >= 0),
    knowledge_revision INTEGER NOT NULL CHECK (knowledge_revision >= 0),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX generation_runs_recent ON generation_runs(book_id, sequence DESC);
  CREATE UNIQUE INDEX one_running_generation_per_book ON generation_runs(book_id) WHERE state = 'running';
  CREATE TRIGGER immutable_generation_context BEFORE UPDATE OF id, book_id, part, parent_run_id, seed_json,
    connection_snapshot_json, prompt_version, messages_json, context_hash, estimated_input_tokens,
    book_revision, knowledge_revision, created_at ON generation_runs
  BEGIN SELECT RAISE(ABORT, 'Generation context is immutable'); END;
  CREATE TABLE generation_adoptions (
    id TEXT NOT NULL UNIQUE,
    run_id TEXT PRIMARY KEY REFERENCES generation_runs(id),
    first_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    refs_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER immutable_generation_adoption_update BEFORE UPDATE ON generation_adoptions
  BEGIN SELECT RAISE(ABORT, 'Generation adoption is immutable'); END;
  CREATE TRIGGER immutable_generation_adoption_delete BEFORE DELETE ON generation_adoptions
  BEGIN SELECT RAISE(ABORT, 'Generation adoption is immutable'); END;
`

export const GENERATION_BOOK_UPGRADE = `
  ALTER TABLE book_meta ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('kickstarting', 'active', 'finished'));
  ALTER TABLE book_meta ADD COLUMN logline TEXT NOT NULL DEFAULT '';
  ALTER TABLE book_meta ADD COLUMN master_outline_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE book_meta ADD COLUMN seed_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE volumes ADD COLUMN goal TEXT NOT NULL DEFAULT '';
  ALTER TABLE volumes ADD COLUMN conflict TEXT NOT NULL DEFAULT '';
  ALTER TABLE volumes ADD COLUMN climax TEXT NOT NULL DEFAULT '';
  ALTER TABLE chapters ADD COLUMN conflict TEXT NOT NULL DEFAULT '';
  ALTER TABLE chapters ADD COLUMN hook TEXT NOT NULL DEFAULT '';
  ALTER TABLE chapters ADD COLUMN tension INTEGER CHECK (tension IS NULL OR (tension >= 0 AND tension <= 100));
  ALTER TABLE chapters ADD COLUMN beats_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE chapters ADD COLUMN outline_stale INTEGER NOT NULL DEFAULT 0 CHECK (outline_stale IN (0, 1));
  ${GENERATION_SCHEMA}
`
