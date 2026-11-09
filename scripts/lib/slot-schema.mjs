// 驗證單一時段 JSON（data/slots/YYYY-MM-DD_HHMM.json）
// legacy: true 的舊資料只對「讀解題、紅底數量」給警告，新資料一律視為錯誤。
import { parseMarkup, listHighlights, charCount, LEVELS } from "../../assets/markup.js";

export const SLOTS = ["08:00", "17:00", "22:00"];

export const LIMITS = {
  dialogueLines: [3, 10],
  articleParagraphs: [2, 6],
  articleChars: { hardMin: 250, hardMax: 1100, softMin: 300, softMax: 550 },
  dialogueChars: { softMin: 60, softMax: 140 },
  highlightsPerBlock: 2,   // 每句對話／每段文章最多幾個紅底
  highlightsTotal: 8,      // 每個時段最多幾個紅底
  questions: [2, 4]
};

export function slotFileName(date, slot) {
  return `${date}_${slot.replace(":", "")}.json`;
}

export function parseSlotFileName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})\.json$/.exec(name);
  return m ? { date: m[1], slot: `${m[2]}:${m[3]}` } : null;
}

export function validateSlot(data, { fileName } = {}) {
  const errors = [];
  const warnings = [];
  const strict = !(data && data.legacy === true);
  const soft = (msg) => (strict ? errors : warnings).push(msg);

  const isStr = v => typeof v === "string" && v.trim().length > 0;
  const need = (obj, key, where) => { if (!obj || !isStr(obj[key])) errors.push(`${where}.${key} 必須是非空字串`); };
  const levelOk = v => LEVELS.includes(v);

  if (!data || typeof data !== "object" || Array.isArray(data)) return { errors: ["檔案內容必須是 JSON 物件"], warnings };
  if (data.schemaVersion !== 2) errors.push("schemaVersion 必須是 2");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || "")) errors.push("date 格式應為 YYYY-MM-DD");
  if (!SLOTS.includes(data.slot)) errors.push(`slot 必須是 ${SLOTS.join(" / ")} 其中之一`);
  if (fileName) {
    const f = parseSlotFileName(fileName);
    if (!f) errors.push(`檔名格式應為 YYYY-MM-DD_HHMM.json：${fileName}`);
    else if (f.date !== data.date || f.slot !== data.slot) errors.push(`檔名 ${fileName} 和內容的 date/slot（${data.date} ${data.slot}）不一致`);
  }
  need(data, "theme", "slot");

  const checkMarkup = (text, where) => {
    const { errors: e } = parseMarkup(text);
    e.forEach(msg => errors.push(`${where}：${msg}`));
    const n = listHighlights(text).length;
    if (n > LIMITS.highlightsPerBlock) soft(`${where}：紅底標記 ${n} 個，超過每段 ${LIMITS.highlightsPerBlock} 個的上限`);
    return n;
  };
  const checkVocab = (list, where, min) => {
    if (!Array.isArray(list) || list.length < min) { errors.push(`${where} 至少要有 ${min} 個`); return; }
    list.forEach((v, i) => {
      need(v, "word", `${where}[${i}]`);
      need(v, "meaning", `${where}[${i}]`);
      if (!levelOk(v && v.level)) errors.push(`${where}[${i}].level 必須是 N1～N5`);
    });
  };

  let hlTotal = 0;

  // ---- 對話 ----
  const dlg = data.dialogue;
  if (!dlg || typeof dlg !== "object") errors.push("缺少 dialogue");
  else {
    ["scene", "title", "tone"].forEach(k => need(dlg, k, "dialogue"));
    const [lmin, lmax] = LIMITS.dialogueLines;
    if (!Array.isArray(dlg.lines) || dlg.lines.length < lmin || dlg.lines.length > lmax) {
      errors.push(`dialogue.lines 應為 ${lmin}～${lmax} 句`);
    } else {
      let chars = 0;
      dlg.lines.forEach((l, i) => {
        ["speaker", "role", "jp", "zh"].forEach(k => need(l, k, `dialogue.lines[${i}]`));
        if (l && isStr(l.jp)) { hlTotal += checkMarkup(l.jp, `dialogue.lines[${i}].jp`); chars += charCount(l.jp); }
      });
      const { softMin, softMax } = LIMITS.dialogueChars;
      if (chars < softMin || chars > softMax) warnings.push(`對話共 ${chars} 字，建議 ${softMin}～${softMax} 字`);
    }
    checkVocab(dlg.vocab, "dialogue.vocab", 2);
  }

  // ---- 文章 ----
  const art = data.article;
  if (!art || typeof art !== "object") errors.push("缺少 article");
  else {
    ["genre", "title"].forEach(k => need(art, k, "article"));
    if (!/^N[1-5](~N[1-5])?$/.test(art.level || "")) errors.push("article.level 格式應為 N2 或 N1~N2");
    const [pmin, pmax] = LIMITS.articleParagraphs;
    if (!Array.isArray(art.paragraphs) || art.paragraphs.length < pmin || art.paragraphs.length > pmax) {
      errors.push(`article.paragraphs 應為 ${pmin}～${pmax} 段`);
    } else {
      let chars = 0;
      art.paragraphs.forEach((p, i) => {
        if (!isStr(p)) { errors.push(`article.paragraphs[${i}] 必須是非空字串`); return; }
        hlTotal += checkMarkup(p, `article.paragraphs[${i}]`);
        chars += charCount(p);
      });
      const c = LIMITS.articleChars;
      if (chars < c.hardMin || chars > c.hardMax) errors.push(`文章共 ${chars} 字，必須在 ${c.hardMin}～${c.hardMax} 字之間`);
      else if (chars < c.softMin || chars > c.softMax) warnings.push(`文章共 ${chars} 字，建議 ${c.softMin}～${c.softMax} 字`);
      if (!Array.isArray(art.translation) || art.translation.length !== art.paragraphs.length || !art.translation.every(isStr)) {
        errors.push("article.translation 必須和 paragraphs 段數相同，且每段都有中文");
      }
    }
    checkVocab(art.vocab, "article.vocab", 3);
    if (!Array.isArray(art.grammar) || art.grammar.length < 2) errors.push("article.grammar 至少要有 2 個");
    else art.grammar.forEach((g, i) => {
      need(g, "pattern", `article.grammar[${i}]`);
      need(g, "explanation", `article.grammar[${i}]`);
      if (!levelOk(g && g.level)) errors.push(`article.grammar[${i}].level 必須是 N1～N5`);
    });

    // 讀解題
    const [qmin, qmax] = LIMITS.questions;
    const qs = art.questions;
    if (!Array.isArray(qs) || qs.length < qmin || qs.length > qmax) {
      soft(`article.questions 應為 ${qmin}～${qmax} 題`);
    }
    if (Array.isArray(qs)) qs.forEach((q, i) => {
      const w = `article.questions[${i}]`;
      ["type", "question", "explanation"].forEach(k => need(q, k, w));
      if (!q || !Array.isArray(q.options) || q.options.length !== 4 || !q.options.every(isStr)) errors.push(`${w}.options 必須是 4 個非空選項`);
      else if (new Set(q.options).size !== 4) errors.push(`${w}.options 有重複選項`);
      if (!q || !Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) errors.push(`${w}.answer 必須是 0～3 的整數（正確選項的索引）`);
    });

    // 出處（選填）
    if (art.sources !== undefined) {
      if (!Array.isArray(art.sources)) errors.push("article.sources 必須是陣列");
      else art.sources.forEach((s, i) => {
        need(s, "title", `article.sources[${i}]`);
        if (!s || !/^https:\/\/\S+$/.test(s.url || "")) errors.push(`article.sources[${i}].url 必須是 https 網址`);
      });
    }
  }

  // 朗讀音檔（選填，由 scripts/tts.mjs 產生）
  if (data.audio !== undefined) {
    const a = data.audio;
    const id = `${data.date}_${String(data.slot || "").replace(":", "")}`;
    const pathOk = p => typeof p === "string" && p.startsWith(`data/audio/${id}/`) && /^[\w\-\/]+\.(mp3|wav)$/.test(p);
    if (!a || typeof a !== "object") errors.push("audio 必須是物件");
    else {
      if (!Array.isArray(a.dialogue) || a.dialogue.length !== (dlg?.lines?.length ?? -1)) errors.push("audio.dialogue 的數量必須和對話句數相同");
      if (!Array.isArray(a.article) || a.article.length !== (art?.paragraphs?.length ?? -1)) errors.push("audio.article 的數量必須和文章段數相同");
      [...(a.dialogue || []), ...(a.article || [])].forEach(p => { if (!pathOk(p)) errors.push(`audio 路徑格式錯誤：${p}`); });
    }
  }

  if (hlTotal > LIMITS.highlightsTotal) soft(`紅底標記共 ${hlTotal} 個，超過每個時段 ${LIMITS.highlightsTotal} 個的上限`);

  return { errors, warnings };
}
