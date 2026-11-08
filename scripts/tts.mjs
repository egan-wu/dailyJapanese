// 用 Google Cloud Text-to-Speech 幫文章產生朗讀音檔，並清掉過期的音檔。
//
//   GOOGLE_TTS_API_KEY=... node scripts/tts.mjs
//
// 預設行為：
//   1. 最近 AUDIO_KEEP_DAYS 天（預設 30）內、還沒有音檔或內容改過的時段 → 產生音檔
//   2. 超過保留天數的音檔 → 刪除，文章改回瀏覽器語音
//
// 參數：
//   --only 2026-11-08_0800   只處理這個時段（可重複）
//   --force                  已有音檔也重新產生
//   --prune-only             只清除過期音檔，不呼叫 API
//   --mock                   不呼叫 API，產生測試用的提示音（WAV），用來測試流程
//
// 環境變數：
//   GOOGLE_TTS_API_KEY       Cloud TTS 的 API Key（沒設定時只做清除，不會失敗）
//   TTS_VOICE_NARRATOR       文章朗讀聲音，預設 ja-JP-Neural2-B（女聲）
//   TTS_VOICE_A / TTS_VOICE_B 對話中第 1、2 位說話者，預設 ja-JP-Neural2-B / ja-JP-Neural2-C
//   AUDIO_KEEP_DAYS          音檔保留天數，預設 30
//   TTS_USE_FURIGANA         true＝依頁面振假名指定讀音（預設 false，直接送漢字較自然）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseMarkup } from "../assets/markup.js";
import { scanSlots, writeManifest, SLOTS_DIR } from "./build-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIO_DIR = path.join(ROOT, "data", "audio");
const MAX_SLOTS_PER_RUN = 12;
const MAX_SSML_BYTES = 4800; // Cloud TTS 單次上限 5000 bytes

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const VOICES = {
  narrator: env("TTS_VOICE_NARRATOR", "ja-JP-Neural2-B"),
  speakers: [env("TTS_VOICE_A", "ja-JP-Neural2-B"), env("TTS_VOICE_B", "ja-JP-Neural2-C")]
};
const KEEP_DAYS = Number(env("AUDIO_KEEP_DAYS", "30"));

function parseArgs(argv) {
  const a = { only: [], force: false, pruneOnly: false, mock: false };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--only") a.only.push(argv[++i]);
    else if (x === "--force") a.force = true;
    else if (x === "--prune-only") a.pruneOnly = true;
    else if (x === "--mock") a.mock = true;
    else throw new Error(`未知的參數：${x}`);
  }
  return a;
}

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const escXml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

// 預設直接送漢字原文（TTS 的重音和斷詞比較自然）。
// TTS_USE_FURIGANA=true 時，把振假名轉成 <sub alias="かな">漢字</sub>，強制讀音和頁面一致；
// 相鄰的振假名會合併成一個詞，例如 {十|じゅう}{時|じ} → <sub alias="じゅうじ">十時</sub>。
const USE_FURIGANA = env("TTS_USE_FURIGANA", "false") === "true";

export function markupToSsml(text, useFurigana = USE_FURIGANA) {
  const flat = [];
  const collect = toks => toks.forEach(t => (t.type === "hl" ? collect(t.children) : flat.push(t)));
  collect(parseMarkup(text).tokens);
  let out = "";
  for (let i = 0; i < flat.length; i++) {
    const t = flat[i];
    if (t.type === "text") { out += escXml(t.text); continue; }
    if (!useFurigana) { out += escXml(t.base); continue; }
    let base = t.base, rt = t.rt;
    while (flat[i + 1] && flat[i + 1].type === "ruby") { i++; base += flat[i].base; rt += flat[i].rt; }
    out += `<sub alias="${escXml(rt)}">${escXml(base)}</sub>`;
  }
  return `<speak>${out}</speak>`;
}

function slotId(data) { return `${data.date}_${data.slot.replace(":", "")}`; }

// 用來判斷文章或聲音設定改過之後要不要重做
function audioHash(data) {
  const h = crypto.createHash("sha1");
  h.update(JSON.stringify({ v: VOICES, f: USE_FURIGANA, d: data.dialogue.lines.map(l => [l.speaker, l.jp]), a: data.article.paragraphs }));
  return h.digest("hex").slice(0, 12);
}

function speakerVoiceMap(lines) {
  const speakers = [...new Set(lines.map(l => l.speaker))];
  return Object.fromEntries(speakers.map((s, i) => [s, VOICES.speakers[i % VOICES.speakers.length]]));
}

