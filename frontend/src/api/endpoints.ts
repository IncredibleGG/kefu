/** 端點定義:對齊後端 {ok,data,error,request_id} 信封,實際資料在 data。
 *  單一 fetch 的端點用 call();需多請求或資料轉接的用 guarded() + adapters。
 *  mock 僅保留於後端確實沒有的端點(見各處註記與交付回報)。 */
import { apiFetch, call, guarded } from "./client";
import { mockApi } from "./mock";
import {
  fetchChannelMap,
  fetchVisitorMap,
  mapChannel,
  mapCollection,
  mapContact,
  mapContactDetail,
  mapHit,
  mapMessage,
  mapSession,
  mapStaffAdmin,
  mapSuggestReply,
  mapVisitor,
  type RawChannel,
  type RawContact,
  type RawMessage,
  type RawPaged,
  type RawSession,
  type RawStaffRow,
  type RawVisitor,
} from "./adapters";
import type {
  AiInsight,
  AutomationCatalog,
  AutomationRule,
  Canned,
  ChangePasswordResult,
  Channel,
  Contact,
  ContactDetail,
  EmailChannelConfig,
  EmailTestResult,
  FeaturesResponse,
  KbHit,
  KnowledgeCollection,
  Message,
  Paged,
  Permission,
  Plan,
  ProactiveRule,
  ReplySuggestion,
  Role,
  RoleLite,
  SearchResults,
  Session,
  SessionTab,
  SkillGroup,
  SkillGroupDetail,
  SlaBreach,
  SlaPolicy,
  Staff,
  StaffAdmin,
  StaffLite,
  Subscription,
  SubscriptionResponse,
  Tag,
  TenantLite,
  TenantSettings,
  Visitor,
  VisitorTimeline,
} from "@/types";

/* ================================ Auth ================================ */
export const authApi = {
  // 真 API:POST /api/v1/auth/login → { access_token, token_type, staff_id, is_platform_admin }
  login: (email: string, password: string) =>
    call<{ access_token: string; token_type: string; staff_id: string; is_platform_admin?: boolean }>({
      path: "/api/v1/auth/login",
      method: "POST",
      body: { email, password },
      auth: false,
      real: true,
      mock: () => mockApi.login(email),
    }),
  // 真 API:GET /api/v1/auth/me
  me: () =>
    call<Staff>({
      path: "/api/v1/auth/me",
      real: true,
      mock: () => mockApi.me(),
    }),
  // 真 API:POST /api/v1/auth/change-password(需登入;以 old_password 驗證後更新)
  changePassword: (old_password: string, new_password: string) =>
    call<ChangePasswordResult>({
      path: "/api/v1/auth/change-password",
      method: "POST",
      body: { old_password, new_password },
      real: true,
    }),
};

/* ============================ Conversation ============================ */
export const conversationApi = {
  /** 會話列表:tab / 渠道 / 狀態過濾 + 分頁;以渠道、訪客 map 充實成前端 Session。
   *  後端無 q 參數,故 q 於前端就地過濾(僅過濾當前分頁),見回報。 */
  listSessions: (tab: SessionTab, q?: string, page = 1, pageSize = 30, tagId?: string) =>
    guarded<Paged<Session>>(
      async () => {
        const [raw, channelMap, visitorMap] = await Promise.all([
          apiFetch<RawPaged<RawSession>>("/api/v1/conversation/sessions", {
            params: { tab, page, page_size: pageSize, tag_id: tagId },
          }),
          fetchChannelMap(),
          fetchVisitorMap(),
        ]);
        let items = (raw.items ?? []).map((s) => mapSession(s, { channelMap, visitorMap, tab }));
        if (q) {
          const kw = q.toLowerCase();
          items = items.filter(
            (s) =>
              s.visitor.display_name.toLowerCase().includes(kw) ||
              (s.visitor.external_id ?? "").toLowerCase().includes(kw),
          );
        }
        return {
          items,
          total: raw.total ?? items.length,
          page: raw.page ?? page,
          size: raw.page_size ?? raw.size ?? items.length,
        };
      },
      () => mockApi.listSessions(tab, q),
    ),
  // 供 hooks 傳入 tagId 用途保留(見 useSessions 覆寫 mock 分支)

  /** 單一會話詳情(含訪客 contact/tags 充實)。 */
  getSession: (id: string) =>
    guarded<Session | undefined>(
      async () => {
        const [data, channelMap] = await Promise.all([
          apiFetch<{ session: RawSession; messages: RawMessage[] }>(
            `/api/v1/conversation/sessions/${id}`,
          ),
          fetchChannelMap(),
        ]);
        // 取訪客詳情(含 contact + tags)
        let rawV: RawVisitor | undefined;
        try {
          rawV = await apiFetch<RawVisitor>(`/api/v1/visitor/visitors/${data.session.visitor_id}`);
        } catch {
          rawV = (await fetchVisitorMap()).get(data.session.visitor_id);
        }
        const visitorMap = new Map<string, RawVisitor>();
        if (rawV) visitorMap.set(rawV.id, rawV);
        return mapSession(data.session, { channelMap, visitorMap });
      },
      () => mockApi.getSession(id),
    ),

  /** 訊息歷史:後端置於會話詳情端點(無獨立 messages GET),取其 messages。 */
  listMessages: (sessionId: string, limit = 100) =>
    guarded<Message[]>(
      async () => {
        const [data, visitorMap] = await Promise.all([
          apiFetch<{ session: RawSession; messages: RawMessage[] }>(
            `/api/v1/conversation/sessions/${sessionId}`,
            { params: { limit } },
          ),
          fetchVisitorMap().catch(() => new Map<string, RawVisitor>()),
        ]);
        const vName = visitorMap.get(data.session.visitor_id)?.display_name ?? undefined;
        return (data.messages ?? []).map((m) => mapMessage(m, vName ?? undefined));
      },
      () => mockApi.listMessages(sessionId),
    ),

  /** 坐席送訊:sender_type=human,回傳映射後 Message。 */
  sendMessage: (
    sessionId: string,
    content: string,
    contentType: Message["content_type"] = "text",
  ) =>
    guarded<Message>(
      async () => {
        const m = await apiFetch<RawMessage>(
          `/api/v1/conversation/sessions/${sessionId}/messages`,
          { method: "POST", body: { content, content_type: contentType } },
        );
        return mapMessage(m);
      },
      () => mockApi.sendMessage(sessionId, content, contentType),
    ),

  /** 接管 / 轉接。takeover 忽略 handler_staff_id(指派給自己)。 */
  handoff: (
    sessionId: string,
    action: "takeover" | "transfer",
    opts: { handler_staff_id?: string; skill_group_id?: string } = {},
  ) =>
    call<RawSession>({
      path: `/api/v1/conversation/sessions/${sessionId}/handoff`,
      method: "POST",
      body: { action, ...opts },
      real: true,
      mock: async () => ({}) as RawSession,
    }),

  /** 結束會話。 */
  close: (sessionId: string) =>
    call<RawSession>({
      path: `/api/v1/conversation/sessions/${sessionId}/close`,
      method: "POST",
      real: true,
      mock: async () => ({}) as RawSession,
    }),

  /** 開關本會話的雙向翻譯(PATCH),回更新後的會話摘要。 */
  setTranslation: (
    sessionId: string,
    opts: { enabled: boolean; agent_lang?: string; visitor_lang?: string },
  ) =>
    call<RawSession>({
      path: `/api/v1/conversation/sessions/${sessionId}/translation`,
      method: "PATCH",
      body: opts,
      real: true,
      mock: async () => ({ translate_enabled: opts.enabled }) as RawSession,
    }),

  /** 坐席私密內部備註:POST notes,sender_type='note',僅坐席可見。回映射後 Message。 */
  addNote: (sessionId: string, content: string) =>
    call<Message>({
      path: `/api/v1/conversation/sessions/${sessionId}/notes`,
      method: "POST",
      body: { content },
      real: true,
      // client 端把 RawMessage 映射為前端 Message
    }).then((raw) => mapMessage(raw as unknown as RawMessage)),

  /** 會話層標籤:列出套用在該會話上的標籤(tag 詳情)。 */
  listSessionTags: (sessionId: string) =>
    call<Tag[]>({
      path: `/api/v1/conversation/sessions/${sessionId}/tags`,
      real: true,
      mock: async () => [],
    }),

  /** 對會話套用標籤(冪等)。回傳目前標籤 id 清單。 */
  applySessionTag: (sessionId: string, tagId: string) =>
    call<{ session_id: string; tags: string[] }>({
      path: `/api/v1/conversation/sessions/${sessionId}/tags`,
      method: "POST",
      body: { tag_id: tagId },
      real: true,
    }),

  /** 移除會話上的標籤(軟刪關聯;冪等)。 */
  removeSessionTag: (sessionId: string, tagId: string) =>
    call<{ session_id: string; tags: string[] }>({
      path: `/api/v1/conversation/sessions/${sessionId}/tags/${tagId}`,
      method: "DELETE",
      real: true,
    }),

  /** 轉接會話:指定坐席 / 技能組 / 轉回佇列(兩者皆空)。 */
  transfer: (
    sessionId: string,
    opts: { target_staff_id?: string; target_skill_group_id?: string; note?: string } = {},
  ) =>
    call<RawSession>({
      path: `/api/v1/conversation/sessions/${sessionId}/transfer`,
      method: "POST",
      body: opts,
      real: true,
    }),

  /** 訊息級質檢標旗。後端僅支援「加旗」(POST),無取消旗端點(見回報);
   *  故 flagged=false 時只做前端樂觀更新,不呼叫後端。 */
  flagMessage: (_sessionId: string, messageId: string, flagged: boolean) =>
    guarded<void>(
      async () => {
        if (flagged) {
          await apiFetch<unknown>(`/api/v1/quality/message/${messageId}/flag`, {
            method: "POST",
            body: { label: "flagged" },
          });
        }
      },
      () => mockApi.flagMessage(_sessionId, messageId, flagged),
    ),
};

