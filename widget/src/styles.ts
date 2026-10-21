// widget 樣式(注入 shadow DOM,與宿主頁面隔離)。--kf-primary 由設定注入。
export const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.kf-root {
  --kf-primary: #2563eb;
  --kf-bg: #ffffff;
  --kf-fg: #1f2937;
  --kf-muted: #6b7280;
  --kf-border: #e5e7eb;
  --kf-visitor: var(--kf-primary);
  --kf-visitor-fg: #ffffff;
  --kf-agent-bg: #f3f4f6;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC",
    "Microsoft JhengHei", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--kf-fg);
}
.kf-bubble {
  position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px;
  border-radius: 50%; background: var(--kf-primary); color: #fff;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.18); border: none; z-index: 2147483000;
  transition: transform .15s ease;
}
.kf-bubble:hover { transform: scale(1.06); }
.kf-bubble svg { width: 26px; height: 26px; }
.kf-panel {
  position: fixed; right: 20px; bottom: 88px; width: 360px; max-width: calc(100vw - 32px);
  height: 520px; max-height: calc(100vh - 120px);
  background: var(--kf-bg); border: 1px solid var(--kf-border); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,.22); display: flex; flex-direction: column;
  overflow: hidden; z-index: 2147483000;
}
.kf-hidden { display: none !important; }
.kf-header {
  background: var(--kf-primary); color: #fff; padding: 12px 14px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.kf-header .kf-title { font-weight: 600; font-size: 15px; }
.kf-status { font-size: 11px; opacity: .85; display: flex; align-items: center; gap: 5px; }
.kf-dot { width: 8px; height: 8px; border-radius: 50%; background: #fca5a5; display: inline-block; }
.kf-dot.on { background: #4ade80; }
.kf-close { background: transparent; border: none; color: #fff; cursor: pointer; font-size: 20px; line-height: 1; padding: 2px 6px; }
.kf-body { flex: 1; overflow-y: auto; padding: 14px; background: #fafafa; display: flex; flex-direction: column; gap: 10px; }
.kf-row { display: flex; }
.kf-row.visitor { justify-content: flex-end; }
.kf-row.agent { justify-content: flex-start; }
.kf-msg {
  max-width: 78%; padding: 8px 11px; border-radius: 12px; word-wrap: break-word; overflow-wrap: anywhere;
}
.kf-row.visitor .kf-msg { background: var(--kf-visitor); color: var(--kf-visitor-fg); border-bottom-right-radius: 4px; }
.kf-row.agent .kf-msg { background: var(--kf-agent-bg); color: var(--kf-fg); border-bottom-left-radius: 4px; }
.kf-msg.pending { opacity: .6; }
.kf-msg.error { background: #fee2e2; color: #991b1b; }
.kf-msg p, .kf-msg div { margin: 0; }
.kf-msg pre { background: rgba(0,0,0,.06); padding: 8px; border-radius: 6px; overflow-x: auto; margin: 4px 0; }
.kf-row.visitor .kf-msg pre { background: rgba(255,255,255,.18); }
.kf-msg code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.kf-msg a { color: inherit; text-decoration: underline; }
.kf-msg ul { margin: 4px 0; padding-left: 18px; }
.kf-system { align-self: center; color: var(--kf-muted); font-size: 12px; background: transparent; text-align: center; max-width: 90%; }
.kf-footer { border-top: 1px solid var(--kf-border); padding: 10px; display: flex; gap: 8px; align-items: flex-end; background: var(--kf-bg); }
.kf-input {
  flex: 1; resize: none; border: 1px solid var(--kf-border); border-radius: 10px;
  padding: 8px 10px; font: inherit; color: var(--kf-fg); max-height: 96px; outline: none;
}
.kf-input:focus { border-color: var(--kf-primary); }
.kf-send {
  background: var(--kf-primary); color: #fff; border: none; border-radius: 10px;
  width: 40px; height: 38px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
}
.kf-send:disabled { opacity: .5; cursor: not-allowed; }
.kf-send svg { width: 18px; height: 18px; }
.kf-notice { font-size: 12px; color: #92400e; background: #fef3c7; border: 1px solid #fde68a; padding: 8px 10px; border-radius: 8px; }
.kf-body::-webkit-scrollbar { width: 8px; }
.kf-body::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }

/* ---- 輸入區工具鈕(附件 / 表情) ---- */
.kf-tool {
  background: transparent; border: 1px solid var(--kf-border); border-radius: 10px;
  width: 36px; height: 38px; flex: 0 0 auto; cursor: pointer; color: var(--kf-muted);
  display: flex; align-items: center; justify-content: center; font-size: 18px; line-height: 1;
  transition: background .12s ease, color .12s ease;
}
.kf-tool:hover { background: #f3f4f6; color: var(--kf-fg); }
.kf-tool svg { width: 20px; height: 20px; }

/* ---- 表情面板(純前端,常用 emoji 網格) ---- */
.kf-footer { position: relative; }
.kf-emoji-panel {
  position: absolute; left: 10px; right: 10px; bottom: calc(100% + 6px);
  background: var(--kf-bg); border: 1px solid var(--kf-border); border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.16); padding: 8px; z-index: 5;
  display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; max-height: 180px; overflow-y: auto;
}
.kf-emoji-panel button {
  background: transparent; border: none; cursor: pointer; font-size: 20px; line-height: 1;
  padding: 4px 0; border-radius: 8px;
}
.kf-emoji-panel button:hover { background: #f3f4f6; }

/* ---- 圖片訊息 ---- */
.kf-msg.kf-media { padding: 4px; background: transparent !important; }
.kf-img {
  display: block; max-width: 200px; max-height: 200px; border-radius: 10px; cursor: zoom-in;
  object-fit: cover; background: #e5e7eb;
}

/* ---- 檔案訊息 ---- */
.kf-file { display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; }
.kf-file svg { width: 22px; height: 22px; flex: 0 0 auto; opacity: .8; }
.kf-file .kf-file-name { text-decoration: underline; word-break: break-all; }

/* ---- 上傳中佔位 ---- */
.kf-uploading { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.kf-progress { flex: 1; height: 6px; background: rgba(255,255,255,.35); border-radius: 999px; overflow: hidden; }
.kf-progress > i { display: block; height: 100%; width: 0; background: #fff; transition: width .15s ease; }

/* ---- 圖片燈箱(點縮圖看大圖) ---- */
.kf-lightbox {
  position: fixed; inset: 0; background: rgba(0,0,0,.72); z-index: 2147483001;
  display: flex; align-items: center; justify-content: center; padding: 24px; cursor: zoom-out;
}
.kf-lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.5); }

/* ---- 標頭 logo 與左側容器 ---- */
.kf-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.kf-logo {
  width: 32px; height: 32px; border-radius: 8px; object-fit: cover; flex: 0 0 auto;
  background: rgba(255,255,255,.2);
}
.kf-header-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.kf-icon-btn {
  background: transparent; border: none; color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 4px; border-radius: 8px;
  opacity: .9;
}
.kf-icon-btn:hover { opacity: 1; background: rgba(255,255,255,.15); }
.kf-icon-btn svg { width: 18px; height: 18px; }

/* ---- 通用表單(pre-chat / 離線留言) ---- */
.kf-form { padding: 16px 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.kf-form-intro { font-size: 13px; color: var(--kf-muted); line-height: 1.6; }
.kf-field { display: flex; flex-direction: column; gap: 5px; }
.kf-field label { font-size: 12.5px; color: var(--kf-fg); font-weight: 600; }
.kf-field .kf-req { color: #dc2626; margin-left: 2px; }
.kf-field input, .kf-field textarea {
  border: 1px solid var(--kf-border); border-radius: 10px; padding: 9px 11px;
  font: inherit; color: var(--kf-fg); outline: none; background: #fff; width: 100%;
}
.kf-field input:focus, .kf-field textarea:focus { border-color: var(--kf-primary); }
.kf-field textarea { resize: vertical; min-height: 76px; }
.kf-field.invalid input, .kf-field.invalid textarea { border-color: #dc2626; }
.kf-field-err { font-size: 11.5px; color: #dc2626; min-height: 0; }
.kf-btn {
  background: var(--kf-primary); color: #fff; border: none; border-radius: 10px;
  padding: 10px 14px; font: inherit; font-weight: 600; cursor: pointer;
}
.kf-btn:hover { filter: brightness(.95); }
.kf-btn:disabled { opacity: .55; cursor: not-allowed; }

/* ---- CSAT 評分(覆蓋於面板 body 上方) ---- */
.kf-csat {
  position: absolute; inset: 0; background: rgba(255,255,255,.97); z-index: 6;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 24px; text-align: center;
}
.kf-csat h3 { margin: 0; font-size: 16px; color: var(--kf-fg); }
.kf-csat .kf-csat-sub { font-size: 12.5px; color: var(--kf-muted); margin: -6px 0 0; }
.kf-stars { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
.kf-star {
  background: transparent; border: none; cursor: pointer; padding: 2px; line-height: 1;
  color: #d1d5db;
}
.kf-star svg { width: 34px; height: 34px; }
.kf-star.on { color: #f59e0b; }
.kf-csat textarea {
  width: 100%; border: 1px solid var(--kf-border); border-radius: 10px; padding: 9px 11px;
  font: inherit; color: var(--kf-fg); outline: none; resize: vertical; min-height: 64px;
}
.kf-csat textarea:focus { border-color: var(--kf-primary); }
.kf-csat-actions { display: flex; gap: 8px; width: 100%; }
.kf-csat-actions .kf-btn { flex: 1; }
.kf-btn-ghost {
  background: transparent; color: var(--kf-muted); border: 1px solid var(--kf-border);
  border-radius: 10px; padding: 10px 14px; font: inherit; cursor: pointer;
}
.kf-btn-ghost:hover { background: #f3f4f6; }
.kf-csat-thanks { font-size: 14px; color: var(--kf-fg); }

/* ---- 可自訂 post-chat 問卷(沿用 .kf-csat 覆蓋層;多欄位時改為上對齊 + 可捲動) ---- */
.kf-csat.kf-csat-survey {
  justify-content: flex-start; align-items: stretch; text-align: left;
  overflow-y: auto; gap: 12px;
}
.kf-csat.kf-csat-survey h3 { text-align: center; }
.kf-csat.kf-csat-survey .kf-csat-sub { text-align: center; }
.kf-survey { display: flex; flex-direction: column; gap: 12px; width: 100%; }
.kf-survey .kf-stars { justify-content: flex-start; }
/* choice 單選晶片 */
.kf-choices { display: flex; flex-wrap: wrap; gap: 6px; }
.kf-choice {
  background: transparent; border: 1px solid var(--kf-border); border-radius: 999px;
  padding: 6px 12px; font: inherit; font-size: 12.5px; color: var(--kf-fg); cursor: pointer;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.kf-choice:hover { background: #f3f4f6; }
.kf-choice.on { background: var(--kf-primary); border-color: var(--kf-primary); color: #fff; }
.kf-field.invalid .kf-choices { outline: none; }

/* ---- eye-catcher 圖形 / 圖片(沿用 .kf-proactive 容器定位與外觀) ---- */
.kf-eyecatcher-graphic { display: flex; align-items: center; color: var(--kf-primary); }
.kf-eyecatcher-graphic:not(:last-child) { margin-bottom: 8px; }
.kf-eyecatcher-graphic svg { width: 30px; height: 30px; }
.kf-eyecatcher-img {
  display: block; width: 100%; max-height: 120px; object-fit: cover;
  border-radius: 10px; background: #e5e7eb;
}
.kf-eyecatcher-img:not(:last-child) { margin-bottom: 8px; }

/* ---- 主動式訊息氣泡提示(show_bubble;浮在啟動鈕上方) ---- */
.kf-proactive {
  position: fixed; right: 20px; bottom: 88px; width: 280px; max-width: calc(100vw - 40px);
  background: var(--kf-bg); color: var(--kf-fg); border: 1px solid var(--kf-border);
  border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,.18);
  padding: 13px 34px 13px 15px; z-index: 2147483000; cursor: pointer;
  font-size: 13.5px; line-height: 1.55; animation: kf-pop .2s ease;
}
.kf-proactive:hover { border-color: var(--kf-primary); box-shadow: 0 14px 36px rgba(0,0,0,.24); }
.kf-proactive:focus-visible { outline: 2px solid var(--kf-primary); outline-offset: 2px; }
.kf-proactive-text { word-wrap: break-word; overflow-wrap: anywhere; }
.kf-proactive-close {
  position: absolute; top: 6px; right: 8px; background: transparent; border: none;
  color: var(--kf-muted); font-size: 17px; line-height: 1; cursor: pointer; padding: 2px 5px;
  border-radius: 6px;
}
.kf-proactive-close:hover { color: var(--kf-fg); background: #f3f4f6; }
@keyframes kf-pop { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* ---- eye-catcher 誘餌(沿用 proactive teaser 外觀) ---- */
/* .kf-eyecatcher 已套用 .kf-proactive 的定位與外觀,此處無需額外覆寫 */

/* ---- 富卡片(content_type=card) ---- */
.kf-msg.kf-card {
  padding: 0; background: var(--kf-bg) !important; color: var(--kf-fg);
  border: 1px solid var(--kf-border); border-radius: 12px; overflow: hidden;
  width: 240px; max-width: 100%;
}
.kf-card-img { display: block; width: 100%; height: 140px; object-fit: cover; background: #e5e7eb; }
.kf-card-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.kf-card-title { font-weight: 600; font-size: 14px; color: var(--kf-fg); }
.kf-card-text { font-size: 12.5px; color: var(--kf-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.kf-card-actions { display: flex; flex-direction: column; border-top: 1px solid var(--kf-border); }
.kf-card-btn {
  display: block; width: 100%; text-align: center; padding: 9px 12px;
  font: inherit; font-size: 13px; font-weight: 600; color: var(--kf-primary);
  background: transparent; border: none; border-bottom: 1px solid var(--kf-border);
  cursor: pointer; text-decoration: none;
}
.kf-card-btn:last-child { border-bottom: none; }
.kf-card-btn:hover { background: #f3f4f6; }

/* ---- 富卡片輪播(content_type=card + meta.cards 多張) ---- */
/* 容器:橫向可捲動 + scroll-snap;背景/邊框交由內部各卡處理,故自身透明無框。 */
.kf-msg.kf-carousel {
  padding: 0; background: transparent !important; border: none; border-radius: 0;
  width: auto; max-width: 90%;
  display: flex; gap: 8px; padding-bottom: 6px;
  overflow-x: auto; overflow-y: hidden;
  scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch;
  overscroll-behavior-x: contain;
}
/* 輪播內每卡:固定寬度、對齊起點吸附,套用與單卡一致的卡片外觀。 */
.kf-carousel .kf-card {
  flex: 0 0 auto; width: 220px; scroll-snap-align: start;
  background: var(--kf-bg); color: var(--kf-fg);
  border: 1px solid var(--kf-border); border-radius: 12px; overflow: hidden;
}
.kf-carousel::-webkit-scrollbar { height: 6px; }
.kf-carousel::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
`;
