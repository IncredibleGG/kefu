/** 執行期組態(來自 Vite env) */
export const config = {
  /** 後端 API 基底。VITE_API_BASE="" → 同源相對路徑(經 nginx 反代,適用 CF 隧道);
   *  未設(dev)→ 預設 localhost:8000。注意:空字串是刻意的同源,不可用 || 回退。 */
  apiBase:
    (import.meta.env.VITE_API_BASE as string | undefined) === undefined
      ? "http://localhost:8000"
      : (import.meta.env.VITE_API_BASE as string),
  /** mock 模式:auto | on | off */
  mockMode: ((import.meta.env.VITE_MOCK as string) || "auto") as
    | "auto"
    | "on"
    | "off",
} as const;

export const STORAGE_KEYS = {
  token: "kefu-token",
  theme: "kefu-theme",
  auth: "kefu-auth", // zustand persist
  ui: "kefu-ui",
} as const;