/* ================================= AI ================================= */
export const aiApi = {
  /** 坐席 Copilot 建議:後端為單則 suggest_reply,轉成建議陣列(AI + 來源聯想)。 */
  suggestions: (sessionId: string) =>
    guarded<ReplySuggestion[]>(
      async () => {
        const r = await apiFetch<{ suggestion: string; confidence: number; sources?: any[] }>(
          "/api/v1/ai/suggest_reply",
          { method: "POST", body: { session_id: sessionId } },
        );
        return mapSuggestReply(r);
      },
      () => mockApi.suggestions(sessionId),
    ),
  // 洞察:真 API GET /ai/sessions/{id}/insight(由會話訊息即時推導);查無會話回 null → 顯示空狀態。
  insight: (sessionId: string) =>
    call<AiInsight | null>({
      path: `/api/v1/ai/sessions/${sessionId}/insight`,
      real: true,
    }),
  // AI Agent 設定(取 / upsert)
  getConfig: () =>
    call<Record<string, unknown> | null>({ path: "/api/v1/ai/config", real: true }),
  upsertConfig: (body: Record<string, unknown>) =>
    call<Record<string, unknown>>({
      path: "/api/v1/ai/config",
      method: "PUT",
      body,
      real: true,
    }),
  // 探測 LLM 可用模型
  models: () =>
    call<{ provider: string; base_url: string; models: string[]; default: string }>({
      path: "/api/v1/ai/models",
      real: true,
    }),
};

/* ============================= Knowledge ============================= */
export const knowledgeApi = {
  /** 情境面板 KB 命中:取該會話最後一則訪客訊息當 query,呼叫 /retrieve。 */
  hits: (sessionId: string) =>
    guarded<KbHit[]>(
      async () => {
        const msgs = await conversationApi.listMessages(sessionId, 50);
        const lastVisitor = [...msgs].reverse().find((m) => m.sender_type === "visitor");
        const query = lastVisitor?.content?.trim();
        if (!query) return [];
        const r = await apiFetch<{ query: string; hits: any[] }>("/api/v1/knowledge/retrieve", {
          method: "POST",
          body: { query, top_k: 5 },
        });
        return (r.hits ?? []).map(mapHit);
      },
      () => mockApi.kbHits(sessionId),
    ),
  collections: () =>
    guarded<KnowledgeCollection[]>(
      async () => {
        const rows = await apiFetch<
          {
            id: string;
            name: string;
            source_type: string;
            created_at: string;
            doc_count?: number;
            hit_rate?: number;
          }[]
        >("/api/v1/knowledge/collections");
        return (rows ?? []).map(mapCollection);
      },
      () => mockApi.collections(),
    ),
  createCollection: (name: string, source_type = "document") =>
    call({
      path: "/api/v1/knowledge/collections",
      method: "POST",
      body: { name, source_type },
      real: true,
    }),
  listDocuments: (collectionId: string) =>
    call({ path: `/api/v1/knowledge/collections/${collectionId}/documents`, real: true }),
  createDocument: (collectionId: string, content: string, title?: string) =>
    call({
      path: `/api/v1/knowledge/collections/${collectionId}/documents`,
      method: "POST",
      body: { content, title },
      real: true,
    }),
  uploadDocument: (collectionId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiFetch(`/api/v1/knowledge/collections/${collectionId}/documents/upload`, {
      method: "POST",
      body: form,
    });
  },
  listQa: (collectionId: string) =>
    call({ path: `/api/v1/knowledge/collections/${collectionId}/qa`, real: true }),
  createQa: (collectionId: string, question: string, answer: string) =>
    call({
      path: `/api/v1/knowledge/collections/${collectionId}/qa`,
      method: "POST",
      body: { question, answer },
      real: true,
    }),
  retrieve: (query: string, top_k = 5, collection_ids?: string[]) =>
    call({
      path: "/api/v1/knowledge/retrieve",
      method: "POST",
      body: { query, top_k, collection_ids },
      real: true,
    }),
};

