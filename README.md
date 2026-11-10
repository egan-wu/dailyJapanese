# 日日讀日文 YomuHi

每天 08:00、12:00、18:00 上架新文章的 JLPT 日文閱讀練習網站，架在 GitHub Pages。**一週更新一次就好**：一次放入 7 天共 21 篇，網頁依台灣時間自動上架。

## 內容規格

- 每個時段：一則約 100 字的日常生活短對話＋一篇 450～700 字的讀解文章，都附繁體中文翻譯
- 文章 7 種類別輪流，每週各 3 篇：評論、隨筆、深度社論・報導、生物、科學、經濟、文學
- 難度在 JLPT N3～N1 之間輪替；報導、經濟、科學、生物類先上網取材再改寫，並附參考來源
- 每週的文法和單字盡量不重複

## 顯示規則

- 首頁只顯示「今天已到時間」的時段：08:00、12:00、18:00 各自解鎖，還沒到的顯示 🔒
- 頁面開著時，時間一到會自動上架並切到新文章
- 過去的日期收在右上角的 📅

## 功能

- 可切換振假名、中文翻譯、字體大小，支援深色模式
- **常考紅底**：可依 N1／N2／N3 個別開關，點擊看考點解析
- **讀解題**：JLPT 題型（內容理解、主張理解…），作答後顯示解析，並自動打卡
- **計時閱讀**：依級數與字數給參考時間，超時會變紅
- **單字複習**：收藏的單字依遺忘曲線排程（1、2、4、7、15、30、60 天）
- **學習紀錄**：連續閱讀天數、近 7 天讀完數、讀解答對率
- **歷史存檔**：所有文章都保留，可回頭複習
- **朗讀**：優先播放 Google Cloud TTS 預先產生的音檔（對話分角色、逐句高亮）；沒有音檔時改用瀏覽器日文語音或自己的 OpenAI Key

學習紀錄只存在瀏覽器（localStorage），換裝置或清除瀏覽資料就會消失。

## 檔案結構

```
index.html                 網頁版面
assets/app.js              網頁程式
assets/markup.js           文章標記語法（網頁和腳本共用）
data/slots/                每個時段一個 JSON：YYYY-MM-DD_HHMM.json
data/manifest.json         文章清單（自動產生）
data/audio/                朗讀音檔（自動產生，只保留最近 30 天）
prompts/generate-slot.md   給 AI 的指令
scripts/generate.mjs       呼叫 Gemini 產生文章
scripts/tts.mjs            呼叫 Cloud TTS 產生朗讀音檔、清除過期音檔
scripts/validate.mjs       檢查所有文章格式
scripts/build-manifest.mjs 產生文章清單
.github/workflows/         自動產文與部署
```

## 第一次設定

1. 在 GitHub 建立 repo，把這個資料夾推上去（分支名稱要是 `main`）：
   ```bash
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<你的帳號>/<repo 名稱>.git
   git push -u origin main
   ```
2. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 到 [Google AI Studio](https://aistudio.google.com/apikey) 申請 Gemini API Key，然後在
   **Settings → Secrets and variables → Actions → Secrets** 新增 `GEMINI_API_KEY`。
4. （選填）在同一頁的 **Variables** 新增 `GEMINI_MODEL`：要用的模型（預設 `gemini-2.5-flash`；Google 下架舊模型時改這裡）。
5. （選填，建議）設定 Google Cloud TTS 朗讀音檔，步驟見下一節。
6. 到 **Actions → Generate weekly reading → Run workflow** 手動跑一次，確認能產生文章並部署成功。

之後**每週日台灣時間 12:00** 會自動產生下週一～日的 21 篇，約需 10～20 分鐘。要指定從哪一天開始，手動執行時填入 `week` 日期即可。

本機也可以手動產生：

```bash
GEMINI_API_KEY=你的金鑰 node scripts/generate.mjs --week 2026-11-16
```

## 朗讀音檔（Google Cloud TTS）

不設定也能用，網頁會改用瀏覽器內建語音；但很多電腦沒有日文語音，會念不出來或念成中文，所以建議設定。

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案，並**啟用帳單帳戶**（就算在免費額度內也必須綁卡）。
2. 在「API 和服務」啟用 **Cloud Text-to-Speech API**。
3. 「API 和服務 → 憑證 → 建立憑證 → API 金鑰」，建立後點進去把 **API 限制** 設成只允許 Cloud Text-to-Speech API。
4. 在 GitHub **Settings → Secrets and variables → Actions → Secrets** 新增 `GOOGLE_TTS_API_KEY`。
5. 建議在 Cloud Console 的「帳單 → 預算與快訊」設定一個小額預算警示（例如 US$1）。

用量估算：每天 3 個時段，一個月約 9～10 萬字，遠低於 Neural2 等級的每月免費額度（實際額度與價格以 Google 官方價格頁為準）。第一次執行時會順便幫最近 30 天內已有的文章補產生音檔。

可選的 Variables：

| 名稱 | 預設 | 說明 |
|---|---|---|
| `TTS_VOICE_NARRATOR` | `ja-JP-Neural2-B` | 文章朗讀聲音 |
| `TTS_VOICE_A` / `TTS_VOICE_B` | `ja-JP-Neural2-B` / `ja-JP-Neural2-C` | 對話第 1、2 位說話者（女聲／男聲） |
| `TTS_USE_FURIGANA` | `false` | `true`＝依頁面上的振假名指定讀音。預設直接送漢字，重音和斷詞比較自然 |
| `AUDIO_KEEP_DAYS` | `30` | 音檔保留天數。更早的文章自動改回瀏覽器語音，避免 repo 太大 |

可用的聲音名稱見 [Cloud TTS 支援的語音清單](https://cloud.google.com/text-to-speech/docs/voices)（篩選 Japanese）。改了聲音設定後，下次執行會自動重新產生保留期間內的音檔（每次最多 12 個時段）。

## 自動化流程

```
每週日排程 → generate.mjs 逐篇產生下週 21 篇
             （報導、經濟、科學、生物類先用 Gemini 的 Google 搜尋取材）
           → 檢查格式（不合格會把錯誤回傳給 AI 修正，最多 3 次）
           → 寫入 data/slots/ → tts.mjs 產生朗讀音檔、刪除過期音檔 → commit → 部署
網頁       → 依台灣時間，08:00／12:00／18:00 到了才顯示
```

- 部分文章失敗時，成功的照樣上架；失敗的時段可以再手動執行一次補上（已存在的會略過）。
- 注意：未來的文章雖然在網頁上看不到，但放在公開 repo 裡，知道路徑的人還是讀得到。

- 音檔產生失敗不會影響文章上線，網頁會改用瀏覽器語音，下次執行時會再補。

- 檢查沒通過就不寫入任何檔案，網站繼續顯示原本的文章。
- 每次部署都會重新檢查所有文章；有壞掉的檔案會被略過（網站照常運作），validate job 失敗時 GitHub 會寄信通知你。

## 改用 Gemini Spark 或其他 AI 產文

只要讓它把一個時段的 JSON commit 到 `data/slots/YYYY-MM-DD_HHMM.json`（例如 `2026-11-09_0800.json`）並 push 到 `main`，部署時就會自動加入清單。

- 指令內容直接用 [prompts/generate-slot.md](prompts/generate-slot.md)，把 `{{...}}` 換成實際的值；每個時段的類別和難度可用 `node scripts/generate.mjs --slot 08:00 --date 2026-11-16 --print-prompt --no-research` 印出來。
- 一週一次產生 21 個檔案即可，不用每天執行。
- JSON 還要加上這三個欄位：`"schemaVersion": 2`、`"date": "2026-11-09"`、`"slot": "08:00"`。
- 如果 Spark 沒辦法 push 到 GitHub，就用上面的 GitHub Actions 方案，不需要 Spark。
- 兩種方式同時用的話，同一個時段已經有檔案時，Actions 會略過不重複產生。

## 文章標記語法

```
{漢字|かんじ}                 振假名
[[表現|N2|單字|說明]]         常考紅底，表現內可以再放 {漢字|かんじ}
```

範例：`[[{先方|せんぽう}|N2|單字|先方：對方、客戶方]]の{都合|つごう}で`

每句對話、每段文章最多 2 個紅底，每個時段最多 10 個。完整規則見 [scripts/lib/slot-schema.mjs](scripts/lib/slot-schema.mjs)。

## 在自己電腦上測試

網頁要用伺服器開啟（直接雙擊 index.html 會讀不到資料）：

```bash
python -m http.server 8123
```

然後開 http://localhost:8123 。其他指令：

```bash
npm run validate
```

```bash
GEMINI_API_KEY=你的金鑰 node scripts/generate.mjs --slot 08:00 --date 2026-11-09
```

```bash
node scripts/generate.mjs --print-prompt
```

```bash
GOOGLE_TTS_API_KEY=你的金鑰 node scripts/tts.mjs
```

```bash
node scripts/tts.mjs --mock --only 2026-11-08_1800
```

`--mock` 不會呼叫 API，只產生測試用的提示音，用來檢查播放流程；測完記得刪掉 `data/audio/` 和 JSON 裡的 `audio` 欄位，不要 commit。

## 舊資料

最早的 3 天（2026-11-06～08）是從舊版網頁轉換過來的，標記為 `"legacy": true`：紅底比較多、沒有讀解題（11-08 已補上），檢查時只給警告。舊版標示「約 580 字」，實際只有約 380 字。