async function synthesize(ssml, voiceName) {
  if (Buffer.byteLength(ssml, "utf8") > MAX_SSML_BYTES) throw new Error(`單段文字太長（超過 ${MAX_SSML_BYTES} bytes）`);
  const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GOOGLE_TTS_API_KEY },
    body: JSON.stringify({
      input: { ssml },
      voice: { languageCode: "ja-JP", name: voiceName },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 }
    })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Cloud TTS ${res.status}：${body.slice(0, 400)}`);
  const json = JSON.parse(body);
  if (!json.audioContent) throw new Error("Cloud TTS 沒有回傳音訊");
  return Buffer.from(json.audioContent, "base64");
}

// 測試用：產生 0.6 秒的提示音 WAV（不同聲音用不同音高）
function mockWav(voiceName) {
  const rate = 8000, secs = 0.6, n = Math.floor(rate * secs);
  const freq = voiceName.endsWith("C") ? 330 : 523;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 8000 * Math.min(1, (n - i) / 400)), 44 + i * 2);
  return buf;
}

async function makeAudio(data, { mock }) {
  const id = slotId(data);
  const dir = path.join(AUDIO_DIR, id);
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const ext = mock ? "wav" : "mp3";
  const voiceOf = speakerVoiceMap(data.dialogue.lines);
  const synth = (text, voice) => mock ? Promise.resolve(mockWav(voice)) : synthesize(markupToSsml(text), voice);

  const out = { provider: mock ? "mock" : "google-cloud-tts", hash: audioHash(data), dialogue: [], article: [] };
  let chars = 0;
  for (const [i, line] of data.dialogue.lines.entries()) {
    const name = `d${String(i + 1).padStart(2, "0")}.${ext}`;
    fs.writeFileSync(path.join(tmp, name), await synth(line.jp, voiceOf[line.speaker]));
    out.dialogue.push(`data/audio/${id}/${name}`);
    chars += line.jp.length;
  }
  for (const [i, para] of data.article.paragraphs.entries()) {
    const name = `p${String(i + 1).padStart(2, "0")}.${ext}`;
    fs.writeFileSync(path.join(tmp, name), await synth(para, VOICES.narrator));
    out.article.push(`data/audio/${id}/${name}`);
    chars += para.length;
  }
  // 全部成功才替換，避免留下一半的音檔
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return { audio: out, chars };
}

function writeSlot(file, data) {
  fs.writeFileSync(path.join(SLOTS_DIR, file), JSON.stringify(data, null, 2) + "\n");
}

function audioFilesExist(audio) {
  return [...(audio.dialogue || []), ...(audio.article || [])].every(p => fs.existsSync(path.join(ROOT, p)));
}

async function main() {
  const args = parseArgs(process.argv);
  const cutoff = addDays(taipeiToday(), -(KEEP_DAYS - 1));
  const results = scanSlots().filter(r => !r.errors.length && r.data);
  let changed = false;

  // 1. 清除過期音檔
  for (const r of results) {
    if (r.data.date >= cutoff || !r.data.audio) continue;
    fs.rmSync(path.join(AUDIO_DIR, slotId(r.data)), { recursive: true, force: true });
    delete r.data.audio;
    writeSlot(r.file, r.data);
    changed = true;
    console.log(`🧹 刪除過期音檔：${r.file}`);
  }
  // 沒有對應文章的音檔資料夾也刪掉
  if (fs.existsSync(AUDIO_DIR)) {
    const keep = new Set(results.filter(r => r.data.audio).map(r => slotId(r.data)));
    for (const d of fs.readdirSync(AUDIO_DIR)) {
      if (!keep.has(d)) { fs.rmSync(path.join(AUDIO_DIR, d), { recursive: true, force: true }); console.log(`🧹 刪除多餘的音檔資料夾：${d}`); }
    }
  }

  // 2. 產生缺少的音檔
  if (!args.pruneOnly) {
    if (!args.mock && !process.env.GOOGLE_TTS_API_KEY) {
      console.log("沒有設定 GOOGLE_TTS_API_KEY，略過產生音檔（網頁會使用瀏覽器語音）");
    } else {
      const todo = results
        .filter(r => (args.only.length ? args.only.includes(slotId(r.data)) : r.data.date >= cutoff))
        .filter(r => args.force || !r.data.audio || r.data.audio.hash !== audioHash(r.data) || !audioFilesExist(r.data.audio))
        .sort((a, b) => b.file.localeCompare(a.file))
        .slice(0, MAX_SLOTS_PER_RUN);
      if (!todo.length) console.log("所有時段都已經有音檔");
      let failed = 0, totalChars = 0;
      for (const r of todo) {
        try {
          const { audio, chars } = await makeAudio(r.data, args);
          r.data.audio = audio;
          writeSlot(r.file, r.data);
          changed = true;
          totalChars += chars;
          console.log(`🔊 ${r.file}：${audio.dialogue.length} 句對話＋${audio.article.length} 段文章`);
        } catch (e) {
          failed++;
          console.error(`❌ ${r.file} 產生音檔失敗：${e.message}`);
        }
      }
      if (totalChars) console.log(`本次約送出 ${totalChars} 字（含標記）`);
      if (failed && failed === todo.length) process.exitCode = 1;
    }
  }

  if (changed) writeManifest();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
}