/* ============================== Channel ============================== */
export const channelApi = {
  list: () =>
    guarded<Channel[]>(
      async () => {
        const rows = await apiFetch<RawChannel[]>("/api/v1/channel");
        return (rows ?? []).map(mapChannel);
      },
      () => mockApi.channels(),
    ),
  get: (id: string) => call<RawChannel>({ path: `/api/v1/channel/${id}`, real: true }),
  create: (type: string, name: string, config?: Record<string, unknown>) =>
    call({ path: "/api/v1/channel", method: "POST", body: { type, name, config }, real: true }),
  update: (id: string, body: Record<string, unknown>) =>
    call({ path: `/api/v1/channel/${id}`, method: "PATCH", body, real: true }),
  remove: (id: string) => call({ path: `/api/v1/channel/${id}`, method: "DELETE", real: true }),
  setTelegramToken: (id: string, bot_token: string) =>
    call({
      path: `/api/v1/channel/${id}/telegram/bot-token`,
      method: "PUT",
      body: { bot_token },
      real: true,
    }),
  setTelegramWebhook: (id: string, base_url: string, allow_groups?: boolean) =>
    call({
      path: `/api/v1/channel/${id}/telegram/webhook`,
      method: "POST",
      body: { base_url, allow_groups },
      real: true,
    }),

  /* --------------------------- Email 渠道 --------------------------- */
  /** 本租戶所有 email 型別渠道(含遮罩後 config,供表單預填)。 */
  listEmail: () =>
    call<RawChannel[]>({
      path: "/api/v1/channel",
      real: true,
      mock: async () => [],
    }).then((rows) => (rows ?? []).filter((c) => c.type === "email")),
  /** 建立 email 渠道(僅需名稱;IMAP/SMTP 之後以 email/config 設定)。 */
  createEmail: (name: string) =>
    call<RawChannel>({
      path: "/api/v1/channel",
      method: "POST",
      body: { type: "email", name },
      real: true,
    }),
  /** 存 IMAP/SMTP 設定(PUT);密碼欄留空沿用既有值(後端 _resolve_secret)。 */
  setEmailConfig: (id: string, body: EmailChannelConfig) =>
    call<RawChannel>({
      path: `/api/v1/channel/${id}/email/config`,
      method: "PUT",
      body,
      real: true,
    }),
  /** 測試 IMAP + SMTP 連線,回各自 ok/error。 */
  testEmail: (id: string) =>
    call<EmailTestResult>({
      path: `/api/v1/channel/${id}/email/test`,
      method: "POST",
      real: true,
    }),
};

/* ============================ Automation ============================ */
export const automationApi = {
  /** 規則建構器目錄:events / condition 欄位與運算子 / action 型別。 */
  catalog: () =>
    call<AutomationCatalog>({
      path: "/api/v1/automation/catalog",
      real: true,
      mock: async () => ({ events: [], condition_ops: [], condition_fields: [], action_types: [] }),
    }),
  /** 規則清單(依 priority 升冪)。攤平 {items,total} → 陣列。 */
  list: () =>
    call<{ items: AutomationRule[]; total: number }>({
      path: "/api/v1/automation/rules",
      params: { limit: 500 },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r.items ?? []),
  create: (body: {
    name: string;
    trigger_event: string;
    conditions: AutomationRule["conditions"];
    actions: AutomationRule["actions"];
    is_active: boolean;
    priority: number;
  }) => call<AutomationRule>({ path: "/api/v1/automation/rules", method: "POST", body, real: true }),
  update: (id: string, body: Partial<Omit<AutomationRule, "id" | "created_at" | "updated_at">>) =>
    call<AutomationRule>({ path: `/api/v1/automation/rules/${id}`, method: "PATCH", body, real: true }),
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/automation/rules/${id}`,
      method: "DELETE",
      real: true,
    }),
};

/* ============================ Proactive ============================ */
export const proactiveApi = {
  /** 主動式訊息規則清單。攤平 {items} → 陣列。 */
  list: () =>
    call<{ items: ProactiveRule[] }>({
      path: "/api/v1/proactive",
      params: { limit: 500 },
      real: true,
      mock: async () => ({ items: [] }),
    }).then((r) => r.items ?? []),
  create: (body: {
    name: string;
    trigger: ProactiveRule["trigger"];
    message: string;
    mode: ProactiveRule["mode"];
    frequency: ProactiveRule["frequency"];
    priority: number;
    is_active: boolean;
    channel_id?: string | null;
  }) => call<ProactiveRule>({ path: "/api/v1/proactive", method: "POST", body, real: true }),
  update: (id: string, body: Partial<Omit<ProactiveRule, "id" | "created_at" | "updated_at">>) =>
    call<ProactiveRule>({ path: `/api/v1/proactive/${id}`, method: "PATCH", body, real: true }),
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/proactive/${id}`,
      method: "DELETE",
      real: true,
    }),
};

