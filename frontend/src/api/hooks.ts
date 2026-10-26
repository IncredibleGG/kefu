/** TanStack Query hooks(讀取快取 + mutation 失效) */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiApi,
  authApi,
  automationApi,
  billingApi,
  cannedApi,
  channelApi,
  conversationApi,
  iamApi,
  knowledgeApi,
  proactiveApi,
  qualityApi,
  reportApi,
  settingsApi,
  slaApi,
  visitorApi,
} from "./endpoints";
import { adoptRotatedToken } from "@/stores/auth";
import type { Canned, Message, SessionTab } from "@/types";

export const qk = {
  sessions: (tab: SessionTab, q?: string, tagId?: string) =>
    ["sessions", tab, q ?? "", tagId ?? ""] as const,
  session: (id: string) => ["session", id] as const,
  messages: (id: string) => ["messages", id] as const,
  suggestions: (id: string) => ["suggestions", id] as const,
  insight: (id: string) => ["insight", id] as const,
  kbHits: (id: string) => ["kbHits", id] as const,
  collections: () => ["collections"] as const,
  channels: () => ["channels"] as const,
  visitors: (q?: string) => ["visitors", q ?? ""] as const,
  report: () => ["report"] as const,
};

export function useSessions(tab: SessionTab, q?: string, tagId?: string) {
  return useQuery({
    queryKey: qk.sessions(tab, q, tagId),
    queryFn: () => conversationApi.listSessions(tab, q, 1, 30, tagId),
    refetchInterval: 15_000,
  });
}

export function useMessages(sessionId?: string) {
  return useQuery({
    queryKey: qk.messages(sessionId ?? "none"),
    queryFn: () => conversationApi.listMessages(sessionId!),
    enabled: !!sessionId,
  });
}

export function useSuggestions(sessionId?: string) {
  return useQuery({
    queryKey: qk.suggestions(sessionId ?? "none"),
    queryFn: () => aiApi.suggestions(sessionId!),
    enabled: !!sessionId,
  });
}

export function useInsight(sessionId?: string) {
  return useQuery({
    queryKey: qk.insight(sessionId ?? "none"),
    queryFn: () => aiApi.insight(sessionId!),
    enabled: !!sessionId,
  });
}

export function useKbHits(sessionId?: string) {
  return useQuery({
    queryKey: qk.kbHits(sessionId ?? "none"),
    queryFn: () => knowledgeApi.hits(sessionId!),
    enabled: !!sessionId,
  });
}

export function useCollections() {
  return useQuery({ queryKey: qk.collections(), queryFn: () => knowledgeApi.collections() });
}

export function useChannels() {
  return useQuery({ queryKey: qk.channels(), queryFn: () => channelApi.list() });
}

export function useVisitors(q?: string) {
  return useQuery({ queryKey: qk.visitors(q), queryFn: () => visitorApi.list({ q }) });
}

export function useReport() {
  return useQuery({ queryKey: qk.report(), queryFn: () => reportApi.overview() });
}

export function useSendMessage(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: string; contentType?: Message["content_type"] }) =>
      conversationApi.sendMessage(sessionId, input.content, input.contentType),
    onSuccess: (msg) => {
      // 直接把新訊息塞進快取(以 id 去重,避免與 WS 推送重複)
      qc.setQueryData<Message[]>(qk.messages(sessionId), (old) => {
        if (old?.some((m) => m.id === msg.id)) return old;
        return [...(old ?? []), msg];
      });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
    // 送訊失敗:不吞錯(mutateAsync 會 reject,呼叫端保留輸入內容並顯示提示);
    // 另重新對齊訊息列表,確保 UI 不殘留任何不一致狀態。
    onError: () => {
      qc.invalidateQueries({ queryKey: qk.messages(sessionId) });
    },
  });
}

