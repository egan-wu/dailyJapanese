// =============================================================================
// 日日讀日文 YomuHi — 主程式
// 資料來源：data/manifest.json（文章清單）＋ data/slots/*.json（每個時段一個檔）
// =============================================================================
import { toHtml, toPlain, charCount, escapeHtml as esc } from "./markup.js";

const SLOT_ORDER = ["08:00", "17:00", "22:00"];
const SLOT_META = {
  "08:00": { periodName: "晨間篇", icon: "🌅" },
  "17:00": { periodName: "午後篇", icon: "🌇" },
  "22:00": { periodName: "夜間篇", icon: "🌙" }
};
const RECENT_DAYS = 3;
// 計時參考：每分鐘閱讀字數（粗估，含思考時間另計每題 1 分鐘）
const READING_SPEED = { N1: 250, N2: 200, N3: 150, N4: 120, N5: 100 };
// 單字複習間隔（天），依熟練度 box 0～6
const SRS_INTERVALS = [1, 2, 4, 7, 15, 30, 60];

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const state = {
  manifest: null,
  activeDate: null,
  activeSlotKey: null,
  archiveDate: null,          // 從歷史存檔選的日期（不在最新 3 天內）
  slot: null,                 // 目前時段的資料
  showFurigana: false,
  showExamHighlight: true,
  hlLevels: { N1: true, N2: true, N3: true },
  expandAllTranslations: false,
  dialogueTransOpen: false,
  articleTransOpen: false,
  zone1Open: false,
  zone2Open: false,
  largeFont: false,
  speechRate: 0.95,
  selectedVoiceURI: "auto",
  openaiKey: "",
  completedSlots: {},
  savedVocab: [],
  quizResults: {},            // slotId -> { answers, correct, total, seconds, at }
  activity: {},               // "YYYY-MM-DD" -> true（有讀完或作答的日子）
  quizDraft: {},              // 目前作答中的選擇
  timer: { running: false, start: 0, elapsed: 0, handle: null },
  vocabTab: "review",
  reviewQueue: [],
  reviewShowAnswer: false
};

const slotCache = new Map();

// -----------------------------------------------------------------------------
// Storage（localStorage 失敗時照常運作，只是不會記住）
// -----------------------------------------------------------------------------
function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); } catch (e) {}
}

function loadSavedState() {
  state.completedSlots = readJSON("yomuhi_completed_slots", {});
  state.savedVocab = readJSON("yomuhi_saved_vocab", []).map(normalizeSavedVocab);
  state.quizResults = readJSON("yomuhi_quiz", {});
  state.activity = readJSON("yomuhi_activity", {});
  try { state.openaiKey = localStorage.getItem("yomuhi_openai_key") || ""; } catch (e) {}
  const prefs = readJSON("yomuhi_prefs", {});
  if (prefs.hlLevels) state.hlLevels = { ...state.hlLevels, ...prefs.hlLevels };
  if (typeof prefs.speechRate === "number") state.speechRate = prefs.speechRate;
  if (prefs.selectedVoiceURI) state.selectedVoiceURI = prefs.selectedVoiceURI;
  if (typeof prefs.largeFont === "boolean") state.largeFont = prefs.largeFont;
}

function saveState() {
  writeJSON("yomuhi_completed_slots", state.completedSlots);
  writeJSON("yomuhi_saved_vocab", state.savedVocab);
  writeJSON("yomuhi_quiz", state.quizResults);
  writeJSON("yomuhi_activity", state.activity);
  writeJSON("yomuhi_openai_key", state.openaiKey || "");
  writeJSON("yomuhi_prefs", {
    hlLevels: state.hlLevels,
    speechRate: state.speechRate,
    selectedVoiceURI: state.selectedVoiceURI,
    largeFont: state.largeFont
  });
}

// 舊版收藏的單字是「先方（せんぽう）」這種格式，轉成 word + reading
function normalizeSavedVocab(v) {
  const out = { box: 0, due: todayStr(), ...v };
  if (!out.reading) {
    const m = String(out.word || "").match(/^(.*?)（([^）]*)）$/);
    if (m) { out.word = m[1]; out.reading = m[2]; }
  }
  if (out.level && !/^N[1-5]$/.test(out.level)) {
    const m = String(out.level).match(/N[1-5]/);
    out.level = m ? m[0] : "";
  }
  return out;
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------
function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayStr() { return dateStr(new Date()); }
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return dateStr(new Date(y, m - 1, d + n));
}
function dayLabel(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日（週${dow}）`;
}
function dayBadge(ymd, idx) {
  const t = todayStr();
  if (ymd === t) return "今日";
  if (ymd === addDays(t, -1)) return "昨日";
  if (idx === 0) return "最新";
  return state.archiveDate === ymd ? "存檔" : "前日";
}

function markActivity() {
  state.activity[todayStr()] = true;
}
function calcStreak() {
  let d = todayStr();
  if (!state.activity[d]) d = addDays(d, -1); // 今天還沒讀不會中斷連續紀錄
  let n = 0;
  while (state.activity[d]) { n++; d = addDays(d, -1); }
  return n;
}

// -----------------------------------------------------------------------------
// Data loading
// -----------------------------------------------------------------------------
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}：HTTP ${res.status}`);
  return res.json();
}

async function loadManifest() {
  state.manifest = await fetchJSON("data/manifest.json");
  if (!Array.isArray(state.manifest.days)) throw new Error("manifest.json 格式錯誤");
}

function findDay(date) {
  return state.manifest.days.find(d => d.date === date) || null;
}

function visibleDays() {
  const days = state.manifest.days.slice(0, RECENT_DAYS);
  if (state.archiveDate && !days.some(d => d.date === state.archiveDate)) {
    const extra = findDay(state.archiveDate);
    if (extra) days.push(extra);
  }
  return days;
}

async function loadSlot(date, key) {
  const id = getSlotId(date, key);
  if (slotCache.has(id)) return slotCache.get(id);
  const meta = findDay(date)?.slots?.[key];
  if (!meta) return null;
  const data = await fetchJSON(meta.file);
  slotCache.set(id, data);
  return data;
}

function getSlotId(date, key) { return `${date}_${key}`; }
function currentSlotId() { return getSlotId(state.activeDate, state.activeSlotKey); }

function latestSlotKey(day) {
  const keys = SLOT_ORDER.filter(k => day.slots[k]);
  return keys[keys.length - 1] || null;
}

// -----------------------------------------------------------------------------
// UI helpers
// -----------------------------------------------------------------------------
const $ = id => document.getElementById(id);

