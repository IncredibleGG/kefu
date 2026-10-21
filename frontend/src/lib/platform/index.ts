/** ============================================================
 *  平台層(docs/NATIVE-CLIENTS.md §3):同一份 React 程式碼在 web / Tauri 桌面 / Capacitor 手機
 *  三種環境執行,所有原生差異都收斂在這裡。
 *  - 偵測:"__TAURI_INTERNALS__" in window → tauri;window.Capacitor?.isNativePlatform?.() → capacitor;否則 web。
 *  - 原生外掛一律在對應 adapter(tauri.ts / capacitor.ts)內 **動態 import**,web bundle 不執行任何原生程式碼;
 *    adapter 本身也是動態載入。
 *  - initPlatform() 必須在 main.tsx render 前 await:讀原生儲存 → localStorage、裝連結攔截器、
 *    resume / pause / online / deep-link 監聽、原生環境解除 Service Worker。
 *  ============================================================ */
import { STORAGE_KEYS } from "@/lib/config";
import { fileUrl, publicUrl } from "@/lib/server";
import { createWebAdapter } from "./web";

export type PlatformKind = "web" | "tauri" | "capacitor";
export type OsKind = "windows" | "macos" | "linux" | "ios" | "android" | "web";
/** 原生持久儲存的鍵名(桌面 tauri-plugin-store `kefu.json`、手機 @capacitor/preferences)。 */
export type NativeKey = "server" | "token" | "deviceId";
export type NotificationPermissionState = "granted" | "denied" | "default";

export interface NotifyInput {
  title: string;
  body?: string;
  tag?: string;
  sessionId?: string;
}

/** adapter 回呼平台層的掛勾(事件統一由 index 分發)。 */
export interface AdapterHooks {
  emitDeepLink: (url: string) => void;
  emitPushTap: (data: Record<string, string>) => void;
  emitOnline: () => void;
  /** 前景狀態可能改變(adapter 內部狀態更新後呼叫),由 index 比對後發 resume / pause。 */
  refreshForeground: () => void;
}

export interface AdapterInitResult {
  os?: OsKind;
  appVersion?: string;
  osVersion?: string;
  /** 原生儲存讀出的值(undefined / null = 原生端沒有)。 */
  storage?: Partial<Record<NativeKey, string | null>>;
}

/** 各平台 adapter 必須實作的介面(web.ts / tauri.ts / capacitor.ts)。 */
export interface Adapter {
  init(hooks: AdapterHooks): Promise<AdapterInitResult>;
  storageSet(key: NativeKey, value: string | null): Promise<void>;
  notificationSupported(): boolean;
  getNotificationPermission(): Promise<NotificationPermissionState>;
  requestNotificationPermission(): Promise<boolean>;
  notify(o: NotifyInput): Promise<boolean>;
  setBadge(count: number): Promise<void>;
  isAppForeground(): boolean;
  openExternal(url: string): Promise<void>;
  saveFile(blob: Blob, filename: string): Promise<void>;
  startExternalAuth(url: string): Promise<void>;
  pushRegister(): Promise<{ token: string } | null>;
  /** 首次 render 完成(手機:隱藏啟動畫面)。 */
  appReady?(): void;
}

/* ---------------------------------- 偵測 ---------------------------------- */
type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string };

function capacitorGlobal(): CapacitorGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

function detectPlatform(): PlatformKind {
  if (typeof window === "undefined") return "web";
  if ("__TAURI_INTERNALS__" in window) return "tauri";
  try {
    if (capacitorGlobal()?.isNativePlatform?.()) return "capacitor";
  } catch {
    /* 忽略 */
  }
  return "web";
}

export const platform: PlatformKind = detectPlatform();
export const isNative: boolean = platform !== "web";
export const isDesktopApp: boolean = platform === "tauri";
export const isMobileApp: boolean = platform === "capacitor";

