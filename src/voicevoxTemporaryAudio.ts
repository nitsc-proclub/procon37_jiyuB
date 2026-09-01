/** Private, short-lived VOICEVOX WAV storage. Archive promotion is intentionally
 * absent: a future, separately-authorized archive must copy to another bucket. */
export const TEMPORARY_AUDIO_PREFIX = "wav/v1/";
export const TEMPORARY_AUDIO_METADATA_PREFIX = `${TEMPORARY_AUDIO_PREFIX}metadata/`;
export const TEMPORARY_AUDIO_DEFAULT_TTL_SECONDS = 60 * 60;
export const TEMPORARY_AUDIO_MAX_TTL_SECONDS = 24 * 60 * 60;
export const TEMPORARY_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
/** The temporary bucket needs an R2 lifecycle rule for prefix `wav/`, expire after one day. */
export const TEMPORARY_AUDIO_ORPHAN_LIFECYCLE_DAYS = 1;

type R2ObjectLike = { key: string; size: number };
type R2ObjectBodyLike = R2ObjectLike & { body: ReadableStream<Uint8Array> };
/** Subset used by this module; generated `R2Bucket` is compile-checked below. */
export type TemporaryAudioR2Bucket = {
  put(
    key: string,
    value:
      | ArrayBuffer
      | ArrayBufferView
      | ReadableStream<Uint8Array>
      | string
      | null
      | Blob,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
      sha256?: ArrayBuffer | ArrayBufferView | string;
    },
  ): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
};
type AssertR2BucketCompatibility<T extends TemporaryAudioR2Bucket> = T;
type GeneratedR2BucketCompatibility = AssertR2BucketCompatibility<R2Bucket>;

export type TemporaryAudioScope = {
  jobId: string;
  attempt: number;
  leaseId: string;
};
export type TemporaryAudioReference = TemporaryAudioScope & {
  audioId: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
};
type TemporaryAudioMetadata = TemporaryAudioReference & {
  version: 1;
  wavKey: string;
};
export type TemporaryAudioCleanupResult = {
  scanned: number;
  deleted: number;
  corrupt: number;
  failed: number;
  nextCursor?: string;
};
export type TemporaryAudioErrorCode =
  | "invalid-input"
  | "audio-too-large"
  | "invalid-wav"
  | "not-found"
  | "expired"
  | "corrupt-metadata"
  | "storage-failed";
export class TemporaryAudioError extends Error {
  constructor(
    public readonly code: TemporaryAudioErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TemporaryAudioError";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const fail = (code: TemporaryAudioErrorCode, message: string): never => {
  throw new TemporaryAudioError(code, message);
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const validTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const validAudioId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const validScope = (scope: TemporaryAudioScope): scope is TemporaryAudioScope =>
  typeof scope?.jobId === "string" &&
  scope.jobId.length > 0 &&
  !/\s/u.test(scope.jobId) &&
  encoder.encode(scope.jobId).byteLength <= 256 &&
  Number.isInteger(scope.attempt) &&
  scope.attempt >= 1 &&
  scope.attempt <= 100 &&
  typeof scope.leaseId === "string" &&
  UUID.test(scope.leaseId);
const jobSegment = (jobId: string) => hex(encoder.encode(jobId)); // prevents a job ID from becoming an R2 path.
const wavKeyFor = (scope: TemporaryAudioScope, audioId: string) =>
  `${TEMPORARY_AUDIO_PREFIX}audio/${jobSegment(scope.jobId)}/${scope.attempt}/${scope.leaseId}/${audioId}.wav`;
const metadataKeyFor = (audioId: string) =>
  `${TEMPORARY_AUDIO_METADATA_PREFIX}${audioId}.json`;

const snapshotStoreInput = (
  scope: TemporaryAudioScope,
  options: { now?: number; ttlSeconds?: number },
) => ({
  scope: { jobId: scope.jobId, attempt: scope.attempt, leaseId: scope.leaseId },
  now: options.now ?? Date.now(),
  ttlSeconds: options.ttlSeconds ?? TEMPORARY_AUDIO_DEFAULT_TTL_SECONDS,
});
const assertTtlAndTime = (now: number, ttlSeconds: number) => {
  if (
    !validTimestamp(now) ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > TEMPORARY_AUDIO_MAX_TTL_SECONDS ||
    now > Number.MAX_SAFE_INTEGER - ttlSeconds * 1000
  )
    fail("invalid-input", "temporary audio time bounds are invalid");
};
const asStream = (
  value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
) =>
  value instanceof ReadableStream
    ? value
    : new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(
                  value.buffer,
                  value.byteOffset,
                  value.byteLength,
                ),
          );
          controller.close();
        },
      });
