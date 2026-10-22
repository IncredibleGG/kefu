/** ============================================================
 *  原生 deep link 解析與外部連結(docs/NATIVE-CLIENTS.md §2 Deep link)。
 *  - kefu://setup?server=…           佈建連結:只回正規化後的伺服器,**套用前一律要使用者確認**。
 *  - kefu://auth/callback?code&state 原生 SSO 回呼;失敗為 ?sso_error=CODE&state=…
 *  不同平台對自訂 scheme 的解析不一致(host=auth、pathname=/callback,或 pathname=//auth/callback,
 *  Windows 可能多一個尾斜線),一律把 host + pathname 合併後去掉多餘斜線再比對。
 *  ============================================================ */
import { isMobileApp, openExternal } from "@/lib/platform";
import { normalizeServerUrl } from "@/lib/server";

export const KEFU_SCHEME = "kefu:";
/** 原生 SSO 的 redirect_uri(必須與後端 KEFU_NATIVE_REDIRECT_URIS 完全相等)。 */
export const NATIVE_REDIRECT_URI = "kefu://auth/callback";

/** 把 kefu:// 連結解析成 { target: "auth/callback", params }。非 kefu:// 或解析失敗回 null。 */
function parseKefuUrl(url: string): { target: string; params: URLSearchParams } | null {
  if (typeof url !== "string" || url.length > 4096) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol.toLowerCase() !== KEFU_SCHEME) return null;
  const target = `${u.host}/${u.pathname}`
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return { target, params: u.searchParams };
}

/** kefu://setup?server=… → 正規化後的伺服器網址;非佈建連結或網址不合法回 null。 */
export function parseSetupLink(url: string): string | null {
  const p = parseKefuUrl(url);
  if (!p || p.target !== "setup") return null;
  const server = p.params.get("server");
  if (!server) return null;
  try {
    return normalizeServerUrl(server);
  } catch {
    return null;
  }
}

export interface AuthCallback {
  state: string;
  code?: string;
  ssoError?: string;
}

/** kefu://auth/callback?… → { state, code | ssoError };非 SSO 回呼或缺必要參數回 null。 */
export function parseAuthCallback(url: string): AuthCallback | null {
  const p = parseKefuUrl(url);
  if (!p || p.target !== "auth/callback") return null;
  const state = p.params.get("state") ?? "";
  const code = p.params.get("code") ?? "";
  const ssoError = p.params.get("sso_error") ?? "";
  if (ssoError) return { state, ssoError: ssoError.slice(0, 64) };
  if (!code || !state) return null;
  return { state, code };
}

/**
 * 以系統開啟 otpauth:// 連結(交給手機上的驗證器 App)。
 * 手機:由 Capacitor WebView 的導覽攔截交給系統開啟(platform.openExternal 目前只放行 http/mailto/tel);
 * 其他平台走 platform.openExternal(放行規則由平台層決定)。只接受 otpauth://。
 */
export async function openOtpauth(uri: string): Promise<void> {
  if (!/^otpauth:\/\//i.test(uri)) return;
  if (isMobileApp) {
    try {
      window.location.href = uri;
    } catch {
      /* 沒有可處理的 App 時忽略,使用者仍可手動輸入密鑰 */
    }
    return;
  }
  await openExternal(uri);
}
