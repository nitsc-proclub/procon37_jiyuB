-- Delivery bookkeeping is deliberately separate from job execution. A queue
-- send may succeed just before a Worker crashes; a later reconciliation can
-- safely send the same job again because execution is fenced by its lease.
ALTER TABLE voicevox_jobs ADD COLUMN dispatch_lease_id TEXT;
ALTER TABLE voicevox_jobs ADD COLUMN dispatch_lease_expires_at INTEGER;
ALTER TABLE voicevox_jobs ADD COLUMN dispatched_at INTEGER;

CREATE INDEX IF NOT EXISTS voicevox_jobs_outbox
  ON voicevox_jobs (status, dispatched_at, dispatch_lease_expires_at);
