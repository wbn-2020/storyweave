// v19 仅在新建或独立备份后的显式升级事务中追加。
export const REALM_SCHEMA = `
  CREATE TABLE realm_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 262144),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
  ) STRICT;
  CREATE TABLE realm_history (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    revision INTEGER NOT NULL UNIQUE CHECK (revision > 0),
    book_revision INTEGER NOT NULL UNIQUE CHECK (book_revision > 0),
    action_json TEXT NOT NULL CHECK (length(CAST(action_json AS BLOB)) <= 270336),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 262144),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24)
  ) STRICT;
  CREATE TRIGGER immutable_realm_history_update BEFORE UPDATE ON realm_history
  BEGIN SELECT RAISE(ABORT, 'Realm history is immutable'); END;
  CREATE TRIGGER immutable_realm_history_delete BEFORE DELETE ON realm_history
  BEGIN SELECT RAISE(ABORT, 'Realm history is immutable'); END;
`