const readBounded = async (
  value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  maxBytes: number,
) => {
  const reader = asStream(value).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("temporary-audio-bound");
        fail("audio-too-large", "WAV exceeds the 32 MiB VOICEVOX limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
const ascii = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));
const uint32le = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
const assertWav = (bytes: Uint8Array) => {
  if (
    bytes.byteLength < 44 ||
    ascii(bytes, 0) !== "RIFF" ||
    ascii(bytes, 8) !== "WAVE" ||
    uint32le(bytes, 4) !== bytes.byteLength - 8
  )
    fail("invalid-wav", "temporary audio must be a complete RIFF/WAVE file");
  let offset = 12;
  let fmt = false;
  let data = false;
  while (offset + 8 <= bytes.byteLength) {
    const size = uint32le(bytes, offset + 4);
    const end = offset + 8 + size;
    if (end > bytes.byteLength) break;
    if (ascii(bytes, offset) === "fmt " && size >= 16) fmt = true;
    if (ascii(bytes, offset) === "data") data = true;
    offset = end + (size % 2);
  }
  if (!fmt || !data || offset !== bytes.byteLength)
    fail("invalid-wav", "temporary audio WAV chunks are incomplete");
};
const parseMetadata = (
  value: string,
  expectedAudioId?: string,
): TemporaryAudioMetadata => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail("corrupt-metadata", "temporary audio metadata is invalid");
  }
  const record =
    parsed && typeof parsed === "object"
      ? (parsed as Partial<TemporaryAudioMetadata>)
      : null;
  if (
    !record ||
    record.version !== 1 ||
    !validAudioId(record.audioId) ||
    (expectedAudioId && record.audioId !== expectedAudioId) ||
    !validScope(record as TemporaryAudioScope) ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 44 ||
    record.bytes > TEMPORARY_AUDIO_MAX_BYTES ||
    !validTimestamp(record.createdAt) ||
    !validTimestamp(record.expiresAt) ||
    record.expiresAt <= record.createdAt ||
    record.expiresAt - record.createdAt >
      TEMPORARY_AUDIO_MAX_TTL_SECONDS * 1000 ||
    !SHA256_HEX.test(record.sha256 ?? "") ||
    record.wavKey !== wavKeyFor(record as TemporaryAudioScope, record.audioId)
  )
    return fail(
      "corrupt-metadata",
      "temporary audio metadata failed validation",
    );
  return record as TemporaryAudioMetadata;
};
const readMetadata = async (
  bucket: TemporaryAudioR2Bucket,
  audioId: string,
) => {
  if (!validAudioId(audioId))
    fail("invalid-input", "audioId must be a server-issued UUID");
  const object = await bucket.get(metadataKeyFor(audioId));
  if (!object) fail("not-found", "temporary audio was not found");
  if (object.size < 2 || object.size > 4096) {
    await object.body.cancel();
    fail("corrupt-metadata", "temporary audio metadata is out of bounds");
  }
  return parseMetadata(
    new TextDecoder().decode(await readBounded(object.body, 4096)),
    audioId,
  );
};