/** 接管 / 轉接會話 */
export function useHandoff(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      action: "takeover" | "transfer";
      handler_staff_id?: string;
      skill_group_id?: string;
    }) => conversationApi.handoff(sessionId, input.action, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: qk.messages(sessionId) });
    },
  });
}

/** 服務小結的持久化:category / note 走 service-summary 端點。
 *
 *  ⚠️ CSAT 雙來源污染修正:坐席端這顆星等是「內部處理評級」,**絕不**再打
 *  /quality/csat(那是訪客滿意度的唯一來源;坐席送進去會覆蓋訪客真實評分、
 *  污染滿意度報表)。改為:僅在坐席明確評分(1–5)時,把評級以「內部處理評級」
 *  併入服務小結備註,與訪客 CSAT 完全分流。未評分(csat 省略 / 0)則不送任何評級。 */
async function persistServiceSummary(
  sessionId: string,
  input?: { category?: string; note?: string; csat?: number },
): Promise<void> {
  if (!input) return;
  const rated = typeof input.csat === "number" && input.csat >= 1 && input.csat <= 5;
  let note = (input.note ?? "").trim();
  if (rated) {
    const line = `內部處理評級:${input.csat}/5`;
    note = note ? `${note}\n${line}` : line;
  }
  // 有分類或(補上內部評級後的)備註才建立服務小結;不再呼叫 submitCsat。
  if (input.category || note) {
    await qualityApi.createServiceSummary(sessionId, input.category, note || undefined);
  }
}

/** 結束會話 + 選填服務小結(分類 / 備註 / CSAT 滿意度) */
export function useCloseSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input?: { category?: string; note?: string; csat?: number }) => {
      await persistServiceSummary(sessionId, input);
      return conversationApi.close(sessionId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: qk.messages(sessionId) });
    },
    // 結束 / 存檔失敗:不吞錯(交由呼叫端保留對話框並顯示提示),並重新對齊列表。
    onError: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}

/** 僅記錄服務小結(分類 / 備註 / CSAT)但不結束會話。 */
export function useServiceSummary(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { category?: string; note?: string; csat?: number }) =>
      persistServiceSummary(sessionId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}

/* ============ 設定 / 套餐 / 翻譯 / 標籤(設定區各子頁共用) ============ */

/** 快捷回覆清單(依 scope / 關鍵字) */
export function useCanned(scope: "all" | "shared" | "mine" = "all", q?: string) {
  return useQuery({
    queryKey: ["canned", scope, q ?? ""],
    queryFn: () => cannedApi.list({ scope, q }),
  });
}

/** 快捷回覆 建立/更新/刪除(共用失效） */
export function useCannedMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["canned"] });
  const create = useMutation({ mutationFn: cannedApi.create, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (input: { id: string; body: Partial<Canned> }) =>
      cannedApi.update(input.id, input.body),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => cannedApi.remove(id), onSuccess: invalidate });
  return { create, update, remove };
}

/** 租戶客服設定(Widget / 接待) */
export function useTenantSettings() {
  return useQuery({ queryKey: ["tenantSettings"], queryFn: () => settingsApi.get() });
}

/** 坐席自助修改密碼(舊密碼驗證後更新) */
export function useChangePassword() {
  return useMutation({
    mutationFn: (i: { old_password: string; new_password: string }) =>
      authApi.changePassword(i.old_password, i.new_password),
    // 改密後伺服器撤銷所有舊 token(其他裝置需重新登入),本次 session 改用回應中的新 token
    onSuccess: (res) => adoptRotatedToken(res?.access_token),
  });
}

/** 方案列表 */
export function usePlans() {
  return useQuery({ queryKey: ["billing", "plans"], queryFn: () => billingApi.listPlans() });
}

/** 目前訂閱 + 生效功能 */
export function useSubscription() {
  return useQuery({ queryKey: ["billing", "subscription"], queryFn: () => billingApi.getSubscription() });
}

/** 生效功能字典 + 功能目錄(catalog) */
export function useFeatures() {
  return useQuery({ queryKey: ["billing", "features"], queryFn: () => billingApi.features() });
}

