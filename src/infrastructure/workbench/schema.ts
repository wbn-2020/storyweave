export const WORKBENCH_SCHEMA = `
  CREATE TABLE workbench_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL DEFAULT 0,
    premise TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '', narrator TEXT NOT NULL DEFAULT '',
    tense TEXT NOT NULL DEFAULT '', rules TEXT NOT NULL DEFAULT ''
  ) STRICT;
  INSERT INTO workbench_settings (singleton) VALUES (1);
  CREATE TABLE scene_cards (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0),
    chapter_id TEXT REFERENCES chapters(id), position INTEGER NOT NULL CHECK (position >= 0),
    fields_json TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX scene_cards_by_chapter ON scene_cards(chapter_id, position, id);
  CREATE TABLE review_issues (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0),
    chapter_id TEXT NOT NULL REFERENCES chapters(id), fields_json TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX review_issues_by_chapter ON review_issues(chapter_id, updated_at, id);
  CREATE TABLE writing_goals (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), fields_json TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE workbench_revisions (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('brief', 'scene', 'review', 'goal')),
    revision INTEGER NOT NULL, fields_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(kind, entity_id, revision)
  ) STRICT;
  CREATE TRIGGER immutable_workbench_revision_update BEFORE UPDATE ON workbench_revisions
  BEGIN SELECT RAISE(ABORT, 'Workbench revisions are immutable'); END;
  CREATE TRIGGER immutable_workbench_revision_delete BEFORE DELETE ON workbench_revisions
  BEGIN SELECT RAISE(ABORT, 'Workbench revisions are immutable'); END;
  CREATE TABLE writing_activity (
    id TEXT PRIMARY KEY, revision_id TEXT UNIQUE REFERENCES chapter_revisions(id),
    chapter_id TEXT REFERENCES chapters(id), date TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('manual', 'ai', 'import', 'restore')),
    added INTEGER NOT NULL CHECK (added >= 0), removed INTEGER NOT NULL CHECK (removed >= 0),
    minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes BETWEEN 0 AND 1440),
    revised INTEGER NOT NULL DEFAULT 0 CHECK (revised IN (0, 1)), created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX writing_activity_by_date ON writing_activity(date, source);
  CREATE TRIGGER immutable_writing_activity_update BEFORE UPDATE ON writing_activity
  BEGIN SELECT RAISE(ABORT, 'Writing activity is immutable'); END;
  CREATE TRIGGER immutable_writing_activity_delete BEFORE DELETE ON writing_activity
  BEGIN SELECT RAISE(ABORT, 'Writing activity is immutable'); END;
`

// 灵感收件箱属于整个书库，与每书正文和设定分开存储。
export const INSPIRATION_APPLICATION_ID = 0x53545749
export const INSPIRATION_SCHEMA = `
  CREATE TABLE inspirations (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), kind TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, tags_json TEXT NOT NULL,
    parent_id TEXT REFERENCES inspirations(id), book_id TEXT, archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX inspirations_by_update ON inspirations(updated_at DESC, id);
  CREATE INDEX inspirations_by_book ON inspirations(book_id, updated_at DESC, id);
  CREATE TABLE inspiration_revisions (
    id TEXT NOT NULL REFERENCES inspirations(id), revision INTEGER NOT NULL, fields_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (id, revision)
  ) STRICT;
  CREATE TRIGGER immutable_inspiration_revision_update BEFORE UPDATE ON inspiration_revisions
  BEGIN SELECT RAISE(ABORT, 'Inspiration revisions are immutable'); END;
  CREATE TRIGGER immutable_inspiration_revision_delete BEFORE DELETE ON inspiration_revisions
  BEGIN SELECT RAISE(ABORT, 'Inspiration revisions are immutable'); END;
`