function showToast(msg) {
  const toast = $("toast-msg");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  if (window._toastTimer) clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function levelOfArticle(level) {
  const m = String(level || "").match(/N[1-5]/g);
  return m ? m.sort()[0] : "N2";
}

// -----------------------------------------------------------------------------
// Voice (Web Speech + optional OpenAI)
// -----------------------------------------------------------------------------
let availableJpVoices = [];
let currentAudioObj = null;
let isPopulatingVoices = false;
let ttsLoading = false;
let cloudPlaying = false;

function scoreJapaneseVoice(v) {
  const name = (v.name || "").toLowerCase();
  let score = 0;
  if (name.includes("natural") || name.includes("online")) score += 50;
  if (name.includes("nanami") || name.includes("keita")) score += 40;
  if (name.includes("google") && name.includes("日本語")) score += 35;
  if (name.includes("kyoko") || name.includes("otoya") || name.includes("siri")) score += 30;
  if (name.includes("enhanced") || name.includes("premium")) score += 20;
  if (!v.localService) score += 10;
  return score;
}

function populateVoices() {
  if (!("speechSynthesis" in window) || isPopulatingVoices) return;
  isPopulatingVoices = true;
  try {
    const allVoices = window.speechSynthesis.getVoices() || [];
    availableJpVoices = allVoices
      .filter(v => v.lang && (v.lang.toLowerCase().startsWith("ja") || v.name.includes("日本語") || v.name.includes("Japanese")))
      .sort((a, b) => scoreJapaneseVoice(b) - scoreJapaneseVoice(a));
    const sel = $("select-jp-voice");
    if (sel) {
      sel.innerHTML = `<option value="auto">✨ 自動優選最自然日文語音（推薦）</option>`;
      availableJpVoices.forEach(v => {
        const opt = document.createElement("option");
        opt.value = v.voiceURI;
        opt.textContent = `${scoreJapaneseVoice(v) >= 30 ? "🌟 " : ""}${v.name} (${v.lang})`;
        sel.appendChild(opt);
      });
      sel.value = [...sel.options].some(o => o.value === state.selectedVoiceURI) ? state.selectedVoiceURI : "auto";
    }
    $("voice-none-hint")?.classList.toggle("hidden", availableJpVoices.length > 0);
    updateVoiceTagLabels();
  } catch (e) {
    // 某些環境存取 speechSynthesis 會出錯，忽略即可
  } finally {
    isPopulatingVoices = false;
  }
}

function getPreferredVoice(speakerIndex = 0) {
  if (availableJpVoices.length === 0) populateVoices();
  const isAlt = speakerIndex % 2 === 1;
  if (state.selectedVoiceURI !== "auto") {
    const found = availableJpVoices.find(v => v.voiceURI === state.selectedVoiceURI);
    if (found) {
      if (!isAlt) return found;
      return availableJpVoices.find(v => v.voiceURI !== found.voiceURI) || found;
    }
  }
  if (availableJpVoices.length > 1 && isAlt) return availableJpVoices[1];
  return availableJpVoices[0] || null;
}

function updateVoiceTagLabels() {
  let label = "系統日文語音";
  if (state.slot?.audio) label = "✨ Google 雲端語音";
  else if (state.openaiKey && state.openaiKey.startsWith("sk-")) label = "✨ OpenAI AI 語音";
  else {
    const v = getPreferredVoice(0);
    if (v) label = `聲線：${v.name.replace(/Microsoft |Online \(Natural\) - Japanese \(Japan\)/g, "").trim()}`;
    else if ("speechSynthesis" in window) label = "⚠️ 找不到日文語音";
  }
  ["current-voice-tag-1", "current-voice-tag-2"].forEach(id => { const t = $(id); if (t) t.textContent = `${label} (${state.speechRate}x)`; });
}

function releaseAudio() {
  if (currentAudioObj && currentAudioObj._blobUrl) URL.revokeObjectURL(currentAudioObj._blobUrl);
  currentAudioObj = null;
}

function stopSpeech() {
  window._speechCancelled = true;
  cloudPlaying = false;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (currentAudioObj) { currentAudioObj.pause(); releaseAudio(); }
  document.querySelectorAll(".speaking-active").forEach(el => el.classList.remove("speaking-active"));
  const btnDlg = $("btn-speak-dialogue");
  const btnArt = $("btn-speak-article");
  if (btnDlg) btnDlg.innerHTML = "<span>🔊 朗讀對話</span>";
  if (btnArt) btnArt.innerHTML = "<span>🔊 朗讀專欄</span>";
}

async function speakWithOpenAI(text, sentences, domElements, btnElement, defaultLabel, alternatePitch) {
  ttsLoading = true;
  try {
    btnElement.innerHTML = "<span>⏳ 生成 AI 語音中...</span>";
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": `Bearer ${state.openaiKey.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "nova", input: text, speed: state.speechRate })
    });
    if (!resp.ok) throw new Error("API request failed");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio._blobUrl = url;
    currentAudioObj = audio;
    btnElement.innerHTML = "<span>⏹ 停止朗讀</span>";
    audio.onended = () => {
      btnElement.innerHTML = `<span>${defaultLabel}</span>`;
      if (currentAudioObj === audio) releaseAudio();
    };
    ttsLoading = false;
    await audio.play();
  } catch (e) {
    ttsLoading = false;
    if (currentAudioObj) releaseAudio();
    showToast("OpenAI 語音呼叫失敗，已改用瀏覽器內建語音");
    btnElement.innerHTML = `<span>${defaultLabel}</span>`;
    speakSentencesSequentially(sentences, domElements, btnElement, defaultLabel, alternatePitch, true);
  }
}

function speakSentencesSequentially(sentences, domElements, btnElement, defaultLabel, alternatePitch = false, skipOpenAI = false) {
  if (ttsLoading) return;
  if (("speechSynthesis" in window && window.speechSynthesis.speaking) || currentAudioObj) { stopSpeech(); return; }
  if (!skipOpenAI && state.openaiKey && state.openaiKey.trim().startsWith("sk-")) {
    speakWithOpenAI(sentences.join("。\n"), sentences, domElements, btnElement, defaultLabel, alternatePitch);
    return;
  }
  if (!("speechSynthesis" in window)) {
    showToast("您的瀏覽器不支援語音合成功能");
    btnElement.innerHTML = `<span>${defaultLabel}</span>`;
    return;
  }
  // 沒有日文語音時，瀏覽器會改用系統預設語音（常常是中文）把日文念成中文，所以直接擋下並說明
  if (availableJpVoices.length === 0) populateVoices();
  if (availableJpVoices.length === 0) {
    btnElement.innerHTML = `<span>${defaultLabel}</span>`;
    showToast("找不到日文語音，已停止朗讀（不然會被念成中文）");
    $("voice-modal").classList.remove("hidden");
    return;
  }

  window._speechCancelled = false;
  btnElement.innerHTML = "<span>⏹ 停止朗讀</span>";
  let idx = 0;
  const clearActive = () => document.querySelectorAll(".speaking-active").forEach(el => el.classList.remove("speaking-active"));

  function nextLine() {
    if (window._speechCancelled || idx >= sentences.length) {
      clearActive();
      btnElement.innerHTML = `<span>${defaultLabel}</span>`;
      return;
    }
    clearActive();
    if (domElements[idx]) domElements[idx].classList.add("speaking-active");
    const utter = new SpeechSynthesisUtterance(sentences[idx]);
    utter.lang = "ja-JP";
    const voice = getPreferredVoice(alternatePitch ? idx : 0);
    if (voice) utter.voice = voice;
    utter.rate = state.speechRate;
    if (alternatePitch) utter.pitch = (idx % 2 === 0) ? 1.03 : 0.94;
    utter.onend = () => { idx++; if (!window._speechCancelled) setTimeout(nextLine, 320); };
    utter.onerror = () => { clearActive(); btnElement.innerHTML = `<span>${defaultLabel}</span>`; };
    window.speechSynthesis.speak(utter);
  }
  nextLine();
}

