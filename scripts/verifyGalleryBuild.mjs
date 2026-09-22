import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

const root = path.resolve(process.argv[2] || "dist");
const assets = await readdir(path.join(root, "assets"));
const text = (await Promise.all(assets.filter(name => /\.(js|css)$/.test(name)).map(name => readFile(path.join(root, "assets", name), "utf8")))).join("\n");
for (const marker of ["ekaki-gallery-action", ".gallery-wall", "展示ギャラリーを開く", "cho-ekaki-uta-debug-history"]) {
  assert.ok(text.includes(marker), `Public gallery is missing ${marker}`);
}
assert.ok(!text.includes("/api/demo-records/events"), "Public gallery must not subscribe to the local server");
console.log("Public gallery, browser storage and entry link included; local SSE excluded.");
