CREATE TABLE IF NOT EXISTS voicevox_grants (
  grant_hash TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL,
  candidate_id TEXT CHECK (candidate_id IS NULL OR candidate_id IN ('candidate-a', 'candidate-b')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  score_hash TEXT,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS voicevox_grants_expiry
  ON voicevox_grants (expires_at);