/* ============================== SLA ============================== */
export const slaApi = {
  /** 政策清單(依 priority 降冪)。攤平 {items,total} → 陣列。 */
  listPolicies: () =>
    call<{ items: SlaPolicy[]; total: number }>({
      path: "/api/v1/sla/policies",
      params: { size: 100 },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r.items ?? []),
  createPolicy: (body: {
    name: string;
    conditions?: Record<string, unknown> | null;
    first_response_minutes: number;
    resolution_minutes: number;
    is_active: boolean;
    priority: number;
  }) => call<SlaPolicy>({ path: "/api/v1/sla/policies", method: "POST", body, real: true }),
  updatePolicy: (id: string, body: Partial<Omit<SlaPolicy, "id" | "created_at" | "updated_at">>) =>
    call<SlaPolicy>({ path: `/api/v1/sla/policies/${id}`, method: "PATCH", body, real: true }),
  deletePolicy: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/sla/policies/${id}`,
      method: "DELETE",
      real: true,
    }),
  /** 違約清單(分頁)。 */
  breaches: (page = 1, size = 50) =>
    call<{ items: SlaBreach[]; total: number; page: number; size: number }>({
      path: "/api/v1/sla/breaches",
      params: { page, size },
      real: true,
      mock: async () => ({ items: [], total: 0, page: 1, size }),
    }),
};

/* ========================== Visitor / CRM / Tag ========================== */
export const visitorApi = {
  list: (params: { q?: string; channel_id?: string; tag_id?: string; limit?: number } = {}) =>
    guarded<Visitor[]>(
      async () => {
        const [rows, channelMap] = await Promise.all([
          apiFetch<RawVisitor[]>("/api/v1/visitor/visitors", {
            params: { limit: params.limit ?? 100, q: params.q, channel_id: params.channel_id, tag_id: params.tag_id },
          }),
          fetchChannelMap().catch(() => new Map<string, RawChannel>()),
        ]);
        return (rows ?? []).map((v) => {
          const t = channelMap.get(v.channel_id)?.type as any;
          return mapVisitor(v, t);
        });
      },
      // 後端未起時以 mock 會話中的訪客當回退
      async () => {
        const paged = await mockApi.listSessions("online");
        return paged.items.map((s) => s.visitor);
      },
    ),
  get: (id: string) =>
    guarded<Visitor>(async () => {
      const [v, channelMap] = await Promise.all([
        apiFetch<RawVisitor>(`/api/v1/visitor/visitors/${id}`),
        fetchChannelMap().catch(() => new Map<string, RawChannel>()),
      ]);
      return mapVisitor(v, channelMap.get(v.channel_id)?.type as any);
    }),
  timeline: (id: string) =>
    call({ path: `/api/v1/visitor/visitors/${id}/timeline`, real: true }),
  block: (id: string) =>
    call({ path: `/api/v1/visitor/visitors/${id}/block`, method: "POST", real: true }),
  unblock: (id: string) =>
    call({ path: `/api/v1/visitor/visitors/${id}/unblock`, method: "POST", real: true }),
  // 聯絡人
  listContacts: (params: { q?: string; tag_id?: string; limit?: number } = {}) =>
    guarded<Contact[]>(async () => {
      const rows = await apiFetch<RawContact[]>("/api/v1/visitor/contacts", {
        params: { limit: params.limit ?? 100, q: params.q, tag_id: params.tag_id },
      });
      return (rows ?? []).map(mapContact);
    }),
  updateContact: (id: string, body: Record<string, unknown>) =>
    call({ path: `/api/v1/visitor/contacts/${id}`, method: "PATCH", body, real: true }),
  /** 聯絡人 CRM 檔案(含關聯訪客與標籤 id)。 */
  getContact: (id: string) =>
    guarded<ContactDetail>(async () => {
      const raw = await apiFetch<RawContact & { visitors?: RawVisitor[]; tags?: string[] }>(
        `/api/v1/visitor/contacts/${id}`,
      );
      return mapContactDetail(raw);
    }),
  createContact: (body: {
    name?: string;
    email?: string;
    phone?: string;
    note?: string;
    attributes?: Record<string, unknown>;
  }) => call<RawContact>({ path: "/api/v1/visitor/contacts", method: "POST", body, real: true }),
  blockContact: (id: string) =>
    call({ path: `/api/v1/visitor/contacts/${id}/block`, method: "POST", real: true }),
  unblockContact: (id: string) =>
    call({ path: `/api/v1/visitor/contacts/${id}/unblock`, method: "POST", real: true }),
  /** 訪客軌跡(typed):來源渠道 + 近期會話。 */
  getTimeline: (id: string) =>
    call<VisitorTimeline>({ path: `/api/v1/visitor/visitors/${id}/timeline`, real: true }),
  // 標籤
  listTags: (category?: string) =>
    call<{ id: string; name: string; color: string | null; category: string | null }[]>({
      path: "/api/v1/visitor/tags",
      params: { category },
      real: true,
    }),
  createTag: (name: string, color?: string, category?: string) =>
    call({ path: "/api/v1/visitor/tags", method: "POST", body: { name, color, category }, real: true }),
  applyTag: (tagId: string, target_type: string, target_id: string) =>
    call({
      path: `/api/v1/visitor/tags/${tagId}/apply`,
      method: "POST",
      body: { target_type, target_id },
      real: true,
    }),
  removeTag: (tagId: string, target_type: string, target_id: string) =>
    call({
      path: `/api/v1/visitor/tags/${tagId}/remove`,
      method: "POST",
      body: { target_type, target_id },
      real: true,
    }),
};

/* ============================== Routing ============================== */
export const routingApi = {
  queue: (skill_group_id?: string) =>
    call({ path: "/api/v1/routing/queue", params: { skill_group_id }, real: true }),
  agentLoads: (skill_group_id?: string) =>
    call({ path: "/api/v1/routing/agents/load", params: { skill_group_id }, real: true }),
  autoAssign: (sessionId: string) =>
    call({ path: `/api/v1/routing/sessions/${sessionId}/assign`, method: "POST", real: true }),
  assignTo: (sessionId: string, staffId: string) =>
    call({
      path: `/api/v1/routing/sessions/${sessionId}/assign/${staffId}`,
      method: "POST",
      real: true,
    }),
  claim: (sessionId: string) =>
    call({ path: `/api/v1/routing/sessions/${sessionId}/claim`, method: "POST", real: true }),
  listPolicies: () => call({ path: "/api/v1/routing/policies", real: true }),
};

/* =============================== Ticket =============================== */
export const ticketApi = {
  list: (params: Record<string, string | number | undefined> = {}) =>
    call({ path: "/api/v1/ticket", params, real: true }),
  get: (id: string) => call({ path: `/api/v1/ticket/${id}`, real: true }),
  create: (body: Record<string, unknown>) =>
    call({ path: "/api/v1/ticket", method: "POST", body, real: true }),
  fromSession: (sessionId: string, body: Record<string, unknown> = {}) =>
    call({ path: `/api/v1/ticket/from-session/${sessionId}`, method: "POST", body, real: true }),
  update: (id: string, body: Record<string, unknown>) =>
    call({ path: `/api/v1/ticket/${id}`, method: "PATCH", body, real: true }),
  assign: (id: string, assignee_staff_id: string | null) =>
    call({ path: `/api/v1/ticket/${id}/assign`, method: "POST", body: { assignee_staff_id }, real: true }),
  setStatus: (id: string, status: string) =>
    call({ path: `/api/v1/ticket/${id}/status`, method: "POST", body: { status }, real: true }),
  remove: (id: string) => call({ path: `/api/v1/ticket/${id}`, method: "DELETE", real: true }),
  // 內部備註串
  listNotes: (id: string) => call({ path: `/api/v1/ticket/${id}/notes`, real: true }),
  addNote: (id: string, body: string) =>
    call({ path: `/api/v1/ticket/${id}/notes`, method: "POST", body: { body }, real: true }),
  // 到期日延後(until=null 取消延後)
  snooze: (id: string, until: string | null) =>
    call({ path: `/api/v1/ticket/${id}/snooze`, method: "POST", body: { until }, real: true }),
  // 合併:把 id 併入 into_ticket_id
  merge: (id: string, into_ticket_id: string) =>
    call({ path: `/api/v1/ticket/${id}/merge`, method: "POST", body: { into_ticket_id }, real: true }),
};

/* ============================== Quality ============================== */
export const qualityApi = {
  createServiceSummary: (sessionId: string, category?: string, note?: string) =>
    call({
      path: "/api/v1/quality/service-summary",
      method: "POST",
      body: { session_id: sessionId, category, note },
      real: true,
      mock: async () => ({}),
    }),
  listServiceSummaries: (sessionId?: string) =>
    call({ path: "/api/v1/quality/service-summary", params: { session_id: sessionId }, real: true }),
  // CSAT 為訪客端(無 JWT)提交,坐席端一般不呼叫;此處供監控/列表
  listCsat: (sessionId?: string) =>
    call({ path: "/api/v1/quality/csat", params: { session_id: sessionId }, real: true }),
  submitCsat: (sessionId: string, rating: number, comment?: string) =>
    call({
      path: "/api/v1/quality/csat",
      method: "POST",
      body: { session_id: sessionId, rating, comment },
      auth: false,
      real: true,
    }),
  flagMessage: (messageId: string, label?: string, note?: string, score?: number) =>
    call({
      path: `/api/v1/quality/message/${messageId}/flag`,
      method: "POST",
      body: { label, note, score },
      real: true,
    }),
  listQualityRecords: (params: Record<string, string | number | boolean | undefined> = {}) =>
    call({ path: "/api/v1/quality/quality-record", params, real: true }),
  agentMonitor: (staffId: string) =>
    call({ path: `/api/v1/quality/agent-monitor/${staffId}`, real: true }),
};

/* ============================== Reporting ============================== */
/** 總覽 KPI 項:回穩定 key 與已格式化數值,顯示 label 一律由前端
 *  t("reports.overview.kpi.<key>") 在地化(見 OverviewReportTab 與
 *  locales/_pending/overview2.json),資料層不再內嵌中文。 */
export interface OverviewKpi {
  /** 穩定 KPI 識別:total_sessions | ai_resolution | avg_wait | csat */
  key: string;
  /** 已格式化好的顯示值(如 "312" / "63%" / "42s" / "—") */
  value: string;
  /** 環比變化百分比(正負;顯示文案由前端組) */
  delta: number;
}

/** reportApi.overview 回傳:欄位皆為穩定識別(series.count/ai_resolved/satisfaction、
 *  channelBreakdown.channelType、agentPerf.handled/satisfaction、kpi.key),移除內嵌中文
 *  顯示字串,顯示名由 OverviewReportTab 以 t("reports.overview.*") 在地化,不破壞數據語意
 *  (對齊已修好的 reportApi.dashboard 範式)。滿意度可能為 null(當日/該坐席無 CSAT
 *  回應),圖表以斷點呈現而非以 0 誤導。 */
interface ReportOverview {
  series: { date: string; count: number; ai_resolved: number; satisfaction: number | null }[];
  channelBreakdown: { channelType: string; value: number }[];
  // name 為坐席顯示名(資料值);未知(後端無 display_name)回 null 作為穩定標記,由元件以 t() 在地化
  agentPerf: { name: string | null; handled: number; satisfaction: number | null }[];
  kpi: OverviewKpi[];
}

/** 後端 /reporting/overview 回傳型別(單一聚合端點)。 */
interface RawReportKpi {
  value: number | null;
  prev: number | null;
  delta_pct: number | null;
}
interface RawReportOverview {
  period: { start: string; end: string };
  kpi: {
    conversations: RawReportKpi;
    ai_resolution_rate: RawReportKpi;
    avg_wait_seconds: RawReportKpi;
    csat: RawReportKpi & { responses: number };
  };
  series: { day: string; conversations: number; ai_resolved: number; csat: number | null }[];
  channel_breakdown: { type: string; count: number }[];
  agent_performance: {
    staff_id: string | null;
    display_name: string | null;
    reception: number;
    csat: number | null;
  }[];
}

/** 儀表板 KPI 項:回穩定 key 與插值參數,顯示字串一律由前端 t("dashboard.*") 在地化
 *  (見 DashboardPage 與 locales/_pending/dashi18n.json),資料層不再內嵌中文。 */
export interface DashboardKpi {
  /** 穩定 KPI 識別:sessions_today | online_agents | queue_wait | csat */
  key: string;
  value: string;
  /** 穩定 hint 識別:cumulative | of_total | avg_wait | no_wait_data | responses */
  hintKey?: string;
  /** 對應 hint 的插值變數(如 {{total}} / {{seconds}} / {{count}}) */
  hintParams?: Record<string, string | number>;
}

/** reportApi.dashboard 回傳:欄位皆為穩定識別(volumeSeries.count / agentPerf.handled /
 *  statusBreakdown.statusKey),移除中文顯示字串,顯示名由前端在地化,不破壞數據語意。 */
export interface DashboardResult {
  kpi: DashboardKpi[];
  volumeSeries: { date: string; count: number }[];
  statusBreakdown: { statusKey: string; value: number }[];
  agentPerf: { name: string; handled: number }[];
}

export const reportApi = {
  /** 儀表板總覽:後端單一聚合端點 /reporting/overview,一次取得逐日趨勢 / 渠道分布 /
   *  坐席績效(含滿意度)/ KPI 環比,前端僅做形狀映射與本地化。 */
  overview: () =>
    guarded<ReportOverview>(
      async () => {
        const r = await apiFetch<RawReportOverview>("/api/v1/reporting/overview");

        // 圖表資料欄位用穩定英文名(count/ai_resolved/satisfaction);系列顯示名由
        // OverviewReportTab 以 recharts 的 name={t(...)} 提供,不內嵌中文。
        const series = (r.series ?? []).map((d) => {
          const dt = new Date(d.day);
          return {
            date: `${dt.getMonth() + 1}/${dt.getDate()}`,
            count: d.conversations,
            ai_resolved: d.ai_resolved,
            satisfaction: d.csat, // CSAT 平均百分比;當日無回應為 null
          };
        });

        // 渠道分類回穩定 channelType(web/telegram/…;空值回 other),顯示名由元件 t() 在地化
        const channelBreakdown = (r.channel_breakdown ?? []).map((c) => ({
          channelType: c.type || "other",
          value: c.count,
        }));

        const agentPerf = (r.agent_performance ?? []).map((a) => ({
          // 坐席顯示名為資料值;未知(後端無 display_name)回 null 作穩定標記,由元件以 t() 在地化
          name: a.display_name,
          handled: a.reception,
          satisfaction: a.csat, // 該坐席經手會話的 CSAT 平均百分比;無回應為 null
        }));

        const { conversations, ai_resolution_rate, avg_wait_seconds, csat } = r.kpi;
        const pctText = (v: number | null) => (v != null ? `${Math.round(v)}%` : "—");
        const kpi: OverviewKpi[] = [
          {
            key: "total_sessions",
            value: String(conversations.value ?? 0),
            delta: conversations.delta_pct ?? 0,
          },
          {
            key: "ai_resolution",
            value: pctText(ai_resolution_rate.value),
            delta: ai_resolution_rate.delta_pct ?? 0,
          },
          {
            key: "avg_wait",
            value: avg_wait_seconds.value != null ? `${Math.round(avg_wait_seconds.value)}s` : "—",
            delta: avg_wait_seconds.delta_pct ?? 0,
          },
          { key: "csat", value: pctText(csat.value), delta: csat.delta_pct ?? 0 },
        ];

        return { series, channelBreakdown, agentPerf, kpi };
      },
      // 後端不可用時的回退:回型別安全的空聚合(對齊 reportApi.dashboard 的空回退),
      // 由 OverviewReportTab 的空狀態承接,避免舊 mock 的中文欄位形狀外洩。
      async () => ({ series: [], channelBreakdown: [], agentPerf: [], kpi: [] }),
    ),

  /** Admin Console 總覽儀表板:彙整會話量 / 佇列 / 滿意度 / 坐席績效 + 在線坐席數。 */
  dashboard: () =>
    guarded<DashboardResult>(async () => {
      const [volume, perf, wait, csat, staff] = await Promise.all([
        apiFetch<{
          total: number;
          by_status: Record<string, number>;
          daily: { day: string; count: number }[];
        }>("/api/v1/reporting/conversations/volume").catch(() => ({
          total: 0,
          by_status: {} as Record<string, number>,
          daily: [] as { day: string; count: number }[],
        })),
        apiFetch<{ agents: { display_name: string | null; reception: number }[] }>(
          "/api/v1/reporting/agents/performance",
        ).catch(() => ({ agents: [] as { display_name: string | null; reception: number }[] })),
        apiFetch<{ currently_queued: number; avg_wait_seconds: number | null }>(
          "/api/v1/reporting/queue/wait-times",
        ).catch(() => ({ currently_queued: 0, avg_wait_seconds: null })),
        apiFetch<{ responses: number; avg_score: number | null }>(
          "/api/v1/reporting/satisfaction",
        ).catch(() => ({ responses: 0, avg_score: null })),
        iamApi.staffAdminList().catch(() => [] as StaffAdmin[]),
      ]);

      const volumeSeries = (volume.daily ?? []).map((d) => {
        const dt = new Date(d.day);
        // 圖表欄位用穩定英文名 count;系列顯示名由 DashboardPage 以 t("dashboard.chart.volume") 提供
        return { date: `${dt.getMonth() + 1}/${dt.getDate()}`, count: d.count };
      });

      // 今日會話量(比對 daily 中今天那筆;無則 0)
      const today = new Date();
      const todayCount = (volume.daily ?? []).find((d) => {
        const dt = new Date(d.day);
        return (
          dt.getFullYear() === today.getFullYear() &&
          dt.getMonth() === today.getMonth() &&
          dt.getDate() === today.getDate()
        );
      })?.count;

      const onlineAgents = staff.filter(
        (s) => s.is_active && (s.status === "online" || s.status === "busy"),
      ).length;

      // 狀態分布:回穩定 statusKey(open/queued/closed 或原始鍵),顯示名由前端 t() 在地化
      const statusBreakdown = Object.entries(volume.by_status ?? {}).map(([k, v]) => ({
        statusKey: k,
        value: v,
      }));

      const agentPerf = (perf.agents ?? [])
        // name 為坐席顯示名(資料值);無顯示名者以中性英文回退,避免中文外洩到非中文儀表板
        .map((a) => ({ name: a.display_name ?? "Unknown", handled: a.reception }))
        .sort((a, b) => b.handled - a.handled)
        .slice(0, 8);

      const csatPct = csat.avg_score != null ? Math.round((csat.avg_score / 5) * 100) : null;

      const kpi: DashboardKpi[] = [
        {
          key: "sessions_today",
          value: String(todayCount ?? 0),
          hintKey: "cumulative",
          hintParams: { total: volume.total ?? 0 },
        },
        {
          key: "online_agents",
          value: String(onlineAgents),
          hintKey: "of_total",
          hintParams: { total: staff.length },
        },
        {
          key: "queue_wait",
          value: String(wait.currently_queued ?? 0),
          hintKey: wait.avg_wait_seconds != null ? "avg_wait" : "no_wait_data",
          hintParams:
            wait.avg_wait_seconds != null
              ? { seconds: Math.round(wait.avg_wait_seconds) }
              : undefined,
        },
        {
          key: "csat",
          value: csatPct != null ? `${csatPct}%` : "—",
          hintKey: "responses",
          hintParams: { count: csat.responses ?? 0 },
        },
      ];

      return { kpi, volumeSeries, statusBreakdown, agentPerf };
    }, async () => ({ kpi: [], volumeSeries: [], statusBreakdown: [], agentPerf: [] })),
};

/* ============================== Billing ============================== */
export const billingApi = {
  plans: (include_inactive = false) =>
    call({ path: "/api/v1/billing/plans", params: { include_inactive }, real: true }),
  subscription: () => call({ path: "/api/v1/billing/subscription", real: true }),
  usage: () => call({ path: "/api/v1/billing/usage", real: true }),
  invoice: () => call({ path: "/api/v1/billing/invoice/summary", real: true }),
  /** 方案列表(typed;後端回 {plans:[...]},此處攤平為陣列)。 */
  listPlans: (include_inactive = false) =>
    call<{ plans: Plan[] }>({
      path: "/api/v1/billing/plans",
      params: { include_inactive },
      real: true,
      mock: async () => ({ plans: [] }),
    }).then((r) => r.plans ?? []),
  /** 目前訂閱 + 生效功能(typed)。 */
  getSubscription: () =>
    call<SubscriptionResponse>({
      path: "/api/v1/billing/subscription",
      real: true,
      mock: async () => ({ subscription: null, plan: null, features: {} }),
    }),
  /** 生效功能字典 + 功能目錄(catalog),供前端渲染鎖/升級提示。 */
  features: () =>
    call<FeaturesResponse>({
      path: "/api/v1/billing/features",
      real: true,
      mock: async () => ({ tenant_id: "", features: {}, catalog: {} }),
    }),
  /** 切換 / 訂閱方案(admin;body {plan_id})。 */
  changePlan: (plan_id: string) =>
    call<Subscription>({
      path: "/api/v1/billing/subscription",
      method: "POST",
      body: { plan_id },
      real: true,
    }),
};

/* ============================== Canned ============================== */
export const cannedApi = {
  /** 罐頭 / 快捷回覆清單。shortcut_prefix 供 `/` 觸發即時前綴查詢。 */
  list: (opts: { shortcut_prefix?: string; q?: string; scope?: "all" | "shared" | "mine" } = {}) =>
    call<Canned[]>({
      path: "/api/v1/canned",
      params: { shortcut_prefix: opts.shortcut_prefix, q: opts.q, scope: opts.scope ?? "all" },
      real: true,
      mock: async () => [],
    }).then((r) => ((r as unknown as { items?: Canned[] }).items ?? (r as Canned[]))),
  /** 建立罐頭(POST {title,shortcut,content,skill_group_id?,shared})。 */
  create: (body: {
    title: string;
    shortcut: string;
    content: string;
    skill_group_id?: string | null;
    shared: boolean;
  }) => call<Canned>({ path: "/api/v1/canned", method: "POST", body, real: true }),
  /** 更新罐頭(PATCH 部分欄位)。 */
  update: (
    id: string,
    body: Partial<{ title: string; shortcut: string; content: string; skill_group_id: string | null }>,
  ) => call<Canned>({ path: `/api/v1/canned/${id}`, method: "PATCH", body, real: true }),
  /** 刪除罐頭(軟刪)。 */
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/canned/${id}`,
      method: "DELETE",
      real: true,
    }),
};

