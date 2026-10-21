/** 白牌轉售商帳單 API(乾淨室自建;**不改 endpoints.ts**)。
 *  對齊後端 app/api/v1/billing.py 的轉售儀表板端點(router 前綴 /api/v1/billing):
 *    - GET /reseller/overview                    轉售者總覽(名下每租戶訂閱/方案/用量/計費 + 彙總)
 *    - GET /reseller/tenants/{tenant_id}/usage   下鑽單一名下租戶的用量/帳單明細
 *  兩端點皆受後端 `_require_reseller` 守衛(非 reseller/admin → 403)。
 *  一律走 {ok,data,error} 信封(apiFetch 已解包 data);start/end 為選填時間區間查詢參數。 */
import { apiFetch } from "./client";
import type { Plan, Subscription } from "@/types";

const BASE = "/api/v1/billing/reseller";

/** 逐項計費明細(對齊後端 services/usage.py estimate_charges 的 line_items)。 */
export interface ChargeLineItem {
  kind: string;
  quantity: number;
  included: number;
  billable_quantity: number;
  unit_price: number;
  amount: number;
  /** BYO-Key 情境下由租戶自負、平台不計費 → amount 記 0 並標記自負。 */
  self_funded: boolean;
}

/** 透明帳單估算(對齊 estimate_charges 回傳)。金額皆為貨幣主單位。 */
export interface ChargeEstimate {
  currency: string;
  base_fee: number;
  line_items: ChargeLineItem[];
  metered_total: number;
  total: number;
  byo_key: boolean;
}

/** 用量彙總:計量種類(kind)→ 總量。 */
export type UsageByKind = Record<string, number>;

/** 名下(下游)單一租戶列:訂閱狀態、方案、用量與計費估算。 */
export interface ResellerTenantRow {
  tenant_id: string;
  /** 下游租戶名稱(總覽由後端帶回;租戶中繼缺漏時為 null)。 */
  name?: string | null;
  /** 子網域 slug(同上)。 */
  slug?: string | null;
  /** 租戶啟用狀態(true=啟用、false=已停用;中繼缺漏時 null)。清單停用/啟用操作依此二選一。 */
  is_active?: boolean | null;
  subscription: Subscription;
  plan: Plan | null;
  usage: UsageByKind;
  charges: ChargeEstimate;
}

/** GET /reseller/overview 回應。無名下租戶時 tenants=[]、totals={}(tenant_count 省略)。 */
export interface ResellerOverview {
  reseller_tenant_id: string;
  tenant_count?: number;
  tenants: ResellerTenantRow[];
  /** 跨名下租戶的用量彙總(依 kind 加總)。 */
  totals: UsageByKind;
}

/** GET /reseller/tenants/{tenant_id}/usage 回應(單租戶明細,結構同列)。 */
export type ResellerTenantUsage = ResellerTenantRow;

/** 選填時間區間(ISO 字串);對映後端 start(含)/ end(不含)查詢參數。 */
export interface ResellerRangeParams {
  start?: string;
  end?: string;
}

/** POST /reseller/tenants 輸入(轉售商自助開通下游)。
 *  **不含 reseller_tenant_id**:後端一律取自轉售商自身 JWT,前端傳了也會被忽略。 */
export interface OnboardTenantInput {
  /** 下游租戶名稱(必填)。 */
  name: string;
  /** 下游第一個管理員 email(必填;後端驗格式,錯誤碼 INVALID_EMAIL)。 */
  admin_email: string;
  /** 管理員初始密碼(必填,≥6)。 */
  admin_password: string;
  /** 管理員顯示名稱(選填)。 */
  admin_display_name?: string;
  /** 子網域 slug(選填;未給則由名稱衍生)。 */
  slug?: string;
  /** 白牌品牌設定(選填)。 */
  branding?: Record<string, unknown>;
}

/** POST /reseller/tenants 回應:新開通的租戶與其首位管理員坐席。 */
export interface OnboardTenantResult {
  tenant: { id: string; name: string; slug: string; is_active: boolean };
  admin: { staff_id: string; email: string; display_name: string | null };
}

/** suspend / activate 回應:租戶更新後的啟用狀態。 */
export interface SetTenantActiveResult {
  tenant_id: string;
  is_active: boolean;
}

/** React Query key 工廠(轉售專用命名空間,與 hooks.ts 既有 key 不撞)。 */
export const rkeys = {
  overview: (params?: ResellerRangeParams) =>
    ["reseller", "overview", params?.start ?? "", params?.end ?? ""] as const,
  tenantUsage: (tenantId: string, params?: ResellerRangeParams) =>
    ["reseller", "tenant", tenantId, params?.start ?? "", params?.end ?? ""] as const,
};

export const resellerApi = {
  /** 轉售者總覽:名下所有租戶的用量/計費 + 彙總。 */
  overview: (params?: ResellerRangeParams) =>
    apiFetch<ResellerOverview>(`${BASE}/overview`, {
      params: { start: params?.start, end: params?.end },
    }),
  /** 下鑽單一名下租戶的用量/帳單明細(後端先驗證該租戶確在其名下,否則 404)。 */
  tenantUsage: (tenantId: string, params?: ResellerRangeParams) =>
    apiFetch<ResellerTenantUsage>(`${BASE}/tenants/${tenantId}/usage`, {
      params: { start: params?.start, end: params?.end },
    }),
  /** 開通一個掛在自己名下的下游租戶(含 admin 坐席與 Free 訂閱)。
   *  reseller_tenant_id 由後端從 JWT 帶入,故 body 不需(也不應)提供。 */
  onboardTenant: (body: OnboardTenantInput) =>
    apiFetch<OnboardTenantResult>(`${BASE}/tenants`, { method: "POST", body }),
  /** 停用名下下游租戶(其坐席將無法登入)。 */
  suspendTenant: (tenantId: string) =>
    apiFetch<SetTenantActiveResult>(`${BASE}/tenants/${tenantId}/suspend`, { method: "POST" }),
  /** 重新啟用名下下游租戶。 */
  activateTenant: (tenantId: string) =>
    apiFetch<SetTenantActiveResult>(`${BASE}/tenants/${tenantId}/activate`, { method: "POST" }),
};
