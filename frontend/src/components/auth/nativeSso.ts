/** ============================================================
 *  原生 SSO(PKCE)流程(docs/NATIVE-CLIENTS.md §4.1)。Web 的 SSO 不經過這裡(維持整頁導向 + #sso_token)。
 *
 *  1. beginNativeSso():產生 verifier / S256 challenge / state,暫存 localStorage(5 分鐘),
 *     以系統瀏覽器開啟 {server}/api/v1/auth/oauth/google/start(SAML:/api/v1/saml/login/{slug})
 *     ?client=native&redirect_uri=kefu://auth/callback&state&code_challenge&code_challenge_method=S256。
 *  2. 後端完成後 302 回 kefu://auth/callback?code&state(或 ?sso_error&state),由 platform.onDeepLink 收到。
 *  3. resolveNativeSsoCallback():比對 state 與伺服器 → 取出 verifier(單次使用)→
 *     POST /api/v1/auth/sso/exchange {code, code_verifier} → 呼叫端以 finalizeSession 完成登入。
 *
 *  安全:verifier 只存在本機 localStorage(App 在系統瀏覽器登入期間被系統回收、冷啟動收到回呼時仍讀得到;
 *  sessionStorage / 記憶體會隨程序消失),5 分鐘逾時、用過 / 逾時 / 開瀏覽器失敗即清除;不進網址、不寫日誌。
 *  state 不符時不兌換也不清掉暫存(避免偽造連結打斷正在進行的正常流程)。code / token 一律不 console 輸出。
 *  ============================================================ */
import type { TFunction } from "i18next";
import { platform, startExternalAuth } from "@/lib/platform";
import { apiUrl, getServerBase } from "@/lib/server";
import { createPkcePair, createState } from "@/lib/pkce";
import { ApiError } from "@/api/client";
import type { LoginAttemptResult } from "@/api/authExtra";
import { ssoExchange } from "./loginApi";
import { NATIVE_REDIRECT_URI, type AuthCallback } from "./links";

export type SsoProvider = "google" | "saml";

const PENDING_KEY = "kefu-sso-pending";
/** 暫存效期(後端 nonce 600 秒、code 60 秒;App 端 5 分鐘內沒回來就要重來)。 */
export const PENDING_TTL_MS = 5 * 60_000;

interface PendingSso {
  state: string;
  verifier: string;
  provider: SsoProvider;
  server: string;
  slug?: string;
  at: number;
}

function lsGet(): string | null {
  try {
    return localStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}
function lsSet(v: string | null): void {
  try {
    if (v == null) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, v);
  } catch {
    /* localStorage 不可用:流程仍可在同一個頁面生命週期內以記憶體完成 */
  }
}

/** localStorage 不可用時的記憶體後備。 */
let memPending: PendingSso | null = null;

function savePending(p: PendingSso): void {
  memPending = p;
  lsSet(JSON.stringify(p));
}

/** 讀取尚未過期的暫存;過期即清除。 */
export function readPendingSso(): PendingSso | null {
  let p: PendingSso | null = null;
  const raw = lsGet();
  if (raw) {
    try {
      const v = JSON.parse(raw) as PendingSso;
      if (v && typeof v.state === "string" && typeof v.verifier === "string") p = v;
    } catch {
      p = null;
    }
  }
  if (!p) p = memPending;
  if (!p) return null;
  if (!Number.isFinite(p.at) || Date.now() - p.at > PENDING_TTL_MS) {
    clearPendingSso();
    return null;
  }
  return p;
}

export function clearPendingSso(): void {
  memPending = null;
  lsSet(null);
}

/** 組 SSO 起點網址(伺服器 base + 路徑 + PKCE 參數)。 */
export function buildSsoStartUrl(
  provider: SsoProvider,
  params: { state: string; challenge: string; slug?: string },
): string {
  const path =
    provider === "saml"
      ? `/api/v1/saml/login/${encodeURIComponent(params.slug ?? "")}`
      : "/api/v1/auth/oauth/google/start";
  return apiUrl(path, {
    client: "native",
    redirect_uri: NATIVE_REDIRECT_URI,
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
  });
}

/**
 * 開始原生 SSO:暫存 PKCE 狀態並以系統瀏覽器開啟起點。
 * SAML 需要工作區 slug。失敗丟錯(呼叫端顯示「無法開啟瀏覽器」)。
 */
export async function beginNativeSso(provider: SsoProvider, slug?: string): Promise<void> {
  const server = getServerBase();
  if (!server) throw new Error("no server");
  if (provider === "saml" && !slug) throw new Error("slug required");
  const { verifier, challenge } = await createPkcePair();
  const state = createState();
  savePending({ state, verifier, provider, server, slug, at: Date.now() });
  try {
    await startExternalAuth(buildSsoStartUrl(provider, { state, challenge, slug }));
  } catch (e) {
    clearPendingSso();
    throw e;
  }
}

