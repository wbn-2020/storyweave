// 由作品 v14 的创建/备份升级事务执行；读取日历不隐式创建表。
export const CALENDAR_SCHEMA = `
  CREATE TABLE calendar_entries (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    revision INTEGER NOT NULL CHECK (revision > 0),
    date TEXT NOT NULL CHECK (length(date) = 10),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 16384),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
  ) STRICT;
  CREATE INDEX calendar_entries_by_date ON calendar_entries(date, id);
  CREATE TABLE calendar_entry_history (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    entry_id TEXT NOT NULL REFERENCES calendar_entries(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    book_revision INTEGER NOT NULL UNIQUE CHECK (book_revision > 0),
    fields_json TEXT NOT NULL CHECK (length(CAST(fields_json AS BLOB)) <= 16384),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    UNIQUE(entry_id, revision)
  ) STRICT;
  CREATE TRIGGER immutable_calendar_history_update BEFORE UPDATE ON calendar_entry_history
  BEGIN SELECT RAISE(ABORT, 'Calendar history is immutable'); END;
  CREATE TRIGGER immutable_calendar_history_delete BEFORE DELETE ON calendar_entry_history
  BEGIN SELECT RAISE(ABORT, 'Calendar history is immutable'); END;
`
