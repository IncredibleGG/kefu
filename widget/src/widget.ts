// KefuWidget:氣泡 + 聊天面板;開會話、送訊、WS 優先接收、輪詢 fallback。
import {
  fetchHistory,
  fetchProactiveRules,
  fetchPublicHistory,
  fetchPublicSettings,
  openSession,
  reportPageView,
  resolveUrl,
  sendMessage,
  submitCsat,
  uploadFile,
  type HistoryMessage,
} from "./api";
import { createTranslator, isRtlLocale, resolveLocale, type TranslateFn } from "./i18n";
import { renderMarkdown } from "./markdown";
import { ProactiveEngine } from "./proactive";
import { CSS } from "./styles";
import type {
  CsatInvite,
  PrechatField,
  ProactiveRule,
  PublicSettings,
  RealtimeEvent,
  SenderRole,
  WidgetConfig,
} from "./types";
import { WidgetSocket } from "./ws";

// 注意:title / greeting 刻意不放預設值——未由嵌入方或後端提供時,
// 改由 i18n 依 locale 取當地語系的預設字串(見 mount() 與 greetingText())。
const DEFAULTS: Partial<WidgetConfig> = {
  apiBase: "",
  primaryColor: "#2563eb",
  autoOpen: false,
  pollIntervalMs: 3000,
};

const BUBBLE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
// 附件(迴紋針)、表情(笑臉)、檔案圖示
const ATTACH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
const EMOJI_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`;
const FILE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
// 標頭「結束對話並評分」用的星形圖示(描邊)
const RATE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.9 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 7.1-1.01L12 2z"/></svg>`;
// CSAT 面板實心星
const STAR_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 7.1-1.01L12 2z"/></svg>`;

// eye-catcher 內建圖形(描邊 SVG,沿用 currentColor → 隨主色)。
// 管理員於 widget 主題以 widget_theme.eye_catcher_style 選其一(鍵名即設定值);
// 未知值 / 空值一律不渲染圖形(退回純文字或圖片版),故新增樣式只需在此擴充並同步設定頁下拉。
const EYECATCHER_SHAPES: Record<string, string> = {
  // 揮手打招呼
  wave: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`,
  // 對話泡泡
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  // 鈴鐺(通知感)
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  // 禮物(促銷 / 優惠)
  gift: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>`,
  // 求助問號
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};

// 自帶一組常用 emoji(純前端面板,無外部依賴)。
const EMOJIS = [
  "😀","😃","😄","😁","😆","😅","🤣","😂",
  "🙂","🙃","😉","😊","😇","🥰","😍","😘",
  "😋","😜","🤪","🤗","🤔","🤨","😐","😴",
  "😎","🥳","😏","😒","😞","😢","😭","😤",
  "👍","👎","👌","🙏","👏","🙌","💪","🤝",
  "❤️","🧡","💛","💚","💙","💜","🔥","✨",
  "🎉","🎁","✅","❌","❓","❗","💡","⭐",
  "📎","📷","📄","💰","🛒","📞","📧","🕐",
];

// 上傳大小上限(與後端一致:10MB),前端先擋以省流量。
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function roleFromSender(sender: string): SenderRole {
  if (sender === "visitor") return "visitor";
  if (sender === "system") return "system";
  if (sender === "human") return "human";
  return "ai";
}

/** 附件連結安全檢查:僅允許 http(s):// 或本站相對路徑(單一開頭斜線),
 *  擋掉 javascript: / data: / 協定相對(//host)等,避免點擊圖片 / 檔案連結觸發 XSS。
 *  檢查原始 content(resolveUrl 之前),因 resolveUrl 對非法協定會原樣放行。 */
function isSafeUrl(u: string): boolean {
  if (!u) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (/^\/(?!\/)/.test(u)) return true;
  return false;
}

/** 富卡片 meta 契約(對齊坐席端與 send 端):
 *  meta.card = { title?, text?, image_url?, buttons:[{label, url? , reply?, postback?}] }。
 *  按鈕型別以「值」區分:url=開連結、reply=以訪客身分送出文字、postback=送出機器 payload
 *  觸發 bot 流程 / 自動化(見 renderCard)。 */
interface WidgetCardButton {
  label?: string;
  url?: string;
  reply?: string;
  postback?: string;
}
interface WidgetCard {
  title?: string;
  text?: string;
  image_url?: string;
  buttons?: WidgetCardButton[];
}

/**
 * 可自訂 post-chat 問卷契約(存於 widget_theme.post_chat_survey,JSONB 原樣存讀)。
 * 由管理員於後台設定;widget 於會話結束(csat_invite / session.closed)時,
 * 有啟用且有欄位即改渲染此問卷(取代固定 CSAT),否則退回固定 CSAT(零回歸)。
 * 欄位型別:rating(星等)/ text(單行 / 多行)/ email(驗證)/ choice(單選,options 提供選項)。
 */
type SurveyFieldType = "rating" | "text" | "email" | "choice";
interface SurveyField {
  key: string;
  label?: string;
  type?: SurveyFieldType;
  options?: string[];
  required?: boolean;
}
interface PostChatSurvey {
  enabled?: boolean;
  fields?: SurveyField[];
}

interface PendingBubble {
  el: HTMLElement;
  content: string;
}

export class KefuWidget {
  private cfg: WidgetConfig;
  private locale: string;          // 正規化後的語系代碼
  private t: TranslateFn;          // 綁定於此實例語系的翻譯函式
  private host: HTMLElement;
  private root!: ShadowRoot;
  private panel!: HTMLElement;
  private body!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private statusDot!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private emojiPanel!: HTMLElement;
  private composing = false;  // 輸入法組字中(IME composition)

  private wrap!: HTMLElement;
  private logoEl!: HTMLImageElement;
  private csatBtn!: HTMLButtonElement;
  private footer!: HTMLElement;

  private visitorExternalId = "";
  private sessionId: string | null = null;
  private socket: WidgetSocket | null = null;
  private pollTimer: number | null = null;
  private seen = new Set<string>();
  private pendings: PendingBubble[] = [];
  private opened = false;
  private booted = false;

  // Message sneak-peek:訪客草稿即時預覽的節流狀態(尚未送出的輸入內容)。
  private draftTimer: number | null = null;
  private lastDraftSent = 0;

  // 頁面軌跡(page trail)上報狀態
  private pageTrackingStarted = false;
  private lastTrackedUrl = "";
  private onLocationChange = () => this.reportCurrentPage();

  // 公開設定 / 品牌 / 流程狀態
  private settings: PublicSettings | null = null;
  private settingsReady!: Promise<void>;
  private stage: "init" | "prechat" | "offline" | "chat" = "init";
  private greetingShown = false;
  private prechatDone = false;
  private pendingPrechatSummary = "";
  // CSAT 防重複提交
  private csatSubmitted = false;
  private csatOverlay: HTMLElement | null = null;

  // 主動式訊息(proactive)引擎與呈現狀態
  private proactive: ProactiveEngine | null = null;
  private proactiveTeaser: HTMLElement | null = null;
  private proactiveMessageShown = false;

  // eye-catcher 誘餌:啟動氣泡旁的靜態小氣泡(管理員於 widget 主題設定)
  private eyeCatcherEl: HTMLElement | null = null;

  constructor(config: WidgetConfig) {
    this.cfg = { ...DEFAULTS, ...config } as WidgetConfig;
    // 語系:顯式 cfg.locale → navigator 自動偵測 → 預設 zh-Hant。
    // 需在 mount() 前就緒,建 UI 時即以正確語系輸出字串。
    this.locale = resolveLocale(this.cfg.locale);
    this.t = createTranslator(this.locale);
    this.host = document.createElement("div");
    this.host.setAttribute("data-kefu-widget", "");
    document.body.appendChild(this.host);
    this.mount();
    // 抓公開設定(品牌 / 營業狀態 / pre-chat);永不拋出,失敗走預設。
    this.settingsReady = this.loadSettings();
    // 主動式訊息:抓公開規則並啟動瀏覽器端觸發引擎(全程降級,不阻擋一般流程)。
    void this.startProactive();
    // 頁面軌跡:widget 載入即上報當前頁,並監聽 SPA / 前進後退變化(全程降級)。
    this.startPageTracking();
  }