// 朗讀入口：有雲端音檔（scripts/tts.mjs 產生）就播音檔，否則用 OpenAI／瀏覽器語音
function startReading(kind, btn, label) {
  if (ttsLoading) return;
  if (cloudPlaying || ("speechSynthesis" in window && window.speechSynthesis.speaking) || currentAudioObj) { stopSpeech(); return; }
  const slot = state.slot;
  if (!slot) return;
  const isDialogue = kind === "dialogue";
  const sentences = isDialogue ? slot.dialogue.lines.map(l => toPlain(l.jp)) : slot.article.paragraphs.map(toPlain);
  const els = Array.from(document.querySelectorAll(isDialogue ? ".dialogue-line-item" : ".article-para-item"));
  const urls = slot.audio?.[kind];
  if (Array.isArray(urls) && urls.length === sentences.length) playAudioSequence(urls, sentences, els, btn, label, isDialogue);
  else speakSentencesSequentially(sentences, els, btn, label, isDialogue);
}

function playAudioSequence(urls, sentences, els, btn, label, isDialogue) {
  window._speechCancelled = false;
  cloudPlaying = true;
  btn.innerHTML = "<span>⏹ 停止朗讀</span>";
  let idx = 0;
  let failed = false;
  const clearActive = () => document.querySelectorAll(".speaking-active").forEach(el => el.classList.remove("speaking-active"));
  const finish = () => {
    cloudPlaying = false;
    currentAudioObj = null;
    clearActive();
    btn.innerHTML = `<span>${label}</span>`;
  };
  const fallback = () => {
    if (failed || window._speechCancelled) return;
    failed = true;
    finish();
    showToast("雲端音檔播放失敗，改用瀏覽器語音");
    speakSentencesSequentially(sentences.slice(idx), els.slice(idx), btn, label, isDialogue, true);
  };
  const next = () => {
    if (window._speechCancelled || !cloudPlaying) return;
    if (idx >= urls.length) { finish(); return; }
    clearActive();
    els[idx]?.classList.add("speaking-active");
    const audio = new Audio(urls[idx]);
    audio.playbackRate = state.speechRate;
    currentAudioObj = audio;
    audio.onended = () => {
      if (currentAudioObj !== audio) return;
      currentAudioObj = null;
      idx++;
      setTimeout(next, isDialogue ? 300 : 450);
    };
    audio.onerror = fallback;
    audio.play().catch(fallback);
    // 預先載入下一段，減少段落間的停頓
    if (urls[idx + 1]) { const pre = new Audio(); pre.preload = "auto"; pre.src = urls[idx + 1]; }
  };
  next();
}

// -----------------------------------------------------------------------------
// Rendering: navigation
// -----------------------------------------------------------------------------
function renderDayTabs() {
  const container = $("day-tabs-container");
  const days = visibleDays();
  container.className = `grid ${days.length > 3 ? "grid-cols-4" : "grid-cols-3"} gap-2`;
  container.innerHTML = "";

  days.forEach((dayObj, idx) => {
    const isActive = dayObj.date === state.activeDate;
    const keys = SLOT_ORDER.filter(k => dayObj.slots[k]);
    const doneCount = keys.filter(k => state.completedSlots[getSlotId(dayObj.date, k)]).length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.className = isActive
      ? "p-2.5 sm:p-3 rounded-xl bg-emerald-900 text-white shadow-xs border border-emerald-950 flex flex-col items-center sm:items-start justify-between cursor-pointer transition"
      : "p-2.5 sm:p-3 rounded-xl bg-stone-50 hover:bg-stone-100 text-stone-800 border border-stone-200 flex flex-col items-center sm:items-start justify-between cursor-pointer transition";
    btn.innerHTML = `
      <div class="flex items-center justify-between w-full gap-1">
        <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${isActive ? "bg-amber-400 text-stone-950" : "bg-stone-200 text-stone-700"}">${esc(dayBadge(dayObj.date, idx))}</span>
        <span class="text-[10px] font-semibold ${isActive ? "text-emerald-200" : "text-stone-500"}">${doneCount}/${keys.length}</span>
      </div>
      <div class="text-xs sm:text-sm font-bold mt-1.5 truncate">${esc(dayLabel(dayObj.date))}</div>`;
    btn.addEventListener("click", () => selectSlot(dayObj.date, state.activeDate === dayObj.date ? state.activeSlotKey : latestSlotKey(dayObj)));
    container.appendChild(btn);
  });

  const allKeys = days.flatMap(d => SLOT_ORDER.filter(k => d.slots[k]).map(k => getSlotId(d.date, k)));
  const done = allKeys.filter(id => state.completedSlots[id]).length;
  $("progress-counter").textContent = `已完成 ${done} / ${allKeys.length} 則`;
}

function renderSlotTabs() {
  const container = $("slot-tabs-container");
  container.innerHTML = "";
  const day = findDay(state.activeDate);
  SLOT_ORDER.forEach(key => {
    const meta = SLOT_META[key];
    const available = !!day?.slots?.[key];
    const isActive = key === state.activeSlotKey;
    const isDone = !!state.completedSlots[getSlotId(state.activeDate, key)];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.disabled = !available;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.className = !available
      ? "py-2 px-2 rounded-lg text-stone-400 flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 cursor-not-allowed"
      : isActive
        ? "py-2 px-2 rounded-lg bg-white text-stone-900 shadow-xs border border-stone-200/90 flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 cursor-pointer transition"
        : "py-2 px-2 rounded-lg text-stone-600 hover:text-stone-900 hover:bg-white/50 flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 cursor-pointer transition";
    btn.innerHTML = `
      <span class="text-sm leading-none">${meta.icon}</span>
      <span class="text-xs sm:text-sm font-bold">${key} ${available ? meta.periodName : "尚未更新"}${isDone ? " ✓" : ""}</span>`;
    if (available) btn.addEventListener("click", () => selectSlot(state.activeDate, key));
    container.appendChild(btn);
  });
}

function renderArchiveSelect() {
  const sel = $("archive-select");
  const older = state.manifest.days.slice(RECENT_DAYS);
  sel.innerHTML = `<option value="">${older.length ? "選擇日期…" : "目前沒有更早的文章"}</option>` +
    older.map(d => `<option value="${esc(d.date)}">${esc(dayLabel(d.date))}・${Object.keys(d.slots).length} 則</option>`).join("");
  sel.value = state.archiveDate && older.some(d => d.date === state.archiveDate) ? state.archiveDate : "";
  sel.disabled = older.length === 0;
  $("archive-count").textContent = `目前共 ${state.manifest.days.length} 天、${state.manifest.days.reduce((n, d) => n + Object.keys(d.slots).length, 0)} 則。`;
}