export const storeTemporaryVoicevoxWav = async (
  bucket: TemporaryAudioR2Bucket,
  scope: TemporaryAudioScope,
  wav: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  options: { now?: number; ttlSeconds?: number } = {},
): Promise<TemporaryAudioReference> => {
  const snapshot = snapshotStoreInput(scope, options);
  if (!validScope(snapshot.scope))
    fail(
      "invalid-input",
      "scope must contain a jobId, positive attempt, and lease UUID",
    );
  assertTtlAndTime(snapshot.now, snapshot.ttlSeconds);
  const bytes = await readBounded(wav, TEMPORARY_AUDIO_MAX_BYTES);
  assertWav(bytes);
  const audioId = crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = hex(new Uint8Array(digest));
  const reference: TemporaryAudioReference = {
    ...snapshot.scope,
    audioId,
    bytes: bytes.byteLength,
    sha256,
    createdAt: snapshot.now,
    expiresAt: snapshot.now + snapshot.ttlSeconds * 1000,
  };
  const wavKey = wavKeyFor(snapshot.scope, audioId);
  const customMetadata = {
    temporary: "voicevox",
    createdAt: String(reference.createdAt),
    expiresAt: String(reference.expiresAt),
    bytes: String(reference.bytes),
    sha256,
  };
  try {
    if (
      !(await bucket.put(wavKey, bytes, {
        sha256: digest,
        httpMetadata: {
          contentType: "audio/wav",
          cacheControl: "private, no-store",
        },
        customMetadata,
      }))
    )
      fail("storage-failed", "temporary WAV write was conditionally rejected");
    if (
      !(await bucket.put(
        metadataKeyFor(audioId),
        JSON.stringify({
          version: 1,
          ...reference,
          wavKey,
        } satisfies TemporaryAudioMetadata),
        {
          httpMetadata: {
            contentType: "application/json",
            cacheControl: "private, no-store",
          },
          customMetadata,
        },
      ))
    )
      fail(
        "storage-failed",
        "temporary metadata write was conditionally rejected",
      );
  } catch (error) {
    if (error instanceof TemporaryAudioError) throw error;
    throw new TemporaryAudioError(
      "storage-failed",
      error instanceof Error
        ? error.message
        : "temporary audio could not be stored",
    );
  }
  return reference;
};
const boundedDeliveryBody = (
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
) => {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > expectedBytes)
          controller.error(
            new TemporaryAudioError(
              "corrupt-metadata",
              "stored temporary audio exceeds metadata",
            ),
          );
        else controller.enqueue(chunk);
      },
      flush(controller) {
        if (total !== expectedBytes)
          controller.error(
            new TemporaryAudioError(
              "corrupt-metadata",
              "stored temporary audio is shorter than metadata",
            ),
          );
      },
    }),
  );
};
/** Internal primitive: caller authorization for this job/lease is mandatory; audioId is not a browser credential. */
export const readTemporaryVoicevoxWav = async (
  bucket: TemporaryAudioR2Bucket,
  audioId: string,
  now = Date.now(),
): Promise<Response> => {
  if (!validTimestamp(now))
    fail("invalid-input", "now must be a non-negative timestamp");
  const metadata = await readMetadata(bucket, audioId);
  if (metadata.expiresAt <= now) fail("expired", "temporary audio has expired");
  const object = await bucket.get(metadata.wavKey);
  if (!object) fail("not-found", "temporary audio was not found");
  if (
    object.size !== metadata.bytes ||
    object.size > TEMPORARY_AUDIO_MAX_BYTES
  ) {
    await object.body.cancel();
    fail("corrupt-metadata", "temporary audio size does not match metadata");
  }
  return new Response(boundedDeliveryBody(object.body, metadata.bytes), {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(metadata.bytes),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
const isCleanupMetadataKey = (key: string) =>
  key.startsWith(TEMPORARY_AUDIO_METADATA_PREFIX) &&
  key.endsWith(".json") &&
  validAudioId(key.slice(TEMPORARY_AUDIO_METADATA_PREFIX.length, -5));
/** Bounded cursor-based sweep. It never lists outside `wav/v1/metadata/` and a valid metadata record can only delete its exact `wav/v1/audio/` sibling. */
export const cleanupExpiredTemporaryVoicevoxAudio = async (
  bucket: TemporaryAudioR2Bucket,
  options: {
    now?: number;
    cursor?: string;
    objectBudget?: number;
    pageSize?: number;
  } = {},
): Promise<TemporaryAudioCleanupResult> => {
  const now = options.now ?? Date.now(),
    objectBudget = options.objectBudget ?? 100,
    pageSize = options.pageSize ?? 100;
  if (
    !validTimestamp(now) ||
    !Number.isInteger(objectBudget) ||
    objectBudget < 1 ||
    objectBudget > 100 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    (options.cursor !== undefined &&
      (typeof options.cursor !== "string" || options.cursor.length > 2048))
  )
    fail("invalid-input", "cleanup bounds are invalid");
  let cursor = options.cursor;
  const result: TemporaryAudioCleanupResult = {
    scanned: 0,
    deleted: 0,
    corrupt: 0,
    failed: 0,
  };
  while (result.scanned < objectBudget) {
    const listed = await bucket.list({
      prefix: TEMPORARY_AUDIO_METADATA_PREFIX,
      cursor,
      limit: Math.min(pageSize, objectBudget - result.scanned),
    });
    for (const item of listed.objects) {
      result.scanned += 1;
      if (
        !isCleanupMetadataKey(item.key) ||
        item.size < 2 ||
        item.size > 4096
      ) {
        result.corrupt += 1;
        continue;
      }
      try {
        const audioId = item.key.slice(
          TEMPORARY_AUDIO_METADATA_PREFIX.length,
          -5,
        );
        const metadata = await readMetadata(bucket, audioId);
        if (metadata.expiresAt > now) continue;
        await bucket.delete(metadata.wavKey);
        result.deleted += 1;
        await bucket.delete(item.key);
        result.deleted += 1;
      } catch (error) {
        if (
          error instanceof TemporaryAudioError &&
          error.code === "corrupt-metadata"
        )
          result.corrupt += 1;
        else result.failed += 1;
      }
    }
    if (!listed.truncated) return result;
    if (!listed.cursor) {
      result.failed += 1;
      return result;
    }
    cursor = listed.cursor;
    if (listed.objects.length === 0) {
      result.failed += 1;
      return result;
    }
  }
  result.nextCursor = cursor;
  return result;
};