/** 關掉 App 內的系統瀏覽器面板(iOS SFSafariViewController 不會自己關)。永不拋錯。 */
export async function closeAuthBrowser(): Promise<void> {
  if (platform !== "capacitor") return;
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.close();
  } catch {
    /* Android Custom Tabs 已自行關閉 / 本來就沒開:忽略 */
  }
}

/** 常數時間字串比較(state 比對)。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export type NativeSsoOutcome =
  /** 不是這次流程的回呼(沒有進行中的流程):忽略 */
  | { kind: "ignored" }
  /** 失敗(錯誤碼見 nativeSsoErrorText) */
  | { kind: "error"; code: string; provider?: SsoProvider }
  /** 兌換成功:呼叫端 finalizeSession(result) */
  | { kind: "ok"; result: LoginAttemptResult; provider: SsoProvider };

/** 同一條回呼網址只處理一次(平台層會把冷啟動的 deep link 重播給後來的訂閱者)。 */
const handled = new Set<string>();

/** 處理 kefu://auth/callback。 */
export async function resolveNativeSsoCallback(rawUrl: string, cb: AuthCallback): Promise<NativeSsoOutcome> {
  if (handled.has(rawUrl)) return { kind: "ignored" };
  handled.add(rawUrl);

  const pending = readPendingSso();
  if (!pending) return { kind: "error", code: "SSO_EXPIRED" };
  if (!cb.state || !safeEqual(cb.state, pending.state)) {
    // 不是我們發起的回呼:不兌換,也不清掉正在進行的流程
    return { kind: "error", code: "SSO_STATE_MISMATCH", provider: pending.provider };
  }
  clearPendingSso();
  void closeAuthBrowser();

  if (pending.server !== getServerBase()) {
    return { kind: "error", code: "SSO_EXPIRED", provider: pending.provider };
  }
  if (cb.ssoError) return { kind: "error", code: cb.ssoError, provider: pending.provider };
  if (!cb.code) return { kind: "error", code: "OAUTH_FAILED", provider: pending.provider };

  try {
    const result = await ssoExchange({ code: cb.code, code_verifier: pending.verifier });
    return { kind: "ok", result, provider: pending.provider };
  } catch (err) {
    if (err instanceof ApiError) {
      return { kind: "error", code: err.httpStatus === 429 ? "RATE_LIMITED" : err.code, provider: pending.provider };
    }
    return { kind: "error", code: "NETWORK", provider: pending.provider };
  }
}

/** sso_error / 兌換錯誤碼 → 使用者看得懂的訊息。 */
export function nativeSsoErrorText(t: TFunction, code: string, provider?: SsoProvider): string {
  switch (code) {
    case "SSO_DISABLED":
      return provider === "saml"
        ? t("native.login.sso.errSamlDisabled", "此工作區尚未啟用 SAML 單一登入,請聯絡管理員")
        : t("auth.ssoDisabled", { defaultValue: "尚未設定 Google 單一登入,請聯絡管理員" });
    case "SSO_NOT_INVITED":
      return t("native.login.sso.errNotInvited", "此帳號未被邀請加入工作區,請聯絡管理員");
    case "SSO_UNAVAILABLE":
      return t("native.login.sso.errUnavailable", "單一登入服務暫時無法使用,請稍後再試");
    case "INVALID_REQUEST":
      return t("native.login.sso.errInvalidRequest", "登入請求無效,請更新 App 後再試");
    case "SSO_EXPIRED":
    case "OAUTH_STATE_INVALID":
    case "SAML_STATE_INVALID":
      return t("native.login.sso.errExpired", "登入階段已逾時,請重新登入");
    case "SSO_STATE_MISMATCH":
    case "INVALID_CODE":
    case "INVALID_CODE_VERIFIER":
      return t("native.login.sso.errVerify", "登入驗證失敗,請重新登入");
    case "LOGIN_IP_BLOCKED":
      return t("native.login.sso.errIpBlocked", "目前的網路位址不在允許登入的名單內,請聯絡管理員");
    case "TWOFA_ENROLL_REQUIRED":
      return t("native.login.sso.err2faEnroll", "組織要求兩步驗證,請改用帳號密碼登入完成設定");
    case "TENANT_SUSPENDED":
      return t("native.login.sso.errSuspended", "此工作區已停用,請聯絡管理員");
    case "RATE_LIMITED":
      return t("native.login.sso.errRateLimited", "嘗試次數過多,請稍後再試");
    case "NETWORK":
      return t("native.login.sso.errNetwork", "無法連線到伺服器,請檢查網路後再試");
    default:
      return provider === "saml"
        ? t("native.login.sso.errSamlFailed", "SAML 單一登入失敗,請重試")
        : t("auth.ssoFailed", { defaultValue: "Google 登入失敗,請重試" });
  }
}
