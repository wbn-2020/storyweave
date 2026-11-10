/** v16 只在新建或完成备份后的升级事务中追加。历史与来源不可变，有效性由依赖图计算。 */
export const LIVING_SCHEMA = `
  CREATE TABLE living_outlines (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('book', 'volume', 'chapter')),
    current_revision_id TEXT NOT NULL,
    FOREIGN KEY (id, current_revision_id) REFERENCES living_outline_revisions(outline_id, id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE TABLE living_outline_revisions (
    id TEXT PRIMARY KEY,
    outline_id TEXT NOT NULL REFERENCES living_outlines(id),
    version INTEGER NOT NULL CHECK (version > 0),
    parent_revision_id TEXT,
    fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
    locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'ai', 'restored')),
    run_id TEXT REFERENCES ai_runs(id),
    created_at TEXT NOT NULL,
    UNIQUE (outline_id, id),
    UNIQUE (outline_id, version),
    FOREIGN KEY (outline_id, parent_revision_id) REFERENCES living_outline_revisions(outline_id, id)
  ) STRICT;
  CREATE INDEX living_outline_history ON living_outline_revisions(outline_id, version DESC);
  CREATE TRIGGER immutable_living_outline_update BEFORE UPDATE ON living_outline_revisions
  BEGIN SELECT RAISE(ABORT, 'Outline revisions are immutable'); END;
  CREATE TRIGGER immutable_living_outline_delete BEFORE DELETE ON living_outline_revisions
  BEGIN SELECT RAISE(ABORT, 'Outline revisions preserve their history'); END;

  CREATE TABLE living_runs (
    run_id TEXT PRIMARY KEY REFERENCES ai_runs(id),
    kind TEXT NOT NULL CHECK (kind IN ('memory', 'expand', 'rebase')),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER immutable_living_run_update BEFORE UPDATE ON living_runs
  BEGIN SELECT RAISE(ABORT, 'Living inputs are immutable'); END;
  CREATE TRIGGER immutable_living_run_delete BEFORE DELETE ON living_runs
  BEGIN SELECT RAISE(ABORT, 'Living inputs preserve their audit'); END;

  CREATE TABLE living_memory_batches (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id),
    chapter_title TEXT NOT NULL,
    chapter_revision_id TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE REFERENCES living_runs(run_id),
    state TEXT NOT NULL CHECK (state IN ('published', 'superseded')),
    proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
    created_at TEXT NOT NULL,
    UNIQUE (chapter_id, id),
    FOREIGN KEY (chapter_id, chapter_revision_id) REFERENCES chapter_revisions(chapter_id, id)
  ) STRICT;
  CREATE INDEX living_memory_recent ON living_memory_batches(created_at DESC, id DESC);
  CREATE TABLE living_memory_publications (
    chapter_id TEXT PRIMARY KEY REFERENCES chapters(id),
    batch_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY (chapter_id, batch_id) REFERENCES living_memory_batches(chapter_id, id)
  ) STRICT;
  CREATE TRIGGER immutable_living_memory_source BEFORE UPDATE OF id, chapter_id, chapter_title,
    chapter_revision_id, run_id, proposal_json, created_at ON living_memory_batches
  BEGIN SELECT RAISE(ABORT, 'Memory batch sources are immutable'); END;
  CREATE TRIGGER immutable_living_memory_delete BEFORE DELETE ON living_memory_batches
  BEGIN SELECT RAISE(ABORT, 'Memory batches preserve their audit'); END;

  CREATE TABLE living_dependencies (
    target_kind TEXT NOT NULL CHECK (target_kind IN ('outline', 'memory')),
    -- 大纲目标使用修订 ID，来源使用节点 ID + 固定修订，历史恢复才能保留当时的依赖。
    target_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('chapter', 'knowledge', 'outline', 'memory', 'brief')),
    source_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    PRIMARY KEY (target_kind, target_id, source_kind, source_id)
  ) STRICT;
  CREATE INDEX living_dependencies_source ON living_dependencies(source_kind, source_id, source_revision);
  CREATE TRIGGER immutable_living_dependency_update BEFORE UPDATE ON living_dependencies
  BEGIN SELECT RAISE(ABORT, 'Derivation dependencies are immutable'); END;
  CREATE TRIGGER immutable_living_dependency_delete BEFORE DELETE ON living_dependencies
  BEGIN SELECT RAISE(ABORT, 'Derivation dependencies preserve their audit'); END;
  CREATE TABLE living_receipts (
    run_id TEXT PRIMARY KEY REFERENCES living_runs(run_id),
    accepted_json TEXT NOT NULL CHECK (json_valid(accepted_json)),
    refs_json TEXT NOT NULL CHECK (json_valid(refs_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER immutable_living_receipt_update BEFORE UPDATE ON living_receipts
  BEGIN SELECT RAISE(ABORT, 'Living adoption receipts are immutable'); END;
  CREATE TRIGGER immutable_living_receipt_delete BEFORE DELETE ON living_receipts
  BEGIN SELECT RAISE(ABORT, 'Living adoption receipts preserve their audit'); END;
`
