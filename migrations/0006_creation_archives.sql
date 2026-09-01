CREATE TABLE IF NOT EXISTS creation_archive_quota (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  CHECK (reserved_bytes + used_bytes <= 8000000000)
);
INSERT OR IGNORE INTO creation_archive_quota (singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS creation_archives (
  archive_id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL UNIQUE,
  consent_version TEXT NOT NULL CHECK (consent_version = 'creation-archive-v1'),
  provenance TEXT NOT NULL CHECK (provenance IN ('model-verified', 'client-uploaded')),
  status TEXT NOT NULL CHECK (status IN ('pending','complete','deleting','deleted','failed')),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes BETWEEN 0 AND 75497472),
  uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes BETWEEN 0 AND 75497472),
  created_at INTEGER NOT NULL, pending_expires_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  delete_capability_hash TEXT NOT NULL, upload_capability_hash TEXT NOT NULL,
  manifest_hash TEXT, deleted_at INTEGER,
  active_uploads INTEGER NOT NULL DEFAULT 0 CHECK (active_uploads >= 0),
  upload_lease_expires_at INTEGER,
  CHECK (pending_expires_at > created_at), CHECK (expires_at > created_at)
);
CREATE TABLE IF NOT EXISTS creation_archive_assets (
  archive_id TEXT NOT NULL REFERENCES creation_archives(archive_id),
  asset_name TEXT NOT NULL CHECK (asset_name IN ('input-image','drawing-json','candidate-a-json','candidate-b-json','candidate-a-wav','candidate-b-wav','manifest')),
  r2_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  expected_content_sha256 TEXT,
  upload_token TEXT,
  upload_expires_at INTEGER,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (archive_id, asset_name)
);
CREATE INDEX IF NOT EXISTS creation_archives_pending_expiry ON creation_archives(status, pending_expires_at);
CREATE INDEX IF NOT EXISTS creation_archives_expiry ON creation_archives(status, expires_at);
CREATE TABLE IF NOT EXISTS creation_archive_uploads (
  archive_id TEXT NOT NULL REFERENCES creation_archives(archive_id),
  asset_name TEXT NOT NULL,
  token TEXT PRIMARY KEY NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS creation_archive_uploads_archive ON creation_archive_uploads(archive_id);

-- Quota changes live in the same SQLite transaction as the owning record.
-- The quota CHECK aborts the entire insert/batch, not just a conditional UPDATE.
CREATE TRIGGER IF NOT EXISTS creation_archive_quota_insert AFTER INSERT ON creation_archives
BEGIN
  UPDATE creation_archive_quota SET reserved_bytes=reserved_bytes+NEW.reserved_bytes,
    used_bytes=used_bytes+NEW.uploaded_bytes WHERE singleton=1;
END;
CREATE TRIGGER IF NOT EXISTS creation_archive_quota_update AFTER UPDATE OF reserved_bytes,uploaded_bytes ON creation_archives
BEGIN
  UPDATE creation_archive_quota SET reserved_bytes=reserved_bytes+NEW.reserved_bytes-OLD.reserved_bytes,
    used_bytes=used_bytes+NEW.uploaded_bytes-OLD.uploaded_bytes WHERE singleton=1;
END;

-- A deletion leaves the archive row as a tombstone.  Do not permit a delayed
-- evaluation POST to recreate the cloud record after the user chose deletion.
CREATE TRIGGER IF NOT EXISTS reject_evaluation_for_deleted_archive
BEFORE INSERT ON evaluation_records
WHEN EXISTS (
  SELECT 1 FROM creation_archives
  WHERE generation_id = NEW.generation_id AND status IN ('deleting', 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'creation archive was deleted');
END;