function renderStats() {
  $("stat-streak").textContent = String(calcStreak());
  const since = addDays(todayStr(), -6);
  // 完成日期存成字串；舊版存的是 true（不知道日期），不計入近 7 天
  const completedRecent = Object.values(state.completedSlots).filter(v => typeof v === "string" && v >= since).length;
  $("stat-week").textContent = String(completedRecent);
  const results = Object.values(state.quizResults);
  const total = results.reduce((n, r) => n + r.total, 0);
  const correct = results.reduce((n, r) => n + r.correct, 0);
  $("stat-accuracy").textContent = total ? `${Math.round(correct / total * 100)}%` : "—";
  $("stat-due").textContent = String(dueVocab().length);
}

function renderActiveSlotHeader() {
  const meta = SLOT_META[state.activeSlotKey];
  const slotId = currentSlotId();
  const isDone = !!state.completedSlots[slotId];
  const header = $("active-slot-header");
  header.innerHTML = `
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5 text-[11px] text-emerald-200">
        <span class="font-mono">${esc(state.activeDate)}</span><span>•</span>
        <span class="font-semibold text-amber-300">${meta.icon} ${state.activeSlotKey} ${meta.periodName}</span>
      </div>
      <p class="text-xs sm:text-sm font-bold text-white truncate mt-0.5">${esc(state.slot?.theme || "")}</p>
    </div>
    <button id="btn-mark-complete" type="button"
      class="shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${isDone ? "bg-emerald-700 text-amber-200 border border-emerald-500" : "bg-amber-400 text-stone-950 hover:bg-amber-300"}">
      ${isDone ? "✓ 已完成" : "○ 打卡完成"}
    </button>`;
  $("btn-mark-complete").addEventListener("click", () => {
    setCompleted(slotId, !state.completedSlots[slotId]);
    showToast(state.completedSlots[slotId] ? "已標記本時段為完成閱讀！" : "已取消完成標記");
  });
}

function setCompleted(slotId, done) {
  // 存完成日期（字串）以便統計近 7 天；舊資料是 true 也相容
  if (done) { state.completedSlots[slotId] = todayStr(); markActivity(); }
  else delete state.completedSlots[slotId];
  saveState();
  renderDayTabs();
  renderSlotTabs();
  renderActiveSlotHeader();
  renderStats();
}

function updateAccordionUI() {
  const zones = [
    ["zone1-body", "zone1-status-pill", "btn-accordion-zone1", state.zone1Open, "收合第一區 ▲", "bg-amber-900"],
    ["zone2-body", "zone2-status-pill", "btn-accordion-zone2", state.zone2Open, "收合第二區 ▲", "bg-emerald-900"]
  ];
  zones.forEach(([bodyId, pillId, btnId, open, openText, color]) => {
    $(bodyId).classList.toggle("hidden", !open);
    $(btnId).setAttribute("aria-expanded", open ? "true" : "false");
    const pill = $(pillId);
    pill.textContent = open ? openText : "點擊展開 ▼";
    pill.className = open
      ? "shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold bg-stone-200 text-stone-800"
      : `shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold ${color} text-white shadow-2xs`;
  });
  $("btn-expand-collapse-both").textContent = state.zone1Open && state.zone2Open ? "收合兩大區塊 ▲" : "展開兩大區塊 ▼";
}

function bindExamHighlightClicks(container) {
  container.querySelectorAll(".exam-hl").forEach(el => {
    el.addEventListener("click", e => {
      e.stopPropagation();
      if (!state.showExamHighlight) return;
      const tip = el.getAttribute("data-tip") || el.textContent;
      $("exam-tip-text").textContent = tip;
      showToast(`🖍️ ${tip}`);
    });
  });
}

// -----------------------------------------------------------------------------
// Vocabulary + spaced repetition
// -----------------------------------------------------------------------------
function isVocabSaved(word) { return state.savedVocab.some(item => item.word === word); }

function toggleSaveVocab(v, sourceLabel) {
  const idx = state.savedVocab.findIndex(item => item.word === v.word);
  if (idx >= 0) {
    state.savedVocab.splice(idx, 1);
    showToast(`已從單字本移除：${v.word}`);
  } else {
    state.savedVocab.push({ word: v.word, reading: v.reading || "", level: v.level, meaning: v.meaning, source: sourceLabel, box: 0, due: todayStr() });
    showToast(`★ 已加入單字本：${v.word}（今天開始複習）`);
  }
  saveState();
  updateVocabBadge();
  renderVocabLists();
  renderStats();
}

function updateVocabBadge() { $("badge-vocab-count").textContent = String(state.savedVocab.length); }

function dueVocab() {
  const t = todayStr();
  return state.savedVocab.filter(v => !v.due || v.due <= t);
}

