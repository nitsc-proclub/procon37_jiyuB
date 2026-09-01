import { DurableObject } from "cloudflare:workers";

export const VOICEVOX_BACKENDS = ["vpc", "cloud-run"] as const;
export type VoicevoxBackend = (typeof VOICEVOX_BACKENDS)[number];

const DEFAULT_LEASE_TTL_MS = 300_000;
const MAX_LEASE_TTL_MS = 300_000;
const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface VoicevoxBackendLeaseAcquireRequest {
  backend: VoicevoxBackend;
  jobId: string;
  generationId: string;
  attempt: number;
  /** Defaults to five minutes and is capped at five minutes. */
  ttlMs?: number;
}

export interface VoicevoxBackendLeaseReleaseRequest {
  backend: VoicevoxBackend;
  jobId: string;
  generationId: string;
  attempt: number;
  leaseId: string;
}

export interface VoicevoxBackendLease {
  backend: VoicevoxBackend;
  jobId: string;
  generationId: string;
  attempt: number;
  leaseId: string;
  acquiredAt: number;
  expiresAt: number;
}

export type VoicevoxBackendLeaseAcquireResult =
  | { granted: true; reused: boolean; lease: VoicevoxBackendLease }
  | { granted: false; retryAfterMs: number };

export interface VoicevoxBackendPoolSnapshot {
  backend: VoicevoxBackend | null;
  capacity: number;
  activeLeases: VoicevoxBackendLease[];
}

type LeaseRow = {
  job_id: string;
  generation_id: string;
  attempt: number;
  lease_id: string;
  acquired_at: number;
  expires_at: number;
};

type BackendRow = { value: string };
type CountRow = { count: number };
type ExpiryRow = { expires_at: number };

export class VoicevoxBackendPoolError extends Error {
  constructor(
    public readonly code: "invalid-input" | "backend-pool-mismatch" | "backend-lease-fence-conflict",
    message: string,
  ) {
    super(message);
    this.name = "VoicevoxBackendPoolError";
  }
}

export function voicevoxBackendPoolName(backend: VoicevoxBackend): string {
  assertBackend(backend);
  return `voicevox-backend-pool:v1:${backend}`;
}

export function getVoicevoxBackendPool(
  env: Pick<InfrastructureEnv, "VOICEVOX_BACKEND_POOL">,
  backend: VoicevoxBackend,
): DurableObjectStub<VoicevoxBackendPool> {
  return env.VOICEVOX_BACKEND_POOL.getByName(voicevoxBackendPoolName(backend));
}

/**
 * One deterministic object per physical backend serializes its capacity checks.
 * It never calls the backend: a lease expiry frees scheduling capacity only. A
 * caller must still fence its D1 completion/update with this lease id and attempt,
 * because an expired consumer can finish backend work after its slot was released.
 */
