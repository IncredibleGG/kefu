/** ============================================================
 *  伺服器位址與 token 的單一來源(docs/NATIVE-CLIENTS.md §3)。
 *  - web:沿用建置期 config.apiBase(""=同源,經 nginx 反代),hasServer() 恆為 true。
 *  - 原生殼(Tauri / Capacitor):伺服器由使用者在 App 內設定,存在原生持久儲存,
 *    啟動時由 initPlatform() 讀進 localStorage(kefu-server)作為同步鏡像。
 *  - token:整個前端只有本檔 getToken / setToken / clearToken 會碰 kefu-token。
 *  ============================================================ */
import { config, STORAGE_KEYS } from "@/lib/config";
import { appVersion, isNative, nativeStorageSet } from "@/lib/platform";

export type ServerInfo = {
  app: string;
  api_version: number;
  server_version?: string;
  min_app_version?: string;
  features: { google_sso: boolean; saml: boolean; push: boolean };
};

/** 預設伺服器(原生殼首次啟動時預填)。 */
export const DEFAULT_SERVER: string = (
  (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) || "https://kf.56k.cc"
).replace(/\/+$/, "");

/* ------------------------------ 安全的 localStorage ------------------------------ */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* localStorage 不可用時僅以原生儲存 / 記憶體運作 */
  }
}
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/* ---------------------------------- 伺服器 ---------------------------------- */

/** API 基底(不含尾斜線)。web:config.apiBase(""=同源);native:已存伺服器或 ""。 */
export function getServerBase(): string {
  if (!isNative) return config.apiBase.replace(/\/+$/, "");
  return (lsGet(STORAGE_KEYS.server) ?? "").replace(/\/+$/, "");
}

/** 絕對 origin(給人 / 第三方的連結:webhook、嵌入碼、邀請連結…)。
 *  web 且 base 為空(同源部署)時 = window.location.origin。 */
