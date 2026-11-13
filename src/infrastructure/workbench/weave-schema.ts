// v18 仅由新建或已完成备份的升级事务执行；只读入口不建表。
export const WEAVE_SCHEMA = `
  CREATE TABLE weave_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 262144),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
  ) STRICT;
  CREATE TABLE weave_history (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    revision INTEGER NOT NULL UNIQUE CHECK (revision > 0),
    book_revision INTEGER NOT NULL UNIQUE CHECK (book_revision > 0),
    action_json TEXT NOT NULL CHECK (length(CAST(action_json AS BLOB)) <= 270336),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 262144),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24)
  ) STRICT;
  CREATE TRIGGER immutable_weave_history_update BEFORE UPDATE ON weave_history
  BEGIN SELECT RAISE(ABORT, 'Weave history is immutable'); END;
  CREATE TRIGGER immutable_weave_history_delete BEFORE DELETE ON weave_history
  BEGIN SELECT RAISE(ABORT, 'Weave history is immutable'); END;
`
