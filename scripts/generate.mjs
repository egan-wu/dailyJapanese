// 呼叫 Gemini API 產生一個時段的文章，驗證通過才寫入 data/slots/，並更新 manifest。
//
//   GEMINI_API_KEY=... node scripts/generate.mjs --slot auto
//
// 參數：
//   --slot 08:00|17:00|22:00|auto   要產生的時段（auto＝依台灣時間判斷）
//   --date YYYY-MM-DD               日期（預設＝台灣今天）
//   --force                         檔案已存在也重新產生
//   --mock <file.json>              不呼叫 API，改用本機 JSON 測試流程
//   --print-prompt                  只印出送給 AI 的指令
//
// 環境變數：
//   GEMINI_API_KEY   必填（--mock 時不用）
//   GEMINI_MODEL     預設 gemini-2.5-flash
//   TARGET_LEVEL     學習者目標級數，預設 N2
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSlot, slotFileName, SLOTS } from "./lib/slot-schema.mjs";
import { scanSlots, writeManifest, SLOTS_DIR } from "./build-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIME_ZONE = "Asia/Taipei";
const MAX_ATTEMPTS = 3;

const PERIOD = { "08:00": "晨間篇", "17:00": "午後篇", "22:00": "夜間篇" };
const DIALOGUE_HINTS = {
  "08:00": ["職場晨會與分工", "通勤途中的突發狀況", "和客戶的電話或郵件往來", "新人向前輩請教", "早上在咖啡店點餐與閒聊"],
  "17:00": ["下班後和朋友約吃飯", "商店街或超市購物", "社群媒體上的留言互動", "興趣社團的活動討論", "在車站或觀光地問路"],
  "22:00": ["家人睡前聊天", "室友討論家事分擔", "和朋友講電話規劃旅行", "線上課程或讀書會", "深夜和家人討論新聞話題"]
};
const GENRE_HINTS = {
  "08:00": ["社會・職場文化", "經濟・消費生活", "教育・學習方法", "都市・交通與生活", "科技與社會"],
  "17:00": ["科學・自然現象", "健康・醫學常識", "環境・生態", "心理學・行為", "飲食・生活科學"],
  "22:00": ["文學・隨筆", "日本文化・傳統", "哲學・生活態度", "語言・溝通", "藝術・美感"]
};
const CHAR_RANGE = { N1: "600～800", N2: "500～700", N3: "400～550", N4: "350～450", N5: "350～400" };

function parseArgs(argv) {
  const args = { slot: "auto", date: null, force: false, mock: null, printPrompt: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slot") args.slot = argv[++i];
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--force") args.force = true;
    else if (a === "--mock") args.mock = argv[++i];
    else if (a === "--print-prompt") args.printPrompt = true;
    else throw new Error(`未知的參數：${a}`);
  }
  return args;
}

function taipeiNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// 排程在各時段前約 20 分鐘執行；GitHub 排程可能延遲，所以用區間判斷
function autoSlot(hour) {
  if (hour >= 4 && hour < 13) return "08:00";
  if (hour >= 13 && hour < 20) return "17:00";
  return "22:00";
}

function dayIndex(date) {
  return Math.floor(Date.UTC(...date.split("-").map((n, i) => i === 1 ? n - 1 : Number(n))) / 86400000);
}

