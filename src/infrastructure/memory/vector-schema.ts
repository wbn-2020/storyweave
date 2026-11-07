/** 作品 v10 追加独立向量批次；正文、本地发布批次与原始事件保持各自进度。 */
export const MEMORY_VECTOR_SCHEMA = `
  CREATE TABLE memory_vector_profiles (
    profile_hash TEXT PRIMARY KEY CHECK (length(profile_hash) = 64),
    response_model TEXT NOT NULL CHECK (length(response_model) BETWEEN 1 AND 200),
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE memory_vector_runs (
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    book_id TEXT NOT NULL REFERENCES book_meta(id),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
    state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    kind TEXT NOT NULL CHECK (kind IN ('index', 'search')),
    publication_version INTEGER NOT NULL REFERENCES memory_publications(version),
    connection_id TEXT NOT NULL,
    connection_name TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 64),
    input_count INTEGER NOT NULL CHECK (input_count BETWEEN 1 AND 8),
    context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
    context_integrity_hash TEXT NOT NULL CHECK (length(context_integrity_hash) = 64),
    context_json TEXT NOT NULL,
    result_json TEXT,
    result_integrity_hash TEXT CHECK (result_integrity_hash IS NULL OR length(result_integrity_hash) = 64),
    usage_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (connection_id, book_id) REFERENCES ai_connections(id, book_id),
    CHECK (kind != 'search' OR input_count = 1),
    CHECK ((kind = 'search' AND state = 'succeeded') = (result_json IS NOT NULL)),
    CHECK ((result_json IS NULL) = (result_integrity_hash IS NULL)),
    CHECK (state = 'succeeded' OR usage_json IS NULL)
  ) STRICT;
  CREATE INDEX memory_vector_recent ON memory_vector_runs(book_id, sequence DESC);
  CREATE UNIQUE INDEX memory_vector_one_running ON memory_vector_runs(book_id) WHERE state = 'running';
  CREATE UNIQUE INDEX memory_vector_pending_context ON memory_vector_runs(context_hash) WHERE state IN ('prepared', 'running');
  CREATE TABLE memory_vectors (
    profile_hash TEXT NOT NULL REFERENCES memory_vector_profiles(profile_hash),
    chunk_id INTEGER NOT NULL REFERENCES memory_chunks(id),
    text_hash TEXT NOT NULL CHECK (length(text_hash) = 64),
    vector_json TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES memory_vector_runs(id),
    PRIMARY KEY (profile_hash, chunk_id)
  ) STRICT;
  CREATE TRIGGER immutable_memory_vector_context BEFORE UPDATE OF book_id, kind, publication_version,
    connection_id, connection_name, embedding_model, profile_hash, input_count,
    context_hash, context_integrity_hash, context_json, created_at ON memory_vector_runs
  BEGIN SELECT RAISE(ABORT, 'Vector request context is immutable'); END;
  CREATE TRIGGER immutable_memory_vector_profile_update BEFORE UPDATE ON memory_vector_profiles
  BEGIN SELECT RAISE(ABORT, 'Vector profiles are immutable'); END;
  CREATE TRIGGER immutable_memory_vector_profile_delete BEFORE DELETE ON memory_vector_profiles
  BEGIN SELECT RAISE(ABORT, 'Vector profiles are immutable'); END;
  CREATE TRIGGER immutable_memory_vector_update BEFORE UPDATE ON memory_vectors
  BEGIN SELECT RAISE(ABORT, 'Vector cache is immutable'); END;
  CREATE TRIGGER immutable_memory_vector_delete BEFORE DELETE ON memory_vectors
  BEGIN SELECT RAISE(ABORT, 'Vector cache is immutable'); END;
`