function vocabCardHtml(v, saved, big = false) {
  return `
    <div>
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="font-bold text-rose-950 ${big ? "text-sm" : ""} bg-rose-100 px-1.5 py-0.5 rounded jp-sans">${esc(v.word)}</span>
        ${v.reading ? `<span class="text-[11px] text-stone-500 jp-sans">${esc(v.reading)}</span>` : ""}
        ${v.level ? `<span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200 text-[10px] font-bold">${esc(v.level)}${v.type ? "・" + esc(v.type) : ""}</span>` : ""}
      </div>
      <p class="text-stone-600 mt-1 leading-relaxed">${esc(v.meaning)}</p>
    </div>
    <button type="button" class="shrink-0 px-2 py-1 rounded text-xs font-bold cursor-pointer ${saved ? "bg-amber-100 text-amber-800" : "text-stone-400 hover:text-amber-600"}" title="加入或移除單字本">${saved ? "★" : "☆"}</button>`;
}

function renderVocabLists() {
  const slot = state.slot;
  if (!slot) return;
  const sourceTag = `${state.activeDate} ${state.activeSlotKey}`;
  const fill = (containerId, list, cls, big) => {
    const c = $(containerId);
    c.innerHTML = "";
    (list || []).forEach(v => {
      const item = document.createElement("div");
      item.className = cls;
      item.innerHTML = vocabCardHtml(v, isVocabSaved(v.word), big);
      item.querySelector("button").addEventListener("click", () => toggleSaveVocab(v, sourceTag));
      c.appendChild(item);
    });
  };
  fill("dialogue-vocab-list", slot.dialogue.vocab, "flex items-start justify-between gap-2 p-2.5 rounded-xl bg-white border border-rose-200/80 text-xs", false);
  fill("article-vocab-grid", slot.article.vocab, "flex items-start justify-between gap-2 p-3 rounded-xl bg-white border border-rose-200/90 text-xs shadow-2xs", true);
}

function renderVocabModal() {
  const isReview = state.vocabTab === "review";
  $("vocab-review-pane").classList.toggle("hidden", !isReview);
  $("vocab-list-pane").classList.toggle("hidden", isReview);
  $("tab-vocab-review").className = `px-3 py-1 rounded-md font-semibold cursor-pointer ${isReview ? "bg-stone-200 text-stone-900" : "text-stone-600"}`;
  $("tab-vocab-list").className = `px-3 py-1 rounded-md font-semibold cursor-pointer ${!isReview ? "bg-stone-200 text-stone-900" : "text-stone-600"}`;
  if (isReview) renderReviewPane(); else renderSavedList();
}

function renderSavedList() {
  const container = $("vocab-list-pane");
  if (state.savedVocab.length === 0) {
    container.innerHTML = `<div class="text-center py-8 text-stone-400 text-xs space-y-1">
      <p class="text-base">尚未收藏任何單字</p><p>閱讀時點擊單字卡右側的「☆」即可加入，並自動排入複習。</p></div>`;
    return;
  }
  const t = todayStr();
  container.innerHTML = "";
  state.savedVocab.forEach((v, idx) => {
    const item = document.createElement("div");
    item.className = "p-3 rounded-xl bg-stone-50 border border-stone-200 flex items-start justify-between gap-2 text-xs";
    const due = !v.due || v.due <= t ? "今天複習" : `${v.due} 複習`;
    item.innerHTML = `
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-bold text-sm text-rose-950 bg-rose-100 px-1.5 py-0.5 rounded jp-sans">${esc(v.word)}</span>
          ${v.reading ? `<span class="text-[11px] text-stone-500 jp-sans">${esc(v.reading)}</span>` : ""}
          ${v.level ? `<span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200 text-[10px] font-bold">${esc(v.level)}</span>` : ""}
        </div>
        <p class="text-stone-600 mt-1">${esc(v.meaning)}</p>
        <p class="text-[10px] text-stone-400 mt-1">熟練度 ${v.box || 0}/6 ・ ${esc(due)} ・ 出自 ${esc(v.source || "")}</p>
      </div>
      <button type="button" class="text-stone-400 hover:text-rose-600 px-2 py-1 cursor-pointer" title="移除">✕</button>`;
    item.querySelector("button").addEventListener("click", () => {
      state.savedVocab.splice(idx, 1);
      saveState();
      updateVocabBadge();
      renderSavedList();
      renderVocabLists();
      renderStats();
    });
    container.appendChild(item);
  });
}

function startReview() {
  state.reviewQueue = dueVocab().map(v => v.word);
  state.reviewShowAnswer = false;
}

function renderReviewPane() {
  const pane = $("vocab-review-pane");
  const word = state.reviewQueue[0];
  const v = state.savedVocab.find(x => x.word === word);
  if (!v) {
    const next = state.savedVocab.map(x => x.due).filter(Boolean).sort()[0];
    pane.innerHTML = `<div class="text-center py-10 space-y-2">
      <p class="text-3xl">🎉</p>
      <p class="text-sm font-bold text-stone-800">${state.savedVocab.length ? "今天的複習完成了！" : "還沒有收藏的單字"}</p>
      <p class="text-xs text-stone-500">${state.savedVocab.length ? `下次複習：${esc(next || "—")}` : "閱讀時點擊單字卡的「☆」收藏，就會自動排入複習。"}</p>
    </div>`;
    return;
  }
  pane.innerHTML = `
    <div class="text-center text-[11px] text-stone-500 mb-3">剩下 ${state.reviewQueue.length} 個</div>
    <div class="rounded-2xl border border-stone-200 bg-stone-50 p-6 text-center space-y-3">
      <div class="text-2xl font-bold text-stone-900 jp-sans">${esc(v.word)}</div>
      ${state.reviewShowAnswer ? `
        <div class="text-sm text-stone-500 jp-sans">${esc(v.reading || "")}</div>
        <div class="text-sm text-stone-800 leading-relaxed">${esc(v.meaning)}</div>
        ${v.level ? `<div class="text-[11px] text-rose-800">${esc(v.level)}</div>` : ""}` : `<div class="text-xs text-stone-400">先想想讀音和意思</div>`}
    </div>
    <div class="mt-4 grid ${state.reviewShowAnswer ? "grid-cols-3" : "grid-cols-1"} gap-2">
      ${state.reviewShowAnswer ? `
        <button type="button" data-grade="0" class="py-2 rounded-xl text-xs font-bold bg-rose-100 text-rose-900 border border-rose-300 cursor-pointer">忘記了</button>
        <button type="button" data-grade="1" class="py-2 rounded-xl text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300 cursor-pointer">有點模糊</button>
        <button type="button" data-grade="2" class="py-2 rounded-xl text-xs font-bold bg-emerald-100 text-emerald-900 border border-emerald-300 cursor-pointer">記得</button>`
      : `<button type="button" id="btn-review-reveal" class="py-2 rounded-xl text-xs font-bold bg-emerald-900 text-white cursor-pointer">顯示答案</button>`}
    </div>`;
  $("btn-review-reveal")?.addEventListener("click", () => { state.reviewShowAnswer = true; renderReviewPane(); });
  pane.querySelectorAll("[data-grade]").forEach(b => b.addEventListener("click", () => gradeReview(v, Number(b.dataset.grade))));
}

function gradeReview(v, grade) {
  const t = todayStr();
  state.reviewQueue.shift();
  if (grade === 0) {            // 忘記：歸零，今天稍後再出一次
    v.box = 0;
    v.due = t;
    state.reviewQueue.push(v.word);
  } else if (grade === 1) {     // 模糊：明天再看
    v.due = addDays(t, 1);
  } else {                      // 記得：升級
    v.box = Math.min((v.box || 0) + 1, SRS_INTERVALS.length - 1);
    v.due = addDays(t, SRS_INTERVALS[v.box]);
  }
  state.reviewShowAnswer = false;
  markActivity();
  saveState();
  renderReviewPane();
  renderStats();
}

function openVocabModal(tab) {
  state.vocabTab = tab;
  if (tab === "review") startReview();
  renderVocabModal();
  $("vocab-modal").classList.remove("hidden");
}

// -----------------------------------------------------------------------------
// Reading timer
// -----------------------------------------------------------------------------
function referenceMinutes() {
  const art = state.slot?.article;
  if (!art) return 0;
  const chars = art.paragraphs.reduce((n, p) => n + charCount(p), 0);
  const speed = READING_SPEED[levelOfArticle(art.level)] || 200;
  return Math.max(1, Math.ceil(chars / speed + (art.questions?.length || 0)));
}

function fmtTime(sec) { return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`; }

function timerSeconds() {
  const t = state.timer;
  return Math.floor((t.elapsed + (t.running ? Date.now() - t.start : 0)) / 1000);
}

function renderTimer() {
  const btn = $("btn-timer");
  const ref = referenceMinutes();
  const sec = timerSeconds();
  if (!state.timer.running && sec === 0) {
    btn.innerHTML = `<span>⏱ 開始計時閱讀（參考 ${ref} 分）</span>`;
    btn.className = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-sky-900 text-white hover:bg-sky-800 shadow-2xs transition cursor-pointer";
    return;
  }
  const over = sec > ref * 60;
  btn.innerHTML = `<span>${state.timer.running ? "⏸" : "▶"} ${fmtTime(sec)} / 參考 ${ref}:00</span>`;
  btn.className = `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold font-mono shadow-2xs transition cursor-pointer ${over ? "bg-rose-700 text-white" : "bg-sky-100 text-sky-950 border border-sky-300"}`;
}

