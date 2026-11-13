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

export const NOTE_CHAPTER_SCHEMA = `
  CREATE TABLE note_chapter_links (
    note_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL REFERENCES chapters(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, chapter_id),
    FOREIGN KEY (note_id, book_id) REFERENCES notes(id, book_id)
  ) STRICT;
  CREATE INDEX note_links_by_chapter ON note_chapter_links(chapter_id, note_id);
`

// v22 的素材信息独立追加；旧笔记与不可变转换快照沿用原字段。
export const NOTE_MATERIAL_SCHEMA = `
  CREATE TABLE note_materials (
    note_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (length(CAST(source AS BLOB)) <= 8000 AND instr(source, char(0)) = 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
    UNIQUE (note_id, book_id),
    FOREIGN KEY (note_id, book_id) REFERENCES notes(id, book_id)
  ) STRICT;
  CREATE TABLE note_tags (
    note_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
    tag TEXT NOT NULL CHECK (length(tag) > 0 AND length(CAST(tag AS BLOB)) <= 200 AND instr(tag, char(0)) = 0),
    PRIMARY KEY (note_id, position),
    UNIQUE (note_id, tag),
    FOREIGN KEY (note_id, book_id) REFERENCES note_materials(note_id, book_id)
  ) STRICT;
  CREATE INDEX note_tags_by_value ON note_tags(book_id, tag, note_id);
`

// 图片与移除标记均追加，后续换图不会覆盖唯一的已存原图。
export const NOTE_THUMBNAIL_SCHEMA = `
  CREATE TABLE note_thumbnails (
    note_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    note_revision INTEGER NOT NULL CHECK (note_revision BETWEEN 1 AND 9007199254740991),
    mime TEXT,
    byte_length INTEGER,
    data_base64 TEXT,
    sha256 TEXT,
    alt TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    PRIMARY KEY (note_id, note_revision),
    FOREIGN KEY (note_id, book_id) REFERENCES notes(id, book_id),
    CHECK (
      (mime IS NULL AND byte_length IS NULL AND data_base64 IS NULL AND sha256 IS NULL AND alt IS NULL)
      OR (mime IS NOT NULL AND mime IN ('image/png', 'image/jpeg', 'image/webp')
        AND byte_length IS NOT NULL AND byte_length BETWEEN 4 AND 2097152
        AND data_base64 IS NOT NULL AND length(CAST(data_base64 AS BLOB)) = ((byte_length + 2) / 3) * 4
        AND sha256 IS NOT NULL AND length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'
        AND alt IS NOT NULL AND length(CAST(alt AS BLOB)) <= 8000 AND instr(alt, char(0)) = 0)
    )
  ) STRICT;
  CREATE TRIGGER immutable_note_thumbnail_update BEFORE UPDATE ON note_thumbnails
  BEGIN SELECT RAISE(ABORT, 'Note thumbnails are immutable'); END;
  CREATE TRIGGER immutable_note_thumbnail_delete BEFORE DELETE ON note_thumbnails
  BEGIN SELECT RAISE(ABORT, 'Note thumbnails are immutable'); END;
`
