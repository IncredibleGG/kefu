/** ============================================================
 *  後端 ⇄ 前端資料轉接層。
 *  後端回應(信封內 data)形狀與前端領域型別不同,這裡集中轉換,
 *  讓 endpoints/hooks/元件維持使用既有的前端型別,不必大改。
 *  ============================================================ */
import { apiFetch } from "./client";
import type {
  AgentStatus,
  Channel,
  ChannelType,
  Contact,
  ContactDetail,
  HandlerType,
  KbHit,
  KnowledgeCollection,
  Message,
  MessageContentType,
  ReplySuggestion,
  RoleLite,
  Session,
  SessionTab,
  StaffAdmin,
  Visitor,
} from "@/types";

/* ----------------------------- 後端原始形狀 ----------------------------- */

export interface RawSession {
  id: string;
  channel_id: string;
  visitor_id: string;
  status: string; // queued | open | closed
  handler_type: string; // ai | human | bot
  handler_staff_id: string | null;
  skill_group_id: string | null;
  last_message_at: string | null;
  created_at: string | null;
  closed_at: string | null;
  translate_enabled?: boolean;
  agent_lang?: string;
  visitor_lang?: string | null;
  // 會話端點內嵌的訪客(含關聯 contact 與 ai_profile),供情境面板直接取用;
  // 清單 / 詳情端點會帶,其餘會話回應(接管/轉接/結束)不帶。
  visitor?: RawVisitor | null;
}

export interface RawMessage {
  id: string;
  session_id: string;
  sender_type: string; // visitor | ai | human | system
  sender_id: string | null;
  content_type: string;
  content: string;
  meta: Record<string, unknown> | null;
  created_at: string | null;
}

export interface RawVisitor {
  id: string;
  channel_id: string;
  external_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  contact_id: string | null;
  is_blocked: boolean;
  ai_profile: Record<string, unknown> | null;
  created_at: string | null;
  // 詳情端點才有:
  contact?: RawContact | null;
  tags?: string[];
}

export interface RawContact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  attributes: Record<string, unknown> | null;
  note: string | null;
  is_blocked: boolean;
  created_at: string | null;
}

export interface RawChannel {
  id: string;
  type: string;
  name: string;
  is_active: boolean;
  config: Record<string, unknown> | null;
  created_at: string | null;
}

export interface RawPaged<T> {
  items: T[];
  total: number;
  page: number;
  page_size?: number;
  size?: number;
}

/* ----------------------------- 小工具 ----------------------------- */

/**
 * 前端 ChannelType 型別(@/types)目前只列出核心型別,尚未含 facebook / line;
 * 但後端會回這些型別的渠道(見 metaChannelApi 的 facebook、reportApi 的 line)。
 * 為了讓工作台/渠道頁能正確辨識而非一律當成 web(地球圖示),在此就地以擴充聯集
 * 承載這些型別:runtime 原樣放行,型別上維持回 ChannelType(既有的 as 轉型慣例),
 * 對應的圖示/標籤/顏色由 lib/channels.tsx 的 channelMeta 補齊。
 */
type KnownChannel = ChannelType | "facebook" | "line";

const KNOWN_CHANNELS: KnownChannel[] = [
  "web",
  "telegram",
  "whatsapp",
  "wechat",
  "email",
  "slack",
  "discord",
  "facebook",
  "line",
];

function toChannelType(t: string | undefined): ChannelType {
  return (KNOWN_CHANNELS as string[]).includes(t ?? "") ? (t as ChannelType) : "web";
}

function toHandlerType(t: string | undefined): HandlerType {
  return t === "human" || t === "ai" || t === "bot" ? (t as HandlerType) : "ai";
}

function toContentType(t: string | undefined): MessageContentType {
  const ok = ["text", "markdown", "image", "file", "card", "system"];
  return ok.includes(t ?? "") ? (t as MessageContentType) : "text";
}

/** 後端 status(queued|open|closed) → 前端(open|waiting|closed) */
function toStatus(s: string): Session["status"] {
  if (s === "queued") return "waiting";
  if (s === "closed") return "closed";
  return "open";
}

/* ----------------------------- 訊息 ----------------------------- */