  // ---------------- UI 建構 ----------------
  private mount(): void {
    this.root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    this.root.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "kf-root";
    // RTL 語系(如 ar):設容器方向,文字/排版靠右。
    if (isRtlLocale(this.locale)) wrap.setAttribute("dir", "rtl");
    if (this.cfg.primaryColor) wrap.style.setProperty("--kf-primary", this.cfg.primaryColor);

    const bubble = document.createElement("button");
    bubble.className = "kf-bubble";
    bubble.setAttribute("aria-label", this.t("bubbleAria"));
    bubble.innerHTML = BUBBLE_SVG;
    bubble.addEventListener("click", () => this.toggle());

    const panel = document.createElement("div");
    panel.className = "kf-panel kf-hidden";
    panel.innerHTML = `
      <div class="kf-header">
        <div class="kf-header-left">
          <img class="kf-logo kf-hidden" alt="" />
          <div>
            <div class="kf-title"></div>
            <div class="kf-status"><span class="kf-dot"></span><span class="kf-status-text">${this.t("statusDisconnected")}</span></div>
          </div>
        </div>
        <div class="kf-header-actions">
          <button class="kf-icon-btn kf-rate kf-hidden" aria-label="${this.t("endAndRate")}" title="${this.t("endAndRate")}">${RATE_SVG}</button>
          <button class="kf-close" aria-label="${this.t("close")}">×</button>
        </div>
      </div>
      <div class="kf-body"></div>
      <div class="kf-footer">
        <button class="kf-tool kf-attach" aria-label="${this.t("attach")}">${ATTACH_SVG}</button>
        <button class="kf-tool kf-emoji" aria-label="${this.t("emoji")}">${EMOJI_SVG}</button>
        <textarea class="kf-input" rows="1" placeholder="${this.t("inputPlaceholder")}"></textarea>
        <button class="kf-send" aria-label="${this.t("send")}">${SEND_SVG}</button>
      </div>`;

    wrap.appendChild(panel);
    wrap.appendChild(bubble);
    this.root.appendChild(wrap);

    this.panel = panel;
    this.wrap = wrap;
    this.body = panel.querySelector(".kf-body") as HTMLElement;
    this.input = panel.querySelector(".kf-input") as HTMLTextAreaElement;
    this.sendBtn = panel.querySelector(".kf-send") as HTMLButtonElement;
    this.statusDot = panel.querySelector(".kf-dot") as HTMLElement;
    this.logoEl = panel.querySelector(".kf-logo") as HTMLImageElement;
    this.footer = panel.querySelector(".kf-footer") as HTMLElement;
    this.csatBtn = panel.querySelector(".kf-rate") as HTMLButtonElement;
    (panel.querySelector(".kf-title") as HTMLElement).textContent = this.cfg.title || this.t("title");
    (panel.querySelector(".kf-close") as HTMLElement).addEventListener("click", () => this.toggle());
    this.csatBtn.addEventListener("click", () => this.openFeedback());

    // 隱藏的檔案選擇器(附件鈕觸發)
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", () => this.onFilePicked());
    wrap.appendChild(this.fileInput);

    // 表情面板(常用 emoji 網格,預設隱藏,插入到輸入框)
    this.emojiPanel = document.createElement("div");
    this.emojiPanel.className = "kf-emoji-panel kf-hidden";
    for (const emo of EMOJIS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = emo;
      b.addEventListener("click", (e) => {
        e.stopPropagation();  // 連點多個 emoji 時面板不關閉
        this.insertEmoji(emo);
      });
      this.emojiPanel.appendChild(b);
    }
    (panel.querySelector(".kf-footer") as HTMLElement).appendChild(this.emojiPanel);

    (panel.querySelector(".kf-attach") as HTMLElement).addEventListener("click", () => {
      this.hideEmoji();
      this.fileInput.click();
    });
    (panel.querySelector(".kf-emoji") as HTMLElement).addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleEmoji();
    });

    // 點面板/emoji 鈕以外的區域(含輸入框)關閉表情面板
    wrap.addEventListener("click", () => this.hideEmoji());

    this.sendBtn.addEventListener("click", () => this.onSend());
    // 追蹤輸入法組字狀態:選字期間的 Enter 只是「確認選字」,不可觸發送出。
    this.input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.input.addEventListener("compositionend", () => {
      this.composing = false;
    });
    this.input.addEventListener("keydown", (e) => {
      // 多重防線:isComposing / keyCode 229 / 自行追蹤的 composing 任一為真都不送出。
      if (this.composing || e.isComposing || (e as KeyboardEvent).keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.onSend();
      }
    });
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto";
      this.input.style.height = Math.min(this.input.scrollHeight, 96) + "px";
      this.queueDraft(); // sneak-peek:輸入變動即節流上送草稿預覽
    });

    if (this.cfg.autoOpen) this.toggle();
  }

  private toggle(): void {
    this.opened = !this.opened;
    this.panel.classList.toggle("kf-hidden", !this.opened);
    if (this.opened) {
      this.dismissProactiveTeaser(); // 開窗即收掉主動氣泡提示
      this.dismissEyeCatcher();      // 開窗即收掉誘餌小氣泡
      void this.onOpen();
    }
  }

  /** 確保面板為開啟狀態(主動式訊息 auto_open / 點擊氣泡提示時用)。 */
  private open(): void {
    if (!this.opened) this.toggle();
    else this.dismissProactiveTeaser();
  }

  // ---------------- 品牌 / 公開設定 ----------------
  /** 抓公開設定並套用外觀 / 營業狀態。任何失敗都安靜走預設,絕不崩。 */
  private async loadSettings(): Promise<void> {
    const s = await fetchPublicSettings(this.cfg);
    if (!s) return; // 端點未就緒:預設營業中、無 pre-chat、內建外觀
    this.settings = s;
    if (s.widget_theme) this.applyTheme(s.widget_theme);
    // 依 is_online 先在標頭反映營業狀態(WS 連上後會再更新為「已連線」)
    if (s.is_online === false) this.setStatus(this.t("statusOffline"), false);
    else if (s.is_online === true) this.setStatus(this.t("statusOnline"), true);
    // eye-catcher 誘餌:主題設定有誘餌文字且面板未開時,在啟動氣泡旁顯示小氣泡。
    this.maybeShowEyeCatcher();
  }

  // ---------------- eye-catcher 誘餌 ----------------
  /**
   * 顯示誘餌小氣泡(未開面板、無主動提示佔位時);點擊開面板。沿用 proactive teaser 樣式。
   * 支援三種內容(可組合),任一有值即顯示:
   *   - eye_catcher_image:圖片 URL(先驗 http(s) / 同源相對,經 isSafeUrl 白名單)→ 圖片版;
   *   - eye_catcher_style:內建圖形樣式鍵(EYECATCHER_SHAPES)→ 描邊圖形版;
   *   - eye_catcher:純文字(既有欄位,向後相容)。
   * 圖片優先於內建圖形;圖形 / 圖片可與文字並存。全空則不顯示(沿用既有 dismiss / 顯示守衛)。
   */
  private maybeShowEyeCatcher(): void {
    const theme = this.settings?.widget_theme as
      | { eye_catcher?: string; eye_catcher_image?: string; eye_catcher_style?: string }
      | undefined;
    const msg = (theme?.eye_catcher || "").trim();
    const imageRaw = (theme?.eye_catcher_image || "").trim();
    const styleKey = (theme?.eye_catcher_style || "").trim();
    // 圖片先驗白名單(擋 javascript: / data: / 協定相對);內建圖形須為已知鍵。
    const image = imageRaw && isSafeUrl(imageRaw) ? imageRaw : "";
    const shape = EYECATCHER_SHAPES[styleKey] ? styleKey : "";
    if (!msg && !image && !shape) return; // 全空:不顯示(純文字版相容)
    if (this.opened) return;            // 面板已開,無需誘餌
    if (this.proactiveTeaser) return;   // 主動式訊息提示優先,避免與誘餌重疊
    if (this.eyeCatcherEl) return;      // 已顯示

    const box = document.createElement("div");
    box.className = "kf-proactive kf-eyecatcher";
    box.setAttribute("role", "button");
    box.setAttribute("tabindex", "0");

    const close = document.createElement("button");
    close.className = "kf-proactive-close";
    close.setAttribute("aria-label", this.t("close"));
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.dismissEyeCatcher();
    });
    box.appendChild(close);

    // 圖形 / 圖片(擇一;圖片優先)。皆置於文字之上。
    if (image) {
      const img = document.createElement("img");
      img.className = "kf-eyecatcher-img";
      img.src = resolveUrl(this.cfg.apiBase, image);
      img.alt = msg || this.t("image");
      img.loading = "lazy";
      box.appendChild(img);
    } else if (shape) {
      const g = document.createElement("div");
      g.className = "kf-eyecatcher-graphic";
      g.innerHTML = EYECATCHER_SHAPES[shape];
      box.appendChild(g);
    }

    if (msg) {
      const text = document.createElement("div");
      text.className = "kf-proactive-text";
      text.textContent = msg;
      box.appendChild(text);
    }

    const openFromEyeCatcher = () => this.open();
    box.addEventListener("click", openFromEyeCatcher);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openFromEyeCatcher();
      }
    });

    this.wrap.appendChild(box);
    this.eyeCatcherEl = box;
  }

  private dismissEyeCatcher(): void {
    if (this.eyeCatcherEl) {
      this.eyeCatcherEl.remove();
      this.eyeCatcherEl = null;
    }
  }

  private applyTheme(theme: NonNullable<PublicSettings["widget_theme"]>): void {
    if (theme.primary_color) {
      this.wrap.style.setProperty("--kf-primary", theme.primary_color);
    }
    if (theme.logo_url) {
      this.logoEl.src = resolveUrl(this.cfg.apiBase, theme.logo_url);
      this.logoEl.classList.remove("kf-hidden");
    }
    // greeting 於首開時由 showGreeting() 取用
  }

  private greetingText(): string {
    return this.settings?.widget_theme?.greeting || this.cfg.greeting || this.t("greeting");
  }

  private showGreeting(): void {
    if (this.greetingShown) return;
    this.greetingShown = true;
    const g = this.greetingText();
    if (g) this.addSystem(g);
  }

  // ---------------- 首開流程:pre-chat / 離線 / 正常聊天 ----------------
  private async onOpen(): Promise<void> {
    await this.settingsReady; // 等公開設定(已含逾時/失敗降級,不會卡住)
    this.showGreeting();
    if (this.stage !== "init") {
      // 流程已定;聊天階段時把焦點回到輸入框
      if (this.stage === "chat") this.input.focus();
      return;
    }
    const fields = this.settings?.prechat_fields || [];
    if (this.settings?.prechat_enabled && !this.prechatDone && fields.length) {
      this.stage = "prechat";
      this.renderPrechatForm(fields);
      return;
    }
    this.enterMainFlow();
  }

  /** pre-chat 完成後(或不需要 pre-chat)進入主流程:離線→留言表單;營業中→正常聊天。 */
  private enterMainFlow(): void {
    if (this.settings && this.settings.is_online === false) {
      this.stage = "offline";
      this.enterOfflineMode();
    } else {
      this.stage = "chat";
      void this.boot();
    }
  }

  // ---------------- 主動式訊息(proactive) ----------------
  /** 抓公開規則並啟動觸發引擎;任何失敗安靜降級(不影響一般對話)。 */
  private async startProactive(): Promise<void> {
    try {
      if (!this.cfg.channelKey) return;
      const rules = await fetchProactiveRules(this.cfg);
      if (!rules.length) return;
      this.proactive = new ProactiveEngine(this.cfg.channelKey, {
        onFire: (rule) => this.onProactiveFire(rule),
      });
      this.proactive.start(rules);
    } catch {
      /* 主動式訊息為加值功能,失敗不影響核心 */
    }
  }

  /** 規則命中:auto_open 直接開窗顯示;show_bubble 先顯示可點的氣泡提示。 */
  private onProactiveFire(rule: ProactiveRule): void {
    if (rule.mode === "auto_open") {
      void this.presentProactive(rule.message);
    } else {
      // 已在對話中就直接把訊息當客服開場帶入;否則顯示氣泡提示等點擊。
      if (this.opened) void this.presentProactive(rule.message);
      else this.showProactiveTeaser(rule.message);
    }
  }

  /** 開啟聊天窗並把主動訊息當「客服開場」以坐席氣泡呈現(至多一次)。 */
  private async presentProactive(message: string): Promise<void> {
    this.dismissProactiveTeaser();
    this.open();
    await this.settingsReady; // 讓歡迎語 / 首開流程先跑,順序自然排在其後
    if (this.proactiveMessageShown) return;
    this.proactiveMessageShown = true;
    this.addBubble("ai", message, "text");
  }

  /** show_bubble 模式:在氣泡按鈕上方浮出一則可點的提示卡;點擊開聊天並帶入訊息。 */
  private showProactiveTeaser(message: string): void {
    this.dismissProactiveTeaser();
    this.dismissEyeCatcher(); // 主動式訊息提示優先於靜態誘餌,避免兩者重疊
    const box = document.createElement("div");
    box.className = "kf-proactive";
    box.setAttribute("role", "button");
    box.setAttribute("tabindex", "0");

    const close = document.createElement("button");
    close.className = "kf-proactive-close";
    close.setAttribute("aria-label", this.t("close"));
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.dismissProactiveTeaser();
    });

    const text = document.createElement("div");
    text.className = "kf-proactive-text";
    text.textContent = message;

    const openFromTeaser = () => void this.presentProactive(message);
    box.addEventListener("click", openFromTeaser);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openFromTeaser();
      }
    });

    box.appendChild(close);
    box.appendChild(text);
    this.wrap.appendChild(box);
    this.proactiveTeaser = box;
  }

  private dismissProactiveTeaser(): void {
    if (this.proactiveTeaser) {
      this.proactiveTeaser.remove();
      this.proactiveTeaser = null;
    }
  }

  // ---------------- 頁面軌跡(page trail)----------------
  /**
   * 啟動頁面瀏覽上報:widget 載入即上報當前頁,並攔截 SPA history 變化 + 監聽
   * popstate / hashchange。任何失敗都靜默降級,絕不影響聊天。
   */
  private startPageTracking(): void {
    if (this.pageTrackingStarted) return;
    this.pageTrackingStarted = true;
    try {
      if (typeof window === "undefined") return;
      // 初次載入即上報當前頁
      this.reportCurrentPage();
      // SPA:攔截 pushState / replaceState 觸發自訂事件(僅補一次,避免多實例重複包裹)
      const w = window as unknown as { __kefuHistoryPatched?: boolean };
      if (!w.__kefuHistoryPatched) {
        w.__kefuHistoryPatched = true;
        for (const m of ["pushState", "replaceState"] as const) {
          const orig = history[m];
          history[m] = function (this: History, ...args: unknown[]) {
            const ret = orig.apply(this, args as never);
            window.dispatchEvent(new Event("kefu:locationchange"));
            return ret;
          } as typeof history[typeof m];
        }
      }
      window.addEventListener("popstate", this.onLocationChange);
      window.addEventListener("hashchange", this.onLocationChange);
      window.addEventListener("kefu:locationchange", this.onLocationChange);
    } catch {
      /* 頁面軌跡為加值功能,任何失敗都不影響聊天 */
    }
  }

  /** 供 SPA 宿主在自訂路由變化時主動呼叫上報(未帶參數時取當前 location / title)。 */
  trackPageView(url?: string, title?: string): void {
    try {
      this.reportPageView(
        url || window.location.href,
        title ?? document.title,
      );
    } catch {
      /* 靜默降級 */
    }
  }

  /** 以當前 location / document.title 上報一次(load 與各類路由變化事件共用)。 */
  private reportCurrentPage(): void {
    try {
      this.reportPageView(window.location.href, document.title);
    } catch {
      /* 靜默降級 */
    }
  }

  /**
   * 實際上報一頁:同 URL 去重(SPA 常重複觸發),referrer 取「上一個已上報頁」,
   * 首頁則退回 document.referrer。刻意不觸碰 this.visitorExternalId
   * (那由 openSessionOnce 主導,避免略過開會話),但與其共用同一 localStorage 訪客鍵,
   * 確保開聊前後為同一訪客身份。
   */
  private reportPageView(url: string, title: string): void {
    if (!this.cfg.channelKey) return;
    const u = (url || "").trim();
    if (!u || u === this.lastTrackedUrl) return;
    const referrer =
      this.lastTrackedUrl ||
      (typeof document !== "undefined" ? document.referrer : "") ||
      undefined;
    this.lastTrackedUrl = u;
    void reportPageView(this.cfg, this.trackingVisitorId(), u, title || "", referrer);
  }

  /**
   * 取得(或生成並持久化)供軌跡上報用的訪客 external id。
   * 已開會話則沿用 this.visitorExternalId;否則讀 localStorage 既有值,
   * 皆無則生成 `web-<hex>` 並存回(與 openSession 共用同鍵,開聊後為同一訪客)。
   */
  private trackingVisitorId(): string {
    if (this.visitorExternalId) return this.visitorExternalId;
    let id = this.storageGet("visitor");
    if (!id) {
      id = "web-" + this.randomHex();
      this.storageSet("visitor", id);
    }
    return id;
  }

  private randomHex(): string {
    try {
      const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
      if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
    } catch {
      /* 舊環境無 crypto.randomUUID */
    }
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  // ---------------- 連線引導 ----------------
  /** 開會話(冪等:已開過即直接成功)。回傳是否成功建立 visitor。 */
  private async openSessionOnce(): Promise<boolean> {
    if (this.visitorExternalId) return true;
    if (!this.cfg.channelKey) {
      this.addNotice(this.t("noChannelKey"));
      return false;
    }
    try {
      const stored = this.storageGet("visitor");
      const data = await openSession(this.cfg, stored || undefined);
      this.visitorExternalId = data.visitor_external_id;
      this.sessionId = data.session_id;
      // 把回應帶回的 tenant_id 存進 runtime cfg,供稍後 startWs 訂閱 /ws/widget。
      // 手動優先:嵌入方顯式提供 tenantId 時不覆蓋,以維持相容。
      if (!this.cfg.tenantId && data.tenant_id) this.cfg.tenantId = data.tenant_id;
      this.storageSet("visitor", this.visitorExternalId);
      return true;
    } catch (e) {
      this.addNotice(this.t("openSessionFailedPrefix") + (e as Error).message);
      return false;
    }
  }

  private async boot(): Promise<void> {
    this.booted = true;
    const ok = await this.openSessionOnce();
    if (!ok) return;

    // pre-chat 額外欄位:以首則訪客訊息帶出(姓名已進 display_name)
    if (this.pendingPrechatSummary && this.visitorExternalId) {
      const summary = this.pendingPrechatSummary;
      this.pendingPrechatSummary = "";
      void this.sendVisitorText(summary);
    }

    if (!this.sessionId) {
      this.addNotice(this.t("noSessionId"));
      return;
    }

    // 評分入口延後顯示:僅在會話結案(session.closed)或坐席邀評(csat_invite)時才亮出
    // 標頭星鈕(見 revealCsatEntry)。會話進行中提交 CSAT 後端必回 409,故不在此開放入口,
    // 避免把會失敗的評分入口曝給訪客。
    this.input.focus();

    // 重開/重整後先補歷史(WS 不重播歷史):正式訪客走公開端點,
    // 僅需 channelKey + session_id + visitor_external_id(皆已於 open-session 取得/存於 localStorage),
    // 不再受「只有 agentToken 才補歷史」限制。ingest 以 message_id 去重,不會與 WS 回聲重複。
    if (this.visitorExternalId) {
      try {
        const hist = await fetchPublicHistory(this.cfg, this.sessionId, this.visitorExternalId);
        this.applyHistory(hist);
      } catch {
        /* 歷史失敗不致命:退回無歷史,不影響後續送收訊 */
      }
    }

    // 接收:WS 優先
    if (this.cfg.tenantId) {
      this.startWs();
    } else if (this.cfg.agentToken) {
      this.addNotice(this.t("noTenantPolling"));
      this.startPolling();
    } else {
      this.addNotice(this.t("noReceive"));
    }
  }

  private startWs(): void {
    if (!this.sessionId || !this.cfg.tenantId) return;
    this.socket = new WidgetSocket(this.cfg, this.cfg.tenantId, this.sessionId, {
      onEvent: (ev) => this.onEvent(ev),
      onStatus: (s) =>
        this.setStatus(
          s === "open"
            ? this.t("statusConnected")
            : s === "connecting"
              ? this.t("statusConnecting")
              : this.t("statusReconnecting"),
          s === "open",
        ),
      onGiveUp: () => {
        this.setStatus(this.t("statusWsFailed"), false);
        if (this.cfg.agentToken) {
          this.addNotice(this.t("wsFallbackPolling"));
          this.startPolling();
        } else {
          this.addNotice(this.t("wsFailedNoPoll"));
        }
      },
    }, this.visitorExternalId);
    this.socket.connect();
  }

  private startPolling(): void {
    if (this.pollTimer !== null || !this.sessionId || !this.cfg.agentToken) return;
    this.setStatus(this.t("statusPolling"), true);
    const tick = async () => {
      try {
        const hist = await fetchHistory(this.cfg, this.sessionId as string);
        this.applyHistory(hist);
      } catch {
        /* 單次失敗略過 */
      }
    };
    this.pollTimer = window.setInterval(tick, this.cfg.pollIntervalMs || 3000);
    void tick();
  }

  // ---------------- 事件 / 訊息接收 ----------------
  private onEvent(ev: RealtimeEvent): void {
    const t = ev.type;
    if (t === "message.new" || t === "message") {
      const p = ev.payload || {};
      const content = (p.content as string) || "";
      if (!content) return;
      this.ingest(
        (p.message_id as string) || undefined,
        (p.sender_type as string) || "ai",
        content,
        (p.content_type as string) || "text",
        p.meta,
      );
    } else if (t === "session.closed") {
      this.addSystem(this.t("sessionClosed"));
      // 會話結案才是有效的評分時機:亮出標頭評分入口(供「稍後」後重開)並自動彈出評分卡
      // (尚未評過且有 session 時)。此時後端已結案,提交 CSAT 不會再回 409。
      if (!this.csatSubmitted && this.sessionId) {
        this.revealCsatEntry();
        this.openFeedback();
      }
    }
  }

  private applyHistory(msgs: HistoryMessage[]): void {
    for (const m of msgs) {
      // 公開訪客歷史不含 meta(卡片會降級為 content 純文字);坐席 token 輪詢的
      // 會話詳情端點會帶 meta,故此處帶上(存在時)讓卡片能於歷史還原。
      this.ingest(m.id, m.sender_type, m.content, m.content_type, (m as { meta?: unknown }).meta);
    }
  }

  /** 統一入列:去重(message_id)、訪客回聲則升級既有樂觀氣泡。 */
  private ingest(
    id: string | undefined,
    sender: string,
    content: string,
    contentType: string,
    meta?: unknown,
  ): void {
    if (id && this.seen.has(id)) return;
    const role = roleFromSender(sender);
    if (role === "visitor") {
      const pending = this.takePendingByContent(content);
      if (pending) {
        pending.el.classList.remove("pending");
        if (id) this.seen.add(id);
        return;
      }
    }
    if (id) this.seen.add(id);
    if (role === "system") this.addSystem(content);
    else this.addBubble(role, content, contentType, false, undefined, this.extractCards(meta));
    // W6:結案自動邀評——system 訊息帶 meta.csat_invite 時,除了照常顯示內文(降級可讀),
    // 另據旗標彈出評分卡(依 rating_scale)。去重靠上方 seen,故一則邀評只觸發一次。
    const invite = this.extractCsatInvite(meta);
    if (invite) this.maybeInviteCsat(invite);
  }

  /**
   * 從訊息 meta 取出富卡片清單(輪播 carousel):
   *   - 優先 meta.cards(陣列,多張)→ 逐張過濾出物件卡片;
   *   - 否則單張 meta.card → 收成單元素陣列(向後相容);
   *   - 皆無 / 非物件 → 空陣列(呼叫端落到純文字回退)。
   * 單卡 / 多卡差異(單張走現狀、多張走輪播)由呈現端依長度決定,此處統一收斂資料形狀。
   */
  private extractCards(meta: unknown): WidgetCard[] {
    if (!meta || typeof meta !== "object") return [];
    const m = meta as Record<string, unknown>;
    if (Array.isArray(m.cards)) {
      return m.cards.filter(
        (c): c is WidgetCard => !!c && typeof c === "object",
      );
    }
    const single = m.card;
    if (single && typeof single === "object") return [single as WidgetCard];
    return [];
  }

  /** 從訊息 meta 取出 csat_invite 旗標(容錯:非物件 / 無旗標一律回 null)。 */
  private extractCsatInvite(meta: unknown): CsatInvite | null {
    if (!meta || typeof meta !== "object") return null;
    const inv = (meta as Record<string, unknown>).csat_invite;
    if (!inv || typeof inv !== "object") return null;
    return inv as CsatInvite;
  }

  /** 收到邀評旗標:未評過且有會話才彈卡;依旗標的 rating_scale / submit_endpoint 呈現與提交。 */
  private maybeInviteCsat(invite: CsatInvite): void {
    if (this.csatSubmitted || !this.sessionId) return; // 已評 / 無會話則忽略(仍保留內文降級)
    // 坐席結案邀評:此時後端已結案,亮出標頭評分入口(供「稍後」後重開)並彈出評分卡 / 問卷。
    this.revealCsatEntry();
    this.openFeedback(this.normalizeScale(invite.rating_scale), this.safeSubmitEndpoint(invite.submit_endpoint));
  }

  /**
   * 顯示標頭「結束對話並評分」星鈕。僅在會話已結案 / 坐席邀評後呼叫,
   * 讓評分入口只在後端會接受 CSAT 的時機出現(避免會話進行中點擊必然 409)。
   * 已提交過則維持隱藏(重複觸發無副作用)。
   */
  private revealCsatEntry(): void {
    if (this.csatSubmitted) return;
    this.csatBtn.classList.remove("kf-hidden");
  }

  /** 星等上限正規化:取整數、限 2–10,越界或非數退回預設 5(即 1–5 星)。 */
  private normalizeScale(n?: number): number {
    const v = Math.round(Number(n));
    return Number.isFinite(v) && v >= 2 && v <= 10 ? v : 5;
  }

  /**
   * 提交端點防護:僅接受單斜線開頭的相對路徑(同 apiBase 源),
   * 拒絕絕對 / 協定相對(//)URL,避免評分被 meta 導向外部端點。無效即回 undefined(用預設)。
   */
  private safeSubmitEndpoint(ep?: string): string | undefined {
    return typeof ep === "string" && /^\/(?!\/)/.test(ep) ? ep : undefined;
  }

  // ---------------- 送出 ----------------
  private async onSend(): Promise<void> {
    const text = this.input.value.trim();
    if (!text) return;
    if (!this.booted) await this.boot();
    this.input.value = "";
    this.input.style.height = "auto";
    this.flushDraft(); // 送出後即時把坐席端的草稿預覽清成空字串
    await this.sendVisitorText(text);
  }

  // ---------------- Message sneak-peek(訪客草稿即時預覽)----------------
  /**
   * 節流上送草稿:第一次輸入或距上次上送已逾 400ms 即立即送(維持即時預覽);
   * 連續輸入時改以停頓 300ms 的尾端送出,兩者取其一,避免每個按鍵都送。
   */
  private queueDraft(): void {
    const now = Date.now();
    if (now - this.lastDraftSent >= 400) {
      this.flushDraft();
      return;
    }
    if (this.draftTimer !== null) window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => this.flushDraft(), 300);
  }

  /** 立即上送目前輸入框全文(清空既有排程並記錄上送時間)。 */
  private flushDraft(): void {
    if (this.draftTimer !== null) {
      window.clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    this.lastDraftSent = Date.now();
    this.sendDraft(this.input.value);
  }

  /**
   * 送出草稿控制訊息:{type:"draft", payload:{session_id, text}}。text 為目前草稿全文
   * (清空時為空字串);不落庫、不進歷史。僅在已建會話且有即時連線時送,否則安靜略過。
   * 長度上限與後端一致(2000),前端先截以省流量。
   */
  private sendDraft(text: string): void {
    if (!this.socket || !this.sessionId || !this.visitorExternalId) return;
    this.socket.send({
      type: "draft",
      payload: { session_id: this.sessionId, text: (text || "").slice(0, 2000) },
    });
  }

  /** 以樂觀氣泡送出一則訪客文字訊息(共用於一般輸入與 pre-chat 摘要)。 */
  private async sendVisitorText(text: string): Promise<void> {
    const el = this.addBubble("visitor", text, "text", true);
    this.pendings.push({ el, content: text });

    if (!this.visitorExternalId) {
      el.classList.remove("pending");
      el.classList.add("error");
      this.addNotice(this.t("noSessionCannotSend"));
      return;
    }
    try {
      await sendMessage(this.cfg, this.visitorExternalId, text);
      // 成功:等待 WS/輪詢回聲升級此氣泡;若無接收管道,直接清 pending 樣式。
      if (!this.cfg.tenantId && !this.cfg.agentToken) el.classList.remove("pending");
    } catch (e) {
      el.classList.remove("pending");
      el.classList.add("error");
      this.addNotice(this.t("sendFailedPrefix") + (e as Error).message);
    }
  }

  /**
   * 送出一則 postback:content=payload(機器 token)、content_type="postback"。
   * 走既有訪客送訊端點(POST /message),與一般文字同進標準入站流程 → dispatch.handle_inbound
   * 以 content 當 query 跑流程 bot / RAG,藉此觸發 bot 流程 / 自動化(不新增後端端點)。
   * 樂觀氣泡以 payload 為內容,供 WS 回聲去重(takePendingByContent);坐席端不識別的
   * content_type 會降級為純文字顯示 payload(優雅降級)。
   */
  private async sendVisitorPostback(payload: string): Promise<void> {
    const text = (payload || "").trim();
    if (!text) return;
    if (!this.booted) await this.boot();
    const el = this.addBubble("visitor", text, "postback", true);
    this.pendings.push({ el, content: text });

    if (!this.visitorExternalId) {
      el.classList.remove("pending");
      el.classList.add("error");
      this.addNotice(this.t("noSessionCannotSend"));
      return;
    }
    try {
      await sendMessage(this.cfg, this.visitorExternalId, text, "postback");
      if (!this.cfg.tenantId && !this.cfg.agentToken) el.classList.remove("pending");
    } catch (e) {
      el.classList.remove("pending");
      el.classList.add("error");
      this.addNotice(this.t("sendFailedPrefix") + (e as Error).message);
    }
  }

  // ---------------- DOM 輔助 ----------------
  /** 依 content_type 呈現訊息:image=縮圖(點開大圖)、file=檔名+下載、其餘=Markdown。 */
  private addBubble(
    role: SenderRole,
    content: string,
    ct: string,
    pending = false,
    filename?: string,
    cards?: WidgetCard[] | null,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "kf-row " + (role === "visitor" ? "visitor" : "agent");
    const msg = document.createElement("div");
    msg.className = "kf-msg" + (pending ? " pending" : "");

    if (ct === "card" && cards && cards.length) {
      // 富卡片:標題 / 文字 / 圖 / 按鈕(有卡片資料才走此分支;
      // 歷史降級無 meta.card/meta.cards 時落到最末 else,以 content 純文字回退)。
      if (cards.length >= 2) {
        // 多張 → 橫向可捲動輪播(carousel):每卡為獨立 .kf-card,容器負責 scroll-snap。
        msg.classList.add("kf-carousel");
        for (const c of cards) {
          const cardEl = document.createElement("div");
          cardEl.className = "kf-card";
          this.renderCard(cardEl, c);
          msg.appendChild(cardEl);
        }
      } else {
        // 單張 → 現狀(msg 自身即卡片容器)。
        msg.classList.add("kf-card");
        this.renderCard(msg, cards[0]);
      }
    } else if (ct === "image" && isSafeUrl(content)) {
      msg.classList.add("kf-media");
      const url = resolveUrl(this.cfg.apiBase, content);
      const img = document.createElement("img");
      img.className = "kf-img";
      img.src = url;
      img.alt = filename || this.t("image");
      img.addEventListener("click", () => this.openLightbox(url));
      msg.appendChild(img);
    } else if (ct === "file" && isSafeUrl(content)) {
      const url = resolveUrl(this.cfg.apiBase, content);
      const a = document.createElement("a");
      a.className = "kf-file";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      if (filename) a.setAttribute("download", filename);
      a.innerHTML = FILE_SVG;
      const name = document.createElement("span");
      name.className = "kf-file-name";
      // 有原始檔名用原始檔名;否則退回 url 末段或通用字樣
      name.textContent = filename || this.basenameOf(url) || this.t("downloadAttachment");
      a.appendChild(name);
      msg.appendChild(a);
    } else if (ct === "image" || ct === "file") {
      // 非法連結協定(javascript: / data: / 協定相對等):不渲染為圖片 / 連結,僅顯示純文字。
      msg.textContent = content;
    } else {
      msg.innerHTML = renderMarkdown(content);
    }

    row.appendChild(msg);
    this.body.appendChild(row);
    this.scrollBottom();
    return msg;
  }

  /** 渲染富卡片內容進 msg 容器:標題 / 文字 / 圖 / 按鈕。
   *  - url 按鈕:僅 http(s)(isSafeUrl 白名單,擋 javascript:)→ 開新分頁(rel noopener)。
   *  - reply 按鈕:呼叫 sendVisitorText(reply) 以訪客身分送出(quick reply)。 */
  private renderCard(container: HTMLElement, card: WidgetCard): void {
    if (card.image_url && isSafeUrl(card.image_url)) {
      const img = document.createElement("img");
      img.className = "kf-card-img";
      img.src = resolveUrl(this.cfg.apiBase, card.image_url);
      img.alt = card.title || this.t("image");
      img.loading = "lazy";
      container.appendChild(img);
    }
    if (card.title || card.text) {
      const bodyEl = document.createElement("div");
      bodyEl.className = "kf-card-body";
      if (card.title) {
        const titleEl = document.createElement("div");
        titleEl.className = "kf-card-title";
        titleEl.textContent = card.title;
        bodyEl.appendChild(titleEl);
      }
      if (card.text) {
        const textEl = document.createElement("div");
        textEl.className = "kf-card-text";
        textEl.textContent = card.text;
        bodyEl.appendChild(textEl);
      }
      container.appendChild(bodyEl);
    }
    const buttons = Array.isArray(card.buttons) ? card.buttons : [];
    if (buttons.length) {
      const actions = document.createElement("div");
      actions.className = "kf-card-actions";
      for (const b of buttons) {
        const label = (b.label || b.url || b.reply || b.postback || "").toString();
        if (!label) continue;
        if (b.url && isSafeUrl(b.url)) {
          // 連結按鈕:開新分頁(noopener,先驗 http(s));相對路徑以 apiBase 解析。
          const a = document.createElement("a");
          a.className = "kf-card-btn";
          a.href = resolveUrl(this.cfg.apiBase, b.url);
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = label;
          actions.appendChild(a);
        } else if (typeof b.postback === "string" && b.postback.trim()) {
          // postback:點擊送出機器 payload(非人類可讀文字)以觸發 bot 流程 / 自動化。
          // 走既有送訊端點(content_type="postback"),與 url / reply 相容。
          const payload = b.postback;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "kf-card-btn";
          btn.textContent = label;
          btn.addEventListener("click", () => void this.sendVisitorPostback(payload));
          actions.appendChild(btn);
        } else if (typeof b.reply === "string" && b.reply.trim()) {
          // 快捷回覆:點擊以訪客身分送出該文字(沿用既有送訊路徑)。
          const reply = b.reply;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "kf-card-btn";
          btn.textContent = label;
          btn.addEventListener("click", () => void this.sendVisitorText(reply));
          actions.appendChild(btn);
        }
      }
      if (actions.childElementCount) container.appendChild(actions);
    }
  }

  private basenameOf(url: string): string {
    try {
      const path = url.split(/[?#]/)[0];
      return decodeURIComponent(path.split("/").pop() || "");
    } catch {
      return "";
    }
  }

  // ---------------- 表情面板 ----------------
  private toggleEmoji(): void {
    this.emojiPanel.classList.toggle("kf-hidden");
  }
  private hideEmoji(): void {
    this.emojiPanel.classList.add("kf-hidden");
  }
  /** 在游標處插入 emoji(維持焦點與游標位置)。 */
  private insertEmoji(emo: string): void {
    const el = this.input;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + emo + el.value.slice(end);
    const pos = start + emo.length;
    el.focus();
    el.setSelectionRange(pos, pos);
    // 觸發自動增高
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 96) + "px";
    this.queueDraft(); // 插入 emoji 也算輸入變動,同步草稿預覽
  }

  // ---------------- 附件上傳 ----------------
  private async onFilePicked(): Promise<void> {
    const file = this.fileInput.files && this.fileInput.files[0];
    this.fileInput.value = "";  // 允許連續選同一檔
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      this.addNotice(
        this.t("fileTooLarge", {
          mb: MAX_UPLOAD_BYTES / (1024 * 1024),
          name: file.name,
        }),
      );
      return;
    }
    if (!this.booted) await this.boot();
    if (!this.visitorExternalId) {
      this.addNotice(this.t("noSessionCannotUpload"));
      return;
    }

    const isImage = file.type.startsWith("image/");
    // 上傳中佔位氣泡(含進度條)
    const row = document.createElement("div");
    row.className = "kf-row visitor";
    const holder = document.createElement("div");
    holder.className = "kf-msg pending";
    holder.innerHTML = `<div class="kf-uploading"><span>${this.t("uploading")}</span><span class="kf-progress"><i></i></span></div>`;
    row.appendChild(holder);
    this.body.appendChild(row);
    this.scrollBottom();
    const bar = holder.querySelector(".kf-progress > i") as HTMLElement | null;

    try {
      const up = await uploadFile(this.cfg, file, (r) => {
        if (bar) bar.style.width = Math.round(r * 100) + "%";
      });
      // 上傳成功:移除佔位,改以正式附件氣泡送出訊息
      row.remove();
      await this.sendAttachment(up.url, isImage ? "image" : "file", up.filename);
    } catch (e) {
      holder.classList.remove("pending");
      holder.classList.add("error");
      holder.textContent = this.t("uploadFailedPrefix") + (e as Error).message;
    }
  }

  /** 送出一則附件訊息:content=url,content_type=image|file。 */
  private async sendAttachment(url: string, contentType: string, filename?: string): Promise<void> {
    const el = this.addBubble("visitor", url, contentType, true, filename);
    this.pendings.push({ el, content: url });
    try {
      await sendMessage(this.cfg, this.visitorExternalId, url, contentType);
      if (!this.cfg.tenantId && !this.cfg.agentToken) el.classList.remove("pending");
    } catch (e) {
      el.classList.remove("pending");
      el.classList.add("error");
      this.addNotice(this.t("sendFailedPrefix") + (e as Error).message);
    }
  }

  // ---------------- 圖片燈箱 ----------------
  private openLightbox(url: string): void {
    const box = document.createElement("div");
    box.className = "kf-lightbox";
    const img = document.createElement("img");
    img.src = url;
    box.appendChild(img);
    box.addEventListener("click", () => box.remove());
    (this.root.querySelector(".kf-root") as HTMLElement).appendChild(box);
  }

  private addSystem(text: string): void {
    const el = document.createElement("div");
    el.className = "kf-msg kf-system";
    el.textContent = text;
    this.body.appendChild(el);
    this.scrollBottom();
  }

  private addNotice(text: string): void {
    const el = document.createElement("div");
    el.className = "kf-notice";
    el.textContent = text;
    this.body.appendChild(el);
    this.scrollBottom();
  }

  private takePendingByContent(content: string): PendingBubble | null {
    const idx = this.pendings.findIndex((p) => p.content === content);
    if (idx === -1) return null;
    const [p] = this.pendings.splice(idx, 1);
    return p;
  }

  private setStatus(text: string, on: boolean): void {
    const el = this.root.querySelector(".kf-status-text") as HTMLElement | null;
    if (el) el.textContent = text;
    this.statusDot.classList.toggle("on", on);
  }

  private scrollBottom(): void {
    requestAnimationFrame(() => {
      this.body.scrollTop = this.body.scrollHeight;
    });
  }

  // ---------------- localStorage(以 channelKey 命名空間) ----------------
  private storageKey(k: string): string {
    return `kefu_widget:${this.cfg.channelKey}:${k}`;
  }
  private storageGet(k: string): string | null {
    try {
      return localStorage.getItem(this.storageKey(k));
    } catch {
      return null;
    }
  }
  private storageSet(k: string, v: string): void {
    try {
      localStorage.setItem(this.storageKey(k), v);
    } catch {
      /* 隱私模式等情況忽略 */
    }
  }

  // ---------------- pre-chat 表單 ----------------
  private renderPrechatForm(fields: PrechatField[]): void {
    this.footer.classList.add("kf-hidden"); // 完成表單前隱藏輸入區
    const form = document.createElement("div");
    form.className = "kf-form";
    const intro = document.createElement("div");
    intro.className = "kf-form-intro";
    intro.textContent = this.t("prechatIntro");
    form.appendChild(intro);

    const inputs: { field: PrechatField; el: HTMLInputElement | HTMLTextAreaElement; wrap: HTMLElement; err: HTMLElement }[] = [];
    for (const f of fields) {
      const wrap = document.createElement("div");
      wrap.className = "kf-field";
      const label = document.createElement("label");
      label.textContent = f.label || f.key;
      if (f.required) {
        const star = document.createElement("span");
        star.className = "kf-req";
        star.textContent = "*";
        label.appendChild(star);
      }
      const el = this.buildFieldInput(f);
      const err = document.createElement("div");
      err.className = "kf-field-err";
      wrap.appendChild(label);
      wrap.appendChild(el);
      wrap.appendChild(err);
      form.appendChild(wrap);
      inputs.push({ field: f, el, wrap, err });
    }

    const submit = document.createElement("button");
    submit.className = "kf-btn";
    submit.textContent = this.t("startChat");
    form.appendChild(submit);

    submit.addEventListener("click", () => {
      let valid = true;
      const values: { field: PrechatField; value: string }[] = [];
      for (const it of inputs) {
        const v = it.el.value.trim();
        it.wrap.classList.remove("invalid");
        it.err.textContent = "";
        if (it.field.required && !v) {
          valid = false;
          it.wrap.classList.add("invalid");
          it.err.textContent = this.t("fieldRequired");
        } else if (v && (it.field.type === "email") && !this.isEmail(v)) {
          valid = false;
          it.wrap.classList.add("invalid");
          it.err.textContent = this.t("invalidEmail");
        }
        values.push({ field: it.field, value: v });
      }
      if (!valid) return;
      this.applyPrechatValues(values);
      this.prechatDone = true;
      this.stage = "init"; // 讓 enterMainFlow 決定 chat / offline
      form.remove();
      this.footer.classList.remove("kf-hidden");
      this.enterMainFlow();
    });

    this.body.appendChild(form);
    this.scrollBottom();
  }

  private buildFieldInput(f: PrechatField): HTMLInputElement | HTMLTextAreaElement {
    if (f.type === "textarea") {
      const ta = document.createElement("textarea");
      ta.placeholder = f.label || "";
      return ta;
    }
    const input = document.createElement("input");
    input.type = f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text";
    input.placeholder = f.label || "";
    return input;
  }

  /** 姓名欄 → display_name;其餘非空欄位彙整成首則訊息摘要。 */
  private applyPrechatValues(values: { field: PrechatField; value: string }[]): void {
    const lines: string[] = [];
    for (const { field, value } of values) {
      if (!value) continue;
      if (this.isNameField(field)) {
        this.cfg.displayName = value;
      } else {
        lines.push(`${field.label || field.key}:${value}`);
      }
    }
    this.pendingPrechatSummary = lines.length
      ? this.t("visitorInfo", { lines: lines.join("\n") })
      : "";
  }

  private isNameField(f: PrechatField): boolean {
    const k = (f.key || "").toLowerCase();
    const l = f.label || "";
    return k.includes("name") || l.includes("姓名") || l.includes("名字") || l.includes("稱呼");
  }

  private isEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  // ---------------- 離線留言表單 ----------------
  private enterOfflineMode(): void {
    const msg = this.settings?.offline_message || this.t("offlineDefault");
    this.addSystem(msg);
    this.setStatus(this.t("statusOffline"), false);
    this.footer.classList.add("kf-hidden");

    const form = document.createElement("div");
    form.className = "kf-form";

    const mkField = (labelText: string, required: boolean) => {
      const wrap = document.createElement("div");
      wrap.className = "kf-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      if (required) {
        const s = document.createElement("span");
        s.className = "kf-req";
        s.textContent = "*";
        label.appendChild(s);
      }
      const err = document.createElement("div");
      err.className = "kf-field-err";
      wrap.appendChild(label);
      return { wrap, label, err };
    };

    const emailF = mkField(this.t("email"), true);
    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.placeholder = this.t("emailPlaceholder");
    emailF.wrap.appendChild(emailInput);
    emailF.wrap.appendChild(emailF.err);

    const msgF = mkField(this.t("message"), true);
    const msgInput = document.createElement("textarea");
    msgInput.placeholder = this.t("describeIssue");
    msgF.wrap.appendChild(msgInput);
    msgF.wrap.appendChild(msgF.err);

    const submit = document.createElement("button");
    submit.className = "kf-btn";
    submit.textContent = this.t("submitMessage");

    form.appendChild(emailF.wrap);
    form.appendChild(msgF.wrap);
    form.appendChild(submit);
    this.panel.appendChild(form);

    submit.addEventListener("click", async () => {
      const email = emailInput.value.trim();
      const body = msgInput.value.trim();
      let valid = true;
      emailF.wrap.classList.remove("invalid");
      emailF.err.textContent = "";
      msgF.wrap.classList.remove("invalid");
      msgF.err.textContent = "";
      if (!email || !this.isEmail(email)) {
        valid = false;
        emailF.wrap.classList.add("invalid");
        emailF.err.textContent = this.t("invalidEmail");
      }
      if (!body) {
        valid = false;
        msgF.wrap.classList.add("invalid");
        msgF.err.textContent = this.t("fillMessage");
      }
      if (!valid) return;

      submit.disabled = true;
      submit.textContent = this.t("submitting");
      // 以 Email 當顯示名,建會話後送出一則含 Email 的留言
      this.cfg.displayName = email;
      const ok = await this.openSessionOnce();
      let sent = false;
      if (ok && this.visitorExternalId) {
        try {
          await sendMessage(
            this.cfg,
            this.visitorExternalId,
            this.t("offlineMessage", { email, body }),
          );
          sent = true;
        } catch {
          /* 下方統一提示 */
        }
      }
      if (sent) {
        form.remove();
        this.addSystem(this.t("offlineReceived"));
      } else {
        submit.disabled = false;
        submit.textContent = this.t("submitMessage");
        msgF.err.textContent = this.t("submitFailedRetry");
        msgF.wrap.classList.add("invalid");
      }
    });
    this.scrollBottom();
  }

  // ---------------- post-chat 回饋(問卷 / CSAT 分派) ----------------
  /**
   * 從公開設定取出「已啟用且有有效欄位」的 post-chat 問卷;否則回 null(退回固定 CSAT)。
   * widget_theme 為 JSONB 原樣存讀,故以區域擴充型別取用(不需後端 model)。
   */
  private getPostChatSurvey(): PostChatSurvey | null {
    const s = (this.settings?.widget_theme as { post_chat_survey?: PostChatSurvey } | undefined)
      ?.post_chat_survey;
    if (!s || typeof s !== "object" || !s.enabled) return null;
    const fields = Array.isArray(s.fields)
      ? s.fields.filter(
          (f): f is SurveyField => !!f && typeof f === "object" && typeof f.key === "string" && !!f.key,
        )
      : [];
    return fields.length ? { enabled: true, fields } : null;
  }

  /**
   * 會話結束時的回饋入口分派:有設定 post-chat 問卷 → 渲染自訂問卷;否則 → 固定 CSAT。
   * 三個觸發點(標頭星鈕 / session.closed / csat_invite)共用此分派,行為一致。
   */
  private openFeedback(scale = 5, endpoint?: string): void {
    const survey = this.getPostChatSurvey();
    if (survey) this.openPostChatSurvey(survey, scale, endpoint);
    else this.openCsat(scale, endpoint);
  }

  /**
   * 渲染可自訂 post-chat 問卷(覆蓋於面板 body 上,沿用 .kf-csat 樣式)。
   * 提交策略(不新增後端端點):
   *   - 問卷含 rating 欄且已評分 → 走既有 CSAT 提交(submitCsat):rating 進 rating 參數,
   *     其餘欄位彙整成結構化 comment 一併送出(額外欄位存於 CSAT 回饋)。
   *   - 問卷無 rating 欄 → 退回「既有欄位收集」:把答案彙整成結構化訊息,經既有訪客送訊端點
   *     送出(與 pre-chat 摘要相同機制),不新增端點。
   * 已開卡 / 已評過 / 無會話各自妥善處理,重複觸發不疊卡(對齊 openCsat)。
   */
  private openPostChatSurvey(survey: PostChatSurvey, scale = 5, endpoint?: string): void {
    if (this.csatOverlay) return; // 已開啟
    if (this.csatSubmitted) {
      this.showCsatThanks(this.buildCsatOverlay());
      return;
    }
    if (!this.sessionId) {
      this.addNotice(this.t("noConversationToRate"));
      return;
    }
    const fields = survey.fields || [];
    const overlay = this.buildCsatOverlay();
    overlay.classList.add("kf-csat-survey");

    const h3 = document.createElement("h3");
    h3.textContent = this.t("rateTitle");
    const sub = document.createElement("p");
    sub.className = "kf-csat-sub";
    sub.textContent = this.t("rateSubtitle");
    overlay.appendChild(h3);
    overlay.appendChild(sub);

    const form = document.createElement("div");
    form.className = "kf-survey";
    overlay.appendChild(form);

    // 每個欄位的取值器 + 驗證資訊。ratingIdx 記錄第一個 rating 欄位(供 CSAT 提交)。
    interface FieldRuntime {
      field: SurveyField;
      getValue: () => string;
      wrap: HTMLElement;
      err: HTMLElement;
    }
    const runtimes: FieldRuntime[] = [];
    let ratingIdx = -1;

    for (const f of fields) {
      const type: SurveyFieldType = f.type || "text";
      const wrap = document.createElement("div");
      wrap.className = "kf-field";
      const label = document.createElement("label");
      label.textContent = f.label || f.key;
      if (f.required) {
        const star = document.createElement("span");
        star.className = "kf-req";
        star.textContent = "*";
        label.appendChild(star);
      }
      wrap.appendChild(label);
      const err = document.createElement("div");
      err.className = "kf-field-err";

      let getValue: () => string = () => "";

      if (type === "rating") {
        if (ratingIdx < 0) ratingIdx = runtimes.length;
        let rating = 0;
        const starsRow = document.createElement("div");
        starsRow.className = "kf-stars";
        const starBtns: HTMLButtonElement[] = [];
        for (let i = 1; i <= scale; i++) {
          const b = document.createElement("button");
          b.className = "kf-star";
          b.type = "button";
          b.setAttribute("aria-label", this.t("starAria", { n: i }));
          b.innerHTML = STAR_SVG;
          b.addEventListener("click", () => {
            rating = i;
            starBtns.forEach((sb, idx) => sb.classList.toggle("on", idx < i));
          });
          starBtns.push(b);
          starsRow.appendChild(b);
        }
        wrap.appendChild(starsRow);
        getValue = () => (rating > 0 ? String(rating) : "");
      } else if (type === "choice") {
        const opts = Array.isArray(f.options) ? f.options.filter((o) => !!(o || "").trim()) : [];
        let selected = "";
        const group = document.createElement("div");
        group.className = "kf-choices";
        const chips: HTMLButtonElement[] = [];
        for (const opt of opts) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "kf-choice";
          chip.textContent = opt;
          chip.addEventListener("click", () => {
            selected = opt;
            chips.forEach((c) => c.classList.toggle("on", c === chip));
          });
          chips.push(chip);
          group.appendChild(chip);
        }
        wrap.appendChild(group);
        getValue = () => selected;
      } else {
        // text / email → 輸入框(email 用 email 型別以利行動裝置鍵盤)
        const input = document.createElement("input");
        input.type = type === "email" ? "email" : "text";
        input.placeholder = f.label || "";
        wrap.appendChild(input);
        getValue = () => input.value.trim();
      }

      wrap.appendChild(err);
      form.appendChild(wrap);
      runtimes.push({ field: f, getValue, wrap, err });
    }

    const err = document.createElement("div");
    err.className = "kf-field-err";

    const actions = document.createElement("div");
    actions.className = "kf-csat-actions";
    const cancel = document.createElement("button");
    cancel.className = "kf-btn-ghost";
    cancel.textContent = this.t("later");
    cancel.addEventListener("click", () => this.closeCsat());
    const submit = document.createElement("button");
    submit.className = "kf-btn";
    submit.textContent = this.t("submitRating");
    submit.addEventListener("click", async () => {
      if (!this.sessionId || this.csatSubmitted) return;
      // 逐欄驗證:必填非空、email 格式、rating 必填須已評。
      let valid = true;
      const answers: { field: SurveyField; value: string }[] = [];
      for (const rt of runtimes) {
        const v = rt.getValue();
        rt.wrap.classList.remove("invalid");
        rt.err.textContent = "";
        const type: SurveyFieldType = rt.field.type || "text";
        if (rt.field.required && !v) {
          valid = false;
          rt.wrap.classList.add("invalid");
          rt.err.textContent = this.t("fieldRequired");
        } else if (v && type === "email" && !this.isEmail(v)) {
          valid = false;
          rt.wrap.classList.add("invalid");
          rt.err.textContent = this.t("invalidEmail");
        }
        answers.push({ field: rt.field, value: v });
      }
      if (!valid) return;

      const ratingVal = ratingIdx >= 0 ? Number(answers[ratingIdx].value || 0) : 0;
      // 結構化摘要:CSAT 路徑排除 rating 欄(rating 已入 rating 參數);訊息路徑含全部答案。
      const linesExclRating = answers
        .filter((_, i) => i !== ratingIdx)
        .filter((a) => a.value)
        .map((a) => `${a.field.label || a.field.key}:${a.value}`);
      const linesAll = answers
        .filter((a) => a.value)
        .map((a) => `${a.field.label || a.field.key}:${a.value}`);

      submit.disabled = true;
      submit.textContent = this.t("submitting");
      err.textContent = "";
      try {
        if (ratingIdx >= 0 && ratingVal >= 1) {
          // CSAT 路徑:rating + 其餘欄位彙整為 comment。
          await submitCsat(this.cfg, this.sessionId as string, ratingVal, linesExclRating.join("\n"), endpoint);
        } else {
          // 無 rating 欄:退回結構化訊息(既有訪客送訊端點);無內容則不送。
          const body = linesAll.join("\n");
          if (body) {
            await sendMessage(this.cfg, this.visitorExternalId, this.t("visitorInfo", { lines: body }));
          }
        }
        this.csatSubmitted = true;
        this.csatBtn.classList.add("kf-hidden");
        overlay.classList.remove("kf-csat-survey"); // 還原置中版面以顯示感謝訊息
        this.showCsatThanks(overlay);
      } catch (e) {
        submit.disabled = false;
        submit.textContent = this.t("submitRating");
        err.textContent = this.t("sendFailedPrefix") + (e as Error).message;
      }
    });
    actions.appendChild(cancel);
    actions.appendChild(submit);

    overlay.appendChild(err);
    overlay.appendChild(actions);
  }

  // ---------------- CSAT 訪客評分 ----------------
  /**
   * 開啟評分卡。觸發來源:標頭「結束對話並評分」鈕、WS session.closed、以及 W6 邀評訊息
   * (meta.csat_invite)。scale 為星等上限(預設 5);endpoint 為提交端點(缺省用後端預設)。
   * 已開卡 / 已評過 / 無會話皆各自妥善處理,重複觸發不會疊卡。
   */
  private openCsat(scale = 5, endpoint?: string): void {
    if (this.csatOverlay) return; // 已開啟
    if (this.csatSubmitted) {
      this.showCsatThanks(this.buildCsatOverlay());
      return;
    }
    if (!this.sessionId) {
      this.addNotice(this.t("noConversationToRate"));
      return;
    }
    const overlay = this.buildCsatOverlay();

    const h3 = document.createElement("h3");
    h3.textContent = this.t("rateTitle");
    const sub = document.createElement("p");
    sub.className = "kf-csat-sub";
    sub.textContent = this.t("rateSubtitle");

    let rating = 0;
    const starsRow = document.createElement("div");
    starsRow.className = "kf-stars";
    const starBtns: HTMLButtonElement[] = [];
    for (let i = 1; i <= scale; i++) {
      const b = document.createElement("button");
      b.className = "kf-star";
      b.type = "button";
      b.setAttribute("aria-label", this.t("starAria", { n: i }));
      b.innerHTML = STAR_SVG;
      b.addEventListener("click", () => {
        rating = i;
        starBtns.forEach((sb, idx) => sb.classList.toggle("on", idx < i));
        submit.disabled = false;
      });
      starBtns.push(b);
      starsRow.appendChild(b);
    }

    const comment = document.createElement("textarea");
    comment.placeholder = this.t("rateCommentPlaceholder");

    const err = document.createElement("div");
    err.className = "kf-field-err";

    const actions = document.createElement("div");
    actions.className = "kf-csat-actions";
    const cancel = document.createElement("button");
    cancel.className = "kf-btn-ghost";
    cancel.textContent = this.t("later");
    cancel.addEventListener("click", () => this.closeCsat());
    const submit = document.createElement("button");
    submit.className = "kf-btn";
    submit.textContent = this.t("submitRating");
    submit.disabled = true;
    submit.addEventListener("click", async () => {
      if (rating < 1 || !this.sessionId || this.csatSubmitted) return;
      submit.disabled = true;
      submit.textContent = this.t("submitting");
      err.textContent = "";
      try {
        await submitCsat(this.cfg, this.sessionId, rating, comment.value.trim(), endpoint);
        this.csatSubmitted = true;
        this.csatBtn.classList.add("kf-hidden");
        this.showCsatThanks(overlay);
      } catch (e) {
        submit.disabled = false;
        submit.textContent = this.t("submitRating");
        err.textContent = this.t("sendFailedPrefix") + (e as Error).message;
      }
    });
    actions.appendChild(cancel);
    actions.appendChild(submit);

    overlay.appendChild(h3);
    overlay.appendChild(sub);
    overlay.appendChild(starsRow);
    overlay.appendChild(comment);
    overlay.appendChild(err);
    overlay.appendChild(actions);
  }

  private buildCsatOverlay(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "kf-csat";
    this.panel.appendChild(overlay);
    this.csatOverlay = overlay;
    return overlay;
  }

  private showCsatThanks(overlay: HTMLElement): void {
    overlay.innerHTML = "";
    const thanks = document.createElement("div");
    thanks.className = "kf-csat-thanks";
    thanks.textContent = this.t("rateThanks");
    const close = document.createElement("button");
    close.className = "kf-btn";
    close.textContent = this.t("close");
    close.addEventListener("click", () => this.closeCsat());
    overlay.appendChild(thanks);
    overlay.appendChild(close);
  }

  private closeCsat(): void {
    if (this.csatOverlay) {
      this.csatOverlay.remove();
      this.csatOverlay = null;
    }
  }

  // ---------------- 銷毀 ----------------
  destroy(): void {
    if (this.socket) this.socket.close();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.draftTimer !== null) clearTimeout(this.draftTimer);
    if (this.proactive) this.proactive.teardown();
    this.dismissProactiveTeaser();
    this.dismissEyeCatcher();
    // 卸除頁面軌跡監聽(patch 過的 history 方法留著無妨:已無監聽者回應其事件)
    try {
      window.removeEventListener("popstate", this.onLocationChange);
      window.removeEventListener("hashchange", this.onLocationChange);
      window.removeEventListener("kefu:locationchange", this.onLocationChange);
    } catch {
      /* 忽略 */
    }
    this.host.remove();
  }
}
