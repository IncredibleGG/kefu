/** 企業 SSO(SAML 2.0 + SCIM 2.0)設定 API(乾淨室自建;**不改 endpoints.ts / client.ts**)。
 *  對齊後端 app/api/v1/saml.py(router 前綴 /api/v1/saml):
 *    - GET  /config        取本租戶 SSO 設定 + 衍生 SP/SCIM URL(不回 bearer 雜湊)
 *    - PUT  /config        upsert SAML/SCIM 設定(僅送出有變更的欄位)
 *    - POST /scim-token     產生 / 輪替 SCIM bearer 權杖(回明文,僅此次)
 *  SCIM 協定端點(/api/v1/scim/v2/Users…)由 IdP 直呼,前端不使用。
 *  一律走 {ok,data,error} 信封(apiFetch 已解包 data),皆需 settings.manage。 */
import { apiFetch } from "./client";

/** 本租戶 SSO 設定 + 衍生 SP/SCIM URL(唯讀值供貼入 IdP)。 */
export interface SsoConfig {
  saml_enabled: boolean;
  saml_idp_entity_id: string | null;
  saml_idp_sso_url: string | null;
  saml_idp_x509_cert: string | null;
  scim_enabled: boolean;
  /** 是否已產生 SCIM bearer(僅回布林,不回明文 / 雜湊)。 */
  scim_token_set: boolean;
  default_role: string | null;
  /** 以下為後端衍生的唯讀值。 */
  sp_entity_id: string;
  sp_acs_url: string;
  sp_metadata_url: string;
  scim_base_url: string;
  /** 目前簽章驗證能力:full=完整 XML-DSig;structural=結構驗證(需加 python3-saml 才完整)。 */
  signature_verification: "full" | "structural";
}

/** 更新輸入(皆選填;傳入即覆寫,字串傳空字串等同清空)。 */
export interface SsoConfigUpdate {
  saml_enabled?: boolean;
  saml_idp_entity_id?: string | null;
  saml_idp_sso_url?: string | null;
  saml_idp_x509_cert?: string | null;
  saml_sp_acs_url?: string | null;
  scim_enabled?: boolean;
  default_role?: string | null;
}

/** 產生 SCIM 權杖的回傳(明文僅此次可見)。 */
export interface ScimTokenResult {
  token: string;
  scim_base_url: string;
  note: string;
}

export const ssoApi = {
  /** 取本租戶 SSO 設定(需 settings.manage)。 */
  getConfig: () => apiFetch<SsoConfig>("/api/v1/saml/config"),

  /** upsert 本租戶 SSO 設定(需 settings.manage;僅送出有變更的欄位)。 */
  updateConfig: (body: SsoConfigUpdate) =>
    apiFetch<SsoConfig>("/api/v1/saml/config", { method: "PUT", body }),

  /** 產生 / 輪替 SCIM bearer 權杖(作廢舊權杖);回新權杖明文(僅此次可見)。 */
  generateScimToken: () =>
    apiFetch<ScimTokenResult>("/api/v1/saml/scim-token", { method: "POST" }),
};
