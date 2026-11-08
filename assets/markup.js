// =============================================================================
// 文章標記語法（瀏覽器與 Node 腳本共用）
//
//   {漢字|かんじ}              → 振假名（ruby）
//   [[表現|N2|單字|說明]]      → 常考紅底標記，表現內可再包含 {漢字|かんじ}
//
// 這個格式比直接寫 HTML 短很多、AI 不容易寫壞，也能被腳本自動檢查。
// =============================================================================

export const LEVELS = ["N1", "N2", "N3", "N4", "N5"];

const KANA_RE = /^[ぁ-ゖゝ-ゟァ-ヺー-ヿ・]+$/;

/** 解析標記字串，回傳 { tokens, errors } */
export function parseMarkup(input) {
  const errors = [];
  const tokens = parseInline(String(input ?? ""), errors, false);
  return { tokens, errors: [...new Set(errors)] };
}

function parseInline(s, errors, insideHighlight) {
  const tokens = [];
  let buf = "";
  const flush = () => { if (buf) { tokens.push({ type: "text", text: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("[[", i)) {
      if (insideHighlight) { errors.push(`紅底標記不可巢狀：…${s.slice(i, i + 15)}…`); i += 2; continue; }
      const end = s.indexOf("]]", i + 2);
      if (end < 0) { errors.push(`缺少結尾的 ]]：…${s.slice(i, i + 15)}…`); buf += s.slice(i); break; }
      flush();
      tokens.push(parseHighlight(s.slice(i + 2, end), errors));
      i = end + 2;
      continue;
    }
    if (s.startsWith("]]", i)) { errors.push(`多出來的 ]]：…${s.slice(Math.max(0, i - 10), i + 2)}`); i += 2; continue; }
    if (s[i] === "{") {
      const end = s.indexOf("}", i + 1);
      if (end < 0) { errors.push(`缺少結尾的 }：…${s.slice(i, i + 15)}…`); buf += s.slice(i); break; }
      const inner = s.slice(i + 1, end);
      const bar = inner.indexOf("|");
      const base = bar >= 0 ? inner.slice(0, bar) : inner;
      const rt = bar >= 0 ? inner.slice(bar + 1) : "";
      if (!base || !rt) errors.push(`振假名格式應為 {漢字|かな}：{${inner}}`);
      else if (/[{\[\]|]/.test(base) || /[{\[\]|]/.test(rt)) errors.push(`振假名內不可有括號或 |：{${inner}}`);
      else if (!KANA_RE.test(rt)) errors.push(`讀音只能是假名：{${inner}}`);
      flush();
      tokens.push({ type: "ruby", base, rt });
      i = end + 1;
      continue;
    }
    if (s[i] === "}") { errors.push(`多出來的 }：…${s.slice(Math.max(0, i - 10), i + 1)}`); i++; continue; }
    if (s[i] === "<" || s[i] === ">") { errors.push("內文不可包含 HTML 標籤或 < >"); }
    buf += s[i];
    i++;
  }
  flush();
  return tokens;
}

function parseHighlight(inner, errors) {
  // 以「不在 {} 內的 |」切成 4 段：表現|級數|類別|說明
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "|" && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  if (parts.length !== 4) {
    errors.push(`紅底標記格式應為 [[表現|N2|類別|說明]]：[[${inner}]]`);
  }
  const [expr = "", level = "", kind = "", note = ""] = parts;
  if (!LEVELS.includes(level.trim())) errors.push(`紅底標記級數應為 N1～N5：[[${inner}]]`);
  if (!expr.trim()) errors.push(`紅底標記沒有內容：[[${inner}]]`);
  return {
    type: "hl",
    level: level.trim(),
    kind: kind.trim(),
    note: note.trim(),
    children: parseInline(expr, errors, true)
  };
}

/** 去掉所有標記，只留下日文原文（給朗讀與字數統計用） */
export function toPlain(input) {
  const walk = toks => toks.map(t => t.type === "text" ? t.text : t.type === "ruby" ? t.base : walk(t.children)).join("");
  return walk(parseMarkup(input).tokens);
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 轉成網頁用 HTML（所有文字都會跳脫，AI 輸出無法注入 HTML） */
export function toHtml(input) {
  const walk = toks => toks.map(t => {
    if (t.type === "text") return escapeHtml(t.text);
    if (t.type === "ruby") return `<ruby>${escapeHtml(t.base)}<rt>${escapeHtml(t.rt)}</rt></ruby>`;
    const tip = `【${t.level}${t.kind ? "・" + t.kind : ""}】${t.note}`;
    return `<span class="exam-hl" data-level="${escapeHtml(t.level)}" data-tip="${escapeHtml(tip)}">${walk(t.children)}</span>`;
  }).join("");
  return walk(parseMarkup(input).tokens);
}

/** 列出字串中所有紅底標記 */
export function listHighlights(input) {
  return parseMarkup(input).tokens.filter(t => t.type === "hl");
}

/** 計算日文字數（不含空白） */
export function charCount(input) {
  return toPlain(input).replace(/\s/g, "").length;
}
