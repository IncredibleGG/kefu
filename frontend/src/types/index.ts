/** 全站領域型別(對齊後端概念模型,見 docs/BLUEPRINT 第三節) */

/** 後端統一回應信封 { ok, data, error, request_id } */
export interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  request_id: string | null;
}

export type ChannelType =
  | "web"
  | "telegram"
  | "whatsapp"
  | "wechat"
  | "email"
  | "slack"
  | "discord";

export type AgentStatus = "online" | "busy" | "away" | "offline";

export type HandlerType = "ai" | "human" | "bot";

export type SessionTab = "mine" | "unassigned" | "queue" | "online";

export type SenderType = "visitor" | "agent" | "ai" | "system" | "note";

export type MessageContentType =
  | "text"
  | "markdown"
  | "image"
  | "file"
  | "card"
  | "system";

export interface Staff {
  staff_id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  roles: string[];
  avatar_url?: string;
}

export interface Visitor {
  id: string;
  display_name: string;
  avatar_url?: string;
  channel: ChannelType;
  external_id?: string;
  location?: string;
  os?: string;
  browser?: string;
  first_seen?: string;
  tags: string[];
  /** 關聯 CRM 聯絡人(若已合併) */
  contact?: Contact;
  custom?: Record<string, string>;
}

export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  note?: string;
  lifetime_value?: number;
}

export interface Session {
  id: string;
  visitor: Visitor;
  channel: ChannelType;
  handler_type: HandlerType;
  assignee_id?: string;
  assignee_name?: string;
  tab: SessionTab;
  status: "open" | "waiting" | "closed";
  last_message_preview: string;
  last_message_at: string;
  unread: number;
  waiting_seconds?: number; // 排隊等待時長
  tags: string[];
  skill_group?: string;
  /** 雙向翻譯開關與語言(逐會話) */
  translate_enabled?: boolean;
  agent_lang?: string;
  visitor_lang?: string | null;
}

export interface MessageSource {
  title: string;
  ref: string;
  score: number;
}

/** 訊息翻譯資訊(雙向即時翻譯):原文 / 譯文 / 語言 / 方向 */
export interface MessageI18n {
  original: string;
  translated: string;
  original_lang: string;
  translated_lang: string;
  direction: "inbound" | "outbound";
}

export interface Message {
  id: string;
  session_id: string;
  sender_type: SenderType;
  sender_name?: string;
  content_type: MessageContentType;
  content: string;
  ts: string;
  status?: "sending" | "sent" | "delivered" | "read" | "failed";
  flagged?: boolean; // 質檢標旗
  /** AI 回覆的溯源與信心 */
  ai?: { confidence: number; sources: MessageSource[] };
  /** 雙向翻譯:存在時同時顯示原文與譯文 */
  i18n?: MessageI18n;
  /** 富卡片 payload(content_type=card 時) */
  card?: {
    title: string;
    subtitle?: string;
    buttons?: { label: string; value: string }[];
  };
  /** 富卡片輪播(content_type=card 且 meta.cards 多張時);渲染端以 RichCardData 斷言讀取 */
  cards?: unknown[];
}

/** 標籤主檔(visitor/tags) */
export interface Tag {
  id: string;
  name: string;
  color?: string | null;
  category?: string | null;
}

/** 坐席精簡資料(iam/staff) */
export interface StaffLite {
  id: string;
  display_name: string;
  email?: string;
  status?: string;
}

/** 技能組(iam/skill-groups) */
export interface SkillGroup {
  id: string;
  name: string;
  description?: string | null;
}

/* ===================== IAM 管理端(坐席 / 角色 / 權限 / 技能組) ===================== */

/** 角色精簡(掛在坐席身上) */
export interface RoleLite {
  id: string;
  name: string;
}