/** 標籤主檔 */
export function useTags(category?: string) {
  return useQuery({
    queryKey: ["tags", category ?? ""],
    queryFn: () => visitorApi.listTags(category),
  });
}

export function useFlagMessage(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { messageId: string; flagged: boolean }) =>
      conversationApi.flagMessage(sessionId, input.messageId, input.flagged),
    onMutate: async ({ messageId, flagged }) => {
      qc.setQueryData<Message[]>(qk.messages(sessionId), (old) =>
        (old ?? []).map((m) => (m.id === messageId ? { ...m, flagged } : m)),
      );
    },
  });
}

/* ============ 管理員後台:坐席 / 角色(RBAC)/ 技能組 / 儀表板 / CRM ============ */

/** Admin Console 總覽儀表板資料 */
export function useDashboard() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => reportApi.dashboard() });
}

/** 坐席管理列(含角色與技能組) */
export function useStaffAdmin() {
  return useQuery({ queryKey: ["iam", "staffAdmin"], queryFn: () => iamApi.staffAdminList() });
}

/** 角色清單(RBAC) */
export function useRoles() {
  return useQuery({ queryKey: ["iam", "roles"], queryFn: () => iamApi.listRoles() });
}

/** 單一角色詳情(含權限碼) */
export function useRole(id?: string) {
  return useQuery({
    queryKey: ["iam", "role", id ?? "none"],
    queryFn: () => iamApi.getRole(id!),
    enabled: !!id,
  });
}

/** 權限碼清單 */
export function usePermissions() {
  return useQuery({ queryKey: ["iam", "permissions"], queryFn: () => iamApi.listPermissions() });
}

/** 技能組清單(基本;與快捷回覆頁共用快取) */
export function useSkillGroups() {
  return useQuery({ queryKey: ["iam", "skillGroups"], queryFn: () => iamApi.skillGroups() });
}

/** 技能組詳情(含成員) */
export function useSkillGroupDetail(id?: string) {
  return useQuery({
    queryKey: ["iam", "skillGroup", id ?? "none"],
    queryFn: () => iamApi.getSkillGroup(id!),
    enabled: !!id,
  });
}

/** 聯絡人清單(CRM) */
export function useContacts(q?: string, tagId?: string) {
  return useQuery({
    queryKey: ["contacts", q ?? "", tagId ?? ""],
    queryFn: () => visitorApi.listContacts({ q, tag_id: tagId }),
  });
}

/** 聯絡人 CRM 檔案 */
export function useContactDetail(id?: string) {
  return useQuery({
    queryKey: ["contact", id ?? "none"],
    queryFn: () => visitorApi.getContact(id!),
    enabled: !!id,
  });
}

/** 訪客軌跡(來源渠道 + 近期會話) */
export function useVisitorTimeline(id?: string) {
  return useQuery({
    queryKey: ["visitorTimeline", id ?? "none"],
    queryFn: () => visitorApi.getTimeline(id!),
    enabled: !!id,
  });
}

/** 坐席 建立/更新/刪除/角色/密碼/狀態 */
export function useStaffMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["iam"] });
  const create = useMutation({ mutationFn: iamApi.createStaff, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (i: {
      id: string;
      body: Partial<{ display_name: string; avatar_url: string | null; is_active: boolean }>;
    }) => iamApi.updateStaff(i.id, i.body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => iamApi.deleteStaff(id),
    onSuccess: invalidate,
  });
  const setRoles = useMutation({
    mutationFn: (i: { id: string; roleIds: string[] }) => iamApi.setStaffRoles(i.id, i.roleIds),
    onSuccess: invalidate,
  });
  const setPassword = useMutation({
    mutationFn: (i: { id: string; password: string }) => iamApi.setStaffPassword(i.id, i.password),
    // 改的是自己的密碼時後端回新 token(舊 token 已撤銷);改他人密碼不回
    onSuccess: (res) => adoptRotatedToken(res?.access_token),
  });
  const setStatus = useMutation({
    mutationFn: (i: { id: string; status: string }) => iamApi.setStaffStatus(i.id, i.status),
    onSuccess: invalidate,
  });
  return { create, update, remove, setRoles, setPassword, setStatus };
}

