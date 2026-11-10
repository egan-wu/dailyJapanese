// 呼叫 Gemini API 產生文章，驗證通過才寫入 data/slots/，並更新 manifest。
//
//   GEMINI_API_KEY=... node scripts/generate.mjs --week            產生下週一～日共 21 篇
//   GEMINI_API_KEY=... node scripts/generate.mjs --week 2026-11-16 指定從哪一天開始的 7 天
//   GEMINI_API_KEY=... node scripts/generate.mjs --slot 08:00 --date 2026-11-16   只產生一篇
//
// 其他參數：
//   --force          檔案已存在也重新產生
//   --no-research    不先用 Google 搜尋取材
//   --mock <file>    不呼叫 API，改用本機 JSON 測試流程（只能搭配 --slot）
//   --print-prompt   只印出送給 AI 的指令
//
// 環境變數：
//   GEMINI_API_KEY   必填（--mock 時不用）
//   GEMINI_MODEL     預設 gemini-2.5-flash
//   GEN_DELAY_MS     每次呼叫之間的間隔，避免超過免費額度的速率限制（預設 6000）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSlot, slotFileName, SLOTS } from "./lib/slot-schema.mjs";
import { scanSlots, writeManifest, SLOTS_DIR } from "./build-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIME_ZONE = "Asia/Taipei";
const MAX_ATTEMPTS = 3;
const MODEL = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";
const DELAY = Number(process.env.GEN_DELAY_MS || 6000);

const PERIOD = { "08:00": "早上", "12:00": "中午", "18:00": "傍晚" };

// 一週 21 個時段依序輪流 7 種類別，每種剛好 3 次
export const GENRES = ["評論", "隨筆", "深度社論・報導", "生物", "科學", "經濟", "文學"];
// 難度循環長度 8（和 7 互質），同一類別每次的難度會不一樣
const LEVEL_CYCLE = ["N2", "N3", "N1", "N3", "N2", "N1", "N2", "N3"];
const NEEDS_RESEARCH = new Set(["深度社論・報導", "生物", "科學", "經濟"]);

const DIALOGUE_SCENES = [
  "職場・早上的交接", "朋友・約週末出遊", "家庭・早餐桌上", "社群媒體・留言互動", "店裡・結帳時", "學校・下課後",
  "鄰居・在電梯遇到", "職場・會議前的準備", "朋友・聊最近看的劇", "家庭・討論晚餐", "診所・掛號櫃台", "電話・預約餐廳",
  "職場・下班前", "朋友・訊息聊天", "家庭・打掃房間", "車站・電車誤點", "咖啡店・點餐", "健身房・認識新朋友",
  "職場・請同事幫忙", "家庭・睡前聊天", "旅行・飯店櫃台"
];

function parseArgs(argv) {
  const a = { slot: null, date: null, week: null, force: false, mock: null, printPrompt: false, research: true };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--slot") a.slot = argv[++i];
    else if (x === "--date") a.date = argv[++i];
    else if (x === "--week") a.week = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "next";
    else if (x === "--force") a.force = true;
    else if (x === "--mock") a.mock = argv[++i];
    else if (x === "--print-prompt") a.printPrompt = true;
    else if (x === "--no-research") a.research = false;
    else throw new Error(`未知的參數：${x}`);
  }
  if (!a.week && !a.slot) a.week = "next";
  return a;
}

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday(ymd) { return (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7; } // 週一 = 0
function nextMonday(ymd) { return addDays(ymd, 7 - weekday(ymd)); }

// 依「這一天是週幾、第幾個時段」決定類別和難度
export function planFor(date, slot) {
  const i = weekday(date) * 3 + SLOTS.indexOf(slot);
  return { genre: GENRES[i % GENRES.length], level: LEVEL_CYCLE[i % LEVEL_CYCLE.length], scene: DIALOGUE_SCENES[i % DIALOGUE_SCENES.length] };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(body) {
  const key = process.env.GEMINI_API_KEY;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL())}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini API ${res.status}：${text.slice(0, 400)}`);
  return JSON.parse(text);
}
const candidateText = json => json?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";

// 先用 Google 搜尋找一個最近的真實主題，整理成取材筆記（不能和 JSON 輸出同時使用，所以分兩次呼叫）
async function research(genre, recentThemes) {
  const prompt = `請用 Google 搜尋，找一個最近一個月內、適合寫成日文讀解文章的「${genre}」主題（日本或國際皆可，以日本的新聞或研究優先）。
不要選這些已經寫過的主題：
${recentThemes || "（無）"}

請用繁體中文輸出：
1. 主題（一句話）
2. 5～8 個重點事實（用自己的話整理，不要逐字引用原文，數字要和來源一致）
3. 這件事對一般人生活的意義（一兩句）`;
  const json = await callGemini({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] });
  const notes = candidateText(json).trim();
  const chunks = json?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  // 搜尋結果的連結是會過期的轉址，只保留網站名稱，連到該網站首頁
  const sources = [...new Map(chunks.map(c => c.web).filter(Boolean)
    .filter(w => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(w.title || ""))
    .map(w => [w.title, { title: w.title, url: `https://${w.title}/` }])).values()].slice(0, 3);
  return { notes, sources };
}

function recentContext() {
  const recent = scanSlots().filter(r => !r.errors.length && r.data).sort((a, b) => b.file.localeCompare(a.file));
  const themes = recent.slice(0, 21).map(r => `- ${r.data.date} ${r.data.slot}：${r.data.theme}（${r.data.article.title}）`).join("\n");
  const words = [...new Set(recent.slice(0, 21).flatMap(r => [
    ...r.data.dialogue.vocab.map(v => v.word), ...r.data.article.vocab.map(v => v.word), ...r.data.article.grammar.map(g => g.pattern)
  ]))];
  return { themes, words: words.join("、") };
}