/** 坐席管理列(充實角色與技能組後供 admin 表格顯示) */
export interface StaffAdmin {
  id: string;
  email: string;
  display_name: string;
  avatar_url?: string | null;
  organization_id?: string | null;
  status: AgentStatus;
  is_active: boolean;
  created_at?: string | null;
  roles: RoleLite[];
  skill_groups: { id: string; name: string }[];
}

/** 角色(RBAC);permissions 僅在單筆詳情端點回傳 */
export interface Role {
  id: string;
  name: string;
  description?: string | null;
  is_system: boolean;
  permissions?: string[];
}

/** 權限碼 */
export interface Permission {
  id: string;
  code: string;
  description?: string | null;
}

/** 技能組成員 */
export interface SkillGroupMember {
  id: string;
  display_name: string;
  email?: string | null;
}

/** 技能組詳情(含成員) */
export interface SkillGroupDetail {
  id: string;
  name: string;
  description?: string | null;
  members: SkillGroupMember[];
}

/** 聯絡人詳情(CRM 檔案:含關聯訪客身份與標籤 id) */
export interface ContactDetail {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  note?: string | null;
  is_blocked: boolean;
  attributes?: Record<string, unknown> | null;
  visitors: {
    id: string;
    display_name: string;
    channel_id: string;
    external_id?: string | null;
    is_blocked: boolean;
  }[];
  tags: string[];
}

/** 訪客軌跡(來源渠道 + 近期會話) */
export interface VisitorTimeline {
  visitor_id: string;
  source: { channel_id: string; channel_type: string | null; channel_name: string | null };
  sessions: {
    id: string;
    status: string;
    handler_type: string;
    created_at: string | null;
    closed_at: string | null;
  }[];
}

/** Admin Console 總覽儀表板資料 */
export interface DashboardData {
  kpi: { label: string; value: string; hint?: string }[];
  volumeSeries: { date: string; 會話量: number }[];
  statusBreakdown: { name: string; value: number }[];
  agentPerf: { name: string; 接待: number }[];
}

/** 罐頭 / 快捷回覆 */
export interface Canned {
  id: string;
  title: string;
  shortcut: string;
  content: string;
  shared: boolean;
  owner_staff_id?: string | null;
  skill_group_id?: string | null;
}

/** 全域搜尋結果 */
export interface SearchResults {
  sessions: {
    id: string;
    status: string;
    handler_type: string;
    channel_id: string;
    visitor_id: string;
    visitor_name?: string | null;
    visitor_external_id?: string | null;
    last_message_at?: string | null;
  }[];
  messages: {
    id: string;
    session_id: string;
    sender_type: string;
    content_type: string;
    snippet: string;
    created_at?: string | null;
  }[];
  contacts: {
    id: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    note?: string | null;
  }[];
}

/** AI 回覆建議條 */
export interface ReplySuggestion {
  id: string;
  text: string;
  kind: "ai" | "kb"; // AI 生成 vs 知識庫聯想
  confidence?: number;
  source?: string;
}

/** AI 洞察(右欄) */
export interface AiInsight {
  intent: string;
  sentiment: "positive" | "neutral" | "negative";
  summary: string;
  suggested_actions: string[];
  risk?: string;
}

export interface KbHit {
  id: string;
  title: string;
  snippet: string;
  collection: string;
  score: number;
}

export interface KnowledgeCollection {
  id: string;
  name: string;
  type: "document" | "qa" | "website";
  doc_count: number;
  hit_rate: number;
  updated_at: string;
}

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  status: "connected" | "disconnected" | "error";
  meta?: Record<string, string>;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/* ============================ 套餐 / 計費 ============================ */
/** 套餐方案(billing/plans) */
export interface Plan {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  price_cents: number;
  price_monthly: number;
  currency: string;
  billing_period: string;
  features: FeatureMap | null;
  limits?: Record<string, unknown> | null;
  unit_prices?: Record<string, unknown> | null;
  is_active: boolean;
  is_public: boolean;
  sort: number;
}

