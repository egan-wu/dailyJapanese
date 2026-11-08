// =============================================================================
// 日日讀日文 — 主程式
// 資料來源：data/manifest.json（文章清單）＋ data/slots/*.json（每個時段一個檔）
// =============================================================================
import { toHtml, toPlain, charCount, escapeHtml as esc } from "./markup.js";

const SLOT_ORDER = ["08:00", "17:00", "22:00"];
const RECENT_DAYS = 3;
// 計時參考：每分鐘閱讀字數（粗估），另外每題加 1 分鐘
const READING_SPEED = { N1: 250, N2: 200, N3: 150, N4: 120, N5: 100 };
// 單字複習間隔（天），依熟練度 box 0～6
const SRS_INTERVALS = [1, 2, 4, 7, 15, 30, 60];

const ICON = name => `<svg class="icon icon-sm"><use href="#i-${name}"/></svg>`;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const state = {
  manifest: null,
  activeDate: null,
  activeSlotKey: null,
  archiveDate: null,
  slot: null,
  section: "dialogue",
  showFurigana: false,
  showTranslation: false,
  showExamHighlight: true,
  hlLevels: { N1: true, N2: true, N3: true },
  largeFont: false,
  speechRate: 0.95,
  selectedVoiceURI: "auto",
  openaiKey: "",
  completedSlots: {},
  savedVocab: [],
  quizResults: {},
  activity: {},
  quizDraft: {},
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
  const p = readJSON("yomuhi_prefs", {});
  if (p.hlLevels) state.hlLevels = { ...state.hlLevels, ...p.hlLevels };
  for (const k of ["speechRate", "selectedVoiceURI", "largeFont", "showFurigana", "showTranslation", "showExamHighlight", "section"]) {
    if (p[k] !== undefined) state[k] = p[k];
  }
}

function saveState() {
  writeJSON("yomuhi_completed_slots", state.completedSlots);
  writeJSON("yomuhi_saved_vocab", state.savedVocab);
  writeJSON("yomuhi_quiz", state.quizResults);
  writeJSON("yomuhi_activity", state.activity);
  writeJSON("yomuhi_openai_key", state.openaiKey || "");
  writeJSON("yomuhi_prefs", {
    hlLevels: state.hlLevels, speechRate: state.speechRate, selectedVoiceURI: state.selectedVoiceURI,
    largeFont: state.largeFont, showFurigana: state.showFurigana, showTranslation: state.showTranslation,
    showExamHighlight: state.showExamHighlight, section: state.section
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
function parts(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { m, d, dow: "日一二三四五六"[new Date(y, m - 1, d).getDay()] };
}
function dayLabel(ymd) { const p = parts(ymd); return `${p.m}月${p.d}日 週${p.dow}`; }
function relDay(ymd) {
  const t = todayStr();
  if (ymd === t) return "今天";
  if (ymd === addDays(t, -1)) return "昨天";
  return `週${parts(ymd).dow}`;
}

function markActivity() { state.activity[todayStr()] = true; }
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

function findDay(date) { return state.manifest.days.find(d => d.date === date) || null; }

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
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

function levelOfArticle(level) {
  const m = String(level || "").match(/N[1-5]/g);
  return m ? m.sort()[0] : "N2";
}

let openSheetId = null;
function openSheet(id) {
  if (openSheetId && openSheetId !== id) $(openSheetId).classList.remove("show");
  openSheetId = id;
  $(id).classList.add("show");
  $("backdrop").classList.add("show");
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  if (!openSheetId) return;
  $(openSheetId).classList.remove("show");
  $("backdrop").classList.remove("show");
  document.body.style.overflow = "";
  openSheetId = null;
}

// -----------------------------------------------------------------------------
// Voice (cloud audio files → OpenAI → Web Speech)
// -----------------------------------------------------------------------------
let availableJpVoices = [];
let currentAudioObj = null;
let isPopulatingVoices = false;
let ttsLoading = false;
let cloudPlaying = false;
let activeSpeakBtn = null;

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
    sel.innerHTML = `<option value="auto">自動</option>` + availableJpVoices
      .map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name.replace(/^Microsoft /, "").replace(/ - Japanese \(Japan\)/, ""))}</option>`).join("");
    sel.value = [...sel.options].some(o => o.value === state.selectedVoiceURI) ? state.selectedVoiceURI : "auto";
    $("voice-none-hint").hidden = availableJpVoices.length > 0;
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
    if (found) return isAlt ? (availableJpVoices.find(v => v.voiceURI !== found.voiceURI) || found) : found;
  }
  if (availableJpVoices.length > 1 && isAlt) return availableJpVoices[1];
  return availableJpVoices[0] || null;
}

function setSpeakBtn(btn, playing) {
  if (!btn) return;
  btn.innerHTML = playing ? ICON("stop") : ICON("play");
  btn.setAttribute("aria-label", playing ? "停止朗讀" : btn.dataset.label || "朗讀");
}
function setSpeakLoading(btn) { if (btn) btn.innerHTML = `<span style="font-size:13px">…</span>`; }

function releaseAudio() {
  if (currentAudioObj && currentAudioObj._blobUrl) URL.revokeObjectURL(currentAudioObj._blobUrl);
  currentAudioObj = null;
}

function clearActive() { document.querySelectorAll(".speaking-active").forEach(el => el.classList.remove("speaking-active")); }

function stopSpeech() {
  window._speechCancelled = true;
  cloudPlaying = false;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (currentAudioObj) { currentAudioObj.pause(); releaseAudio(); }
  clearActive();
  setSpeakBtn($("btn-speak-dialogue"), false);
  setSpeakBtn($("btn-speak-article"), false);
}

async function speakWithOpenAI(text, sentences, els, btn, alt) {
  ttsLoading = true;
  try {
    setSpeakLoading(btn);
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": `Bearer ${state.openaiKey.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "nova", input: text, speed: state.speechRate })
    });
    if (!resp.ok) throw new Error("API request failed");
    const url = URL.createObjectURL(await resp.blob());
    const audio = new Audio(url);
    audio._blobUrl = url;
    currentAudioObj = audio;
    setSpeakBtn(btn, true);
    audio.onended = () => { setSpeakBtn(btn, false); if (currentAudioObj === audio) releaseAudio(); };
    ttsLoading = false;
    await audio.play();
  } catch (e) {
    ttsLoading = false;
    if (currentAudioObj) releaseAudio();
    setSpeakBtn(btn, false);
    showToast("OpenAI 語音失敗，改用瀏覽器語音");
    speakSentencesSequentially(sentences, els, btn, alt, true);
  }
}