/** 角色 建立/更新/刪除/綁權限 */
export function useRoleMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["iam"] });
  const create = useMutation({ mutationFn: iamApi.createRole, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (i: { id: string; body: Partial<{ name: string; description: string | null }> }) =>
      iamApi.updateRole(i.id, i.body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => iamApi.deleteRole(id),
    onSuccess: invalidate,
  });
  const setPermissions = useMutation({
    mutationFn: (i: { id: string; codes: string[] }) => iamApi.setRolePermissions(i.id, i.codes),
    onSuccess: invalidate,
  });
  return { create, update, remove, setPermissions };
}

/** 技能組 建立/更新/刪除/成員加入移出 */
export function useSkillGroupMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["iam"] });
  const create = useMutation({ mutationFn: iamApi.createSkillGroup, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (i: { id: string; body: Partial<{ name: string; description: string | null }> }) =>
      iamApi.updateSkillGroup(i.id, i.body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => iamApi.deleteSkillGroup(id),
    onSuccess: invalidate,
  });
  const addMembers = useMutation({
    mutationFn: (i: { id: string; staffIds: string[] }) =>
      iamApi.addSkillGroupMembers(i.id, i.staffIds),
    onSuccess: invalidate,
  });
  const removeMember = useMutation({
    mutationFn: (i: { id: string; staffId: string }) =>
      iamApi.removeSkillGroupMember(i.id, i.staffId),
    onSuccess: invalidate,
  });
  return { create, update, remove, addMembers, removeMember };
}

/** 聯絡人/訪客 CRM 變更:更新欄位 / 封鎖 / 解封 */
export function useCrmMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["contacts"] });
    qc.invalidateQueries({ queryKey: ["contact"] });
    qc.invalidateQueries({ queryKey: ["visitors"] });
  };
  const updateContact = useMutation({
    mutationFn: (i: { id: string; body: Record<string, unknown> }) =>
      visitorApi.updateContact(i.id, i.body),
    onSuccess: invalidate,
  });
  const blockContact = useMutation({
    mutationFn: (id: string) => visitorApi.blockContact(id),
    onSuccess: invalidate,
  });
  const unblockContact = useMutation({
    mutationFn: (id: string) => visitorApi.unblockContact(id),
    onSuccess: invalidate,
  });
  const blockVisitor = useMutation({
    mutationFn: (id: string) => visitorApi.block(id),
    onSuccess: invalidate,
  });
  const unblockVisitor = useMutation({
    mutationFn: (id: string) => visitorApi.unblock(id),
    onSuccess: invalidate,
  });
  return { updateContact, blockContact, unblockContact, blockVisitor, unblockVisitor };
}

/* ============ 進階功能:自動化 / 主動訊息 / SLA / Email 渠道 ============ */

/** 自動化規則建構器目錄(events / 條件欄位 / 動作型別) */
export function useAutomationCatalog() {
  return useQuery({
    queryKey: ["automation", "catalog"],
    queryFn: () => automationApi.catalog(),
    staleTime: 5 * 60_000, // 目錄幾乎不變
  });
}

/** 自動化規則清單 */
export function useAutomationRules() {
  return useQuery({ queryKey: ["automation", "rules"], queryFn: () => automationApi.list() });
}