/** 目前訂閱(billing/subscription) */
export interface Subscription {
  id: string;
  tenant_id: string;
  plan_id: string;
  reseller_tenant_id?: string | null;
  status: string;
  byo_key: boolean;
  seats: number;
  current_period_start?: string | null;
  current_period_end?: string | null;
}

/** 功能生效值:bool 開關 / limit 數值上限(null=無限) */
export type FeatureMap = Record<string, boolean | number | null>;

/** 功能目錄項(billing/features 的 catalog) */
export interface FeatureCatalogEntry {
  key: string;
  name: string;
  type: "bool" | "limit";
  default: boolean | number | null;
  description: string;
}

/** GET /billing/features 回應 */
export interface FeaturesResponse {
  tenant_id: string;
  features: FeatureMap;
  catalog: Record<string, FeatureCatalogEntry>;
}

/** GET /billing/subscription 回應 */
export interface SubscriptionResponse {
  subscription: Subscription | null;
  plan: Plan | null;
  features: FeatureMap;
}

/* ========================= Widget / 接待設定 ========================= */
/** pre-chat 表單欄位定義 */
export interface PrechatField {
  key: string;
  label: string;
  type: "text" | "email" | "tel" | "textarea";
  required: boolean;
}

/** widget 外觀主題 */
export interface WidgetTheme {
  primary_color?: string;
  logo_url?: string;
  greeting?: string;
}

/** 營業時間:各週時段 + 時區。days[weekday] = [[start,end], ...],空=當日休息。 */
export interface BusinessHours {
  timezone?: string;
  days?: Record<string, [string, string][]>;
}

/** 租戶客服設定(settings) */
export interface TenantSettings {
  tenant_id?: string;
  business_hours: BusinessHours | null;
  offline_message: string | null;
  prechat_enabled: boolean;
  prechat_fields: PrechatField[] | null;
  widget_theme: WidgetTheme | null;
  timezone: string | null;
  updated_at?: string | null;
}

/* ============================ 翻譯供應商 ============================ */
/** 翻譯供應商:Google 免費 / 我方 LLM / 自訂 API(存於 tenant.llm_config.translation) */
export type TranslationProvider = "google" | "ours" | "custom";

export interface TranslationConfig {
  provider: TranslationProvider;
  /** custom 專用:自訂翻譯 API 端點 */
  endpoint?: string;
  /** custom 專用:金鑰(巢狀於 llm_config 不被遮罩,讀寫皆原文) */
  api_key?: string;
}

/** 租戶精簡資料(tenancy/tenants/me);llm_config 巢狀存 translation 設定 */
export interface TenantLite {
  id: string;
  name: string;
  slug: string;
  branding: Record<string, unknown> | null;
  llm_config: Record<string, unknown> | null;
  is_active: boolean;
}

/* ===================== 自動化規則引擎(automation) ===================== */
/** 條件列:欄位 / 運算子 / 比對值 */
export interface AutomationCondition {
  field: string;
  op: string;
  value: unknown;
}

/** 動作列:型別 + 參數(依 action_types 的 params 解讀) */
export interface AutomationAction {
  type: string;
  params: Record<string, unknown>;
}

/** 自動化規則(trigger_event + conditions(AND)→ actions) */
export interface AutomationRule {
  id: string;
  name: string;
  trigger_event: string;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  is_active: boolean;
  priority: number;
  created_at?: string | null;
  updated_at?: string | null;
}

/** 規則建構器目錄(GET /automation/catalog):供下拉與動態欄位渲染 */
export interface AutomationCatalog {
  events: { event: string; label: string }[];
  condition_ops: { op: string; label: string }[];
  condition_fields: { field: string; label: string; type: string }[];
  action_types: {
    type: string;
    label: string;
    params: { name: string; type: string; required: boolean }[];
  }[];
}

/* ===================== 主動式訊息(proactive) ===================== */
export type ProactiveTriggerType =
  | "url_match"
  | "time_on_page"
  | "scroll_depth"
  | "visit_count"
  | "exit_intent";
