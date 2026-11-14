function presetTables(suffix: '' | '_v25', summary: boolean): string {
  return `
  CREATE TABLE ai_presets${suffix} (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('plan', 'continue', 'rewrite', 'review', 'study'${summary ? ", 'summarize'" : ''})),
    default_for_task INTEGER NOT NULL CHECK (default_for_task IN (0, 1)),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 32768),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
    CHECK (archived = 0 OR default_for_task = 0)
  ) STRICT;
  CREATE TABLE ai_preset_history${suffix} (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    preset_id TEXT NOT NULL REFERENCES ai_presets${suffix}(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    book_revision INTEGER NOT NULL CHECK (book_revision > 0),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 32768),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    UNIQUE(preset_id, revision)
  ) STRICT;
`
}

const PRESET_PROTECTION = `
  CREATE UNIQUE INDEX ai_presets_one_default ON ai_presets(kind) WHERE default_for_task = 1 AND archived = 0;
  CREATE TRIGGER immutable_ai_preset_history_update BEFORE UPDATE ON ai_preset_history
  BEGIN SELECT RAISE(ABORT, 'AI preset history is immutable'); END;
  CREATE TRIGGER immutable_ai_preset_history_delete BEFORE DELETE ON ai_preset_history
  BEGIN SELECT RAISE(ABORT, 'AI preset history is immutable'); END;
`

// 历史恢复包始终按其原五类结构核对；读取不升级作品。
export const AI_PRESETS_V14_SCHEMA = `${presetTables('', false)}${PRESET_PROTECTION}`
export const AI_PRESETS_SCHEMA = `${presetTables('', true)}${PRESET_PROTECTION}`

// 仅在已有独立备份的作品升级事务内执行；先复制两表的全部原值，再按外键顺序替换。
export const AI_PRESETS_V25_UPGRADE = `
  ${presetTables('_v25', true)}
  INSERT INTO ai_presets_v25 (id, revision, kind, default_for_task, archived, fields_json, updated_at)
    SELECT id, revision, kind, default_for_task, archived, fields_json, updated_at FROM ai_presets;
  INSERT INTO ai_preset_history_v25 (id, preset_id, revision, book_revision, fields_json, created_at)
    SELECT id, preset_id, revision, book_revision, fields_json, created_at FROM ai_preset_history;
  DROP TABLE ai_preset_history;
  DROP TABLE ai_presets;
  ALTER TABLE ai_presets_v25 RENAME TO ai_presets;
  ALTER TABLE ai_preset_history_v25 RENAME TO ai_preset_history;
  ${PRESET_PROTECTION}
`
