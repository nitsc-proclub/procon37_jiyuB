import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const productionOrigin = "https://cho-ekaki-uta.nitsc-proclub.workers.dev";
const localOrigin = "http://127.0.0.1:8787";
const requestTimeoutMs = 180_000;
const maxResponseBytes = 8 * 1024 * 1024;

const parseArguments = (values) => {
  let run = false;
  let production = false;
  let requestCount = 1;
  let requestsProvided = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--run") {
      if (run) throw new Error("--run may only be specified once.");
      run = true;
    } else if (value === "--production") {
      if (production) throw new Error("--production may only be specified once.");
      production = true;
    } else if (value === "--requests") {
      if (requestsProvided || index + 1 >= values.length) throw new Error("--requests requires one integer value.");
      requestsProvided = true;
      requestCount = Number(values[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!run) throw new Error("Refusing to send requests. Re-run with --run (and --production for the deployed Worker).");
  if (!Number.isSafeInteger(requestCount) || requestCount < 1 || requestCount > 3) {
    throw new Error("--requests must be an integer from 1 through 3.");
  }
  if (!production) throw new Error(`This measurement seeds remote D1 grants, so use --production. Local Worker tests should use ${localOrigin}.`);
  return { requestCount };
};

const { requestCount } = parseArguments(process.argv.slice(2));

mkdirSync(".wrangler/benchmarks", { recursive: true });

// Same 14.10-second score used by the VPC benchmark. Its hash lets results be
// compared only with future runs using exactly this payload.
const score = {
  notes: [
    { lyric: "", key: null, frame_length: 2 },
    ...[0, 1, 2].flatMap((line) => [
      { lyric: "ま", key: 64 + (line % 2), frame_length: 48 },
      { lyric: "る", key: 65, frame_length: 48 },
      { lyric: "を", key: 67, frame_length: 48 },
      { lyric: "か", key: 65, frame_length: 48 },
      { lyric: "い", key: 64, frame_length: 48 },
      { lyric: "て", key: 60, frame_length: 48 },
      { lyric: "", key: null, frame_length: 42 },
    ]),
    { lyric: "で", key: 64, frame_length: 55 },
    { lyric: "き", key: 65, frame_length: 55 },
    { lyric: "あ", key: 67, frame_length: 55 },
    { lyric: "が", key: 65, frame_length: 55 },
    { lyric: "り", key: 64, frame_length: 55 },
    { lyric: "だ", key: 60, frame_length: 55 },
  ],
};

const generationId = randomUUID();
const grants = Array.from({ length: requestCount }, () => randomBytes(32).toString("base64url"));
const issuedAt = Date.now();
const expiresAt = issuedAt + 5 * 60_000;
const seedSql = `INSERT INTO voicevox_grants (grant_hash, generation_id, candidate_id, issued_at, expires_at) VALUES ${grants.map((grant, index) => `('${createHash("sha256").update(grant).digest("hex")}', '${generationId}', '${index % 2 === 0 ? "candidate-a" : "candidate-b"}', ${issuedAt}, ${expiresAt})`).join(", ")};`;
const cleanupSql = `DELETE FROM voicevox_grants WHERE generation_id = '${generationId}';`;

const runWranglerD1 = (file) => {
  const child = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "cho-ekaki-uta-evaluations", "--remote", "--file", file], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error(`Remote D1 command failed: ${child.error?.message || child.stderr || child.stdout || `exit ${child.status}`}`);
};

const runSql = (sql, prefix) => {
  const path = `.wrangler/benchmarks/${prefix}-${generationId}.sql`;
  writeFileSync(path, sql, { encoding: "utf8", flag: "wx" });
  try { runWranglerD1(path); } finally { rmSync(path, { force: true }); }
};

const readBoundedBody = async (response) => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds ${maxResponseBytes} bytes.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxResponseBytes) {
        try { await reader.cancel(); } catch { /* The size violation is the relevant error. */ }
        throw new Error(`Response exceeds ${maxResponseBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const endpoint = `${productionOrigin}/api/voicevox/synthesize`;
const scoreHash = createHash("sha256").update(JSON.stringify(score)).digest("hex");
const results = [];
let seedAttempted = false;
let primaryError = null;
let cleanupError = null;
try {
  seedAttempted = true;
  runSql(seedSql, "cloud-run-grants");
  for (const [index, voiceGrant] of grants.entries()) {
    const started = performance.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: productionOrigin },
      body: JSON.stringify({ voiceGrant, score, backend: "cloud-run" }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const headersAt = performance.now();
    const body = await readBoundedBody(response);
    const ended = performance.now();
    const wavValid = body.length >= 12
      && new TextDecoder("ascii").decode(body.subarray(0, 4)) === "RIFF"
      && new TextDecoder("ascii").decode(body.subarray(8, 12)) === "WAVE";
    results.push({
      request: index + 1,
      status: response.status,
      backend: response.headers.get("x-voicevox-backend"),
      fallback: response.headers.get("x-voicevox-fallback"),
      ttfbMs: Math.round(headersAt - started),
      totalMs: Math.round(ended - started),
      bytes: body.length,
      wavValid,
    });
    process.stderr.write(`request ${index + 1}: HTTP ${response.status}, backend=${response.headers.get("x-voicevox-backend")}, ttfb=${Math.round(headersAt - started)}ms, total=${Math.round(ended - started)}ms\n`);
    if (response.status !== 200 || response.headers.get("x-voicevox-backend") !== "cloud-run" || response.headers.get("x-voicevox-fallback") !== "false" || !wavValid) {
      throw new Error(`Request ${index + 1} did not return the expected direct Cloud Run WAV response.`);
    }
  }
} catch (error) {
  primaryError = error instanceof Error ? error.message : String(error);
}
try {
  if (seedAttempted) runSql(cleanupSql, "cloud-run-grants-cleanup");
} catch (error) {
  cleanupError = error instanceof Error ? error.message : String(error);
}
process.stdout.write(`${JSON.stringify({
  startedAt: new Date(issuedAt).toISOString(),
  endpoint: productionOrigin,
  requestCount,
  score: {
    sha256: scoreHash,
    notes: score.notes.length,
    totalFrames: score.notes.reduce((total, note) => total + note.frame_length, 0),
    durationSeconds: score.notes.reduce((total, note) => total + note.frame_length, 0) / 93.75,
  },
  results,
  primaryError,
  cleanupError,
})}\n`);
if (primaryError || cleanupError) process.exitCode = 1;