export type ProactiveMode = "show_bubble" | "auto_open";
export type ProactiveFrequency = "once_per_session" | "once_per_visitor" | "always";

/** 觸發條件 { type, params };params 依 type 解讀 */
export interface ProactiveTrigger {
  type: ProactiveTriggerType;
  params: Record<string, unknown>;
}

export interface ProactiveRule {
  id: string;
  name: string;
  channel_id?: string | null;
  trigger: ProactiveTrigger;
  message: string;
  mode: ProactiveMode;
  frequency: ProactiveFrequency;
  priority: number;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

/* ===================== SLA 政策 / 違約 ===================== */
export interface SlaPolicy {
  id: string;
  name: string;
  conditions: Record<string, unknown> | null;
  first_response_minutes: number;
  resolution_minutes: number;
  is_active: boolean;
  priority: number;
  created_at?: string | null;
  updated_at?: string | null;
}

/** SLA 違約追蹤(GET /sla/breaches) */
export interface SlaBreach {
  id: string;
  session_id: string;
  policy_id: string | null;
  status: string;
  breached_first: boolean;
  breached_resolution: boolean;
  first_response_due: string | null;
  resolution_due: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  updated_at: string | null;
}

/* ===================== Email 渠道設定 ===================== */
export interface EmailImapConfig {
  host: string;
  port: number;
  ssl: boolean;
  user: string;
  /** 送出時留空 = 沿用既有密碼(後端 _resolve_secret 語義) */
  pass?: string;
  folder: string;
}

export interface EmailSmtpConfig {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  pass?: string;
  /** 寄件人;留空後端預設用 SMTP user */
  from?: string;
}

export interface EmailChannelConfig {
  imap: EmailImapConfig;
  smtp: EmailSmtpConfig;
}

/** POST /channel/{id}/email/test 結果 */
export interface EmailTestResult {
  channel_id: string;
  ok: boolean;
  imap: { ok: boolean; error?: string | null } | null;
  smtp: { ok: boolean; error?: string | null } | null;
}

/** WebSocket 事件封包 { type, payload, ts } */
export interface WsEvent<P = unknown> {
  /** 後端(services/conversation, realtime)實際事件:message.new / session.opened /
   *  session.activity / handoff / session.closed。其餘為 mock / 相容保留。 */
  type:
    | "message.new"
    | "note.new"
    | "session.opened"
    | "session.activity"
    | "handoff"
    | "session.closed"
    // 相容 / mock 舊事件名
    | "session.new"
    | "session.assigned"
    | "session.handoff"
    | "typing"
    | "presence"
    | "reply.suggestion"
    | "pong";
  payload: P;
  ts: string;
}

/* ===================== 進階平台:Meta 渠道 / Webhook / API Key / Help Center 發布 =====================
 * 以下型別為「管理 UI(WhatsApp·Facebook 渠道、對外 Webhook、開放 API Key、Help Center 發布)」
 * 追加,對齊後端 channel / webhooks / apikeys / knowledge 端點的欄位。*/

/** WhatsApp(Meta Cloud API)渠道設定表單。敏感欄位留空或送回遮罩值(含 …)= 沿用既有。 */
export interface WhatsAppConfigInput {
  phone_number_id: string;
  access_token?: string;
  verify_token?: string;
  app_secret?: string;
}

/** Facebook Messenger 渠道設定表單(敏感欄位處理同 WhatsApp)。 */
export interface FacebookConfigInput {
  page_id: string;
  page_access_token?: string;
  verify_token?: string;
  app_secret?: string;
}

/** 對外 Webhook 端點(secret 遮罩;建立當下回傳一次明文 secret)。 */
export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** 開放 API 金鑰列(遮罩 + last_used;明文 key 只在建立回應中出現一次)。 */
export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_masked: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string | null;
  /** 僅建立當下回傳一次的明文金鑰(列表 / 讀取不含)。 */
  key?: string;
}