function speakSentencesSequentially(sentences, els, btn, alt = false, skipOpenAI = false) {
  if (ttsLoading) return;
  if (("speechSynthesis" in window && window.speechSynthesis.speaking) || currentAudioObj) { stopSpeech(); return; }
  if (!skipOpenAI && state.openaiKey && state.openaiKey.trim().startsWith("sk-")) {
    speakWithOpenAI(sentences.join("。\n"), sentences, els, btn, alt);
    return;
  }
  if (!("speechSynthesis" in window)) { showToast("這個瀏覽器不支援朗讀"); setSpeakBtn(btn, false); return; }
  // 沒有日文語音時，瀏覽器會改用系統預設語音（常常是中文）把日文念成中文，所以直接擋下並說明
  if (availableJpVoices.length === 0) populateVoices();
  if (availableJpVoices.length === 0) {
    setSpeakBtn(btn, false);
    showToast("找不到日文語音");
    openSheet("sheet-settings");
    $("voice-section").scrollIntoView({ block: "start" });
    return;
  }

  window._speechCancelled = false;
  setSpeakBtn(btn, true);
  let idx = 0;
  function nextLine() {
    if (window._speechCancelled || idx >= sentences.length) { clearActive(); setSpeakBtn(btn, false); return; }
    clearActive();
    els[idx]?.classList.add("speaking-active");
    const utter = new SpeechSynthesisUtterance(sentences[idx]);
    utter.lang = "ja-JP";
    const voice = getPreferredVoice(alt ? idx : 0);
    if (voice) utter.voice = voice;
    utter.rate = state.speechRate;
    if (alt) utter.pitch = (idx % 2 === 0) ? 1.03 : 0.94;
    utter.onend = () => { idx++; if (!window._speechCancelled) setTimeout(nextLine, 320); };
    utter.onerror = () => { clearActive(); setSpeakBtn(btn, false); };
    window.speechSynthesis.speak(utter);
  }
  nextLine();
}

// 朗讀入口：有雲端音檔（scripts/tts.mjs 產生）就播音檔，否則用 OpenAI／瀏覽器語音
function startReading(kind, btn) {
  if (ttsLoading) return;
  if (cloudPlaying || ("speechSynthesis" in window && window.speechSynthesis.speaking) || currentAudioObj) { stopSpeech(); return; }
  const slot = state.slot;
  if (!slot) return;
  activeSpeakBtn = btn;
  const isDialogue = kind === "dialogue";
  const sentences = isDialogue ? slot.dialogue.lines.map(l => toPlain(l.jp)) : slot.article.paragraphs.map(toPlain);
  const els = Array.from(document.querySelectorAll(isDialogue ? "#dialogue-lines .bubble" : "#article-paragraphs .para"));
  const urls = slot.audio?.[kind];
  if (Array.isArray(urls) && urls.length === sentences.length) playAudioSequence(urls, sentences, els, btn, isDialogue);
  else speakSentencesSequentially(sentences, els, btn, isDialogue);
}