function buildPrompt({ date, slot, level }) {
  const recent = scanSlots().filter(r => !r.errors.length && r.data).sort((a, b) => b.file.localeCompare(a.file));
  const recentThemes = recent.slice(0, 15).map(r => `- ${r.data.date} ${r.data.slot}：${r.data.theme}（${r.data.article.title}）`).join("\n") || "（無）";
  const words = [...new Set(recent.slice(0, 21).flatMap(r => [...r.data.dialogue.vocab, ...r.data.article.vocab].map(v => v.word)))];
  const n = dayIndex(date);
  const pick = list => list[n % list.length];
  const template = fs.readFileSync(path.join(ROOT, "prompts", "generate-slot.md"), "utf8");
  const vars = {
    DATE: date,
    SLOT: slot,
    PERIOD: PERIOD[slot],
    LEVEL: level,
    CHAR_RANGE: CHAR_RANGE[level] || CHAR_RANGE.N2,
    DIALOGUE_HINT: pick(DIALOGUE_HINTS[slot]),
    GENRE_HINT: pick(GENRE_HINTS[slot]),
    RECENT_THEMES: recentThemes,
    RECENT_WORDS: words.join("、") || "（無）"
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

async function callGemini(contents) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("沒有設定 GEMINI_API_KEY");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents,
      generationConfig: { responseMimeType: "application/json", temperature: 0.9, maxOutputTokens: 32768 }
    })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Gemini API ${res.status}：${body.slice(0, 500)}`);
  const json = JSON.parse(body);
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  if (!text) throw new Error(`Gemini 沒有回傳內容：${body.slice(0, 500)}`);
  return text;
}

function parseModelJSON(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(cleaned);
}

function finalize(raw, { date, slot }) {
  const { date: _d, slot: _s, schemaVersion: _v, legacy: _l, audio: _a, ...rest } = raw || {};
  return { schemaVersion: 2, date, slot, ...rest };
}

async function main() {
  const args = parseArgs(process.argv);
  const now = taipeiNow();
  const date = args.date || now.date;
  const slot = args.slot === "auto" ? autoSlot(now.hour) : args.slot;
  const level = process.env.TARGET_LEVEL || "N2";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式錯誤：${date}`);
  if (!SLOTS.includes(slot)) throw new Error(`時段必須是 ${SLOTS.join(" / ")} 或 auto`);

  const fileName = slotFileName(date, slot);
  const outFile = path.join(SLOTS_DIR, fileName);
  const prompt = buildPrompt({ date, slot, level });
  if (args.printPrompt) { console.log(prompt); return; }
  if (fs.existsSync(outFile) && !args.force) {
    console.log(`${fileName} 已存在，略過（要重新產生請加 --force）`);
    return;
  }

  if (!args.mock && !process.env.GEMINI_API_KEY) {
    throw new Error("沒有設定 GEMINI_API_KEY（GitHub：Settings → Secrets and variables → Actions 新增）");
  }

  console.log(`產生 ${date} ${slot}（目標 ${level}，模型 ${args.mock ? "mock" : process.env.GEMINI_MODEL || "gemini-2.5-flash"}）`);
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  let lastErrors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let text;
    try {
      text = args.mock ? fs.readFileSync(args.mock, "utf8") : await callGemini(contents);
    } catch (e) {
      console.error(`第 ${attempt} 次呼叫失敗：${e.message}`);
      if (attempt === MAX_ATTEMPTS) throw e;
      await new Promise(r => setTimeout(r, 5000 * attempt));
      continue;
    }

    let data;
    try {
      data = finalize(parseModelJSON(text), { date, slot });
      ({ errors: lastErrors } = validateSlot(data, { fileName }));
    } catch (e) {
      lastErrors = [`輸出不是合法的 JSON：${e.message}`];
    }

    if (!lastErrors.length) {
      const { warnings } = validateSlot(data, { fileName });
      warnings.forEach(w => console.warn(`  警告：${w}`));
      fs.mkdirSync(SLOTS_DIR, { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + "\n");
      const m = writeManifest();
      console.log(`✅ 已寫入 data/slots/${fileName}（第 ${attempt} 次嘗試）；manifest 共 ${m.days.length} 天`);
      return;
    }

    console.warn(`第 ${attempt} 次輸出沒通過檢查（${lastErrors.length} 個錯誤）：`);
    lastErrors.slice(0, 15).forEach(e => console.warn(`  - ${e}`));
    if (args.mock) break;
    contents.push({ role: "model", parts: [{ text }] });
    contents.push({ role: "user", parts: [{ text: `上面的 JSON 沒有通過格式檢查，錯誤如下：\n${lastErrors.map(e => "- " + e).join("\n")}\n\n請修正所有錯誤，重新輸出完整的 JSON（只輸出 JSON）。` }] });
  }
  throw new Error(`嘗試 ${args.mock ? 1 : MAX_ATTEMPTS} 次都沒有產生合格的內容，不寫入任何檔案`);
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