function guessOs(): OsKind {
  if (platform === "web") return "web";
  if (platform === "capacitor") {
    const p = capacitorGlobal()?.getPlatform?.();
    if (p === "ios" || p === "android") return p;
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  return "linux";
}

/** 作業系統(initPlatform 後以原生外掛校正;ESM live binding,匯入端讀到的是最新值)。 */
export let os: OsKind = guessOs();
/** App 版本(建置期 package.json 版本;initPlatform 後以原生 App 版本校正)。 */
export let appVersion: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
/** 系統版本(可能為空字串)。 */
export let osVersion = "";

let impl: Adapter = createWebAdapter();

/* ---------------------------------- 事件 ---------------------------------- */
type Cb<T> = (v: T) => void;
const resumeL = new Set<() => void>();
const pauseL = new Set<() => void>();
const onlineL = new Set<() => void>();
const deepL = new Set<Cb<string>>();
const pushL = new Set<Cb<Record<string, string>>>();

/** 冷啟動時(監聽者尚未掛上)抵達的 deep link / 推播點擊暫存一段時間,讓之後訂閱者仍收得到。 */
const PENDING_MS = 30_000;
const pendingDeep: { v: string; at: number }[] = [];
const pendingPush: { v: Record<string, string>; at: number }[] = [];

function prune<T>(arr: { v: T; at: number }[]) {
  const now = Date.now();
  while (arr.length && now - arr[0].at > PENDING_MS) arr.shift();
  if (arr.length > 20) arr.splice(0, arr.length - 20);
}

function safeCall<T>(cb: Cb<T>, v: T) {
  try {
    cb(v);
  } catch {
    /* 單一監聽者錯誤不影響其他 */
  }
}

let lastFg: boolean | null = null;

const hooks: AdapterHooks = {
  emitDeepLink(url) {
    if (!url) return;
    pendingDeep.push({ v: url, at: Date.now() });
    prune(pendingDeep);
    deepL.forEach((cb) => safeCall(cb, url));
  },
  emitPushTap(data) {
    pendingPush.push({ v: data, at: Date.now() });
    prune(pendingPush);
    pushL.forEach((cb) => safeCall(cb, data));
  },
  emitOnline() {
    onlineL.forEach((cb) => safeCall(cb, undefined));
  },
  refreshForeground() {
    let fg = true;
    try {
      fg = impl.isAppForeground();
    } catch {
      /* 忽略 */
    }
    if (lastFg === null) {
      lastFg = fg;
      return;
    }
    if (fg === lastFg) return;
    lastFg = fg;
    (fg ? resumeL : pauseL).forEach((cb) => safeCall(cb, undefined));
  },
};

function subscribe<T>(set: Set<Cb<T>>, cb: Cb<T>, pending?: { v: T; at: number }[]): () => void {
  set.add(cb);
  if (pending?.length) {
    prune(pending);
    const items = pending.map((p) => p.v);
    setTimeout(() => {
      if (set.has(cb)) items.forEach((v) => safeCall(cb, v));
    }, 0);
  }
  return () => {
    set.delete(cb);
  };
}

export function onResume(cb: () => void): () => void {
  return subscribe(resumeL as Set<Cb<void>>, cb);
}
export function onPause(cb: () => void): () => void {
  return subscribe(pauseL as Set<Cb<void>>, cb);
}
export function onOnline(cb: () => void): () => void {
  return subscribe(onlineL as Set<Cb<void>>, cb);
}
export function onDeepLink(cb: (url: string) => void): () => void {
  return subscribe(deepL, cb, pendingDeep);
}
export function onPushTap(cb: (data: Record<string, string>) => void): () => void {
  return subscribe(pushL, cb, pendingPush);
}

/* ---------------------------------- 儲存 ---------------------------------- */
const LS_KEY: Record<NativeKey, string> = {
  server: STORAGE_KEYS.server,
  token: STORAGE_KEYS.token,
  deviceId: STORAGE_KEYS.deviceId,
};

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, v: string | null) {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* 忽略 */
  }
}

let initPromise: Promise<void> | null = null;

/** 寫入原生持久儲存(web 為 no-op)。永不拋錯。 */
export async function nativeStorageSet(key: NativeKey, value: string | null): Promise<void> {
  if (!isNative) return;
  if (initPromise) await initPromise.catch(() => undefined);
  try {
    await impl.storageSet(key, value);
  } catch {
    /* 原生儲存失敗:localStorage 鏡像仍可用 */
  }
}

