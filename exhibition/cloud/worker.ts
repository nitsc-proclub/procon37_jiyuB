import { parseSingingScore } from '../../src/voicevoxBackend';
import type { VoicevoxPoolServiceRpc } from '../../src/voicevoxJobConsumer';
type GatewayEnv = Omit<ExhibitionCloudEnv, 'VOICEVOX_INFRASTRUCTURE'> & { VOICEVOX_INFRASTRUCTURE: VoicevoxPoolServiceRpc };

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function digest(value: string) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
async function authorized(request: Request, secret: string) {
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get('Authorization') ?? '';
  if (supplied.length > 256) return false;
  const a = await digest(supplied), b = await digest(`Bearer ${secret}`);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function bounded(request: Request | Response, limit: number) {
  if (!request.body) throw new Error('missing-body');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; count += value.length; if (count > limit) { await reader.cancel(); throw new Error('body-too-large'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; } return bytes;
}

// A separately deployed, authenticated gateway. Public UI/Worker and its A/B jobs stay untouched.
// The durable exhibition queue lives on the local PC; the existing infrastructure supplies shared leases.
export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    if (!await authorized(request, env.EXHIBITION_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({ configured: true });
    if (path !== '/synthesize' || request.method !== 'POST') return json({ error: 'not-found' }, 404);
    let score: ReturnType<typeof parseSingingScore>; let selection: string;
    try {
      const input = JSON.parse(new TextDecoder().decode(await bounded(request, 256 * 1024)));
      score = parseSingingScore(input.score);
      selection = input.backend ?? 'auto';
      if (!['auto', 'vpc', 'cloud-run'].includes(selection)) throw new Error('backend');
    } catch { return json({ error: 'invalid-score' }, 400); }
    const attemptId = crypto.randomUUID();
    const backends: Array<'vpc' | 'cloud-run'> = selection === 'auto' ? ['vpc', 'cloud-run'] : [selection as 'vpc' | 'cloud-run'];
    let failed = false;
    for (const backend of backends) {
      const claim = { backend, jobId: `exhibit:${attemptId}`, generationId: attemptId, attempt: 1 };
      const lease = await env.VOICEVOX_INFRASTRUCTURE.acquireBackendLease(claim);
      if (!lease.granted || !lease.lease) continue;
      let grantHash: string | null = null;
      try {
        const grant = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        grantHash = [...await digest(grant)].map(x => x.toString(16).padStart(2, '0')).join('');
        await env.EVALUATIONS_DB.prepare('INSERT INTO voicevox_grants (grant_hash, generation_id, candidate_id, issued_at, expires_at) VALUES (?, ?, NULL, ?, ?)').bind(grantHash, attemptId, Date.now(), Date.now() + 240_000).run();
        const response = await env.PUBLIC_APP.fetch('https://cho-ekaki-uta.nitsc-proclub.workers.dev/api/voicevox/synthesize', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://cho-ekaki-uta.nitsc-proclub.workers.dev' },
          body: JSON.stringify({ voiceGrant: grant, score, backend }),
        });
        const audio = await bounded(response, 32 * 1024 * 1024);
        if (!response.ok || new TextDecoder().decode(audio.slice(0, 4)) !== 'RIFF' || new TextDecoder().decode(audio.slice(8, 12)) !== 'WAVE') {
          let code = 'invalid-wav'; try { code = JSON.parse(new TextDecoder().decode(audio)).code ?? 'upstream-error'; } catch { /* Non-JSON reply. */ }
          console.warn('exhibition synthesis rejected', { backend, status: response.status, code }); failed = true; continue;
        }
        return new Response(audio, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Voicevox-Backend': backend } });
      } catch (e) { console.warn('exhibition gateway failed', { backend, error: e instanceof Error ? e.message.slice(0, 180) : 'unknown' }); failed = true; }
      finally {
        const cleanup = await Promise.allSettled([
          env.VOICEVOX_INFRASTRUCTURE.releaseBackendLease({ ...claim, leaseId: lease.lease.leaseId }),
          ...(grantHash ? [env.EVALUATIONS_DB.prepare('DELETE FROM voicevox_grants WHERE grant_hash = ?').bind(grantHash).run()] : []),
        ]);
        if (cleanup.some(result => result.status === 'rejected')) console.warn('exhibition temporary resource cleanup failed; expiry remains active');
      }
    }
    return json({ error: failed ? 'voice-failed' : 'voice-busy' }, failed ? 502 : 429);
  },
} satisfies ExportedHandler<GatewayEnv>;
