import { spawnSync } from "node:child_process";

const [action, generationId, ...options] = process.argv.slice(2);
const isPreview = options.includes("--preview");
// Keep Preview D1 out of the production Wrangler config. Preview administration
// always uses the isolated staging config and its database name directly.
const database = isPreview ? "cho-ekaki-uta-evaluations-preview" : (process.env.EVALUATIONS_D1_DATABASE || "cho-ekaki-uta-evaluations");
const targetArgs = isPreview ? ["--remote", "--config", "wrangler.staging.jsonc"] : ["--remote"];
const reviewerOption = options.find((value) => value.startsWith("--reviewer="));
const reasonOption = options.find((value) => value.startsWith("--reason="));
const reviewer = reviewerOption?.slice("--reviewer=".length).trim() || "manual-review";
const reason = reasonOption?.slice("--reason=".length).trim() || null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

if (!["approve", "exclude"].includes(action) || !uuid.test(generationId ?? "") || reviewer.length > 128 || (action === "exclude" && (!reason || reason.length > 500))) {
  console.error("Usage: node scripts/evaluationAdmin.mjs approve|exclude <generation-uuid> [--preview] [--reviewer=name] [--reason=text]");
  process.exit(2);
}

const now = new Date().toISOString();
const status = action === "approve" ? "approved" : "excluded";
const sql = `UPDATE evaluation_records SET status=${quote(status)}, reviewed_at=${quote(now)}, reviewed_by=${quote(reviewer)}, exclusion_reason=${reason ? quote(reason) : "NULL"}, updated_at=${quote(now)} WHERE generation_id=${quote(generationId)} AND status='pending'; SELECT changes() AS changed;`;
const wranglerArgs = ["wrangler", "d1", "execute", database, ...targetArgs, "--command", sql, "--json"];
const result = process.platform === "win32"
  ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npx.cmd", ...wranglerArgs], { stdio: "inherit", shell: false })
  : spawnSync("npx", wranglerArgs, { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
