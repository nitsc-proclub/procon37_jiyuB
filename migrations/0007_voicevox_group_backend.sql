-- Route an entire A/B generation to one backend before it reaches a Queue.
-- Existing groups are conservatively VPC; new groups choose Cloud Run only
-- when at least two other, unexpired generations are still unfinished.
ALTER TABLE voicevox_job_groups ADD COLUMN preferred_backend TEXT NOT NULL DEFAULT 'vpc'
  CHECK (preferred_backend IN ('vpc', 'cloud-run'));

-- Jobs created before backend routing was introduced must remain on the
-- original VPC path, including queued retries recovered after deployment.
UPDATE voicevox_jobs SET backend = 'vpc' WHERE backend IS NULL;

CREATE INDEX IF NOT EXISTS voicevox_jobs_active_generation
  ON voicevox_jobs (status, expires_at, generation_id);
