/** 坐席邀請 API(乾淨室自建;**不改 endpoints.ts / client.ts**)。
 *  對齊後端 app/api/v1/auth.py(router 前綴 /api/v1/auth):
 *    - POST /invite                       管理者邀請坐席(需 Bearer + staff.manage);建 pending 帳號回邀請連結
 *    - GET  /invites/pending              列出本租戶尚未接受的 pending 邀請(需 staff.manage)
 *    - POST /invite/{staff_id}/resend     重寄:重簽 token 使舊連結失效,回新邀請連結(需 staff.manage)
 *    - POST /invite/{staff_id}/revoke     撤銷:軟刪尚未接受的 pending 邀請(需 staff.manage)
 *    - POST /accept-invite                公開接受邀請;設定密碼並啟用,回正式 token 可自動登入
 *  一律走 {ok,data,error} 信封(apiFetch 已解包 data);accept-invite 為公開端點不帶 Bearer。 */
import { apiFetch } from "@/api/client";

/* --------------------------------- 邀請坐席 --------------------------------- */
export interface InviteStaffInput {
  /** 受邀者 email(本租戶內唯一;後端驗格式,錯誤碼 INVALID_EMAIL / STAFF_EMAIL_TAKEN)。 */
  email: string;
  /** 顯示名稱(選填;未給則以 email 充當)。 */
  display_name?: string;
  /** 指派角色名(選填,預設 agent;須為本租戶既有角色,否則 ROLE_NOT_FOUND)。 */
  role?: string;
}

export interface InviteStaffResult {
  staff_id: string;
  email: string;
  display_name: string;
  role: string;
  /** 後端是否已透過租戶 Email 渠道寄出邀請信(無 SMTP 或寄送失敗為 false;仍回 invite_url 供複製)。 */
  email_sent: boolean;
  /** 相對路徑邀請連結(/accept-invite?token=…);前端可前綴 origin 組成完整連結。 */
  invite_url: string;
}

/** 邀請一位坐席(需登入且具 staff.manage 權限)。 */
export function inviteStaff(body: InviteStaffInput): Promise<InviteStaffResult> {
  return apiFetch<InviteStaffResult>("/api/v1/auth/invite", { method: "POST", body });
}

/* ----------------------------- pending 邀請管理 ----------------------------- */
export interface PendingInvite {
  staff_id: string;
  email: string;
  display_name: string;
  /** 指派角色名清單。 */
  roles: string[];
  /** 邀請(或最後一次重寄)時間 ISO 字串;可能為 null。 */
  invited_at: string | null;
}

/** 列出本租戶尚未接受的 pending 邀請(需 staff.manage)。 */
export async function listPendingInvites(): Promise<PendingInvite[]> {
  const res = await apiFetch<{ invites: PendingInvite[] }>("/api/v1/auth/invites/pending");
  return res.invites ?? [];
}

export interface ResendInviteResult {
  staff_id: string;
  email: string;
  display_name: string;
  email_sent: boolean;
  invite_url: string;
}

/** 重寄邀請:重簽 token(舊連結因版本改變而失效),回新邀請連結(需 staff.manage)。 */
export function resendInvite(staffId: string): Promise<ResendInviteResult> {
  return apiFetch<ResendInviteResult>(`/api/v1/auth/invite/${staffId}/resend`, { method: "POST" });
}

/** 撤銷邀請:軟刪尚未接受的 pending 邀請(需 staff.manage)。 */
export function revokeInvite(staffId: string): Promise<{ staff_id: string; revoked: boolean }> {
  return apiFetch<{ staff_id: string; revoked: boolean }>(`/api/v1/auth/invite/${staffId}/revoke`, {
    method: "POST",
  });
}

/* ------------------------------ 產生重設連結(管理員) ------------------------------ */
export interface StaffResetLinkResult {
  staff_id: string;
  email: string;
  /** 相對路徑重設連結(/reset-password?token=…);前端可前綴 origin 組成完整連結。 */
  reset_url: string;
  /** 後端是否已透過租戶 Email 渠道另寄出重設信(無 SMTP 或寄送失敗為 false;仍回 reset_url 供複製)。 */
  email_sent: boolean;
}

/** 管理員為本租戶指定坐席產生密碼重設連結(需 staff.manage;tenant 隔離)。
 *  對齊後端 POST /api/v1/auth/staff/{staff_id}/reset-link;供 demo / 無 SMTP 時仍可重設。 */
export function staffResetLink(staffId: string): Promise<StaffResetLinkResult> {
  return apiFetch<StaffResetLinkResult>(`/api/v1/auth/staff/${staffId}/reset-link`, {
    method: "POST",
  });
}

/* ------------------------------- 接受邀請(公開) ------------------------------- */
export interface AcceptInviteInput {
  /** 邀請權杖(取自邀請連結 query string 的 token)。 */
  token: string;
  /** 自訂密碼(≥6;後端亦驗,錯誤碼 WEAK_PASSWORD)。 */
  password: string;
  /** 顯示名稱(選填;提供則覆寫邀請時的預設)。 */
  display_name?: string;
}

/** 接受邀請成功後回正式 token(結構相容 authExtra.finalizeSession 的入參)。 */
export interface AcceptInviteResult {
  access_token?: string;
  token_type?: string;
  staff_id?: string;
  is_platform_admin?: boolean;
}

/** 接受邀請:設定密碼並啟用帳號(公開端點,不帶 Bearer)。 */
export function acceptInvite(body: AcceptInviteInput): Promise<AcceptInviteResult> {
  return apiFetch<AcceptInviteResult>("/api/v1/auth/accept-invite", {
    method: "POST",
    body,
    auth: false,
  });
}
