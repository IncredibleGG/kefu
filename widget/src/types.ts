// kefu widget 對外設定與內部型別

export interface WidgetConfig {
  /** API 根位址。留空 = 同源相對路徑(建議,配合反代)。例:"https://cs.example.com" 或 "" */
  apiBase: string;
  /** 渠道 public_key(後端 Channel.config.public_key)。發訊定位渠道用,必填。 */
  channelKey: string;
  /**
   * 租戶 id(UUID)。用於連 /ws/widget 即時接收 AI/坐席回覆。
   * 一般毋須手動提供:open-session 回應已含 tenant_id,widget 會於開會話後
   * 自動寫入(見 openSessionOnce)。此處僅作「手動覆寫」用——若嵌入方顯式提供,
   * 則以嵌入方的值為準(不會被回應覆蓋)。兩者皆缺時無法用 WS 接收(可改 agentToken 輪詢)。
   */
  tenantId?: string;
  /**
   * 坐席 JWT(選填)。提供後可用 REST 輪詢載入歷史/回覆
   * (GET /api/v1/conversation/sessions/{id}),作為 WS 連不上時的 fallback。
   * 正式訪客場景不應下發此 token;僅供端到端測試。
   */
  agentToken?: string;
  /** 訪客顯示名(選填)。 */
  displayName?: string;
  /**
   * 介面語系(選填)。支援 zh-Hant / zh-CN / en / ja / ko / es / ar,
   * 亦接受常見別名(zh-TW、zh-HK → zh-Hant;zh-Hans → zh-CN;en-US → en …)。
   * 未指定時:自動依 navigator.language(s) 偵測,無法對應則回退 zh-Hant。
   */
  locale?: string;
  /** 面板標題。 */
  title?: string;
  /** 歡迎語(面板首開顯示,不送往後端)。 */
  greeting?: string;
  /** 主題色(氣泡/送出鍵)。 */
  primaryColor?: string;
  /** 是否載入後自動展開面板。 */
  autoOpen?: boolean;
  /** 輪詢間隔(毫秒),預設 3000。 */
  pollIntervalMs?: number;
  /** 設 true 時不自動初始化,等待 window.KefuWidget.init() 手動呼叫(demo 用)。 */
  manualInit?: boolean;
}

export type SenderRole = "visitor" | "ai" | "human" | "system";

export interface ChatMessage {
  id?: string;
  role: SenderRole;
  content: string;
  contentType: string;
  pending?: boolean;
  error?: boolean;
}

/** 後端回應信封 { ok, data, error, request_id } */
export interface Envelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  request_id: string | null;
}

export interface SessionOpenData {
  channel_id: string;
  /**
   * 租戶 id(UUID)。後端 open-session 回應恆帶此欄位,供 widget 訂閱 /ws/widget
   * 即時接收回覆。設為選填以相容尚未升級的後端(缺此欄位時退回手動 tenantId / 輪詢)。
   */
  tenant_id?: string;
  visitor_external_id: string;
  session_id: string | null;
}

/** realtime 事件封包 { type, payload, ts } */
export interface RealtimeEvent {
  type: string;
  payload?: Record<string, unknown>;
  ts?: string;
}

/**
 * W6 CSAT 自動邀評旗標:結案後由 worker(csat_followup)以 conversation.add_message
 * 發一則 system 訊息,於 message.meta.csat_invite 帶此結構(見 backend
 * app/workers/csat_followup.py)。widget 收到帶此旗標的訊息即呈現評分卡。
 * 不理解此旗標的舊客戶端仍會把訊息內文當一般 system 訊息顯示(優雅降級)。
 */
export interface CsatInvite {
  /** 星等上限(整數;預設 5,即 1–5 星)。 */
  rating_scale?: number;
  /** 邀評原因(如 session_closed);widget 目前僅供除錯參考,不影響呈現。 */
  reason?: string;
  /** 提交端點(相對路徑;預設對齊後端 /api/v1/quality/csat)。 */
  submit_endpoint?: string;
}

/** pre-chat 欄位定義(後端公開設定回傳)。type 預設 text,支援 text/email/tel/textarea 等。 */
export interface PrechatField {
  key: string;
  label: string;
  required?: boolean;
  type?: string;
}

/** 外觀客製(主色 / logo / 歡迎語)。 */
export interface WidgetTheme {
  primary_color?: string;
  logo_url?: string;
  greeting?: string;
}

/**
 * 渠道公開設定(GET /api/v1/settings/public/{channel_key},無需 JWT)。
 * 端點未就緒時一律走預設(視為營業中、無 pre-chat、內建外觀)。
 */
export interface PublicSettings {
  is_online?: boolean;
  offline_message?: string;
  prechat_enabled?: boolean;
  prechat_fields?: PrechatField[];
  widget_theme?: WidgetTheme;
}

/** 主動式訊息觸發條件(後端 ProactiveRule.trigger)。 */
export interface ProactiveTrigger {
  /** url_match | time_on_page | scroll_depth | visit_count | exit_intent */
  type: string;
  /** 依 type 解讀的參數(pattern / seconds / percent / count / op …)。 */
  params?: Record<string, unknown>;
}

/** 主動式訊息呈現方式。 */
export type ProactiveMode = "show_bubble" | "auto_open";

/** 主動式訊息觸發頻率。 */
export type ProactiveFrequency = "once_per_session" | "once_per_visitor" | "always";

/**
 * 主動式訊息規則(GET /api/v1/proactive/public/{channel_key},無需 JWT)。
 * 觸發判定全在瀏覽器端:widget 依 trigger 評估,命中依 mode 呈現,並依 frequency 記錄避免洗版。
 */
export interface ProactiveRule {
  id: string;
  trigger: ProactiveTrigger;
  message: string;
  mode: ProactiveMode;
  frequency: ProactiveFrequency;
  /** 數字越大越優先(多規則同時命中時取高者)。 */
  priority: number;
}