function toggleTimer() {
  const t = state.timer;
  if (t.running) {
    t.elapsed += Date.now() - t.start;
    t.running = false;
    clearInterval(t.handle);
  } else {
    t.start = Date.now();
    t.running = true;
    t.handle = setInterval(renderTimer, 1000);
  }
  renderTimer();
}

function resetTimer() {
  clearInterval(state.timer.handle);
  state.timer = { running: false, start: 0, elapsed: 0, handle: null };
}

// -----------------------------------------------------------------------------
// Quiz
// -----------------------------------------------------------------------------
function renderQuiz() {
  const qs = state.slot?.article?.questions || [];
  const section = $("quiz-section");
  $("article-quiz-badge").classList.toggle("hidden", qs.length === 0);
  section.classList.toggle("hidden", qs.length === 0);
  if (!qs.length) return;

  const result = state.quizResults[currentSlotId()];
  const answers = result ? result.answers : (state.quizDraft[currentSlotId()] || []);
  const list = $("quiz-list");
  list.innerHTML = qs.map((q, qi) => `
    <div class="rounded-xl bg-white border border-sky-200 p-3.5">
      <div class="text-[11px] font-bold text-sky-800 mb-1">問${qi + 1}・${esc(q.type)}</div>
      <p class="jp-serif text-sm sm:text-[15px] text-stone-900 leading-relaxed mb-2.5">${esc(q.question)}</p>
      <div class="space-y-1.5">
        ${q.options.map((opt, oi) => {
          const picked = answers[qi] === oi;
          let cls = "border-stone-200 bg-stone-50 hover:bg-sky-50";
          if (result) {
            if (oi === q.answer) cls = "border-emerald-500 bg-emerald-50";
            else if (picked) cls = "border-rose-400 bg-rose-50";
            else cls = "border-stone-200 bg-stone-50 opacity-70";
          } else if (picked) cls = "border-sky-600 bg-sky-50 ring-1 ring-sky-600";
          return `<button type="button" data-q="${qi}" data-o="${oi}" ${result ? "disabled" : ""}
            class="quiz-opt w-full text-left px-3 py-2 rounded-lg border text-sm jp-sans ${cls} ${result ? "" : "cursor-pointer"} transition">
            <span class="font-mono text-xs text-stone-500 mr-1.5">${oi + 1}</span>${esc(opt)}
            ${result && oi === q.answer ? ' <span class="text-emerald-700 font-bold">✓</span>' : ""}
            ${result && picked && oi !== q.answer ? ' <span class="text-rose-700 font-bold">✗</span>' : ""}
          </button>`;
        }).join("")}
      </div>
      ${result ? `<div class="mt-2.5 text-xs text-stone-700 leading-relaxed bg-amber-50/70 border border-amber-200 rounded-lg p-2.5">💡 ${esc(q.explanation)}</div>` : ""}
    </div>`).join("");

  list.querySelectorAll(".quiz-opt:not([disabled])").forEach(b => b.addEventListener("click", () => {
    const id = currentSlotId();
    const draft = state.quizDraft[id] || [];
    draft[Number(b.dataset.q)] = Number(b.dataset.o);
    state.quizDraft[id] = draft;
    renderQuiz();
  }));

  $("btn-quiz-submit").classList.toggle("hidden", !!result);
  $("btn-quiz-retry").classList.toggle("hidden", !result);
  $("quiz-score").textContent = result
    ? `答對 ${result.correct} / ${result.total}${result.seconds ? `・用時 ${fmtTime(result.seconds)}` : ""}`
    : `已選 ${answers.filter(a => a !== undefined).length} / ${qs.length}`;
}

function submitQuiz() {
  const qs = state.slot.article.questions;
  const id = currentSlotId();
  const answers = state.quizDraft[id] || [];
  if (answers.filter(a => a !== undefined).length < qs.length) { showToast("還有題目沒作答喔"); return; }
  if (state.timer.running) toggleTimer();
  const correct = qs.filter((q, i) => answers[i] === q.answer).length;
  state.quizResults[id] = { answers, correct, total: qs.length, seconds: timerSeconds(), at: todayStr() };
  delete state.quizDraft[id];
  if (!state.completedSlots[id]) state.completedSlots[id] = todayStr();
  markActivity();
  saveState();
  renderQuiz();
  renderDayTabs();
  renderSlotTabs();
  renderActiveSlotHeader();
  renderStats();
  showToast(`答對 ${correct} / ${qs.length} 題！已自動打卡`);
}

function retryQuiz() {
  delete state.quizResults[currentSlotId()];
  saveState();
  resetTimer();
  renderTimer();
  renderQuiz();
  renderStats();
}

