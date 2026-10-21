/** 執行期組態(來自 Vite env) */

/** 是否在原生殼(Tauri / Capacitor)內執行。兩者都在頁面腳本執行前注入全域物件,可同步判斷。
 *  (與 lib/platform 的偵測規則一致;此處獨立實作以免 config 反向依賴平台層。) */
function nativeRuntime(): boolean {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  try {
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export const config = {
  /** 後端 API 基底(僅 web 使用)。VITE_API_BASE="" → 同源相對路徑(經 nginx 反代,適用 CF 隧道);
   *  未設(dev)→ 預設 localhost:8000。注意:空字串是刻意的同源,不可用 || 回退。
   *  原生殼一律改用使用者設定的伺服器(見 lib/server.ts 的 getServerBase),不讀此值。 */
  apiBase:
    (import.meta.env.VITE_API_BASE as string | undefined) === undefined
      ? "http://localhost:8000"
      : (import.meta.env.VITE_API_BASE as string),
  /** mock 模式:auto | on | off。
   *  原生殼一律強制 off:伺服器網址填錯 / 斷網時不可靜默改用假資料(見 docs/NATIVE-CLIENTS.md)。 */
  mockMode: (nativeRuntime()
    ? "off"
    : (import.meta.env.VITE_MOCK as string) || "auto") as "auto" | "on" | "off",
} as const;

export const STORAGE_KEYS = {
  token: "kefu-token",
  theme: "kefu-theme",
  auth: "kefu-auth", // zustand persist
  ui: "kefu-ui",
  /** 原生殼:使用者設定的伺服器網址(原生持久儲存的記憶體鏡像) */
  server: "kefu-server",
  /** 穩定裝置 UUID(推播登記 / WS 連線回報用) */
  deviceId: "kefu-device-id",
  /** 本裝置已向後端登記推播(登出時據此呼叫 DELETE /devices/{id}) */
  deviceRegistered: "kefu-device-registered",
} as const;
