import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

const root = path.resolve(process.argv[2] || "dist");
const assets = await readdir(path.join(root, "assets"));
assert.ok(assets.some(name => name.endsWith(".js")), "Build before checking public gallery isolation");
for (const name of assets.filter(name => /\.(js|css)$/.test(name))) {
  const text = await readFile(path.join(root, "assets", name), "utf8");
  for (const marker of ["ekaki-gallery-action", "/api/demo-records/events", ".gallery-wall", "展示ギャラリーを開く"]) {
    assert.ok(!text.includes(marker), `Public asset ${name} includes local gallery marker ${marker}`);
  }
}
console.log("Public build excludes gallery module, CSS, entry link and live event subscription.");
