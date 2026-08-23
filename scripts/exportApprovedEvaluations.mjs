import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const options = process.argv.slice(2);
const outputOption = options.find((value) => value.startsWith("--output="));
if (!outputOption?.slice("--output=".length)) {
  console.error("Usage: node scripts/exportApprovedEvaluations.mjs --output=approved.jsonl [--preview]");
  process.exit(2);
}
const database = process.env.EVALUATIONS_D1_DATABASE || "cho-ekaki-uta-evaluations";
const target = options.includes("--preview") ? "--preview" : "--remote";
const sql = "SELECT generation_id, evaluation_json FROM evaluation_records WHERE status='approved' ORDER BY created_at ASC";
const result = spawnSync("npx.cmd", ["wrangler", "d1", "execute", database, target, "--command", sql, "--json"], { encoding: "utf8", shell: false });
if (result.status !== 0) {
  process.stderr.write(result.stderr || "D1 export failed.\n");
  process.exit(result.status ?? 1);
}

const envelopes = JSON.parse(result.stdout);
const rows = (Array.isArray(envelopes) ? envelopes : [envelopes]).flatMap((entry) => entry?.results ?? entry?.result?.[0]?.results ?? []);
const lines = [];
let skipped = 0;
for (const row of rows) {
  try {
    const evaluation = JSON.parse(row.evaluation_json);
    const selectedId = evaluation.firstImpressionSelection;
    const candidate = evaluation.candidates?.find((item) => item.candidateId === selectedId);
    if (!candidate) { skipped += 1; continue; }
    lines.push(JSON.stringify({
      generationId: row.generation_id,
      input: { drawingAnalysis: evaluation.drawingAnalysis },
      output: { title: candidate.title, lines: candidate.lines, singingKanaLines: candidate.singingKanaLines, identifiedObject: candidate.identifiedObject, lineStrokeMappings: candidate.lineStrokeMappings },
      metadata: { modelInfo: evaluation.modelInfo, promptVersion: evaluation.lyricsPromptVersion },
    }));
  } catch { skipped += 1; }
}
const outputPath = resolve(outputOption.slice("--output=".length));
writeFileSync(outputPath, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", flag: "wx" });
console.error(`Exported ${lines.length} approved candidate(s) to ${outputPath}; skipped ${skipped}.`);
