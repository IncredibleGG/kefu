/** ============================================================
 *  登入頁額外用到的 API(docs/NATIVE-CLIENTS.md §4.1)。
 *  api/authExtra.ts 屬其他工作包,這裡以同一個 apiFetch 自建薄包裝,型別向下相容 LoginAttemptResult:
 *  - POST /api/v1/auth/login        body 多帶選填 tenant(slug);可能回 requires_tenant_selection。
 *  - POST /api/v1/auth/sso/exchange 原生 SSO:一次性 code + PKCE code_verifier → 與登入成功同形的回應。
 *  ============================================================ */
import { apiFetch } from "@/api/client";
import type { LoginAttemptResult, LoginBody } from "@/api/authExtra";

export interface TenantChoice {
  slug: string;
  name: string;
}

export interface LoginWithTenantBody extends LoginBody {
  /** 租戶(工作區)slug;同一 email + 密碼對到多個租戶時必填 */
  tenant?: string;
}

export interface LoginWithTenantResult extends LoginAttemptResult {
  /** 密碼正確但對到多個租戶:請使用者選擇後帶 tenant 重送 */
  requires_tenant_selection?: boolean;
  tenants?: TenantChoice[];
}

/** 工作區 slug 正規化(後端以 lower 比對;只去空白與轉小寫,不在前端猜格式)。 */
export function normalizeTenantSlug(input: string | null | undefined): string {
  return (input ?? "").trim().toLowerCase().slice(0, 100);
}

/** 登入(可帶 tenant)。空字串 tenant 不送出。 */
export function loginWithTenant(body: LoginWithTenantBody): Promise<LoginWithTenantResult> {
  const tenant = normalizeTenantSlug(body.tenant);
  const payload: LoginWithTenantBody = { ...body, tenant: tenant || undefined };
  return apiFetch<LoginWithTenantResult>("/api/v1/auth/login", {
    method: "POST",
    body: payload,
    auth: false,
  });
}

/** 原生 SSO 兌換:失敗丟 ApiError(INVALID_CODE / INVALID_CODE_VERIFIER / SSO_NOT_INVITED …)。 */
export function ssoExchange(arg: { code: string; code_verifier: string }): Promise<LoginAttemptResult> {
  return apiFetch<LoginAttemptResult>("/api/v1/auth/sso/exchange", {
    method: "POST",
    body: arg,
    auth: false,
  });
}

/** 解析 requires_tenant_selection 回應裡的租戶清單(過濾掉格式不對的項目)。 */
export function tenantChoicesOf(res: LoginWithTenantResult): TenantChoice[] {
  if (!res.requires_tenant_selection || !Array.isArray(res.tenants)) return [];
  return res.tenants
    .filter((x): x is TenantChoice => Boolean(x && typeof x.slug === "string" && x.slug))
    .map((x) => ({ slug: x.slug, name: typeof x.name === "string" && x.name ? x.name : x.slug }));
}
