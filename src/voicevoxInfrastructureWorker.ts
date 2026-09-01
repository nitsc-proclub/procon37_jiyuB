import { WorkerEntrypoint } from "cloudflare:workers";
import {
  getVoicevoxBackendPool,
  type VoicevoxBackendLeaseAcquireRequest,
  type VoicevoxBackendLeaseAcquireResult,
  type VoicevoxBackendLeaseReleaseRequest,
  type VoicevoxBackendPoolSnapshot,
} from "./voicevoxBackendPool";
import { consumeVoicevoxJob, type VoicevoxJobQueueMessage } from "./voicevoxJobConsumer";
import { recoverExpiredVoicevoxJobs, purgeExpiredVoicevoxJobPayloads } from "./voicevoxJobLifecycle";
import { dispatchVoicevoxJobs, voicevoxDispatchRepository } from "./voicevoxJobDispatcher";
import { cleanupExpiredTemporaryVoicevoxAudio } from "./voicevoxTemporaryAudio";

export { VoicevoxBackendPool } from "./voicevoxBackendPool";

/**
 * Internal service-binding RPC entrypoint. It intentionally has no HTTP API:
 * the parent Worker reaches it through a Service Binding, and it in turn uses a
 * deterministic Durable Object name for each backend pool.
 */
export class VoicevoxInfrastructureWorker extends WorkerEntrypoint<InfrastructureEnv> {
  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  }

  async acquireBackendLease(request: VoicevoxBackendLeaseAcquireRequest): Promise<VoicevoxBackendLeaseAcquireResult> {
    return getVoicevoxBackendPool(this.env, request.backend).acquire(request);
  }

  async releaseBackendLease(request: VoicevoxBackendLeaseReleaseRequest): Promise<{ released: boolean }> {
    return getVoicevoxBackendPool(this.env, request.backend).release(request);
  }

  async snapshotBackendPool(
    request: { backend: VoicevoxBackendLeaseAcquireRequest["backend"] },
  ): Promise<VoicevoxBackendPoolSnapshot> {
    return getVoicevoxBackendPool(this.env, request.backend).snapshot();
  }
}

export default {
  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  },
  async queue(batch: MessageBatch<VoicevoxJobQueueMessage>, env: InfrastructureEnv): Promise<void> {
    // Wrangler consumer max_concurrency=1 is the primary bound; preserve it
    // here as well by handling one queued job at a time.
    for (const message of batch.messages) {
      const outcome = await consumeVoicevoxJob(message.body, {
        ...env,
        VOICEVOX_BACKEND_POOL: {
          acquire: (request) => getVoicevoxBackendPool(env, request.backend).acquire(request),
          release: (request) => getVoicevoxBackendPool(env, request.backend).release(request),
        },
      }, "vpc");
      if (outcome === "ack") message.ack();
      else message.retry();
    }
  },
  async scheduled(_event: ScheduledEvent, env: InfrastructureEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const now = Date.now(); await recoverExpiredVoicevoxJobs(env.EVALUATIONS_DB, { now, limit: 100 });
      await dispatchVoicevoxJobs(voicevoxDispatchRepository(env.EVALUATIONS_DB), {
        vpc: { send: async (message) => { await env.VOICEVOX_JOBS.send(message); } },
        "cloud-run": { send: async (message) => { await env.VOICEVOX_CLOUD_RUN_JOBS.send(message); } },
      }, { limit: 20 });
      await purgeExpiredVoicevoxJobPayloads(env.EVALUATIONS_DB, { now, limit: 100 });
      await cleanupExpiredTemporaryVoicevoxAudio(env.TEMPORARY_AUDIO, { now, objectBudget: 100 });
    })());
  },
};