function playAudioSequence(urls, sentences, els, btn, isDialogue) {
  window._speechCancelled = false;
  cloudPlaying = true;
  setSpeakBtn(btn, true);
  let idx = 0;
  let failed = false;
  const finish = () => { cloudPlaying = false; currentAudioObj = null; clearActive(); setSpeakBtn(btn, false); };
  const fallback = () => {
    if (failed || window._speechCancelled) return;
    failed = true;
    finish();
    showToast("音檔播放失敗，改用瀏覽器語音");
    speakSentencesSequentially(sentences.slice(idx), els.slice(idx), btn, isDialogue, true);
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
    if (urls[idx + 1]) { const pre = new Audio(); pre.preload = "auto"; pre.src = urls[idx + 1]; }
  };
  next();
}

// -----------------------------------------------------------------------------
// Rendering: header, stats, navigation
// -----------------------------------------------------------------------------
function renderNav() {
  $("nav-date").textContent = dayLabel(todayStr());
}

function renderStats() {
  $("stat-streak").textContent = String(calcStreak());
  const since = addDays(todayStr(), -6);
  // 完成日期存成字串；舊版存的是 true（不知道日期），不計入近 7 天
  $("stat-week").textContent = String(Object.values(state.completedSlots).filter(v => typeof v === "string" && v >= since).length);
  const results = Object.values(state.quizResults);
  const total = results.reduce((n, r) => n + r.total, 0);
  const correct = results.reduce((n, r) => n + r.correct, 0);
  $("stat-accuracy").innerHTML = total ? `${Math.round(correct / total * 100)}<small>%</small>` : "—";
  const due = dueVocab().length;
  $("stat-due").textContent = String(due);
  const badge = $("badge-vocab-count");
  badge.textContent = String(due);
  badge.hidden = due === 0;
}

function renderDayTabs() {
  const container = $("day-tabs-container");
  const days = visibleDays();
  const hasOlder = state.manifest.days.length > RECENT_DAYS;
  container.innerHTML = days.map(day => {
    const keys = SLOT_ORDER.filter(k => day.slots[k]);
    const p = parts(day.date);
    const active = day.date === state.activeDate;
    const dots = SLOT_ORDER.map(k => `<i class="${state.completedSlots[getSlotId(day.date, k)] ? "done" : ""}" ${day.slots[k] ? "" : 'style="opacity:.35"'}></i>`).join("");
    return `<button type="button" role="tab" class="date-chip ${active ? "active" : ""}" data-date="${esc(day.date)}" aria-selected="${active}" aria-label="${esc(dayLabel(day.date))}，${keys.length} 則">
      <div class="dc-week">${esc(relDay(day.date))}</div>
      <div class="dc-day">${p.d}</div>
      <div class="dc-dots">${dots}</div>
    </button>`;
  }).join("") + (hasOlder ? `<button type="button" class="date-chip more" id="btn-open-archive" aria-label="更早的文章"><svg class="icon"><use href="#i-calendar"/></svg></button>` : "");

  container.querySelectorAll("[data-date]").forEach(b => b.addEventListener("click", () => {
    const day = findDay(b.dataset.date);
    selectSlot(day.date, state.activeDate === day.date ? state.activeSlotKey : latestSlotKey(day));
  }));
  $("btn-open-archive")?.addEventListener("click", () => { renderArchive(); openSheet("sheet-archive"); });
}

function renderSlotTabs() {
  const day = findDay(state.activeDate);
  const c = $("slot-tabs-container");
  c.innerHTML = SLOT_ORDER.map(k => {
    const ok = !!day?.slots?.[k];
    const done = !!state.completedSlots[getSlotId(state.activeDate, k)];
    return `<button type="button" role="tab" data-slot="${k}" class="${k === state.activeSlotKey ? "active" : ""}" ${ok ? "" : "disabled"} aria-selected="${k === state.activeSlotKey}">
      ${k}${done ? '<span class="seg-check">✓</span>' : ""}</button>`;
  }).join("");
  c.querySelectorAll("button:not([disabled])").forEach(b => b.addEventListener("click", () => selectSlot(state.activeDate, b.dataset.slot)));
}

