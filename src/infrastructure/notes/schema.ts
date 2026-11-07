export const NOTES_SCHEMA = `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    category TEXT NOT NULL CHECK (category IN ('inspiration', 'material', 'method')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, book_id)
  ) STRICT;
  CREATE INDEX notes_by_update ON notes(book_id, updated_at DESC, id);
  CREATE INDEX notes_by_category ON notes(book_id, category, updated_at DESC, id);
  CREATE TABLE note_promotions (
    note_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    item_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('person', 'place', 'organization', 'object', 'rule', 'theme', 'other')),
    note_revision INTEGER NOT NULL CHECK (note_revision BETWEEN 1 AND 9007199254740991),
    fields_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (note_id, book_id) REFERENCES notes(id, book_id),
    FOREIGN KEY (item_id, book_id) REFERENCES knowledge_items(id, book_id)
  ) STRICT;
  CREATE TRIGGER immutable_note_promotion_update BEFORE UPDATE ON note_promotions
  BEGIN SELECT RAISE(ABORT, 'Note promotions are immutable'); END;
  CREATE TRIGGER immutable_note_promotion_delete BEFORE DELETE ON note_promotions
  BEGIN SELECT RAISE(ABORT, 'Note promotions are immutable'); END;
`