function buildPrompt({ date, slot, plan, researchNotes }) {
  const ctx = recentContext();
  const vars = {
    DATE: date, SLOT: slot, PERIOD: PERIOD[slot], GENRE: plan.genre, LEVEL: plan.level, DIALOGUE_HINT: plan.scene,
    RESEARCH: researchNotes ? `# 取材資料（請用自己的話改寫，不可照抄）\n\n${researchNotes}` : "",
    RECENT_THEMES: ctx.themes || "（無）",
    RECENT_WORDS: ctx.words || "（無）"
  };
  const template = fs.readFileSync(path.join(ROOT, "prompts", "generate-slot.md"), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function parseModelJSON(text) {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
}

function finalize(raw, { date, slot, plan, sources }) {
  const { date: _d, slot: _s, schemaVersion: _v, legacy: _l, audio: _a, ...rest } = raw || {};
  const out = { schemaVersion: 2, date, slot, ...rest };
  if (out.article && typeof out.article === "object") {
    out.article.genre = out.article.genre || plan.genre;
    out.article.level = plan.level;
    delete out.article.sources;
    if (sources?.length) out.article.sources = sources;
  }
  return out;
}

async function generateSlot(date, slot, args) {
  const fileName = slotFileName(date, slot);
  const outFile = path.join(SLOTS_DIR, fileName);
  if (fs.existsSync(outFile) && !args.force) { console.log(`⏭  ${fileName} 已存在，略過`); return "skipped"; }
  const plan = planFor(date, slot);

  let researchNotes = "", sources = [];
  if (args.research && !args.mock && NEEDS_RESEARCH.has(plan.genre)) {
    try {
      ({ notes: researchNotes, sources } = await research(plan.genre, recentContext().themes));
      console.log(`   🔎 已取材（${sources.length} 個來源）`);
    } catch (e) {
      console.warn(`   取材失敗，改用一般知識撰寫：${e.message}`);
    }
    await sleep(DELAY);
  }

  const prompt = buildPrompt({ date, slot, plan, researchNotes });
  if (args.printPrompt) { console.log(prompt); return "printed"; }

  console.log(`✍️  ${date} ${slot}｜${plan.genre}｜${plan.level}｜${plan.scene}`);
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  let errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let text;
    try {
      text = args.mock ? fs.readFileSync(args.mock, "utf8") : candidateText(await callGemini({
        contents, generationConfig: { responseMimeType: "application/json", temperature: 0.9, maxOutputTokens: 32768 }
      }));
      if (!text) throw new Error("Gemini 沒有回傳內容");
    } catch (e) {
      console.error(`   第 ${attempt} 次呼叫失敗：${e.message}`);
      if (attempt === MAX_ATTEMPTS || args.mock) throw e;
      await sleep(DELAY * 2 * attempt);
      continue;
    }
    let data;
    try {
      data = finalize(parseModelJSON(text), { date, slot, plan, sources });
      ({ errors } = validateSlot(data, { fileName }));
    } catch (e) {
      errors = [`輸出不是合法的 JSON：${e.message}`];
    }
    if (!errors.length) {
      validateSlot(data, { fileName }).warnings.forEach(w => console.warn(`   警告：${w}`));
      fs.mkdirSync(SLOTS_DIR, { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + "\n");
      console.log(`   ✅ 已寫入 data/slots/${fileName}（第 ${attempt} 次）`);
      return "written";
    }
    console.warn(`   第 ${attempt} 次沒通過檢查（${errors.length} 個錯誤）：`);
    errors.slice(0, 12).forEach(e => console.warn(`     - ${e}`));
    if (args.mock) break;
    contents.push({ role: "model", parts: [{ text }] });
    contents.push({ role: "user", parts: [{ text: `上面的 JSON 沒有通過格式檢查，錯誤如下：\n${errors.map(e => "- " + e).join("\n")}\n\n請修正所有錯誤，重新輸出完整的 JSON（只輸出 JSON）。` }] });
    await sleep(DELAY);
  }
  throw new Error(`${fileName} 嘗試多次都沒有合格的內容，不寫入`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.mock && !args.printPrompt && !process.env.GEMINI_API_KEY) {
    throw new Error("沒有設定 GEMINI_API_KEY（GitHub：Settings → Secrets and variables → Actions 新增）");
  }

  let targets;
  if (args.slot) {
    if (!SLOTS.includes(args.slot)) throw new Error(`時段必須是 ${SLOTS.join(" / ")}`);
    targets = [{ date: args.date || taipeiToday(), slot: args.slot }];
  } else {
    const start = args.week === "next" ? nextMonday(taipeiToday()) : args.week;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error(`日期格式錯誤：${start}`);
    targets = Array.from({ length: 7 }, (_, d) => SLOTS.map(slot => ({ date: addDays(start, d), slot }))).flat();
    console.log(`產生 ${start} 起 7 天、共 ${targets.length} 個時段（模型 ${MODEL()}）`);
  }

  let failed = 0, written = 0;
  for (const t of targets) {
    try {
      const r = await generateSlot(t.date, t.slot, args);
      if (r === "written") { written++; await sleep(DELAY); }
    } catch (e) {
      failed++;
      console.error(`❌ ${e.message}`);
    }
  }
  if (written) writeManifest();
  console.log(`\n完成：新增 ${written} 篇，失敗 ${failed} 篇`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
}