/* ---------------------------------- 初始化 ---------------------------------- */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 原生環境:解除任何已註冊的 Service Worker(避免快取舊殼)。 */
function unregisterServiceWorkers() {
  try {
    void navigator.serviceWorker
      ?.getRegistrations?.()
      .then((rs) => rs.forEach((r) => void r.unregister()))
      .catch(() => undefined);
  } catch {
    /* 忽略 */
  }
}

/**
 * 連結攔截器(capture 階段,僅原生):webview 內 target=_blank 不會開新視窗、外部網址會把整個 App
 * 導離、相對的 /api/… 附件網址會被解析到 App origin。統一改交 openExternal(系統瀏覽器)。
 * 只 preventDefault、不 stopPropagation,元件自身 onClick 照常執行。
 */
function installLinkInterceptor() {
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented) return;
      const target = e.target as Element | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!href || href.startsWith("#")) return;
      if (/^(javascript|mailto|tel|sms|blob|data):/i.test(href)) return;
      if (a.hasAttribute("download")) return;

      let external: string | null = null;
      if (/^\/api\//.test(href)) {
        // 附件等伺服器資源(相對路徑)→ 補伺服器前綴
        external = fileUrl(href);
      } else if (/^(https?:)?\/\//i.test(href)) {
        try {
          const abs = new URL(href, window.location.href);
          if (abs.origin !== window.location.origin) external = abs.href;
        } catch {
          return;
        }
      } else if (a.target === "_blank") {
        // 要求開新視窗的站內相對路徑(如公開 Help Center)→ 開伺服器上的公開頁
        external = publicUrl(href);
      }
      if (!external) return;
      e.preventDefault();
      void openExternal(external);
    },
    true,
  );
}

async function doInit(): Promise<void> {
  if (isNative) {
    try {
      if (platform === "tauri") impl = (await import("./tauri")).createTauriAdapter();
      else if (platform === "capacitor") impl = (await import("./capacitor")).createCapacitorAdapter();
    } catch {
      /* adapter 載入失敗:退回 web 行為,至少不白屏 */
    }
  }

  let result: AdapterInitResult = {};
  try {
    result = await withTimeout(impl.init(hooks), 5000);
  } catch {
    /* 原生外掛無回應時不阻塞首屏 */
  }

  if (result.os) os = result.os;
  if (result.appVersion) appVersion = result.appVersion;
  if (result.osVersion) osVersion = result.osVersion;

  // 原生儲存是事實來源:有值 → 覆寫 localStorage 鏡像;原生沒有但 localStorage 有 → 回填原生
  if (isNative && result.storage) {
    for (const key of Object.keys(LS_KEY) as NativeKey[]) {
      const nv = result.storage[key];
      const lv = lsGet(LS_KEY[key]);
      if (nv != null && nv !== "") {
        if (nv !== lv) lsSet(LS_KEY[key], nv);
      } else if (lv) {
        void impl.storageSet(key, lv).catch(() => undefined);
      }
    }
  }

  if (isNative) {
    try {
      document.documentElement.classList.add("native", `platform-${platform}`, `os-${os}`);
    } catch {
      /* 忽略 */
    }
    unregisterServiceWorkers();
    installLinkInterceptor();
  }

  // 前景 / 背景與網路恢復(三個平台共用 DOM 事件;原生 adapter 另會補上 App 狀態事件)
  const refresh = () => hooks.refreshForeground();
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("focus", refresh);
  window.addEventListener("blur", refresh);
  window.addEventListener("pageshow", refresh);
  window.addEventListener("online", () => hooks.emitOnline());
  hooks.refreshForeground();
}

/** main.tsx 在 render 前 await(重複呼叫回傳同一個 Promise)。永不 reject。 */
export function initPlatform(): Promise<void> {
  if (!initPromise) initPromise = doInit().catch(() => undefined);
  return initPromise;
}

/** 首次 render 後呼叫(手機:隱藏啟動畫面)。 */
export function appReady(): void {
  try {
    impl.appReady?.();
  } catch {
    /* 忽略 */
  }
}

/* ---------------------------------- 通知 ---------------------------------- */
export function notificationSupported(): boolean {
  try {
    return impl.notificationSupported();
  } catch {
    return false;
  }
}