/* ============================== Settings ============================== */
export const settingsApi = {
  /** 取本租戶客服設定(admin;無則回預設)。 */
  get: () =>
    call<TenantSettings>({
      path: "/api/v1/settings",
      real: true,
      mock: async () => ({
        business_hours: null,
        offline_message: null,
        prechat_enabled: false,
        prechat_fields: null,
        widget_theme: null,
        timezone: null,
      }),
    }),
  /** 建立/更新設定(PUT upsert;傳入欄位整段覆寫)。 */
  update: (body: Partial<TenantSettings>) =>
    call<TenantSettings>({ path: "/api/v1/settings", method: "PUT", body, real: true }),
};

/* ============================== Tenancy ============================== */
export const tenancyApi = {
  /** 取目前登入者所屬租戶(含 llm_config;巢狀 translation 不被遮罩)。 */
  me: () =>
    call<TenantLite>({
      path: "/api/v1/tenancy/tenants/me",
      real: true,
      mock: async () => ({ id: "", name: "", slug: "", branding: null, llm_config: null, is_active: true }),
    }),
  /** 更新租戶(admin;llm_config 整段覆寫,呼叫端需先 read-merge)。 */
  update: (
    id: string,
    body: { llm_config?: Record<string, unknown>; branding?: Record<string, unknown>; name?: string },
  ) => call<TenantLite>({ path: `/api/v1/tenancy/tenants/${id}`, method: "PATCH", body, real: true }),
};

