/** 企業安全設定 API(乾淨室自建;**不改 endpoints.ts / client.ts / authExtra.ts**)。
 *  對齊後端 app/api/v1/auth.py(router 前綴 /api/v1/auth):
 *    - GET  /security-policy                    取租戶安全政策(強制 2FA / IP 白名單 + 當前 IP)
 *    - PUT  /security-policy                    更新政策(自鎖護欄:非空名單須含當前 IP)
 *    - GET  /2fa/status                         2FA 狀態(含備援碼剩餘數)
 *    - POST /2fa/recovery-codes/regenerate      重新產生備援碼(回明文,僅此次)
 *  一律走 {ok,data,error} 信封(apiFetch 已解包 data),皆需 Bearer。 */
import { apiFetch } from "./client";

/** 租戶企業安全政策。current_ip 為呼叫者目前真實來源 IP(供設定白名單時避免自鎖)。 */
export interface SecurityPolicy {
  require_2fa: boolean;
  login_ip_allowlist: string[];
  current_ip: string;
}

/** 更新政策的輸入(皆選填;傳入即覆寫)。 */
export interface SecurityPolicyUpdate {
  require_2fa?: boolean;
  login_ip_allowlist?: string[];
}

/** 2FA 狀態(擴充版:含備援碼資訊)。 */
export interface TwoFaStatusFull {
  totp_enabled: boolean;
  has_secret: boolean;
  recovery_codes_remaining: number;
  recovery_codes_generated: boolean;
}

export const securityApi = {
  /** 取本租戶安全政策(需 settings.manage)。 */
  getPolicy: () => apiFetch<SecurityPolicy>("/api/v1/auth/security-policy"),

  /** 更新本租戶安全政策(需 settings.manage;僅送出有變更的欄位)。 */
  updatePolicy: (body: SecurityPolicyUpdate) =>
    apiFetch<SecurityPolicy>("/api/v1/auth/security-policy", { method: "PUT", body }),

  /** 目前登入坐席的 2FA 狀態(含備援碼剩餘數)。 */
  twoFaStatus: () => apiFetch<TwoFaStatusFull>("/api/v1/auth/2fa/status"),

  /** 重新產生一組備援碼(作廢舊碼);回新碼明文(僅此次可見)。 */
  regenerateRecoveryCodes: () =>
    apiFetch<{ recovery_codes: string[]; count: number }>(
      "/api/v1/auth/2fa/recovery-codes/regenerate",
      { method: "POST" },
    ),
};
