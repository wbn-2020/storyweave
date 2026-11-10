// 由作品 v14 创建或显式备份升级事务执行；读取预设不会隐式迁移。
export const AI_PRESETS_SCHEMA = `
  CREATE TABLE ai_presets (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('plan', 'continue', 'rewrite', 'review', 'study')),
    default_for_task INTEGER NOT NULL CHECK (default_for_task IN (0, 1)),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 32768),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
    CHECK (archived = 0 OR default_for_task = 0)
  ) STRICT;
  CREATE UNIQUE INDEX ai_presets_one_default ON ai_presets(kind) WHERE default_for_task = 1 AND archived = 0;
  CREATE TABLE ai_preset_history (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    preset_id TEXT NOT NULL REFERENCES ai_presets(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    book_revision INTEGER NOT NULL CHECK (book_revision > 0),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 32768),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    UNIQUE(preset_id, revision)
  ) STRICT;
  CREATE TRIGGER immutable_ai_preset_history_update BEFORE UPDATE ON ai_preset_history
  BEGIN SELECT RAISE(ABORT, 'AI preset history is immutable'); END;
  CREATE TRIGGER immutable_ai_preset_history_delete BEFORE DELETE ON ai_preset_history
  BEGIN SELECT RAISE(ABORT, 'AI preset history is immutable'); END;
`