/** 後端 sender_type(human) → 前端(agent);note/system 等原樣 */
function toSenderType(t: string): Message["sender_type"] {
  if (t === "human") return "agent";
  if (t === "visitor" || t === "ai" || t === "system" || t === "note") return t;
  return "agent";
}

export function mapMessage(m: RawMessage, visitorName?: string): Message {
  const meta = (m.meta ?? {}) as Record<string, any>;
  const senderType = toSenderType(m.sender_type);
  const ai =
    m.sender_type === "ai" && (meta.confidence != null || meta.ai || meta.sources)
      ? {
          confidence: Number(meta.confidence ?? meta.ai?.confidence ?? 0),
          sources: Array.isArray(meta.sources ?? meta.ai?.sources)
            ? (meta.sources ?? meta.ai?.sources).map((s: any) => ({
                // 純資料轉接層拿不到 t();知識來源標題以中性英文回退,避免中文外洩到非中文語系
                title: s.title ?? s.source_ref?.title ?? s.source_ref?.question ?? "Source",
                ref: s.ref ?? s.source_ref?.document_id ?? s.source_ref?.qa_pair_id ?? "",
                score: Number(s.score ?? 0),
              }))
            : [],
        }
      : undefined;
  // 雙向翻譯:後端於 meta.i18n 帶原文/譯文/語言/方向
  const rawI18n = meta.i18n && typeof meta.i18n === "object" ? meta.i18n : null;
  const i18n = rawI18n
    ? {
        original: String(rawI18n.original ?? m.content),
        translated: String(rawI18n.translated ?? m.content),
        original_lang: String(rawI18n.original_lang ?? ""),
        translated_lang: String(rawI18n.translated_lang ?? ""),
        direction: rawI18n.direction === "outbound" ? "outbound" : "inbound",
      }
    : undefined;
  return {
    id: m.id,
    session_id: m.session_id,
    sender_type: senderType,
    // 純資料轉接層拿不到 t();AI 送訊者顯示名以語意穩定的中性英文回退,
    // 避免中文外洩到非中文語系(元件端如需在地化,可依 sender_type 自行覆寫顯示名)。
    sender_name:
      m.sender_type === "ai"
        ? "AI Assistant"
        : m.sender_type === "visitor"
          ? visitorName
          : undefined,
    content_type: toContentType(m.content_type),
    content: m.content,
    ts: m.created_at ?? new Date().toISOString(),
    flagged: meta.quality != null || meta.flagged === true ? true : undefined,
    ai,
    i18n: i18n as Message["i18n"],
    card: meta.card,
    cards: meta.cards,
  };
}

/**
 * 即時 WS 封包(message.new payload)→ 前端 Message。
 * payload 形狀:{session_id, message_id, sender_type, sender_id, content_type, content, meta}
 * 也相容 mock 產生的完整 Message。
 */
export function mapWsMessage(payload: any, ts?: string): Message {
  if (payload && payload.id && payload.ts) return payload as Message; // mock 已是完整 Message
  return mapMessage(
    {
      id: payload.message_id ?? payload.id ?? "",
      session_id: payload.session_id,
      sender_type: payload.sender_type,
      sender_id: payload.sender_id ?? null,
      content_type: payload.content_type ?? "text",
      content: payload.content ?? "",
      meta: payload.meta ?? null,
      created_at: ts ?? payload.created_at ?? new Date().toISOString(),
    },
    payload.sender_name,
  );
}

/* ----------------------------- 訪客 / 聯絡人 ----------------------------- */

/* ----------------------------- IAM 坐席管理 ----------------------------- */

export interface RawStaffRow {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  organization_id: string | null;
  status: string;
  is_active: boolean;
  created_at: string | null;
}

const AGENT_STATUS: AgentStatus[] = ["online", "busy", "away", "offline"];

export function toAgentStatus(s: string | undefined): AgentStatus {
  return (AGENT_STATUS as string[]).includes(s ?? "") ? (s as AgentStatus) : "offline";
}

export function mapStaffAdmin(
  s: RawStaffRow,
  roles: RoleLite[],
  skillGroups: { id: string; name: string }[],
): StaffAdmin {
  return {
    id: s.id,
    email: s.email,
    display_name: s.display_name,
    avatar_url: s.avatar_url ?? undefined,
    organization_id: s.organization_id ?? undefined,
    status: toAgentStatus(s.status),
    is_active: s.is_active,
    created_at: s.created_at ?? undefined,
    roles,
    skill_groups: skillGroups,
  };
}