// -----------------------------------------------------------------------------
// Rendering: content
// -----------------------------------------------------------------------------
function renderContentZones() {
  const slot = state.slot;
  if (!slot) return;
  const dlg = slot.dialogue;
  const art = slot.article;

  updateAccordionUI();
  updateVoiceTagLabels();

  // ---- Zone 1 ----
  $("dialogue-scene-badge").textContent = dlg.scene;
  $("dialogue-title").textContent = dlg.title;
  $("dialogue-char-count").textContent = `${dlg.lines.reduce((n, l) => n + charCount(l.jp), 0)} 字`;
  $("dialogue-tone-note").textContent = `💡 ${dlg.tone}`;

  const linesContainer = $("dialogue-lines-container");
  const speakers = [...new Set(dlg.lines.map(l => l.speaker))];
  linesContainer.innerHTML = dlg.lines.map((line, i) => {
    const first = speakers.indexOf(line.speaker) % 2 === 0;
    return `
      <div class="dialogue-line-item p-3.5 rounded-xl border transition ${first ? "bg-stone-50/90 border-stone-200/90 mr-1 sm:mr-4" : "bg-amber-50/35 border-amber-200/70 ml-1 sm:ml-4"}">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs font-bold ${first ? "text-emerald-900" : "text-amber-900"}">${esc(line.speaker)} <span class="font-normal text-stone-500">（${esc(line.role)}）</span></span>
          <span class="text-[10px] text-stone-400 font-mono">#${i + 1}</span>
        </div>
        <p class="dialogue-bubble text-stone-900 ${state.largeFont ? "text-lg" : "text-[15px] sm:text-base"}">${toHtml(line.jp)}</p>
      </div>`;
  }).join("");
  bindExamHighlightClicks(linesContainer);

  const showDlgTrans = state.expandAllTranslations || state.dialogueTransOpen;
  $("dialogue-trans-box").innerHTML = dlg.lines.map(l => `<p><span class="font-semibold">${esc(l.speaker)}：</span>${esc(l.zh)}</p>`).join("");
  $("dialogue-trans-box").classList.toggle("hidden", !showDlgTrans);
  $("btn-toggle-dialogue-trans").textContent = showDlgTrans ? "隱藏中文翻譯" : "展開中文翻譯";

  // ---- Zone 2 ----
  $("article-genre-badge").textContent = art.genre;
  $("article-jlpt-badge").textContent = `JLPT ${art.level}`;
  $("article-title").textContent = art.title;
  $("article-char-count").textContent = `${art.paragraphs.reduce((n, p) => n + charCount(p), 0)} 字`;

  const sources = art.sources || [];
  $("article-source-bar").innerHTML = sources.length
    ? `<div class="flex flex-wrap items-center gap-x-2 gap-y-1"><span class="font-semibold text-stone-500">📎 參考：</span>${
        sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="text-emerald-800 hover:underline font-medium">${esc(s.title)} ↗</a>`).join('<span class="text-stone-300">|</span>')}</div>`
    : "";

  const para = $("article-paragraphs-container");
  para.className = `p-4 sm:p-6 space-y-5 jp-serif reading-text text-stone-900 ${state.largeFont ? "text-lg sm:text-xl" : "text-base sm:text-[17px]"}`;
  para.innerHTML = art.paragraphs.map(p => `<p class="article-para-item indent-4 p-1 rounded-lg transition">${toHtml(p)}</p>`).join("");
  bindExamHighlightClicks(para);

  const showArtTrans = state.expandAllTranslations || state.articleTransOpen;
  $("article-trans-box").innerHTML = art.translation.map(t => `<p class="indent-4">${esc(t)}</p>`).join("");
  $("article-trans-box").classList.toggle("hidden", !showArtTrans);
  $("btn-toggle-article-trans").textContent = showArtTrans ? "隱藏中文翻譯" : "展開中文翻譯";

  $("article-grammar-list").innerHTML = (art.grammar || []).map(g => `
    <div class="p-3 rounded-xl bg-white border border-rose-200/90 text-xs sm:text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-bold text-rose-950 bg-rose-100 px-2 py-0.5 rounded jp-sans">${esc(g.pattern)}</span>
        ${g.reading ? `<span class="text-[11px] text-stone-500 jp-sans">${esc(g.reading)}</span>` : ""}
        <span class="px-1.5 py-0.5 rounded bg-rose-700 text-white text-[10px] font-bold">${esc(g.level)}</span>
      </div>
      <p class="text-stone-600 mt-1.5 text-xs leading-relaxed">${esc(g.explanation)}</p>
    </div>`).join("");

  renderVocabLists();
  renderQuiz();
  renderTimer();
}

function syncToolbarButtons() {
  const on = "inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-900 text-white shadow-2xs transition cursor-pointer";
  const off = "inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-white text-stone-700 border border-stone-300 hover:bg-stone-100 transition cursor-pointer";
  const mobOn = "flex-1 py-2 px-1 rounded-xl text-[11px] font-bold bg-emerald-900 text-white flex flex-col items-center gap-0.5 cursor-pointer";
  const mobOff = "flex-1 py-2 px-1 rounded-xl text-[11px] font-bold bg-stone-100 text-stone-700 flex flex-col items-center gap-0.5 cursor-pointer";

  document.body.classList.toggle("hide-furigana", !state.showFurigana);
  $("label-furigana").textContent = state.showFurigana ? "平假名：開啟" : "平假名：關閉";
  $("btn-toggle-furigana").className = state.showFurigana ? on : off;
  $("mob-label-furigana").textContent = state.showFurigana ? "開啟" : "關閉";
  $("mob-btn-furigana").className = state.showFurigana ? mobOn : mobOff;

  document.body.classList.toggle("hide-exam-hl", !state.showExamHighlight);
  ["N1", "N2", "N3"].forEach(l => document.body.classList.toggle(`hl-off-${l}`, !state.hlLevels[l]));
  $("label-exam-hl").textContent = state.showExamHighlight ? "常考紅底：開啟" : "常考紅底：關閉";
  $("btn-toggle-exam-hl").className = state.showExamHighlight
    ? "inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-100 text-rose-900 border border-rose-300 hover:bg-rose-200/70 transition cursor-pointer"
    : off;
  $("mob-label-exam").textContent = state.showExamHighlight ? "開啟" : "關閉";
  $("mob-btn-exam").className = state.showExamHighlight
    ? "flex-1 py-2 px-1 rounded-xl text-[11px] font-bold bg-rose-100 text-rose-900 flex flex-col items-center gap-0.5 cursor-pointer"
    : mobOff;
  document.querySelectorAll(".hl-level-btn").forEach(b => {
    const active = state.hlLevels[b.dataset.hlLevel] && state.showExamHighlight;
    b.className = `hl-level-btn px-2 py-0.5 rounded-md text-[11px] font-bold border cursor-pointer ${active ? "bg-rose-200 text-rose-950 border-rose-400" : "bg-white text-stone-400 border-stone-300"}`;
  });

  $("label-all-trans").textContent = state.expandAllTranslations ? "譯文：全部展開" : "譯文：預設隱藏";
  $("btn-toggle-all-trans").className = state.expandAllTranslations ? on : off;
  $("mob-label-trans").textContent = state.expandAllTranslations ? "展開" : "隱藏";
  $("mob-btn-trans").className = state.expandAllTranslations ? mobOn : mobOff;

  $("btn-font-normal").className = `px-2 py-0.5 rounded-md font-medium transition cursor-pointer ${!state.largeFont ? "bg-stone-200 text-stone-900" : "text-stone-600 hover:text-stone-900"}`;
  $("btn-font-large").className = `px-2 py-0.5 rounded-md font-medium transition cursor-pointer ${state.largeFont ? "bg-stone-200 text-stone-900" : "text-stone-600 hover:text-stone-900"}`;

  document.querySelectorAll(".rate-btn").forEach(b => {
    b.className = parseFloat(b.dataset.rate) === state.speechRate
      ? "rate-btn py-2 rounded-xl border border-emerald-800 bg-emerald-900 text-white text-xs font-semibold cursor-pointer"
      : "rate-btn py-2 rounded-xl border border-stone-300 text-xs font-semibold text-stone-700 cursor-pointer";
  });
}

// -----------------------------------------------------------------------------
// Slot selection
// -----------------------------------------------------------------------------
let selectToken = 0;
async function selectSlot(date, key) {
  const day = findDay(date);
  if (!day) return;
  if (!key || !day.slots[key]) key = latestSlotKey(day);
  stopSpeech();
  resetTimer();
  const changed = date !== state.activeDate || key !== state.activeSlotKey;
  state.activeDate = date;
  state.activeSlotKey = key;
  if (changed) {
    if (!state.expandAllTranslations) { state.dialogueTransOpen = false; state.articleTransOpen = false; }
    state.zone1Open = false;
    state.zone2Open = false;
  }
  renderDayTabs();
  renderSlotTabs();

  const token = ++selectToken;
  $("content-root").classList.add("opacity-50");
  try {
    const data = await loadSlot(date, key);
    if (token !== selectToken) return; // 使用者已切到別的時段
    state.slot = data;
    $("load-error").classList.add("hidden");
    renderActiveSlotHeader();
    renderContentZones();
  } catch (e) {
    if (token !== selectToken) return;
    showLoadError(`無法載入 ${date} ${key} 的文章：${e.message}`);
  } finally {
    if (token === selectToken) $("content-root").classList.remove("opacity-50");
  }
}

function showLoadError(msg) {
  const box = $("load-error");
  const fileHint = location.protocol === "file:"
    ? "<br>直接用檔案開啟時瀏覽器會擋掉資料讀取，請用本機伺服器開啟（README 有說明），或部署到 GitHub Pages。"
    : "";
  box.innerHTML = `⚠️ ${esc(msg)}${fileHint}`;
  box.classList.remove("hidden");
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------
function bindEvents() {
  $("btn-accordion-zone1").addEventListener("click", () => { state.zone1Open = !state.zone1Open; updateAccordionUI(); });
  $("btn-accordion-zone2").addEventListener("click", () => { state.zone2Open = !state.zone2Open; updateAccordionUI(); });
  $("btn-expand-collapse-both").addEventListener("click", () => {
    const target = !(state.zone1Open && state.zone2Open);
    state.zone1Open = target; state.zone2Open = target;
    updateAccordionUI();
  });

  const toggleFurigana = () => { state.showFurigana = !state.showFurigana; syncToolbarButtons(); };
  $("btn-toggle-furigana").addEventListener("click", toggleFurigana);
  $("mob-btn-furigana").addEventListener("click", toggleFurigana);

  const toggleExam = () => { state.showExamHighlight = !state.showExamHighlight; syncToolbarButtons(); };
  $("btn-toggle-exam-hl").addEventListener("click", toggleExam);
  $("mob-btn-exam").addEventListener("click", toggleExam);
  document.querySelectorAll(".hl-level-btn").forEach(b => b.addEventListener("click", () => {
    const l = b.dataset.hlLevel;
    if (!state.showExamHighlight) { state.showExamHighlight = true; }
    else state.hlLevels[l] = !state.hlLevels[l];
    saveState();
    syncToolbarButtons();
  }));

  const toggleAllTrans = () => {
    state.expandAllTranslations = !state.expandAllTranslations;
    state.dialogueTransOpen = state.expandAllTranslations;
    state.articleTransOpen = state.expandAllTranslations;
    syncToolbarButtons();
    renderContentZones();
  };
  $("btn-toggle-all-trans").addEventListener("click", toggleAllTrans);
  $("mob-btn-trans").addEventListener("click", toggleAllTrans);

  $("btn-toggle-dialogue-trans").addEventListener("click", () => {
    state.dialogueTransOpen = !(state.expandAllTranslations || state.dialogueTransOpen);
    if (!state.dialogueTransOpen) state.expandAllTranslations = false;
    syncToolbarButtons();
    renderContentZones();
  });
  $("btn-toggle-article-trans").addEventListener("click", () => {
    state.articleTransOpen = !(state.expandAllTranslations || state.articleTransOpen);
    if (!state.articleTransOpen) state.expandAllTranslations = false;
    syncToolbarButtons();
    renderContentZones();
  });

  $("btn-font-normal").addEventListener("click", () => { state.largeFont = false; saveState(); syncToolbarButtons(); renderContentZones(); });
  $("btn-font-large").addEventListener("click", () => { state.largeFont = true; saveState(); syncToolbarButtons(); renderContentZones(); });

  $("btn-speak-dialogue").addEventListener("click", function () { startReading("dialogue", this, "🔊 朗讀對話"); });
  $("btn-speak-article").addEventListener("click", function () { startReading("article", this, "🔊 朗讀專欄"); });

  $("btn-timer").addEventListener("click", toggleTimer);
  $("btn-quiz-submit").addEventListener("click", submitQuiz);
  $("btn-quiz-retry").addEventListener("click", retryQuiz);

  // Voice modal
  const voiceModal = $("voice-modal");
  const openVoiceModal = () => {
    populateVoices();
    $("input-openai-key").value = state.openaiKey || "";
    syncToolbarButtons();
    voiceModal.classList.remove("hidden");
  };
  $("btn-open-voice-modal").addEventListener("click", openVoiceModal);
  $("mob-btn-voice").addEventListener("click", openVoiceModal);
  $("btn-close-voice-modal").addEventListener("click", () => voiceModal.classList.add("hidden"));
  $("select-jp-voice").addEventListener("change", e => { state.selectedVoiceURI = e.target.value; updateVoiceTagLabels(); });
  document.querySelectorAll(".rate-btn").forEach(btn => btn.addEventListener("click", () => {
    state.speechRate = parseFloat(btn.dataset.rate);
    if (currentAudioObj) currentAudioObj.playbackRate = state.speechRate;
    syncToolbarButtons();
    updateVoiceTagLabels();
  }));
  $("btn-test-voice").addEventListener("click", function () {
    state.openaiKey = $("input-openai-key").value.trim();
    speakSentencesSequentially(["こんにちは。毎日の日本語読解へようこそ。"], [], this, "🔊 試聽目前語音", false);
  });
  $("btn-save-voice-modal").addEventListener("click", () => {
    state.openaiKey = $("input-openai-key").value.trim();
    saveState();
    updateVoiceTagLabels();
    voiceModal.classList.add("hidden");
    showToast("已儲存語音與朗讀設定！");
  });

  // Vocab modal
  const vocabModal = $("vocab-modal");
  $("btn-open-vocab-modal").addEventListener("click", () => openVocabModal(dueVocab().length ? "review" : "list"));
  $("btn-open-review").addEventListener("click", () => openVocabModal("review"));
  $("tab-vocab-review").addEventListener("click", () => { state.vocabTab = "review"; startReview(); renderVocabModal(); });
  $("tab-vocab-list").addEventListener("click", () => { state.vocabTab = "list"; renderVocabModal(); });
  $("btn-close-vocab-modal").addEventListener("click", () => vocabModal.classList.add("hidden"));
  $("btn-close-vocab-footer").addEventListener("click", () => vocabModal.classList.add("hidden"));
  $("btn-clear-vocab").addEventListener("click", () => {
    if (!state.savedVocab.length) return;
    if (!confirm(`確定要清空全部 ${state.savedVocab.length} 個收藏單字？複習進度也會一起刪除，無法復原。`)) return;
    state.savedVocab = [];
    state.reviewQueue = [];
    saveState();
    updateVocabBadge();
    renderVocabModal();
    renderVocabLists();
    renderStats();
    showToast("已清空單字收藏本");
  });

  // Archive
  $("archive-select").addEventListener("change", e => {
    const date = e.target.value;
    if (!date) return;
    state.archiveDate = date;
    selectSlot(date, null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function initApp() {
  loadSavedState();
  try {
    if ("speechSynthesis" in window) {
      populateVoices();
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }
  } catch (e) {}
  bindEvents();
  syncToolbarButtons();
  updateVocabBadge();
  renderStats();

  try {
    await loadManifest();
  } catch (e) {
    showLoadError(`無法載入文章清單：${e.message}`);
    $("content-root").classList.add("hidden");
    return;
  }
  if (!state.manifest.days.length) {
    showLoadError("目前還沒有任何文章。");
    $("content-root").classList.add("hidden");
    return;
  }
  renderArchiveSelect();
  const latest = state.manifest.days[0];
  await selectSlot(latest.date, latestSlotKey(latest));
}

initApp();
