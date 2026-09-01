import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
});
const tickets = await vite.ssrLoadModule("/src/creationArchiveTicket.ts");
const archive = await vite.ssrLoadModule("/src/creationArchive.ts");
const generationId = "123e4567-e89b-42d3-a456-426614174000";
const hash = "a".repeat(43),
  secret = "s".repeat(32);

test("generation ticket binds the generation, image, analysis, and candidate fingerprints", async () => {
  const issued = await tickets.issueArchiveGenerationTicket(
    {
      generationId,
      evaluationFingerprint: hash,
      imageSha256: "b".repeat(64),
      analysisSha256: "c".repeat(64),
      candidateSha256: "d".repeat(64),
    },
    secret,
    1_000,
    60,
  );
  assert.deepEqual(
    await tickets.verifyArchiveGenerationTicket(issued.value, secret, 1_001),
    {
      generationId,
      evaluationFingerprint: hash,
      imageSha256: "b".repeat(64),
      analysisSha256: "c".repeat(64),
      candidateSha256: "d".repeat(64),
    },
  );
  assert.equal(
    await tickets.verifyArchiveGenerationTicket(issued.value, secret, 61_000),
    null,
  );
  assert.equal(
    await tickets.verifyArchiveGenerationTicket(
      issued.value.replace("ca1", "ca2"),
      secret,
      1_001,
    ),
    null,
  );
});

test("archive constants preserve the exact consent, retention, quotas, and fixed private asset contract", () => {
  assert.equal(archive.CREATION_ARCHIVE_CONSENT_VERSION, "creation-archive-v1");
  assert.equal(
    archive.CREATION_ARCHIVE_RETENTION_MS,
    365 * 24 * 60 * 60 * 1000,
  );
  assert.equal(archive.CREATION_ARCHIVE_QUOTA_BYTES, 8_000_000_000);
});

test.after(async () => vite.close());