export class VoicevoxBackendPool extends DurableObject<InfrastructureEnv> {
  constructor(ctx: DurableObjectState, env: InfrastructureEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS voicevox_backend_pool_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS voicevox_backend_pool_leases (
          job_id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          lease_id TEXT NOT NULL UNIQUE,
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at)
        );
        CREATE INDEX IF NOT EXISTS voicevox_backend_pool_leases_expires_at
          ON voicevox_backend_pool_leases (expires_at);
      `);
    });
  }

  acquire(request: VoicevoxBackendLeaseAcquireRequest): VoicevoxBackendLeaseAcquireResult {
    const input = parseAcquireRequest(request);
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      this.configureBackend(input.backend);
      this.releaseExpiredLeases(now);

      const existing = this.findLease(input.jobId);
      if (existing) {
        if (existing.generation_id !== input.generationId || existing.attempt !== input.attempt) {
          throw new VoicevoxBackendPoolError(
            "backend-lease-fence-conflict",
            "The job already has an active lease for another generation or attempt.",
          );
        }
        return { granted: true, reused: true, lease: toLease(input.backend, existing) };
      }

      const capacity = this.capacityFor(input.backend);
      const active = this.ctx.storage.sql
        .exec<CountRow>("SELECT COUNT(*) AS count FROM voicevox_backend_pool_leases")
        .one().count;
      if (active >= capacity) {
        const earliestExpiry = this.ctx.storage.sql
          .exec<ExpiryRow>("SELECT expires_at FROM voicevox_backend_pool_leases ORDER BY expires_at ASC LIMIT 1")
          .one().expires_at;
        return { granted: false, retryAfterMs: Math.max(1, earliestExpiry - now) };
      }

      const row: LeaseRow = {
        job_id: input.jobId,
        generation_id: input.generationId,
        attempt: input.attempt,
        lease_id: crypto.randomUUID(),
        acquired_at: now,
        expires_at: now + input.ttlMs,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO voicevox_backend_pool_leases
          (job_id, generation_id, attempt, lease_id, acquired_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        row.job_id,
        row.generation_id,
        row.attempt,
        row.lease_id,
        row.acquired_at,
        row.expires_at,
      );
      return { granted: true, reused: false, lease: toLease(input.backend, row) };
    });
  }

  release(request: VoicevoxBackendLeaseReleaseRequest): { released: boolean } {
    const input = parseReleaseRequest(request);
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      this.configureBackend(input.backend);
      this.releaseExpiredLeases(now);
      const existing = this.findLease(input.jobId);
      if (
        !existing ||
        existing.generation_id !== input.generationId ||
        existing.attempt !== input.attempt ||
        existing.lease_id !== input.leaseId
      ) {
        return { released: false };
      }
      this.ctx.storage.sql.exec("DELETE FROM voicevox_backend_pool_leases WHERE job_id = ?", input.jobId);
      return { released: true };
    });
  }

  snapshot(): VoicevoxBackendPoolSnapshot {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      this.releaseExpiredLeases(now);
      const backendRow = this.ctx.storage.sql
        .exec<BackendRow>("SELECT value FROM voicevox_backend_pool_metadata WHERE key = 'backend'")
        .toArray()[0];
      const backend = backendRow ? parseStoredBackend(backendRow.value) : null;
      const activeLeases = this.ctx.storage.sql
        .exec<LeaseRow>(
          `SELECT job_id, generation_id, attempt, lease_id, acquired_at, expires_at
           FROM voicevox_backend_pool_leases ORDER BY acquired_at ASC, job_id ASC`,
        )
        .toArray()
        .map((row) => toLease(backend ?? null, row));
      return {
        backend: backend ?? null,
        capacity: backend ? this.capacityFor(backend) : 0,
        activeLeases,
      };
    });
  }

  private configureBackend(backend: VoicevoxBackend): void {
    const row = this.ctx.storage.sql
      .exec<BackendRow>("SELECT value FROM voicevox_backend_pool_metadata WHERE key = 'backend'")
      .toArray()[0];
    if (!row) {
      this.ctx.storage.sql.exec(
        "INSERT INTO voicevox_backend_pool_metadata (key, value) VALUES ('backend', ?)",
        backend,
      );
      return;
    }
    if (row.value !== backend) {
      throw new VoicevoxBackendPoolError("backend-pool-mismatch", "This Durable Object belongs to another backend.");
    }
  }

  private capacityFor(backend: VoicevoxBackend): number {
    return parseCapacity(backend === "vpc" ? this.env.VPC_CAPACITY : this.env.CLOUD_RUN_CAPACITY, backend);
  }

  private releaseExpiredLeases(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM voicevox_backend_pool_leases WHERE expires_at <= ?", now);
  }

  private findLease(jobId: string): LeaseRow | undefined {
    return this.ctx.storage.sql
      .exec<LeaseRow>(
        `SELECT job_id, generation_id, attempt, lease_id, acquired_at, expires_at
         FROM voicevox_backend_pool_leases WHERE job_id = ?`,
        jobId,
      )
      .toArray()[0];
  }
}

function parseAcquireRequest(request: VoicevoxBackendLeaseAcquireRequest): Required<VoicevoxBackendLeaseAcquireRequest> {
  const base = parseLeaseIdentity(request);
  const ttlMs = request.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new VoicevoxBackendPoolError("invalid-input", "ttlMs must be an integer between 1 and 300000.");
  }
  return { ...base, ttlMs };
}

function parseReleaseRequest(request: VoicevoxBackendLeaseReleaseRequest): VoicevoxBackendLeaseReleaseRequest {
  const base = parseLeaseIdentity(request);
  assertId("leaseId", request.leaseId);
  return { ...base, leaseId: request.leaseId };
}

function parseLeaseIdentity(request: {
  backend: VoicevoxBackend;
  jobId: string;
  generationId: string;
  attempt: number;
}): Omit<VoicevoxBackendLeaseAcquireRequest, "ttlMs"> {
  assertBackend(request.backend);
  assertId("jobId", request.jobId);
  assertId("generationId", request.generationId);
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1 || request.attempt > 1_000_000) {
    throw new VoicevoxBackendPoolError("invalid-input", "attempt must be a positive safe integer.");
  }
  return request;
}

function assertBackend(backend: unknown): asserts backend is VoicevoxBackend {
  if (!isVoicevoxBackend(backend)) {
    throw new VoicevoxBackendPoolError("invalid-input", "backend must be vpc or cloud-run.");
  }
}

function isVoicevoxBackend(value: unknown): value is VoicevoxBackend {
  return typeof value === "string" && (VOICEVOX_BACKENDS as readonly string[]).includes(value);
}

function assertId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    throw new VoicevoxBackendPoolError("invalid-input", `${label} has an invalid format or length.`);
  }
}

function parseCapacity(value: unknown, backend: VoicevoxBackend): number {
  if (backend === "vpc") {
    if (value === "1") return 1;
    throw new VoicevoxBackendPoolError(
      "backend-pool-mismatch",
      "vpc capacity must be configured as the fixed value '1'.",
    );
  }

  const capacity = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 3) {
    throw new VoicevoxBackendPoolError(
      "backend-pool-mismatch",
      "cloud-run capacity must be configured as an integer from '1' through '3'.",
    );
  }
  return capacity;
}

function parseStoredBackend(value: string): VoicevoxBackend {
  if (!isVoicevoxBackend(value)) {
    throw new VoicevoxBackendPoolError("backend-pool-mismatch", "Stored backend pool metadata is invalid.");
  }
  return value;
}

function toLease(backend: VoicevoxBackend | null, row: LeaseRow): VoicevoxBackendLease {
  if (!backend) {
    throw new VoicevoxBackendPoolError("backend-pool-mismatch", "A lease exists without backend metadata.");
  }
  return {
    backend,
    jobId: row.job_id,
    generationId: row.generation_id,
    attempt: row.attempt,
    leaseId: row.lease_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}