/** 知識庫集合(含發布狀態,供 Help Center 發布管理)。 */
export interface PublishCollection {
  id: string;
  name: string;
  source_type: string;
  is_published: boolean;
  public_slug: string | null;
  created_at: string | null;
}

/** POST /knowledge/collections/{id}/publish|unpublish 回應。 */
export interface PublishResult {
  id: string;
  is_published: boolean;
  public_slug: string | null;
  tenant_slug: string | null;
  /** 可直接使用的公開分類/文章連結(相對後端 helpcenter 路徑)。 */
  public_url: string | null;
  public_base: string | null;
}

/* ===================== 平台超級管理員(跨租戶) =====================
 * 對齊後端 app/api/v1/platform.py:租戶列表 / 開通 / 停用啟用 / 指派方案 / 總覽。 */

/** 方案精簡(掛在租戶列上) */
export interface PlanBrief {
  id: string;
  code: string;
  name: string;
}

/** 平台租戶列(GET /platform/tenants 的 items):含方案 / 坐席數 / 會話數 / 啟用狀態。 */
export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string | null;
  plan: PlanBrief | null;
  seat_count: number;
  session_count: number;
}

/** 開通新租戶表單(POST /platform/tenants)。 */
export interface TenantProvisionInput {
  name: string;
  slug: string;
  admin_email: string;
  admin_password: string;
  admin_display_name?: string;
}

/** 開通新租戶回應:新租戶與其第一個 admin 坐席(不含密碼)。 */
export interface TenantProvisionResult {
  tenant: {
    id: string;
    name: string;
    slug: string;
    is_active: boolean;
    created_at: string | null;
  };
  admin: {
    staff_id: string;
    email: string;
    display_name: string;
    role: string;
  };
}

/** 平台總覽(GET /platform/overview):跨租戶聚合。 */
export interface PlatformOverview {
  tenants: { total: number; active: number; inactive: number };
  staff_total: number;
  session_total: number;
  /** 各方案 code → 租戶數(none = 無生效方案)。 */
  plan_distribution: Record<string, number>;
}

/* ===================== 白牌品牌 / 自訂網域 =====================
 * 對齊後端 app/api/v1/branding.py:公開品牌解析 + 租戶網域綁定。 */

/** GET /public/branding?host=<域名> 的回應(公開,無 JWT)。 */
export interface PublicBranding {
  tenant_slug: string | null;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
  /** 完整白牌設定(其餘 token) */
  branding: Record<string, unknown>;
  /** 找不到對應租戶網域時為 true → 前端沿用內建預設,不套用 */
  is_default: boolean;
  domain?: string;
  verified?: boolean;
}

/** DNS 記錄(綁定網域後回給使用者去設定)。 */
export interface DnsRecord {
  host: string;
  type: string;
  value: string;
}

/** DNS 設定指示:先加 TXT 驗證,再把網域 CNAME 到平台入口。 */
export interface DnsInstructions {
  txt: DnsRecord;
  cname: DnsRecord;
  note: string;
}

/** 租戶自訂網域列(GET /branding/domains 的 items;未驗證者附 DNS 指示)。 */
export interface CustomDomain {
  id: string;
  tenant_id: string;
  domain: string;
  is_primary: boolean;
  verified: boolean;
  created_at: string | null;
  /** 僅未驗證時回傳:驗證用 token 與 DNS 設定指示 */
  verify_token?: string;
  dns_instructions?: DnsInstructions;
}

/** POST /branding/domains/{id}/verify 的回應。 */
export interface DomainVerifyResult {
  id: string;
  domain: string;
  verified: boolean;
  status: string;
  detail?: string;
  dns_instructions?: DnsInstructions;
}

/** POST /auth/change-password 的回應(坐席自助改密碼)。 */
export interface ChangePasswordResult {
  staff_id: string;
  password_changed: boolean;
  /** 改密後伺服器撤銷舊 token;本次 session 須改用此新 token(舊版伺服器不回) */
  access_token?: string;
  token_type?: string;
}
