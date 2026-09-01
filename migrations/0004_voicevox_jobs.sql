-- Asynchronous public VOICEVOX jobs. All timestamps are Unix milliseconds.
-- Registration must create the group, its candidate-a/candidate-b jobs, and
-- their payloads in one D1 batch. The UNIQUE constraints make retries
-- idempotent; the batch is responsible for requiring both candidates.
CREATE TABLE IF NOT EXISTS voicevox_job_groups (
  group_id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (
    status IN ('accepted', 'queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (expires_at > created_at),
  UNIQUE (group_id, generation_id)
);

CREATE TABLE IF NOT EXISTS voicevox_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL CHECK (candidate_id IN ('candidate-a', 'candidate-b')),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key = generation_id || ':' || candidate_id
  ),
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (
    status IN ('accepted', 'queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  backend TEXT CHECK (backend IS NULL OR backend IN ('vpc', 'cloud-run')),
  -- The backend-pool Durable Object is the active-lease authority. These
  -- fields fence stale consumers when D1 status is updated afterwards.
  current_lease_id TEXT,
  current_lease_expires_at INTEGER,
  result_ref TEXT,
  result_expires_at INTEGER,
  error_code TEXT,
  error_retryable INTEGER CHECK (error_retryable IS NULL OR error_retryable IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (group_id, generation_id)
    REFERENCES voicevox_job_groups (group_id, generation_id)
    ON DELETE CASCADE,
  CHECK (attempt <= max_attempts),
  CHECK (updated_at >= created_at),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'running') = (
      current_lease_id IS NOT NULL AND current_lease_expires_at IS NOT NULL
    )
  ),
  CHECK (
    current_lease_expires_at IS NULL OR (
      current_lease_expires_at > created_at AND current_lease_expires_at <= expires_at
    )
  ),
  CHECK (
    (result_ref IS NULL AND result_expires_at IS NULL) OR
    (length(trim(result_ref)) > 0 AND result_expires_at > created_at AND result_expires_at <= expires_at)
  ),
  CHECK (
    (error_code IS NULL AND error_retryable IS NULL) OR
    (length(trim(error_code)) > 0 AND error_retryable IS NOT NULL)
  ),
  UNIQUE (generation_id, candidate_id),
  UNIQUE (group_id, candidate_id)
);

-- SingingScore includes lyrics, so keep it separate from job status reads and
-- delete it when its short retention window expires. payloadRef is job_id.
CREATE TABLE IF NOT EXISTS voicevox_job_payloads (
  job_id TEXT PRIMARY KEY NOT NULL,
  score_json TEXT NOT NULL CHECK (length(trim(score_json)) > 0),
  score_hash TEXT NOT NULL CHECK (length(trim(score_hash)) > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES voicevox_jobs (job_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS voicevox_job_groups_expiry
  ON voicevox_job_groups (expires_at);

CREATE INDEX IF NOT EXISTS voicevox_jobs_group_candidate
  ON voicevox_jobs (group_id, candidate_id);

CREATE INDEX IF NOT EXISTS voicevox_jobs_dispatch
  ON voicevox_jobs (status, updated_at);

CREATE INDEX IF NOT EXISTS voicevox_jobs_expiry
  ON voicevox_jobs (expires_at);

CREATE INDEX IF NOT EXISTS voicevox_jobs_running_lease_expiry
  ON voicevox_jobs (current_lease_expires_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS voicevox_job_payloads_expiry
  ON voicevox_job_payloads (expires_at);
