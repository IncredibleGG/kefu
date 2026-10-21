/** 認證周邊 API(乾淨室自建;**不改 endpoints.ts / client.ts / stores/auth.ts**)。
 *  對齊後端 app/api/v1/auth.py(router 前綴 /api/v1/auth):
 *    - POST /register          自助註冊(建租戶 + admin 坐席;成功回正式 token 可自動登入)
 *    - POST /forgot-password   忘記密碼(公開;有 SMTP 則寄信,dev 回傳 token)
 *    - POST /reset-password    以重設權杖更新密碼
 *    - POST /login             登入(支援 2FA:otp / challenge;組織強制 2FA 未啟用者回設定流程)
 *    - POST /2fa/enroll/verify 組織強制 2FA 設定流程第二步:驗證掃碼碼 → 啟用並發正式 token + 備援碼
 *    - GET  /2fa/status        2FA 狀態
 *    - POST /2fa/setup|enable|disable  2FA 設定
 *  一律走 {ok,data,error} 信封(apiFetch 已解包 data);公開端點以 auth:false 不帶 Bearer。 */
import { apiFetch, ApiError } from "./client";
import { STORAGE_KEYS } from "@/lib/config";
import { useAuth } from "@/stores/auth";

/* ------------------------------ 登入(含 2FA) ------------------------------ */
export interface LoginAttemptResult {
  /** 已啟用 2FA 且尚未帶 OTP → 後端回此旗標與 challenge,不發正式 token。 */
  requires_2fa?: boolean;
  challenge?: string;
  /** 組織強制 2FA 但坐席「尚未啟用」→ 後端不發正式 token,回此旗標與設定流程所需資料。 */
  requires_2fa_enrollment?: boolean;
  /** 設定流程專用的短時效 challenge(purpose=2fa_enroll),供 enrollVerify2fa 帶回。 */
  enroll_challenge?: string;
  /** TOTP 密鑰(手動輸入用) */
  secret?: string;
  /** otpauth:// URI(供產生 / 掃描 QR,或作為連結文字) */
  otpauth_uri?: string;
  /** TOTP 位數與週期(供顯示 / 校時提示) */
  digits?: number;
  period?: number;
  access_token?: string;
  token_type?: string;
  staff_id?: string;
  is_platform_admin?: boolean;
}

/** /2fa/enroll/verify 成功回傳:啟用 2FA 並自動登入,附一次性備援碼(僅此次回傳)。 */
export interface EnrollVerifyResult {
  access_token: string;
  token_type?: string;
  staff_id: string;
  is_platform_admin: boolean;
  /** 一次性備援碼明文(僅本次回傳,需提示使用者妥善保存) */
  recovery_codes?: string[];
}

export interface LoginBody {
  email?: string;
  password?: string;
  /** 2FA 驗證碼(可與 email/password 一次送出) */
  otp?: string;
  /** 2FA 第一步後回帶的 challenge(免再送密碼) */
  challenge?: string;
}

/** 直接呼叫後端 /auth/login(支援 2FA)。回傳原始結果(可能為 requires_2fa / requires_2fa_enrollment)。 */
export function loginRequest(body: LoginBody): Promise<LoginAttemptResult> {
  return apiFetch<LoginAttemptResult>("/api/v1/auth/login", {
    method: "POST",
    body,
    auth: false,
  });
}

/**
 * 組織強制 2FA 設定流程第二步:以 login 回的 enroll_challenge + 驗證器動態碼完成綁定。
 * 成功即啟用 2FA 並發正式 token,另附一次性備援碼(需提示保存)。公開端點(以 challenge 認證,不帶 Bearer)。
 * 失敗丟 ApiError:INVALID_OTP(碼錯)、INVALID_TOKEN / TWOFA_NOT_SETUP(challenge 失效)、429(次數過多)。
 */
export function enrollVerify2fa(arg: { challenge: string; code: string }): Promise<EnrollVerifyResult> {
  return apiFetch<EnrollVerifyResult>("/api/v1/auth/2fa/enroll/verify", {
    method: "POST",
    body: arg,
    auth: false,
  });
}

/**
 * 完成登入:寫入 token 並同步 auth store(等同 stores/auth.login 的收尾),再載入 /me。
 * 供 2FA / 註冊等自訂流程共用;透過 store 的 setState/getState 公開 API 更新,不改 store 檔。
 */
export async function finalizeSession(res: LoginAttemptResult): Promise<void> {
  if (!res.access_token) throw new ApiError("NO_TOKEN", "登入回應缺少 token");
  try {
    localStorage.setItem(STORAGE_KEYS.token, res.access_token);
  } catch {
    /* localStorage 不可用時仍以記憶體 state 運作 */
  }
  useAuth.setState({
    token: res.access_token,
    isPlatformAdmin: Boolean(res.is_platform_admin),
    status: "loading",
    error: null,
  });
  await useAuth.getState().loadMe();
  useAuth.setState({ status: "authed" });
}

/* -------------------------------- 自助註冊 -------------------------------- */
export interface RegisterInput {
  email: string;
  password: string;
  tenant_name: string;
  display_name?: string;
  slug?: string;
}

export function registerRequest(input: RegisterInput): Promise<LoginAttemptResult> {
  return apiFetch<LoginAttemptResult>("/api/v1/auth/register", {
    method: "POST",
    body: input,
    auth: false,
  });
}

/* ----------------------------- 忘記 / 重設密碼 ----------------------------- */
export interface ForgotPasswordResult {
  message: string;
  /** 僅 dev / 測試環境回傳(正式環境不外洩) */
  email_sent?: boolean;
  debug_tokens?: { tenant_id: string; token: string }[];
}

export function forgotPasswordRequest(email: string): Promise<ForgotPasswordResult> {
  return apiFetch<ForgotPasswordResult>("/api/v1/auth/forgot-password", {
    method: "POST",
    body: { email },
    auth: false,
  });
}

export function resetPasswordRequest(
  token: string,
  new_password: string,
): Promise<{ staff_id: string; password_reset: boolean }> {
  return apiFetch<{ staff_id: string; password_reset: boolean }>("/api/v1/auth/reset-password", {
    method: "POST",
    body: { token, new_password },
    auth: false,
  });
}

/* --------------------------------- 2FA/TOTP --------------------------------- */
export interface TwoFaStatus {
  totp_enabled: boolean;
  has_secret: boolean;
}
export interface TwoFaSetupResult {
  secret: string;
  otpauth_uri: string;
  digits: number;
  period: number;
}

export const twoFaApi = {
  /** 目前登入坐席的 2FA 狀態(需 Bearer)。 */
  status: () => apiFetch<TwoFaStatus>("/api/v1/auth/2fa/status"),
  /** 產生新密鑰(未啟用),回 otpauth URI 供掃碼 / 手動加入。 */
  setup: () => apiFetch<TwoFaSetupResult>("/api/v1/auth/2fa/setup", { method: "POST" }),
  /** 以驗證器 App 產生的 code 啟用。 */
  enable: (code: string) =>
    apiFetch<{ totp_enabled: boolean }>("/api/v1/auth/2fa/enable", {
      method: "POST",
      body: { code },
    }),
  /** 停用:需帶有效 OTP 或帳號密碼(擇一)。 */
  disable: (arg: { code?: string; password?: string }) =>
    apiFetch<{ totp_enabled: boolean }>("/api/v1/auth/2fa/disable", {
      method: "POST",
      body: arg,
    }),
};
