import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const options = process.argv.slice(2);
const outputOption = options.find((value) => value.startsWith("--output="));
if (!outputOption?.slice("--output=".length)) {
  console.error("Usage: node scripts/exportApprovedEvaluations.mjs --output=approved.jsonl [--preview]");
  process.exit(2);
}
const isPreview = options.includes("--preview");
// Keep Preview D1 out of the production Wrangler config. Preview exports
// always use the isolated staging config and its database name directly.
const database = isPreview ? "cho-ekaki-uta-evaluations-preview" : (process.env.EVALUATIONS_D1_DATABASE || "cho-ekaki-uta-evaluations");
const targetArgs = isPreview ? ["--remote", "--config", "wrangler.staging.jsonc"] : ["--remote"];
const sql = "SELECT r.generation_id, r.evaluation_json, f.final_preference_selection, f.subject_feedback_choice, f.subject_feedback_label, f.rating_drawing_song_quality, f.rating_drawing_order_clarity, f.rating_child_friendliness, f.rating_singability FROM evaluation_records r LEFT JOIN evaluation_followups f ON f.generation_id = r.generation_id WHERE r.status='approved' ORDER BY r.created_at ASC";
const wranglerArgs = ["wrangler", "d1", "execute", database, ...targetArgs, "--command", sql, "--json"];
const result = process.platform === "win32"
  ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npx.cmd", ...wranglerArgs], { encoding: "utf8", shell: false })
  : spawnSync("npx", wranglerArgs, { encoding: "utf8", shell: false });
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
    // SFT remains grounded in the lyric-only first impression. Playback can
    // influence the later preference, so keep it as analysis metadata only.
    const selectedId = evaluation.firstImpressionSelection;
    const candidate = evaluation.candidates?.find((item) => item.candidateId === selectedId);
    if (!candidate) { skipped += 1; continue; }
    lines.push(JSON.stringify({
      generationId: row.generation_id,
      input: { drawingAnalysis: evaluation.drawingAnalysis },
      output: { title: candidate.title, lines: candidate.lines, singingKanaLines: candidate.singingKanaLines, identifiedObject: candidate.identifiedObject, lineStrokeMappings: candidate.lineStrokeMappings },
      metadata: {
        modelInfo: evaluation.modelInfo,
        promptVersion: evaluation.lyricsPromptVersion,
        firstImpressionSelection: evaluation.firstImpressionSelection,
        finalPreferenceSelection: row.final_preference_selection ?? null,
        subjectFeedback: row.subject_feedback_choice ? { choice: row.subject_feedback_choice, label: row.subject_feedback_label } : null,
        ratings: {
          drawingSongQuality: row.rating_drawing_song_quality ?? null,
          drawingOrderClarity: row.rating_drawing_order_clarity ?? null,
          childFriendliness: row.rating_child_friendliness ?? null,
          singability: row.rating_singability ?? null,
        },
      },
    }));
  } catch { skipped += 1; }
}
const outputPath = resolve(outputOption.slice("--output=".length));
writeFileSync(outputPath, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", flag: "wx" });
console.error(`Exported ${lines.length} approved candidate(s) to ${outputPath}; skipped ${skipped}.`);
