// 檢查所有文章 JSON，有錯誤時以 exit code 1 結束（GitHub Actions 會寄信通知）
//   node scripts/validate.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSlots } from "./build-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = scanSlots();
// 音檔不存在只是警告：網頁播放失敗時會自動改用瀏覽器語音
for (const r of results) {
  const a = r.data && r.data.audio;
  if (!a || r.errors.length) continue;
  const missing = [...(a.dialogue || []), ...(a.article || [])].filter(p => !fs.existsSync(path.join(ROOT, p)));
  if (missing.length) r.warnings.push(`有 ${missing.length} 個音檔不存在（執行 node scripts/tts.mjs 會重新產生）`);
}
let errorCount = 0, warnCount = 0;
for (const r of results) {
  if (!r.errors.length && !r.warnings.length) { console.log(`✅ ${r.file}`); continue; }
  console.log(`${r.errors.length ? "❌" : "⚠️"} ${r.file}`);
  r.errors.forEach(e => console.log(`   錯誤：${e}`));
  r.warnings.forEach(w => console.log(`   警告：${w}`));
  errorCount += r.errors.length;
  warnCount += r.warnings.length;
}
console.log(`\n共 ${results.length} 個檔案，${errorCount} 個錯誤，${warnCount} 個警告`);
if (results.length === 0) console.log("（data/slots 裡沒有任何檔案）");
process.exit(errorCount ? 1 : 0);