/** 自動化規則 建立/更新/刪除 */
export function useAutomationMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["automation", "rules"] });
  const create = useMutation({ mutationFn: automationApi.create, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (i: { id: string; body: Parameters<typeof automationApi.update>[1] }) =>
      automationApi.update(i.id, i.body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => automationApi.remove(id),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

/** 主動式訊息規則清單 */
export function useProactiveRules() {
  return useQuery({ queryKey: ["proactive", "rules"], queryFn: () => proactiveApi.list() });
}

/** 主動式訊息規則 建立/更新/刪除 */
export function useProactiveMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["proactive", "rules"] });
  const create = useMutation({ mutationFn: proactiveApi.create, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (i: { id: string; body: Parameters<typeof proactiveApi.update>[1] }) =>
      proactiveApi.update(i.id, i.body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => proactiveApi.remove(id),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

/** SLA 政策清單 */
export function useSlaPolicies() {
  return useQuery({ queryKey: ["sla", "policies"], queryFn: () => slaApi.listPolicies() });
}

/** SLA 違約清單 */
export function useSlaBreaches(page = 1, size = 50) {
  return useQuery({
    queryKey: ["sla", "breaches", page, size],
    queryFn: () => slaApi.breaches(page, size),
  });
}

/** SLA 政策 建立/更新/刪除 */
export function useSlaMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["sla", "policies"] });
  const create = useMutation({ mutationFn: slaApi.createPolicy, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (i: { id: string; body: Parameters<typeof slaApi.updatePolicy>[1] }) =>
      slaApi.updatePolicy(i.id, i.body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => slaApi.deletePolicy(id),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

/** Email 型別渠道清單(含遮罩後 config) */
export function useEmailChannels() {
  return useQuery({ queryKey: ["channels", "email"], queryFn: () => channelApi.listEmail() });
}

/** Email 渠道 建立/存 IMAP·SMTP 設定 */
export function useEmailChannelMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["channels", "email"] });
  const create = useMutation({
    mutationFn: (name: string) => channelApi.createEmail(name),
    onSuccess: invalidate,
  });
  const setConfig = useMutation({
    mutationFn: (i: { id: string; body: Parameters<typeof channelApi.setEmailConfig>[1] }) =>
      channelApi.setEmailConfig(i.id, i.body),
    onSuccess: invalidate,
  });
  return { create, setConfig };
}

/* ============ 進階平台:Meta 渠道 / Webhook / API Key / Help Center 發布 ============
 * 追加式擴充:另起一段 import(同模組多次 import 合法,綁定名不重複)。 */
import { apikeyApi, helpCenterApi, metaChannelApi, webhookApi } from "./endpoints";

/** WhatsApp / Facebook 渠道清單(含遮罩後 config) */
export function useMetaChannels() {
  return useQuery({ queryKey: ["channels", "meta"], queryFn: () => metaChannelApi.list() });
}

/** Meta 渠道 建立 / 存 WhatsApp·Facebook 設定 */
export function useMetaChannelMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["channels", "meta"] });
  const create = useMutation({
    mutationFn: (i: { type: "whatsapp" | "facebook"; name: string }) =>
      metaChannelApi.create(i.type, i.name),
    onSuccess: invalidate,
  });
  const setWhatsapp = useMutation({
    mutationFn: (i: { id: string; body: Parameters<typeof metaChannelApi.setWhatsappConfig>[1] }) =>
      metaChannelApi.setWhatsappConfig(i.id, i.body),
    onSuccess: invalidate,
  });
  const setFacebook = useMutation({
    mutationFn: (i: { id: string; body: Parameters<typeof metaChannelApi.setFacebookConfig>[1] }) =>
      metaChannelApi.setFacebookConfig(i.id, i.body),
    onSuccess: invalidate,
  });
  return { create, setWhatsapp, setFacebook };
}

/** 可訂閱 webhook 事件清單(幾乎不變,長快取) */
export function useWebhookEvents() {
  return useQuery({
    queryKey: ["webhooks", "events"],
    queryFn: () => webhookApi.events(),
    staleTime: 5 * 60_000,
  });
}

/** Webhook 端點清單 */
export function useWebhookEndpoints() {
  return useQuery({ queryKey: ["webhooks", "endpoints"], queryFn: () => webhookApi.list() });
}