export async function getNotificationPermission(): Promise<NotificationPermissionState> {
  try {
    return await impl.getNotificationPermission();
  } catch {
    return "default";
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    return await impl.requestNotificationPermission();
  } catch {
    return false;
  }
}

/** 顯示系統通知。已授權且實際送出回 true;其餘(不支援 / 未授權 / web 分頁在前景)回 false。 */
export async function notify(o: NotifyInput): Promise<boolean> {
  try {
    return await impl.notify(o);
  } catch {
    return false;
  }
}

/** 未讀角標(Dock / 工作列 / 系統匣 / 手機圖示)。web 為 no-op(由 TopBar 的標題閃爍處理)。 */
export async function setBadge(count: number): Promise<void> {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  try {
    await impl.setBadge(n);
  } catch {
    /* 忽略 */
  }
}

/** App 是否在前景(web:分頁可見;桌面:可見且有焦點;手機:App 為 active)。 */
export function isAppForeground(): boolean {
  try {
    return impl.isAppForeground();
  } catch {
    return true;
  }
}

/* ------------------------------ 外部連結 / 檔案 ------------------------------ */
const EXTERNAL_RE = /^(https?|mailto|tel):/i;

/** 以系統瀏覽器(web:新分頁)開啟外部網址。只接受 http(s) / mailto / tel。 */
export async function openExternal(url: string): Promise<void> {
  if (!url || !EXTERNAL_RE.test(url)) return;
  try {
    await impl.openExternal(url);
  } catch {
    /* 忽略 */
  }
}

/** 系統瀏覽器開啟 SSO 起點(web:整頁導向)。 */
export async function startExternalAuth(url: string): Promise<void> {
  if (!url || !/^https?:/i.test(url)) return;
  await impl.startExternalAuth(url);
}

/** 存檔:web `<a download>`;桌面存檔對話框;手機 Filesystem + 分享面板。使用者取消不視為錯誤。 */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  const safe = (filename || "download").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120) || "download";
  await impl.saveFile(blob, safe);
}

/* ---------------------------------- 推播 ---------------------------------- */
/** 取得推播 token(僅手機)。沒有 Firebase 設定 / 使用者拒絕 / 逾時一律回 null,不拋錯。 */
export async function pushRegister(): Promise<{ token: string } | null> {
  if (!isMobileApp) return null;
  try {
    return await impl.pushRegister();
  } catch {
    return null;
  }
}

/** 本機已取得推播 token、成功登記到伺服器且伺服器回報會送推播(usePushRegistration 設定)。 */
let _pushActive = false;

/** usePushRegistration 用:POST /devices 成功且 push_enabled 時設 true;登出 / 換人 / 卸載時設 false。 */
export function setPushActive(active: boolean): void {
  _pushActive = active;
}

/**
 * App 在背景時,伺服器推播的系統通知是否已涵蓋「訪客訊息 / 指派 / 轉接給我」。
 * 僅 Android(FCM 的 notification 訊息在背景由系統直接顯示);iOS 目前收不到 FCM 推播
 * (見 docs/NATIVE-CLIENTS.md §4.3),桌面 / web 沒有推播,一律 false。
 */
export function pushCoversBackground(): boolean {
  return _pushActive && isMobileApp && os === "android";
}

/* --------------------------------- 裝置 ID --------------------------------- */
function randomUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 非安全情境可能不可用 */
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let _deviceId: string | null = null;

/** 穩定裝置 UUID(首次產生後存 localStorage + 原生儲存)。 */
export function getDeviceId(): string {
  if (_deviceId) return _deviceId;
  let id = lsGet(STORAGE_KEYS.deviceId);
  if (!id) {
    id = randomUuid();
    lsSet(STORAGE_KEYS.deviceId, id);
    void nativeStorageSet("deviceId", id);
  }
  _deviceId = id;
  return id;
}

/** WS / 裝置登記用的平台字串:手機 ios|android、桌面 desktop、網頁 web。 */
export function clientPlatform(): "ios" | "android" | "desktop" | "web" {
  if (isMobileApp) return os === "ios" ? "ios" : "android";
  if (isDesktopApp) return "desktop";
  return "web";
}