/* ================================ IAM ================================ */
export const iamApi = {
  /** 坐席清單(供轉接選擇)。 */
  staff: (q?: string) =>
    call<StaffLite[]>({
      path: "/api/v1/iam/staff",
      params: { q, size: 100 },
      real: true,
      mock: async () => [],
    }).then((r) => ((r as unknown as { items?: StaffLite[] }).items ?? (r as StaffLite[]))),
  /** 技能組清單(供轉接選擇)。 */
  skillGroups: () =>
    call<SkillGroup[]>({
      path: "/api/v1/iam/skill-groups",
      real: true,
      mock: async () => [],
    }).then((r) => ((r as unknown as { items?: SkillGroup[] }).items ?? (r as SkillGroup[]))),

  /* ------------------------- 坐席管理(admin) ------------------------- */
  /** 充實後的坐席管理列:list + 逐筆角色 + 各技能組成員 map。
   *  後端 list 不含角色/技能組,故以 N 筆詳情 + 各技能組成員清單就地充實(admin 團隊規模小)。 */
  staffAdminList: () =>
    guarded<StaffAdmin[]>(async () => {
      const [staffRes, groups] = await Promise.all([
        apiFetch<{ items: RawStaffRow[] }>("/api/v1/iam/staff", { params: { size: 100 } }),
        iamApi.skillGroups(),
      ]);
      const items = staffRes.items ?? [];
      const [details, groupDetails] = await Promise.all([
        Promise.all(
          items.map((s) =>
            apiFetch<RawStaffRow & { roles?: RoleLite[] }>(`/api/v1/iam/staff/${s.id}`),
          ),
        ),
        Promise.all(
          groups.map((g) =>
            apiFetch<{ id: string; name: string; members?: { id: string }[] }>(
              `/api/v1/iam/skill-groups/${g.id}`,
            ),
          ),
        ),
      ]);
      const rolesById = new Map(details.map((d) => [d.id, d.roles ?? []]));
      const sgByStaff = new Map<string, { id: string; name: string }[]>();
      groupDetails.forEach((gd) =>
        (gd.members ?? []).forEach((m) => {
          const arr = sgByStaff.get(m.id) ?? [];
          arr.push({ id: gd.id, name: gd.name });
          sgByStaff.set(m.id, arr);
        }),
      );
      return items.map((s) =>
        mapStaffAdmin(s, rolesById.get(s.id) ?? [], sgByStaff.get(s.id) ?? []),
      );
    }, async () => []),

  createStaff: (body: {
    email: string;
    password: string;
    display_name: string;
    role_ids?: string[];
  }) => call<StaffAdmin>({ path: "/api/v1/iam/staff", method: "POST", body, real: true }),

  updateStaff: (
    id: string,
    body: Partial<{ display_name: string; avatar_url: string | null; is_active: boolean }>,
  ) => call<StaffAdmin>({ path: `/api/v1/iam/staff/${id}`, method: "PATCH", body, real: true }),

  deleteStaff: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/iam/staff/${id}`,
      method: "DELETE",
      real: true,
    }),

  setStaffRoles: (id: string, role_ids: string[]) =>
    call<{ id: string; roles: RoleLite[] }>({
      path: `/api/v1/iam/staff/${id}/roles`,
      method: "PUT",
      body: { role_ids },
      real: true,
    }),

  setStaffPassword: (id: string, new_password: string) =>
    call<{ id: string; password_changed: boolean }>({
      path: `/api/v1/iam/staff/${id}/password`,
      method: "POST",
      body: { new_password },
      real: true,
    }),

  setStaffStatus: (id: string, status: string) =>
    call<{ id: string; status: string }>({
      path: `/api/v1/iam/staff/${id}/status`,
      method: "PATCH",
      body: { status },
      real: true,
    }),

  /* ------------------------------ 角色 / RBAC ------------------------------ */
  listRoles: () =>
    call<{ items: Role[] }>({
      path: "/api/v1/iam/roles",
      real: true,
      mock: async () => ({ items: [] }),
    }).then((r) => (r as unknown as { items?: Role[] }).items ?? (r as unknown as Role[])),

  getRole: (id: string) => call<Role>({ path: `/api/v1/iam/roles/${id}`, real: true }),

  createRole: (body: { name: string; description?: string | null; permission_codes?: string[] }) =>
    call<Role>({ path: "/api/v1/iam/roles", method: "POST", body, real: true }),

  updateRole: (id: string, body: Partial<{ name: string; description: string | null }>) =>
    call<Role>({ path: `/api/v1/iam/roles/${id}`, method: "PATCH", body, real: true }),

  deleteRole: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/iam/roles/${id}`,
      method: "DELETE",
      real: true,
    }),

  setRolePermissions: (id: string, codes: string[]) =>
    call<{ id: string; permissions: string[] }>({
      path: `/api/v1/iam/roles/${id}/permissions`,
      method: "PUT",
      body: { codes },
      real: true,
    }),

  listPermissions: () =>
    call<{ items: Permission[] }>({
      path: "/api/v1/iam/permissions",
      real: true,
      mock: async () => ({ items: [] }),
    }).then(
      (r) => (r as unknown as { items?: Permission[] }).items ?? (r as unknown as Permission[]),
    ),

  /* ------------------------------ 技能組管理 ------------------------------ */
  getSkillGroup: (id: string) =>
    call<SkillGroupDetail>({ path: `/api/v1/iam/skill-groups/${id}`, real: true }),

  createSkillGroup: (body: { name: string; description?: string | null }) =>
    call<SkillGroup>({ path: "/api/v1/iam/skill-groups", method: "POST", body, real: true }),

  updateSkillGroup: (id: string, body: Partial<{ name: string; description: string | null }>) =>
    call<SkillGroup>({ path: `/api/v1/iam/skill-groups/${id}`, method: "PATCH", body, real: true }),

  deleteSkillGroup: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/iam/skill-groups/${id}`,
      method: "DELETE",
      real: true,
    }),

  addSkillGroupMembers: (id: string, staff_ids: string[]) =>
    call<SkillGroupDetail>({
      path: `/api/v1/iam/skill-groups/${id}/members`,
      method: "POST",
      body: { staff_ids },
      real: true,
    }),

  removeSkillGroupMember: (id: string, staffId: string) =>
    call<SkillGroupDetail>({
      path: `/api/v1/iam/skill-groups/${id}/members/${staffId}`,
      method: "DELETE",
      real: true,
    }),
};

/* =============================== Search =============================== */
export const searchApi = {
  /** 全域搜尋:訊息 / 會話 / 聯絡人。空白 q 回空結果。 */
  query: (q: string, type: "all" | "sessions" | "messages" | "contacts" = "all", page = 1, size = 20) =>
    call<SearchResults>({
      path: "/api/v1/search",
      params: { q, type, page, size },
      real: true,
      mock: async () => ({ sessions: [], messages: [], contacts: [] }),
    }),
};

/* ============ 進階平台:Meta 渠道 / Webhook / API Key / Help Center 發布 ============
 * 全部走 {ok,data,error} 信封;沿用 call()/apiFetch()。新型別於檔尾追加匯入,
 * RawChannel / apiFetch / call 已於檔首匯入,直接沿用不重複匯入。 */
import type {
  ApiKeyRow,
  FacebookConfigInput,
  PublishCollection,
  PublishResult,
  WebhookEndpoint,
  WhatsAppConfigInput,
} from "@/types";

/** WhatsApp / Facebook(Meta)渠道:列出、建立、存設定。與既有 channelApi 分離以維持追加式擴充。 */
export const metaChannelApi = {
  /** 本租戶所有 whatsapp / facebook 渠道(含遮罩後 config;webhook 需用的 public_key 不被遮罩)。 */
  list: () =>
    call<RawChannel[]>({
      path: "/api/v1/channel",
      real: true,
      mock: async () => [],
    }).then((rows) => (rows ?? []).filter((c) => c.type === "whatsapp" || c.type === "facebook")),
  /** 建立 whatsapp / facebook 渠道(僅需名稱;設定另存)。回 RawChannel(含 config.public_key)。 */
  create: (type: "whatsapp" | "facebook", name: string) =>
    call<RawChannel>({
      path: "/api/v1/channel",
      method: "POST",
      body: { type, name },
      real: true,
    }),
  /** 存 WhatsApp 設定(PUT);敏感欄位(access_token/verify_token/app_secret)留空沿用既有。 */
  setWhatsappConfig: (id: string, body: WhatsAppConfigInput) =>
    call<RawChannel>({
      path: `/api/v1/channel/${id}/whatsapp/config`,
      method: "PUT",
      body,
      real: true,
    }),
  /** 存 Facebook Messenger 設定(PUT);敏感欄位處理同 WhatsApp。 */
  setFacebookConfig: (id: string, body: FacebookConfigInput) =>
    call<RawChannel>({
      path: `/api/v1/channel/${id}/facebook/config`,
      method: "PUT",
      body,
      real: true,
    }),
};

/** 對外 Webhook 端點管理(需 webhook.manage / admin)。 */
export const webhookApi = {
  /** 可訂閱事件名清單。 */
  events: () =>
    call<{ events: string[] }>({
      path: "/api/v1/webhooks/events",
      real: true,
      mock: async () => ({ events: [] }),
    }).then((r) => r.events ?? []),
  /** 端點清單(secret 遮罩)。攤平 {items} → 陣列。 */
  list: () =>
    call<{ items: WebhookEndpoint[]; total: number }>({
      path: "/api/v1/webhooks/endpoints",
      params: { limit: 500 },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r.items ?? []),
  /** 建立端點(未帶 secret 後端自動產生;回應含一次明文 secret)。 */
  create: (body: {
    url: string;
    events: string[];
    secret?: string;
    description?: string;
    is_active: boolean;
  }) => call<WebhookEndpoint>({ path: "/api/v1/webhooks/endpoints", method: "POST", body, real: true }),
  /** 更新端點(部分欄位;啟停用亦走此)。 */
  update: (
    id: string,
    body: Partial<{
      url: string;
      events: string[];
      secret: string;
      description: string;
      is_active: boolean;
    }>,
  ) => call<WebhookEndpoint>({ path: `/api/v1/webhooks/endpoints/${id}`, method: "PATCH", body, real: true }),
  /** 刪除端點(軟刪)。 */
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/webhooks/endpoints/${id}`,
      method: "DELETE",
      real: true,
    }),
  /** 對端點送一則測試事件,回是否送達。 */
  test: (id: string) =>
    call<{ endpoint_id: string; delivered: boolean }>({
      path: `/api/v1/webhooks/endpoints/${id}/test`,
      method: "POST",
      real: true,
    }),
};