export function getServerOrigin(): string {
  const base = getServerBase();
  if (base) return base;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

/** 伺服器 host(白牌品牌查詢用;原生殼不可用 window.location.host,那會是 localhost)。 */
export function serverHost(): string {
  try {
    return new URL(getServerOrigin()).host;
  } catch {
    return "";
  }
}

/** 是否已設定伺服器。web 恆為 true。 */
export function hasServer(): boolean {
  if (!isNative) return true;
  return Boolean(getServerBase());
}

/** normalizeServerUrl 失敗時丟出的錯誤(code 供 UI 對應翻譯)。 */
export class ServerUrlError extends Error {
  code: "empty" | "invalid_url" | "https_required";
  constructor(code: ServerUrlError["code"]) {
    super(code);
    this.name = "ServerUrlError";
    this.code = code;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 正規化使用者輸入的伺服器網址:補 https://、去掉路徑 / 查詢 / 尾斜線,只留 origin。
 * 原生殼只接受 https(localhost / 127.0.0.1 開發用除外;iOS ATS 與 Android 明文限制也會擋 http)。
 * 不合法時丟 ServerUrlError。
 */
export function normalizeServerUrl(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) throw new ServerUrlError("empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new ServerUrlError("invalid_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ServerUrlError("invalid_url");
  if (!u.hostname || u.username || u.password) throw new ServerUrlError("invalid_url");
  if (isNative && u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname)) {
    throw new ServerUrlError("https_required");
  }
  return `${u.protocol}//${u.host}`;
}

/** 讀取信封 / 原始 JSON;失敗回 null。 */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** 帶逾時的 GET(不帶 token;探測用)。 */
async function probeGet(url: string, timeoutMs = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探測伺服器:GET {url}/health(需 ok 且 data.status==="up"),再 GET /api/v1/public/server-info。
 * 舊版伺服器沒有 server-info(404)→ info 為 undefined,仍視為 ok。永不拋錯。
 * error 碼:empty / invalid_url / https_required / unreachable / not_kefu。
 */
export async function probeServer(
  url: string,
): Promise<{ ok: boolean; info?: ServerInfo; error?: string }> {
  let base: string;
  try {
    base = normalizeServerUrl(url);
  } catch (e) {
    return { ok: false, error: e instanceof ServerUrlError ? e.code : "invalid_url" };
  }

  try {
    const res = await probeGet(`${base}/health`);
    const j = (await readJson(res)) as { ok?: boolean; data?: { status?: string } } | null;
    if (!res.ok || !j?.ok || j.data?.status !== "up") return { ok: false, error: "not_kefu" };
  } catch {
    return { ok: false, error: "unreachable" };
  }

  try {
    const res = await probeGet(`${base}/api/v1/public/server-info`);
    if (res.status === 404) return { ok: true };
    if (!res.ok) return { ok: true };
    const j = (await readJson(res)) as { ok?: boolean; data?: ServerInfo } | ServerInfo | null;
    const data = (j && "data" in j ? j.data : j) as ServerInfo | null | undefined;
    if (data && typeof data === "object" && typeof data.app === "string") {
      if (data.app !== "kefu") return { ok: false, error: "not_kefu" };
      return { ok: true, info: data };
    }
    return { ok: true };
  } catch {
    // server-info 不可用不影響連線(舊版伺服器)
    return { ok: true };
  }
}

/** 比較語意化版本 a < b(只比數字段)。 */
function versionLess(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** 伺服器要求的最低 App 版本是否高於目前 App(需提示更新)。 */
export function isAppOutdated(info?: ServerInfo | null): boolean {
  if (!info?.min_app_version || !appVersion) return false;
  return versionLess(appVersion, info.min_app_version);
}

const serverListeners = new Set<() => void>();

/** 訂閱伺服器變更(setServerBase 完成後觸發)。回傳取消函式。 */
export function onServerChange(cb: () => void): () => void {
  serverListeners.add(cb);
  return () => {
    serverListeners.delete(cb);
  };
}

const setupListeners = new Set<() => void>();

/** 要求顯示「伺服器設定」畫面(例如登入頁的「更換伺服器」按鈕)。由 ServerGate 響應。 */
export function requestServerSetup(): void {
  setupListeners.forEach((l) => l());
}

/** ServerGate 用:訂閱「顯示伺服器設定」請求。 */
export function onServerSetupRequest(cb: () => void): () => void {
  setupListeners.add(cb);
  return () => {
    setupListeners.delete(cb);
  };
}

/** 換伺服器時的清理掛勾(由 stores/auth 註冊,避免本檔反向依賴 store / query / realtime)。 */
export interface ServerSwitchHooks {
  /** 在舊伺服器上正常登出(含撤銷推播裝置) */
  logout: () => Promise<void>;
  /** 清空登入狀態、Query 快取、即時連線 */
  reset: () => void;
}
let switchHooks: ServerSwitchHooks | null = null;

export function registerServerSwitchHooks(h: ServerSwitchHooks): void {
  switchHooks = h;
}

/**
 * 設定伺服器(寫入原生持久儲存 + localStorage 鏡像)並觸發 onServerChange。
 * 伺服器改變時依序:(舊伺服器上登出並撤銷裝置)→ clearToken → 移除 kefu-auth →
 * queryClient.clear() + agentSocket.disconnect()(stores/auth 註冊的 reset)→ onServerChange
 * (main.tsx 於此重新 bootstrapBranding())。
 * 網址不合法時丟 ServerUrlError。
 */
export async function setServerBase(url: string): Promise<void> {
  const next = normalizeServerUrl(url);
  // web 的伺服器由建置期決定(同源),不提供執行期切換
  if (!isNative) return;
  const prev = getServerBase();
  const changed = prev !== next;

  // 換伺服器:先在舊伺服器上走正常登出(撤銷推播裝置需要舊 base + 舊 token)
  if (changed && prev && getToken() && switchHooks) {
    try {
      await switchHooks.logout();
    } catch {
      /* 盡力而為 */
    }
  }

  lsSet(STORAGE_KEYS.server, next);
  await nativeStorageSet("server", next);

  if (changed) {
    clearToken();
    lsRemove(STORAGE_KEYS.auth);
    try {
      switchHooks?.reset();
    } catch {
      /* 忽略 */
    }
  }

  serverListeners.forEach((l) => {
    try {
      l();
    } catch {
      /* 單一監聽者錯誤不影響其他 */
    }
  });
}

/* ---------------------------------- URL 組裝 ---------------------------------- */

/** REST URL:base + path + ?qs(略過 undefined / null)。取代舊 client.ts buildUrl。 */
export function apiUrl(path: string, params?: Record<string, unknown>): string {
  const base = getServerBase();
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
  }
  const query = qs.toString();
  // base 為空字串 → 走同源相對路徑(可置於任意網域/CF 隧道後,經 nginx 反代)
  const full = base + path;
  return query ? `${full}${full.includes("?") ? "&" : "?"}${query}` : full;
}

/** WebSocket URL:http→ws、https→wss;base 為空時用目前頁面 origin(同源經 nginx 反代 /ws)。 */
export function wsUrl(path: string, params?: Record<string, string>): string {
  const base =
    getServerBase() ||
    (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "");
  const wsBase = base.replace(/^http/i, "ws");
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, v);
    }
  }
  const query = qs.toString();
  return query ? `${wsBase}${path}?${query}` : `${wsBase}${path}`;
}

/** 檔案 / 圖片網址:"/…" 相對路徑補上伺服器前綴;絕對網址與其他值原樣回傳;空值回 null。 */
export function fileUrl(u?: string | null): string | null {
  if (!u) return null;
  if (/^\/(?!\/)/.test(u)) return getServerBase() + u;
  return u;
}

/** 給人 / 第三方的公開網址:getServerOrigin() + path。 */
export function publicUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return getServerOrigin() + p;
}

/* ----------------------------------- token ----------------------------------- */

/** 目前登入 token(同步讀 localStorage 鏡像)。 */
export function getToken(): string | null {
  return lsGet(STORAGE_KEYS.token);
}

/** 寫入 token:同步寫 localStorage,非同步寫原生持久儲存。 */
export function setToken(t: string): void {
  lsSet(STORAGE_KEYS.token, t);
  void nativeStorageSet("token", t);
}

/** 清除 token(localStorage + 原生持久儲存)。 */
export function clearToken(): void {
  lsRemove(STORAGE_KEYS.token);
  void nativeStorageSet("token", null);
}
