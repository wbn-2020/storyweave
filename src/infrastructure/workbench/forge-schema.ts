export const FORGE_SCHEMA = `
  CREATE TABLE forge_runs (
    run_id TEXT PRIMARY KEY REFERENCES ai_runs(id),
    kind TEXT NOT NULL CHECK (kind IN ('names', 'cast', 'fill', 'extract', 'world', 'relations', 'audition')),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER immutable_forge_run_update BEFORE UPDATE ON forge_runs
  BEGIN SELECT RAISE(ABORT, 'Forge sources are immutable'); END;
  CREATE TRIGGER immutable_forge_run_delete BEFORE DELETE ON forge_runs
  BEGIN SELECT RAISE(ABORT, 'Forge sources preserve their audit'); END;
  CREATE TABLE forge_receipts (
    run_id TEXT PRIMARY KEY REFERENCES forge_runs(run_id),
    accepted_json TEXT NOT NULL CHECK (json_valid(accepted_json)),
    refs_json TEXT NOT NULL CHECK (json_valid(refs_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER immutable_forge_receipt_update BEFORE UPDATE ON forge_receipts
  BEGIN SELECT RAISE(ABORT, 'Forge receipts are immutable'); END;
  CREATE TRIGGER immutable_forge_receipt_delete BEFORE DELETE ON forge_receipts
  BEGIN SELECT RAISE(ABORT, 'Forge receipts preserve their audit'); END;
`