function renderArchive() {
  const older = state.manifest.days.slice(RECENT_DAYS);
  $("archive-list").innerHTML = older.length ? older.map(d => {
    const n = Object.keys(d.slots).length;
    const done = Object.keys(d.slots).filter(k => state.completedSlots[getSlotId(d.date, k)]).length;
    return `<button type="button" class="list-row" data-date="${esc(d.date)}">
      <span class="row-title">${esc(dayLabel(d.date))}</span>
      <span class="row-value">${done}/${n}</span>
      <svg class="icon icon-sm chevron"><use href="#i-chevron"/></svg>
    </button>`;
  }).join('<div class="divider"></div>') : `<div class="empty">沒有更早的文章</div>`;
  $("archive-list").querySelectorAll("[data-date]").forEach(b => b.addEventListener("click", () => {
    state.archiveDate = b.dataset.date;
    closeSheet();
    selectSlot(b.dataset.date, null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
}

function renderHero() {
  const id = currentSlotId();
  const done = !!state.completedSlots[id];
  const p = parts(state.activeDate);
  $("active-slot-header").innerHTML = `
    <div class="hero-text">
      <div class="eyebrow">${p.m}/${p.d} · ${state.activeSlotKey}</div>
      <div class="hero-title">${esc(state.slot?.theme || "")}</div>
    </div>
    <button type="button" class="done-btn ${done ? "done" : ""}" id="btn-mark-complete" aria-label="${done ? "取消完成" : "標記完成"}" aria-pressed="${done}">
      ${ICON("check")}${done ? "" : "完成"}
    </button>`;
  $("btn-mark-complete").addEventListener("click", () => setCompleted(id, !state.completedSlots[id]));
}

function setCompleted(slotId, done) {
  if (done) { state.completedSlots[slotId] = todayStr(); markActivity(); }
  else delete state.completedSlots[slotId];
  saveState();
  renderDayTabs();
  renderSlotTabs();
  renderHero();
  renderStats();
}

function renderSectionTabs() {
  document.querySelectorAll("#section-tabs button").forEach(b => {
    const on = b.dataset.section === state.section;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on);
  });
  $("pane-dialogue").hidden = state.section !== "dialogue";
  $("pane-article").hidden = state.section !== "article";
  $("pane-words").hidden = state.section !== "words";
}

// -----------------------------------------------------------------------------
// Rendering: content
// -----------------------------------------------------------------------------
function bindExamHighlightClicks(container) {
  container.querySelectorAll(".exam-hl").forEach(el => el.addEventListener("click", e => {
    if (!state.showExamHighlight) return;
    const lv = el.dataset.level;
    const key = ["N4", "N5"].includes(lv) ? "N3" : lv;
    if (state.hlLevels[key] === false) return;
    e.stopPropagation();
    showToast(el.dataset.tip || el.textContent);
  }));
}

// 翻譯常以「健太：……」開頭，泡泡上方已經有名字，去掉重複的部分
function stripSpeaker(zh, speaker) {
  const s = String(zh || "");
  const i = s.search(/[：:]/);
  return i > 0 && i <= 12 && (s.slice(0, i).includes(speaker) || speaker.includes(s.slice(0, i))) ? s.slice(i + 1).trim() : s;
}

function renderDialogue() {
  const dlg = state.slot.dialogue;
  $("dialogue-scene").textContent = dlg.scene;
  $("dialogue-chars").textContent = `${dlg.lines.reduce((n, l) => n + charCount(l.jp), 0)} 字`;
  $("dialogue-title").textContent = dlg.title;
  $("dialogue-tone").textContent = dlg.tone;
  const speakers = [...new Set(dlg.lines.map(l => l.speaker))];
  let prev = null;
  $("dialogue-lines").innerHTML = dlg.lines.map(line => {
    const me = speakers.indexOf(line.speaker) % 2 === 1;
    const showName = line.speaker !== prev;
    prev = line.speaker;
    return `<div class="msg ${me ? "me" : ""}">
      ${showName ? `<div class="msg-name">${esc(line.speaker)}・${esc(line.role)}</div>` : ""}
      <div class="bubble">${toHtml(line.jp)}</div>
      ${state.showTranslation ? `<div class="msg-zh">${esc(stripSpeaker(line.zh, line.speaker))}</div>` : ""}
    </div>`;
  }).join("");
  bindExamHighlightClicks($("dialogue-lines"));
}

function renderArticle() {
  const art = state.slot.article;
  $("article-level").textContent = art.level;
  $("article-genre").textContent = art.genre;
  $("article-chars").textContent = `${art.paragraphs.reduce((n, p) => n + charCount(p), 0)} 字`;
  $("article-title").textContent = art.title;
  const sources = art.sources || [];
  $("article-sources").hidden = !sources.length;
  $("article-sources").innerHTML = sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)} ↗</a>`).join("　");
  $("article-paragraphs").innerHTML = art.paragraphs.map((p, i) =>
    `<p class="para">${toHtml(p)}</p>${state.showTranslation && art.translation[i] ? `<p class="para-zh">${esc(art.translation[i])}</p>` : ""}`
  ).join("");
  bindExamHighlightClicks($("article-paragraphs"));
  renderQuiz();
  renderTimer();
}

function wordRow(v, sourceTag, { withStar = true } = {}) {
  const saved = isVocabSaved(v.word);
  return `<div class="word-row">
    <div class="word-main">
      <div class="word-top">
        <span class="word">${esc(v.word || v.pattern)}</span>
        ${v.reading ? `<span class="reading">${esc(v.reading)}</span>` : ""}
        ${v.level ? `<span class="tag level">${esc(v.level)}</span>` : ""}
      </div>
      <div class="word-meaning">${esc(v.meaning || v.explanation)}</div>
    </div>
    ${withStar ? `<button type="button" class="star-btn ${saved ? "on" : ""}" data-word="${esc(v.word)}" aria-label="${saved ? "從單字本移除" : "加入單字本"}" aria-pressed="${saved}">${saved ? "★" : "☆"}</button>` : ""}
  </div>`;
}

function renderWords() {
  const slot = state.slot;
  if (!slot) return;
  const tag = `${state.activeDate} ${state.activeSlotKey}`;
  const fill = (id, list, opts) => {
    const c = $(id);
    c.innerHTML = (list || []).map(v => wordRow(v, tag, opts)).join("") || `<div class="empty">—</div>`;
    c.querySelectorAll(".star-btn").forEach(b => b.addEventListener("click", () => {
      const v = list.find(x => x.word === b.dataset.word);
      if (v) toggleSaveVocab(v, tag);
    }));
  };
  fill("dialogue-vocab", slot.dialogue.vocab);
  fill("article-vocab", slot.article.vocab);
  fill("article-grammar", slot.article.grammar, { withStar: false });
}

function renderContent() {
  if (!state.slot) return;
  renderSectionTabs();
  renderDialogue();
  renderArticle();
  renderWords();
}

function applyDisplayPrefs() {
  const b = document.body.classList;
  b.toggle("show-furigana", state.showFurigana);
  b.toggle("hide-exam-hl", !state.showExamHighlight);
  b.toggle("large-text", state.largeFont);
  ["N1", "N2", "N3"].forEach(l => b.toggle(`hl-off-${l}`, !state.hlLevels[l]));

  const tools = { "tool-furigana": state.showFurigana, "tool-highlight": state.showExamHighlight, "tool-translation": state.showTranslation };
  for (const [id, on] of Object.entries(tools)) { $(id).classList.toggle("on", on); $(id).setAttribute("aria-pressed", on); }

  $("set-furigana").checked = state.showFurigana;
  $("set-translation").checked = state.showTranslation;
  $("set-highlight").checked = state.showExamHighlight;
  document.querySelectorAll("#set-hl-levels button").forEach(x => x.classList.toggle("active", !!state.hlLevels[x.dataset.hlLevel]));
  document.querySelectorAll("#set-font button").forEach(x => x.classList.toggle("active", (x.dataset.font === "large") === state.largeFont));
  document.querySelectorAll("#set-rate button").forEach(x => x.classList.toggle("active", parseFloat(x.dataset.rate) === state.speechRate));
}

// -----------------------------------------------------------------------------
// Vocabulary + spaced repetition
// -----------------------------------------------------------------------------
function isVocabSaved(word) { return state.savedVocab.some(item => item.word === word); }

function toggleSaveVocab(v, sourceLabel) {
  const idx = state.savedVocab.findIndex(item => item.word === v.word);
  if (idx >= 0) {
    state.savedVocab.splice(idx, 1);
    showToast(`已移除「${v.word}」`);
  } else {
    state.savedVocab.push({ word: v.word, reading: v.reading || "", level: v.level, meaning: v.meaning, source: sourceLabel, box: 0, due: todayStr() });
    showToast(`已收藏「${v.word}」`);
  }
  saveState();
  renderWords();
  renderStats();
}

function dueVocab() {
  const t = todayStr();
  return state.savedVocab.filter(v => !v.due || v.due <= t);
}

function renderVocabSheet() {
  const review = state.vocabTab === "review";
  document.querySelectorAll("#vocab-tabs button").forEach(b => b.classList.toggle("active", (b.dataset.vtab === "review") === review));
  $("vocab-review-pane").hidden = !review;
  $("vocab-list-pane").hidden = review;
  $("btn-clear-vocab").style.visibility = !review && state.savedVocab.length ? "visible" : "hidden";
  if (review) renderReviewPane(); else renderSavedList();
}

function renderSavedList() {
  const c = $("vocab-list-pane");
  if (!state.savedVocab.length) {
    c.innerHTML = `<div class="empty"><div class="big">☆</div>點單字旁的 ☆ 收藏</div>`;
    return;
  }
  const t = todayStr();
  c.innerHTML = `<div class="group">${state.savedVocab.map((v, i) => `
    <div class="word-row">
      <div class="word-main">
        <div class="word-top"><span class="word">${esc(v.word)}</span>${v.reading ? `<span class="reading">${esc(v.reading)}</span>` : ""}${v.level ? `<span class="tag level">${esc(v.level)}</span>` : ""}</div>
        <div class="word-meaning">${esc(v.meaning)}</div>
        <div class="word-sub">${!v.due || v.due <= t ? "今天複習" : `${esc(v.due.slice(5).replace("-", "/"))} 複習`} · 熟練 ${v.box || 0}/6</div>
      </div>
      <button type="button" class="star-btn on" data-i="${i}" aria-label="移除">★</button>
    </div>`).join("")}</div>`;
  c.querySelectorAll("[data-i]").forEach(b => b.addEventListener("click", () => {
    state.savedVocab.splice(Number(b.dataset.i), 1);
    saveState();
    renderVocabSheet();
    renderWords();
    renderStats();
  }));
}

function startReview() {
  state.reviewQueue = dueVocab().map(v => v.word);
  state.reviewShowAnswer = false;
}

function renderReviewPane() {
  const pane = $("vocab-review-pane");
  const v = state.savedVocab.find(x => x.word === state.reviewQueue[0]);
  if (!v) {
    const next = state.savedVocab.map(x => x.due).filter(Boolean).sort()[0];
    pane.innerHTML = state.savedVocab.length
      ? `<div class="empty"><div class="big">🎉</div>今天的複習完成了${next ? `<br>下次：${esc(next.slice(5).replace("-", "/"))}` : ""}</div>`
      : `<div class="empty"><div class="big">☆</div>點單字旁的 ☆ 收藏後，會在這裡複習</div>`;
    return;
  }
  const a = state.reviewShowAnswer;
  pane.innerHTML = `
    <div class="review-count">剩 ${state.reviewQueue.length} 個</div>
    <div class="review-card">
      <div class="review-word">${esc(v.word)}</div>
      ${a ? `<div class="review-reading">${esc(v.reading || "")}</div><div class="review-meaning">${esc(v.meaning)}</div>`
          : `<div class="review-hint">讀音和意思？</div>`}
    </div>
    <div class="grade-row ${a ? "" : "single"}">
      ${a ? `<button type="button" class="grade again" data-grade="0">忘記</button>
             <button type="button" class="grade hard" data-grade="1">模糊</button>
             <button type="button" class="grade good" data-grade="2">記得</button>`
          : `<button type="button" class="grade reveal" id="btn-review-reveal">顯示答案</button>`}
    </div>`;
  $("btn-review-reveal")?.addEventListener("click", () => { state.reviewShowAnswer = true; renderReviewPane(); });
  pane.querySelectorAll("[data-grade]").forEach(b => b.addEventListener("click", () => gradeReview(v, Number(b.dataset.grade))));
}

function gradeReview(v, grade) {
  const t = todayStr();
  state.reviewQueue.shift();
  if (grade === 0) { v.box = 0; v.due = t; state.reviewQueue.push(v.word); }       // 忘記：今天稍後再出一次
  else if (grade === 1) { v.due = addDays(t, 1); }                                   // 模糊：明天再看
  else { v.box = Math.min((v.box || 0) + 1, SRS_INTERVALS.length - 1); v.due = addDays(t, SRS_INTERVALS[v.box]); }
  state.reviewShowAnswer = false;
  markActivity();
  saveState();
  renderReviewPane();
  renderStats();
}

function openVocab(tab) {
  state.vocabTab = tab;
  if (tab === "review") startReview();
  renderVocabSheet();
  openSheet("sheet-vocab");
}

// -----------------------------------------------------------------------------
// Reading timer
// -----------------------------------------------------------------------------
function referenceMinutes() {
  const art = state.slot?.article;
  if (!art) return 0;
  const chars = art.paragraphs.reduce((n, p) => n + charCount(p), 0);
  return Math.max(1, Math.ceil(chars / (READING_SPEED[levelOfArticle(art.level)] || 200) + (art.questions?.length || 0)));
}
function fmtTime(sec) { return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }
function timerSeconds() {
  const t = state.timer;
  return Math.floor((t.elapsed + (t.running ? Date.now() - t.start : 0)) / 1000);
}

function renderTimer() {
  const btn = $("btn-timer");
  const ref = referenceMinutes();
  const sec = timerSeconds();
  if (!state.timer.running && sec === 0) {
    btn.className = "pill";
    btn.innerHTML = `${ICON("timer")}${ref}:00`;
    btn.setAttribute("aria-label", `開始計時，參考 ${ref} 分鐘`);
    return;
  }
  btn.className = `pill ${sec > ref * 60 ? "over" : state.timer.running ? "running" : ""}`;
  btn.innerHTML = `${ICON("timer")}${fmtTime(sec)}`;
  btn.setAttribute("aria-label", state.timer.running ? "暫停計時" : "繼續計時");
}

function toggleTimer() {
  const t = state.timer;
  if (t.running) { t.elapsed += Date.now() - t.start; t.running = false; clearInterval(t.handle); }
  else { t.start = Date.now(); t.running = true; t.handle = setInterval(renderTimer, 1000); }
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
  $("quiz-card").hidden = qs.length === 0;
  if (!qs.length) return;
  const id = currentSlotId();
  const result = state.quizResults[id];
  const answers = result ? result.answers : (state.quizDraft[id] || []);

  $("quiz-list").innerHTML = qs.map((q, qi) => `
    <div class="question">
      <div class="q-type">問${qi + 1}・${esc(q.type)}</div>
      <div class="q-text">${esc(q.question)}</div>
      ${q.options.map((opt, oi) => {
        const picked = answers[qi] === oi;
        let cls = picked ? "picked" : "";
        let mark = picked ? "✓" : "";
        if (result) {
          if (oi === q.answer) { cls = "correct"; mark = "✓"; }
          else if (picked) { cls = "wrong"; mark = "✕"; }
          else cls = "dim";
        }
        return `<button type="button" class="option ${cls}" data-q="${qi}" data-o="${oi}" ${result ? "disabled" : ""}><span class="radio">${mark}</span><span>${esc(opt)}</span></button>`;
      }).join("")}
      ${result ? `<div class="explain">${esc(q.explanation)}</div>` : ""}
    </div>`).join("");

  if (!result) $("quiz-list").querySelectorAll(".option").forEach(b => b.addEventListener("click", () => {
    const draft = state.quizDraft[id] || [];
    draft[Number(b.dataset.q)] = Number(b.dataset.o);
    state.quizDraft[id] = draft;
    renderQuiz();
  }));

  $("btn-quiz-submit").hidden = !!result;
  $("btn-quiz-retry").hidden = !result;
  $("quiz-score").textContent = result
    ? `${result.correct}/${result.total}${result.seconds ? ` · ${fmtTime(result.seconds)}` : ""}`
    : `${answers.filter(a => a !== undefined).length}/${qs.length}`;
}

function submitQuiz() {
  const qs = state.slot.article.questions;
  const id = currentSlotId();
  const answers = state.quizDraft[id] || [];
  if (answers.filter(a => a !== undefined).length < qs.length) { showToast("還有題目沒作答"); return; }
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
  renderHero();
  renderStats();
  showToast(`答對 ${correct}/${qs.length}`);
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
// Slot selection
// -----------------------------------------------------------------------------
let selectToken = 0;
async function selectSlot(date, key) {
  const day = findDay(date);
  if (!day) return;
  if (!key || !day.slots[key]) key = latestSlotKey(day);
  stopSpeech();
  resetTimer();
  state.activeDate = date;
  state.activeSlotKey = key;
  renderDayTabs();
  renderSlotTabs();

  const token = ++selectToken;
  $("content-root").style.opacity = ".5";
  try {
    const data = await loadSlot(date, key);
    if (token !== selectToken) return; // 使用者已切到別的時段
    state.slot = data;
    $("load-error").hidden = true;
    $("content-root").hidden = false;
    renderHero();
    renderContent();
  } catch (e) {
    if (token !== selectToken) return;
    showLoadError(`無法載入 ${date} ${key}：${e.message}`);
  } finally {
    if (token === selectToken) $("content-root").style.opacity = "";
  }
}

function showLoadError(msg) {
  const box = $("load-error");
  box.textContent = msg + (location.protocol === "file:" ? "（請用本機伺服器開啟，見 README）" : "");
  box.hidden = false;
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------
function bindEvents() {
  // Navbar 捲動後顯示標題與分隔線
  const navbar = $("navbar");
  const onScroll = () => navbar.classList.toggle("scrolled", window.scrollY > 36);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Section tabs
  document.querySelectorAll("#section-tabs button").forEach(b => b.addEventListener("click", () => {
    if (state.section === b.dataset.section) return;
    stopSpeech();
    state.section = b.dataset.section;
    saveState();
    renderSectionTabs();
  }));

  // Toolbar
  const toggle = (key, rerender) => () => {
    state[key] = !state[key];
    saveState();
    applyDisplayPrefs();
    if (rerender && state.slot) { renderDialogue(); renderArticle(); }
  };
  $("tool-furigana").addEventListener("click", toggle("showFurigana"));
  $("tool-highlight").addEventListener("click", toggle("showExamHighlight"));
  $("tool-translation").addEventListener("click", toggle("showTranslation", true));
  $("tool-display").addEventListener("click", () => { populateVoices(); $("input-openai-key").value = state.openaiKey || ""; openSheet("sheet-settings"); });

  // Settings sheet
  $("set-furigana").addEventListener("change", e => { state.showFurigana = e.target.checked; saveState(); applyDisplayPrefs(); });
  $("set-highlight").addEventListener("change", e => { state.showExamHighlight = e.target.checked; saveState(); applyDisplayPrefs(); });
  $("set-translation").addEventListener("change", e => {
    state.showTranslation = e.target.checked; saveState(); applyDisplayPrefs();
    if (state.slot) { renderDialogue(); renderArticle(); }
  });
  document.querySelectorAll("#set-hl-levels button").forEach(b => b.addEventListener("click", () => {
    state.hlLevels[b.dataset.hlLevel] = !state.hlLevels[b.dataset.hlLevel];
    if (!state.showExamHighlight) state.showExamHighlight = true;
    saveState(); applyDisplayPrefs();
  }));
  document.querySelectorAll("#set-font button").forEach(b => b.addEventListener("click", () => {
    state.largeFont = b.dataset.font === "large"; saveState(); applyDisplayPrefs();
  }));
  document.querySelectorAll("#set-rate button").forEach(b => b.addEventListener("click", () => {
    state.speechRate = parseFloat(b.dataset.rate);
    if (currentAudioObj) currentAudioObj.playbackRate = state.speechRate;
    saveState(); applyDisplayPrefs();
  }));
  $("select-jp-voice").addEventListener("change", e => { state.selectedVoiceURI = e.target.value; saveState(); });
  $("input-openai-key").addEventListener("change", e => { state.openaiKey = e.target.value.trim(); saveState(); });
  $("btn-test-voice").addEventListener("click", function () {
    state.openaiKey = $("input-openai-key").value.trim();
    speakSentencesSequentially(["こんにちは。毎日の日本語読解へようこそ。"], [], null, false);
  });

  // Reading
  $("btn-speak-dialogue").dataset.label = "朗讀對話";
  $("btn-speak-article").dataset.label = "朗讀文章";
  setSpeakBtn($("btn-speak-dialogue"), false);
  setSpeakBtn($("btn-speak-article"), false);
  $("btn-speak-dialogue").addEventListener("click", function () { startReading("dialogue", this); });
  $("btn-speak-article").addEventListener("click", function () { startReading("article", this); });
  $("btn-timer").addEventListener("click", toggleTimer);
  $("btn-quiz-submit").addEventListener("click", submitQuiz);
  $("btn-quiz-retry").addEventListener("click", retryQuiz);

  // Vocab
  $("btn-open-vocab").addEventListener("click", () => openVocab(dueVocab().length ? "review" : "list"));
  $("btn-open-review").addEventListener("click", () => openVocab("review"));
  document.querySelectorAll("#vocab-tabs button").forEach(b => b.addEventListener("click", () => {
    state.vocabTab = b.dataset.vtab;
    if (state.vocabTab === "review") startReview();
    renderVocabSheet();
  }));
  $("btn-clear-vocab").addEventListener("click", () => {
    if (!state.savedVocab.length) return;
    if (!confirm(`清空全部 ${state.savedVocab.length} 個收藏？複習進度也會刪除，無法復原。`)) return;
    state.savedVocab = [];
    state.reviewQueue = [];
    saveState();
    renderVocabSheet();
    renderWords();
    renderStats();
  });

  // Settings button
  $("btn-open-settings").addEventListener("click", () => { populateVoices(); $("input-openai-key").value = state.openaiKey || ""; openSheet("sheet-settings"); });

  // Sheets: close by backdrop, 完成, Esc, or swipe down on the header
  $("backdrop").addEventListener("click", closeSheet);
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeSheet));
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
  document.querySelectorAll(".sheet").forEach(sheet => {
    let startY = null;
    const head = [sheet.querySelector(".grabber"), sheet.querySelector(".sheet-head")];
    head.forEach(h => {
      h.addEventListener("touchstart", e => { startY = e.touches[0].clientY; }, { passive: true });
      h.addEventListener("touchend", e => {
        if (startY !== null && e.changedTouches[0].clientY - startY > 60) closeSheet();
        startY = null;
      });
    });
  });
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------
async function initApp() {
  loadSavedState();
  try {
    if ("speechSynthesis" in window) {
      populateVoices();
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }
  } catch (e) {}
  bindEvents();
  applyDisplayPrefs();
  renderNav();
  renderStats();
  renderSectionTabs();

  try {
    await loadManifest();
  } catch (e) {
    showLoadError(`無法載入文章清單：${e.message}`);
    $("content-root").hidden = true;
    return;
  }
  if (!state.manifest.days.length) {
    showLoadError("目前還沒有文章");
    $("content-root").hidden = true;
    return;
  }
  const latest = state.manifest.days[0];
  await selectSlot(latest.date, latestSlotKey(latest));
}

initApp();
