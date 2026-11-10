import { MAX_BOOK_MEDIA_BASE64_LENGTH, MAX_BOOK_MEDIA_BYTES, MAX_BOOK_MEDIA_ITEM_BYTES, MAX_BOOK_MEDIA_ITEMS } from '../../contracts/book-media'

// 由单书 v14 新建 / 备份升级事务执行；读取素材不隐式建表。
export const MEDIA_SCHEMA = `
  CREATE TABLE book_media (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    book_revision INTEGER NOT NULL UNIQUE CHECK (book_revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('cover', 'portrait')),
    person_id TEXT REFERENCES knowledge_items(id),
    title TEXT NOT NULL CHECK (length(title) > 0 AND length(CAST(title AS BLOB)) <= 480),
    alt TEXT NOT NULL CHECK (length(CAST(alt AS BLOB)) <= 8000),
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 4 AND ${MAX_BOOK_MEDIA_ITEM_BYTES}),
    data_base64 TEXT NOT NULL CHECK (length(CAST(data_base64 AS BLOB)) = ((byte_length + 2) / 3) * 4 AND length(data_base64) <= ${MAX_BOOK_MEDIA_BASE64_LENGTH}),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    CHECK ((kind = 'cover' AND person_id IS NULL) OR (kind = 'portrait' AND person_id IS NOT NULL))
  ) STRICT;
  CREATE INDEX book_media_by_kind ON book_media(kind, person_id, book_revision DESC);
  CREATE TRIGGER immutable_book_media_update BEFORE UPDATE ON book_media
  BEGIN SELECT RAISE(ABORT, 'Book media is immutable'); END;
  CREATE TRIGGER immutable_book_media_delete BEFORE DELETE ON book_media
  BEGIN SELECT RAISE(ABORT, 'Book media is immutable'); END;
  CREATE TRIGGER book_media_person_insert BEFORE INSERT ON book_media
  WHEN NEW.kind = 'portrait' AND NOT EXISTS (
    SELECT 1 FROM knowledge_items WHERE id = NEW.person_id AND kind = 'person'
      AND book_id = (SELECT id FROM book_meta WHERE singleton = 1)
  )
  BEGIN SELECT RAISE(ABORT, 'Portrait requires a person in this book'); END;
  CREATE TRIGGER book_media_preserve_person BEFORE UPDATE OF id, kind, book_id ON knowledge_items
  WHEN (NEW.id != OLD.id OR NEW.kind != 'person' OR NEW.book_id != OLD.book_id)
    AND EXISTS (SELECT 1 FROM book_media WHERE person_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'Person is referenced by immutable book media'); END;
  CREATE TRIGGER book_media_budget_insert BEFORE INSERT ON book_media
  WHEN (SELECT COUNT(*) FROM book_media) >= ${MAX_BOOK_MEDIA_ITEMS}
    OR (SELECT COALESCE(SUM(byte_length), 0) FROM book_media) + NEW.byte_length > ${MAX_BOOK_MEDIA_BYTES}
  BEGIN SELECT RAISE(ABORT, 'Book media budget exceeded'); END;
`