/** Webhook 端點 建立/更新/刪除 */
export function useWebhookMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["webhooks", "endpoints"] });
  const create = useMutation({ mutationFn: webhookApi.create, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (i: { id: string; body: Parameters<typeof webhookApi.update>[1] }) =>
      webhookApi.update(i.id, i.body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => webhookApi.remove(id),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

/** 開放 API 金鑰清單 */
export function useApiKeys() {
  return useQuery({ queryKey: ["apikeys"], queryFn: () => apikeyApi.list() });
}

/** API 金鑰 建立/撤銷 */
export function useApiKeyMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["apikeys"] });
  const create = useMutation({ mutationFn: (name: string) => apikeyApi.create(name), onSuccess: invalidate });
  const revoke = useMutation({ mutationFn: (id: string) => apikeyApi.revoke(id), onSuccess: invalidate });
  return { create, revoke };
}

/** Help Center 集合(含發布狀態) */
export function useHelpCenterCollections() {
  return useQuery({ queryKey: ["helpcenter", "collections"], queryFn: () => helpCenterApi.collections() });
}

/** Help Center 發布 / 取消發布 */
export function useHelpCenterMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["helpcenter", "collections"] });
  const publish = useMutation({ mutationFn: (id: string) => helpCenterApi.publish(id), onSuccess: invalidate });
  const unpublish = useMutation({ mutationFn: (id: string) => helpCenterApi.unpublish(id), onSuccess: invalidate });
  return { publish, unpublish };
}

/* ============ 平台超級管理員(跨租戶)/ 自訂網域 ============ */
import { brandingApi, platformApi } from "./endpoints";

/** 平台總覽卡(跨租戶聚合) */
export function usePlatformOverview() {
  return useQuery({ queryKey: ["platform", "overview"], queryFn: () => platformApi.overview() });
}

/** 平台租戶列表(分頁 + 搜尋) */
export function usePlatformTenants(params: { q?: string; page?: number; size?: number; is_active?: boolean }) {
  return useQuery({
    queryKey: ["platform", "tenants", params.q ?? "", params.page ?? 1, params.size ?? 20, params.is_active ?? "all"],
    queryFn: () => platformApi.listTenants(params),
  });
}

/** 平台租戶 開通 / 停用 / 啟用 / 指派方案(共用失效) */
export function usePlatformMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["platform"] });
  const provision = useMutation({
    mutationFn: (body: Parameters<typeof platformApi.provisionTenant>[0]) => platformApi.provisionTenant(body),
    onSuccess: invalidate,
  });
  const suspend = useMutation({ mutationFn: (id: string) => platformApi.suspendTenant(id), onSuccess: invalidate });
  const activate = useMutation({ mutationFn: (id: string) => platformApi.activateTenant(id), onSuccess: invalidate });
  const setPlan = useMutation({
    mutationFn: (i: { id: string; body: Parameters<typeof platformApi.setPlan>[1] }) => platformApi.setPlan(i.id, i.body),
    onSuccess: invalidate,
  });
  return { provision, suspend, activate, setPlan };
}

/** 本租戶自訂網域清單 */
export function useCustomDomains() {
  return useQuery({ queryKey: ["branding", "domains"], queryFn: () => brandingApi.listDomains() });
}

/** 自訂網域 綁定 / 解除 / 驗證(共用失效) */
export function useDomainMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["branding", "domains"] });
  const bind = useMutation({
    mutationFn: (i: { domain: string; is_primary?: boolean }) => brandingApi.bindDomain(i.domain, i.is_primary),
    onSuccess: invalidate,
  });
  const unbind = useMutation({ mutationFn: (id: string) => brandingApi.unbindDomain(id), onSuccess: invalidate });
  const verify = useMutation({ mutationFn: (id: string) => brandingApi.verifyDomain(id), onSuccess: invalidate });
  return { bind, unbind, verify };
}
