import { MAX_FORESHADOW_THUMBNAILS, MAX_FORESHADOW_THUMBNAIL_BYTES } from '../../contracts/foreshadow-thumbnail'
import { MAX_BOOK_MEDIA_ITEM_BYTES } from '../../contracts/book-media'

// 配图和移除标记固定到故事修订；换图不覆盖原图，恢复沿用同一份追加结构。
export const FORESHADOW_THUMBNAIL_SCHEMA = `
  CREATE TABLE foreshadow_thumbnails (
    record_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    knowledge_revision INTEGER NOT NULL UNIQUE CHECK (knowledge_revision BETWEEN 1 AND 9007199254740991),
    mime TEXT,
    byte_length INTEGER,
    data_base64 TEXT,
    sha256 TEXT,
    alt TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    PRIMARY KEY (record_id, knowledge_revision),
    FOREIGN KEY (record_id, book_id) REFERENCES story_records(id, book_id),
    FOREIGN KEY (knowledge_revision) REFERENCES story_record_revisions(knowledge_revision),
    CHECK (
      (mime IS NULL AND byte_length IS NULL AND data_base64 IS NULL AND sha256 IS NULL AND alt IS NULL)
      OR (mime IS NOT NULL AND mime IN ('image/png', 'image/jpeg', 'image/webp')
        AND byte_length IS NOT NULL AND byte_length BETWEEN 4 AND ${MAX_BOOK_MEDIA_ITEM_BYTES}
        AND data_base64 IS NOT NULL AND length(CAST(data_base64 AS BLOB)) = ((byte_length + 2) / 3) * 4
        AND sha256 IS NOT NULL AND length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'
        AND alt IS NOT NULL AND length(CAST(alt AS BLOB)) <= 8000 AND instr(alt, char(0)) = 0)
    )
  ) STRICT;
  CREATE TRIGGER immutable_foreshadow_thumbnail_update BEFORE UPDATE ON foreshadow_thumbnails
  BEGIN SELECT RAISE(ABORT, 'Foreshadow thumbnails are immutable'); END;
  CREATE TRIGGER immutable_foreshadow_thumbnail_delete BEFORE DELETE ON foreshadow_thumbnails
  BEGIN SELECT RAISE(ABORT, 'Foreshadow thumbnails are immutable'); END;
  CREATE TRIGGER foreshadow_thumbnail_owner_insert BEFORE INSERT ON foreshadow_thumbnails
  WHEN NOT EXISTS (
    SELECT 1 FROM story_record_revisions r JOIN story_records s ON s.id = r.record_id
    WHERE r.record_id = NEW.record_id AND r.knowledge_revision = NEW.knowledge_revision
      AND r.created_at = NEW.created_at AND s.book_id = NEW.book_id AND s.kind = 'foreshadow'
  )
  BEGIN SELECT RAISE(ABORT, 'Thumbnail requires its original foreshadow revision'); END;
  CREATE TRIGGER foreshadow_thumbnail_budget_insert BEFORE INSERT ON foreshadow_thumbnails
  WHEN (SELECT COUNT(*) FROM foreshadow_thumbnails) >= ${MAX_FORESHADOW_THUMBNAILS * 2}
    OR (NEW.mime IS NOT NULL AND ((SELECT COUNT(mime) FROM foreshadow_thumbnails) >= ${MAX_FORESHADOW_THUMBNAILS}
      OR (SELECT COALESCE(SUM(byte_length), 0) FROM foreshadow_thumbnails) + NEW.byte_length > ${MAX_FORESHADOW_THUMBNAIL_BYTES}))
  BEGIN SELECT RAISE(ABORT, 'Foreshadow thumbnail budget exceeded'); END;
`