/**
 * 後端 `attributes`(自由 key-value 物件)→ 前端 `custom`(Record<string,string>)。
 * @/types 的 `Visitor.custom` 型別固定為 Record<string,string>(不可改),故在此就地轉形狀:
 * 值一律轉字串、略過 null/undefined,物件/陣列以 JSON 字串呈現;全空則回 undefined(方便上游判斷是否顯示)。
 */
function attrsToCustom(
  attributes: Record<string, unknown> | null | undefined,
): Record<string, string> | undefined {
  if (!attributes || typeof attributes !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(attributes)) {
    if (val === null || val === undefined) continue;
    out[k] =
      typeof val === "string"
        ? val
        : typeof val === "object"
          ? JSON.stringify(val)
          : String(val);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 訪客 AI 畫像(Visitor.ai_profile)→ 前端可讀結構。
 * 後端 ai_profile 為扁平 dict(見 services/ai/profile.py):
 *   intent(意圖)/ sentiment(情緒:正面·中性·負面 或自由文字)/ tags(自動標籤)/
 *   summary(側寫)+ meta(source / generated_at / message_count)。
 * 前端型別固定(@/types 的 Visitor 無 ai_profile 欄位,不可改),故以擴充型別
 * VisitorWithProfile 承載;僅有 meta 而無實質內容時視為「尚無畫像」回 undefined。
 */
export interface VisitorAiProfile {
  intent?: string;
  /** 原始情緒詞(正面/中性/負面 或自由文字);由 ContextPanel 對映圖示 */
  sentiment?: string;
  tags: string[];
  summary?: string;
  /** 來源:ai_auto(AI 自動)或人工;供面板標示 */
  source?: string;
  generated_at?: string;
  /** 保留原始 dict,便於除錯 / 未來擴充 */
  raw: Record<string, unknown>;
}

/** 前端 Visitor 擴充:帶 ai_profile 與 is_blocked(型別固定的 Visitor 無此二欄位) */
export type VisitorWithProfile = Visitor & {
  ai_profile?: VisitorAiProfile;
  is_blocked?: boolean;
};

function mapAiProfile(
  aiProfile: Record<string, unknown> | null | undefined,
): VisitorAiProfile | undefined {
  if (!aiProfile || typeof aiProfile !== "object") return undefined;
  const p = aiProfile as Record<string, any>;
  const str = (val: unknown): string | undefined =>
    typeof val === "string" && val.trim() ? val.trim() : undefined;
  const tags = Array.isArray(p.tags)
    ? p.tags.filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  const intent = str(p.intent);
  const sentiment = str(p.sentiment);
  const summary = str(p.summary);
  // 全無實質內容(僅剩 source/generated_at 等 meta)→ 視為尚無畫像
  if (!intent && !sentiment && !summary && tags.length === 0) return undefined;
  return {
    intent,
    sentiment,
    tags,
    summary,
    source: str(p.source),
    generated_at: str(p.generated_at),
    raw: p,
  };
}

/** 聯絡人詳情端點(含關聯訪客與標籤 id)→ 前端 ContactDetail */
export function mapContactDetail(
  c: RawContact & {
    visitors?: RawVisitor[];
    tags?: string[];
  },
): ContactDetail {
  const attrs = (c.attributes ?? {}) as Record<string, any>;
  return {
    id: c.id,
    name: c.name ?? "Unnamed",
    email: c.email ?? undefined,
    phone: c.phone ?? undefined,
    company: attrs.company ?? attrs["公司"] ?? undefined,
    note: c.note ?? undefined,
    is_blocked: c.is_blocked,
    // 原樣帶回 attributes(自由 key-value),作為聯絡人檔案自訂欄位的可編輯來源。
    attributes: c.attributes ?? undefined,
    visitors: (c.visitors ?? []).map((v) => ({
      id: v.id,
      display_name: v.display_name ?? v.external_id ?? "Visitor",
      channel_id: v.channel_id,
      external_id: v.external_id ?? undefined,
      is_blocked: v.is_blocked,
    })),
    tags: c.tags ?? [],
  };
}

export function mapContact(c: RawContact): Contact {
  // Contact(清單 DTO)型別無泛用 custom 欄位,只從 attributes 萃取既有的 company / lifetime_value;
  // 完整自訂屬性由 mapContactDetail.attributes(可編輯來源)與 mapVisitor.custom(情境面板顯示)承載。
  const attrs = (c.attributes ?? {}) as Record<string, any>;
  return {
    id: c.id,
    name: c.name ?? "Unnamed",
    email: c.email ?? undefined,
    phone: c.phone ?? undefined,
    company: attrs.company ?? attrs["公司"] ?? undefined,
    note: c.note ?? undefined,
    lifetime_value: typeof attrs.lifetime_value === "number" ? attrs.lifetime_value : undefined,
  };
}

export function mapVisitor(v: RawVisitor, channelType?: ChannelType): VisitorWithProfile {
  const ai = (v.ai_profile ?? {}) as Record<string, any>;
  return {
    id: v.id,
    display_name: v.display_name ?? v.external_id ?? "Visitor",
    avatar_url: v.avatar_url ?? undefined,
    channel: channelType ?? "web",
    external_id: v.external_id ?? undefined,
    location: ai.location ?? undefined,
    os: ai.os ?? undefined,
    browser: ai.browser ?? undefined,
    first_seen: v.created_at ?? undefined,
    tags: v.tags ?? [],
    contact: v.contact ? mapContact(v.contact) : undefined,
    // 自訂欄位取自關聯 Contact 的 attributes(訪客本身無 attributes 欄位)。
    // 清單端點不帶 contact → custom 為 undefined;會話端點內嵌 contact → 顯示真實自訂屬性。
    custom: attrsToCustom(v.contact?.attributes),
    // AI 畫像(意圖/情緒/標籤/摘要)映射成前端可讀結構;無畫像則 undefined。
    ai_profile: mapAiProfile(v.ai_profile),
    // 此渠道身份封鎖狀態(供情境面板黑名單按鈕反映與切換)。
    is_blocked: v.is_blocked,
  };
}

/* ----------------------------- 會話 ----------------------------- */

export interface EnrichCtx {
  channelMap: Map<string, RawChannel>;
  visitorMap: Map<string, RawVisitor>;
  tab?: SessionTab;
}

export function mapSession(s: RawSession, ctx: EnrichCtx): Session {
  const rawCh = ctx.channelMap.get(s.channel_id);
  const chType = toChannelType(rawCh?.type);
  // 優先取會話端點內嵌的訪客(含 contact.attributes 與 ai_profile),
  // 無內嵌時回退到 visitorMap(清單快取)。
  const rawV = s.visitor ?? ctx.visitorMap.get(s.visitor_id);
  const visitor: VisitorWithProfile = rawV
    ? mapVisitor(rawV, chType)
    : {
        id: s.visitor_id,
        display_name: "Visitor",
        channel: chType,
        tags: [],
      };
  const status = toStatus(s.status);
  let waiting_seconds: number | undefined;
  if (status === "waiting") {
    const base = s.created_at ? Date.parse(s.created_at) : Date.now();
    waiting_seconds = Math.max(0, Math.floor((Date.now() - base) / 1000));
  }
  return {
    id: s.id,
    visitor,
    channel: chType,
    handler_type: toHandlerType(s.handler_type),
    assignee_id: s.handler_staff_id ?? undefined,
    assignee_name: undefined,
    tab: ctx.tab ?? "online",
    status,
    last_message_preview: "", // 後端 session 摘要未提供,見回報
    last_message_at: s.last_message_at ?? s.created_at ?? new Date().toISOString(),
    unread: 0, // 後端未提供未讀數,見回報
    waiting_seconds,
    tags: [],
    skill_group: s.skill_group_id ?? undefined,
    translate_enabled: s.translate_enabled ?? false,
    agent_lang: s.agent_lang ?? "zh-Hant",
    visitor_lang: s.visitor_lang ?? null,
  };
}

/* --------------------- 渠道 / 訪客 map(帶短快取)--------------------- */

let _chCache: { at: number; map: Map<string, RawChannel> } | null = null;
let _vCache: { at: number; map: Map<string, RawVisitor> } | null = null;
const TTL = 20_000;

export async function fetchChannelMap(force = false): Promise<Map<string, RawChannel>> {
  if (!force && _chCache && Date.now() - _chCache.at < TTL) return _chCache.map;
  const rows = await apiFetch<RawChannel[]>("/api/v1/channel");
  const map = new Map<string, RawChannel>();
  (rows ?? []).forEach((c) => map.set(c.id, c));
  _chCache = { at: Date.now(), map };
  return map;
}

export async function fetchVisitorMap(force = false): Promise<Map<string, RawVisitor>> {
  if (!force && _vCache && Date.now() - _vCache.at < TTL) return _vCache.map;
  const rows = await apiFetch<RawVisitor[]>("/api/v1/visitor/visitors", {
    params: { limit: 200 },
  });
  const map = new Map<string, RawVisitor>();
  (rows ?? []).forEach((v) => map.set(v.id, v));
  _vCache = { at: Date.now(), map };
  return map;
}

/* ----------------------------- 知識庫 ----------------------------- */

export function mapCollection(c: {
  id: string;
  name: string;
  source_type: string;
  created_at: string;
  doc_count?: number;
  hit_rate?: number;
}): KnowledgeCollection {
  const type =
    c.source_type === "qa" || c.source_type === "website" || c.source_type === "document"
      ? (c.source_type as KnowledgeCollection["type"])
      : "document";
  return {
    id: c.id,
    name: c.name,
    type,
    // 後端這波開始回 doc_count;hit_rate 可能為 0/null/缺欄位 → 一律容錯回退 0
    doc_count: typeof c.doc_count === "number" ? c.doc_count : 0,
    hit_rate: typeof c.hit_rate === "number" ? c.hit_rate : 0,
    updated_at: c.created_at,
  };
}

/** /knowledge/retrieve 命中 → KbHit */
export function mapHit(h: any, idx: number): KbHit {
  const ref = h.source_ref ?? {};
  return {
    id: ref.document_id ?? ref.qa_pair_id ?? `hit-${idx}`,
    title: ref.title ?? ref.question ?? "Knowledge snippet",
    snippet: h.content ?? "",
    collection: ref.collection_id ?? "",
    score: Number(h.score ?? 0),
  };
}

/** ai/suggest_reply 回應 → ReplySuggestion[](AI 建議 + 來源知識庫聯想) */
export function mapSuggestReply(r: {
  suggestion: string;
  confidence: number;
  sources?: any[];
}): ReplySuggestion[] {
  const out: ReplySuggestion[] = [];
  if (r.suggestion) {
    out.push({ id: "ai-0", kind: "ai", confidence: r.confidence, text: r.suggestion });
  }
  (r.sources ?? []).slice(0, 3).forEach((s, i) => {
    const ref = s.source_ref ?? {};
    out.push({
      id: `kb-${i}`,
      kind: "kb",
      source: ref.title ?? ref.question ?? "Knowledge base",
      text: (s.content ?? "").slice(0, 160),
    });
  });
  return out;
}

/** 渠道 config 中可安全展示的欄位 → Channel.meta */
export function mapChannel(c: RawChannel): Channel {
  const cfg = (c.config ?? {}) as Record<string, any>;
  const type = toChannelType(c.type);
  const meta: Record<string, string> = {};
  if (cfg.bot_username) meta["Bot"] = `@${cfg.bot_username}`;
  if (cfg.domain ?? cfg["網域"]) meta["網域"] = String(cfg.domain ?? cfg["網域"]);
  if (cfg.public_key) {
    // web 渠道的 public_key 是要嵌到自家網站的「公開嵌入金鑰」(channelKey),本就會出現在
    // 前端頁面原始碼,非機敏值,故對自己租戶的 web 渠道提供完整值,供渠道頁組出嵌入碼並複製;
    // 其他型別(若日後也帶 public_key)維持遮罩,其餘機敏欄位(bot_token 等)本就不進 meta。
    meta["public_key"] =
      type === "web" ? String(cfg.public_key) : String(cfg.public_key).slice(0, 10) + "…";
  }
  return {
    id: c.id,
    type,
    name: c.name,
    enabled: c.is_active,
    // 後端無「連線健康」狀態,以啟用與否近似,見回報
    status: c.is_active ? "connected" : "disconnected",
    meta: Object.keys(meta).length ? meta : undefined,
  };
}
