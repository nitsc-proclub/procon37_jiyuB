CREATE TABLE IF NOT EXISTS evaluation_records (
  generation_id TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'excluded')),
  central_consent TEXT NOT NULL CHECK (central_consent = 'accepted'),
  evaluation_json TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  exclusion_reason TEXT
);

CREATE INDEX IF NOT EXISTS evaluation_records_status_created_at
  ON evaluation_records (status, created_at);