/** 開放 API 金鑰管理(需 apikey.manage / admin)。 */
export const apikeyApi = {
  /** 金鑰清單(遮罩 + last_used)。攤平 {items} → 陣列。 */
  list: () =>
    call<{ items: ApiKeyRow[]; total: number }>({
      path: "/api/v1/apikeys",
      params: { limit: 500 },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r.items ?? []),
  /** 建立金鑰(回應含一次性明文 key,務必當下複製保存)。 */
  create: (name: string) =>
    call<ApiKeyRow>({ path: "/api/v1/apikeys", method: "POST", body: { name }, real: true }),
  /** 撤銷金鑰(DELETE 同義於 revoke:停用並軟刪,認證即失效)。 */
  revoke: (id: string) =>
    call<{ id: string; revoked: boolean }>({
      path: `/api/v1/apikeys/${id}`,
      method: "DELETE",
      real: true,
    }),
};

/** Help Center 發布管理(知識庫集合對外公開)。 */
export const helpCenterApi = {
  /** 知識庫集合清單(含 is_published / public_slug);與 knowledgeApi.collections 不同,保留發布欄位。 */
  collections: () =>
    call<PublishCollection[]>({
      path: "/api/v1/knowledge/collections",
      real: true,
      mock: async () => [],
    }),
  /** 發布集合到公開 Help Center;回 public_slug / public_url。 */
  publish: (id: string) =>
    call<PublishResult>({
      path: `/api/v1/knowledge/collections/${id}/publish`,
      method: "POST",
      real: true,
    }),
  /** 取消發布(保留 public_slug,便於重新發布維持連結)。 */
  unpublish: (id: string) =>
    call<PublishResult>({
      path: `/api/v1/knowledge/collections/${id}/unpublish`,
      method: "POST",
      real: true,
    }),
};

/* ============ 平台超級管理員(跨租戶)/ 白牌品牌 / 自訂網域 ============
 * 追加式擴充:另起一段 import(同模組多次 import 合法)。
 * 平台端點需登入者 is_platform_admin;公開品牌端點無 JWT;網域端點為 JWT admin。 */
import type {
  CustomDomain,
  DomainVerifyResult,
  PlatformOverview,
  PlatformTenant,
  PublicBranding,
  TenantProvisionInput,
  TenantProvisionResult,
} from "@/types";

/** 平台超管:租戶列表(分頁 + 搜尋)、開通、停用 / 啟用、指派方案、總覽。 */
export const platformApi = {
  /** 平台總覽卡:租戶數 / 啟用數 / 總坐席 / 總會話 / 方案分佈。 */
  overview: () =>
    call<PlatformOverview>({ path: "/api/v1/platform/overview", real: true }),
  /** 租戶列表:分頁 + q 模糊搜尋 + 依啟用狀態過濾。 */
  listTenants: (params: { q?: string; page?: number; size?: number; is_active?: boolean }) =>
    call<Paged<PlatformTenant>>({
      path: "/api/v1/platform/tenants",
      params,
      real: true,
    }),
  /** 開通新租戶(建租戶 + 種預設方案 / 權限 + 第一個 admin 坐席)。 */
  provisionTenant: (body: TenantProvisionInput) =>
    call<TenantProvisionResult>({
      path: "/api/v1/platform/tenants",
      method: "POST",
      body,
      real: true,
    }),
  /** 停用租戶(旗標;登入攔停用由後端處理)。 */
  suspendTenant: (id: string) =>
    call<{ id: string; is_active: boolean }>({
      path: `/api/v1/platform/tenants/${id}/suspend`,
      method: "PATCH",
      real: true,
    }),
  /** 重新啟用租戶。 */
  activateTenant: (id: string) =>
    call<{ id: string; is_active: boolean }>({
      path: `/api/v1/platform/tenants/${id}/activate`,
      method: "PATCH",
      real: true,
    }),
  /** 指派方案(plan_code 擇一;方案須為該租戶名下)。 */
  setPlan: (id: string, body: { plan_id?: string; plan_code?: string; seats?: number; byo_key?: boolean }) =>
    call<{ subscription: Subscription; plan: { id: string; code: string; name: string } }>({
      path: `/api/v1/platform/tenants/${id}/set-plan`,
      method: "POST",
      body,
      real: true,
    }),
};

/** 白牌品牌解析(公開)+ 租戶自訂網域綁定(JWT admin)。 */
export const brandingApi = {
  /** 依 host 解析租戶品牌(公開,無 JWT);查無 / 停用回預設品牌(is_default=true)。 */
  resolveBranding: (host: string) =>
    call<PublicBranding>({
      path: "/api/v1/public/branding",
      params: { host },
      auth: false,
      real: true,
    }),
  /** 列本租戶已綁網域(含 verified 狀態;未驗證者附 DNS 指示)。 */
  listDomains: () =>
    call<{ items: CustomDomain[]; total: number }>({
      path: "/api/v1/branding/domains",
      real: true,
    }),
  /** 綁定新網域(送出回 verify_token 與 DNS 設定指示)。 */
  bindDomain: (domain: string, is_primary = false) =>
    call<CustomDomain>({
      path: "/api/v1/branding/domains",
      method: "POST",
      body: { domain, is_primary },
      real: true,
    }),
  /** 解除綁定(硬刪,釋放全域唯一網域)。 */
  unbindDomain: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/branding/domains/${id}`,
      method: "DELETE",
      real: true,
    }),
  /** 觸發 DNS TXT 驗證;未過回 pending 與 DNS 指示(不報錯)。 */
  verifyDomain: (id: string) =>
    call<DomainVerifyResult>({
      path: `/api/v1/branding/domains/${id}/verify`,
      method: "POST",
      real: true,
    }),
};
