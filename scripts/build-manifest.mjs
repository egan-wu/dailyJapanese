// 掃描 data/slots/*.json，驗證後產生 data/manifest.json（網頁靠這份清單找文章）
// 驗證失敗的檔案不會放進清單，網站照常運作。
//
//   node scripts/build-manifest.mjs            → 寫入 data/manifest.json
//   node scripts/build-manifest.mjs --out X    → 寫到其他位置（部署用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSlot, parseSlotFileName, SLOTS } from "./lib/slot-schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SLOTS_DIR = path.join(ROOT, "data", "slots");

export function scanSlots() {
  const files = fs.existsSync(SLOTS_DIR) ? fs.readdirSync(SLOTS_DIR).filter(f => f.endsWith(".json")).sort() : [];
  return files.map(file => {
    let data = null, errors = [], warnings = [];
    try {
      data = JSON.parse(fs.readFileSync(path.join(SLOTS_DIR, file), "utf8"));
      ({ errors, warnings } = validateSlot(data, { fileName: file }));
    } catch (e) {
      errors = [`JSON 解析失敗：${e.message}`];
    }
    return { file, data, errors, warnings };
  });
}

export function buildManifest(results = scanSlots()) {
  const days = new Map();
  for (const r of results) {
    if (r.errors.length || !parseSlotFileName(r.file)) continue;
    const { date, slot } = r.data;
    if (!days.has(date)) days.set(date, { date, slots: {} });
    days.get(date).slots[slot] = {
      file: `data/slots/${r.file}`,
      theme: r.data.theme,
      level: r.data.article.level,
      title: r.data.article.title,
      hasQuiz: Array.isArray(r.data.article.questions) && r.data.article.questions.length > 0,
      hasAudio: !!r.data.audio
    };
  }
  const list = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
  list.forEach(d => { d.slots = Object.fromEntries(SLOTS.filter(s => d.slots[s]).map(s => [s, d.slots[s]])); });
  return { generatedAt: new Date().toISOString(), days: list };
}

export function writeManifest(outFile = path.join(ROOT, "data", "manifest.json"), results) {
  const manifest = buildManifest(results);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const out = i > 0 ? path.resolve(process.argv[i + 1]) : undefined;
  const results = scanSlots();
  const bad = results.filter(r => r.errors.length);
  bad.forEach(r => console.warn(`⚠️ 略過 ${r.file}（${r.errors.length} 個錯誤，執行 npm run validate 查看）`));
  const m = writeManifest(out, results);
  console.log(`manifest：${m.days.length} 天、${m.days.reduce((n, d) => n + Object.keys(d.slots).length, 0)} 個時段`);
}
