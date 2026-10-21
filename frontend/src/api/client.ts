import { config, STORAGE_KEYS } from "@/lib/config";
import type { Envelope } from "@/types";

/** API 錯誤(帶後端錯誤碼) */
export class ApiError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 由 auth store 注入的登出回呼(401 時觸發導回登入) */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

function getToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.token);
  } catch {
    return null;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  auth?: boolean; // 是否帶 Bearer(預設帶)
  signal?: AbortSignal;
}

function buildUrl(path: string, params?: RequestOptions["params"]): string {
  const base = config.apiBase.replace(/\/$/, "");
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
  }
  const query = qs.toString();
  // base 為空字串 → 走同源相對路徑(可置於任意網域/CF 隧道後,經 nginx 反代)
  const full = (base ? base : "") + path;
  return query ? `${full}?${query}` : full;
}

/**
 * 真實 API 呼叫:處理 {ok,data,error} 信封、Bearer、401 導回登入。
 * 成功回傳 data;失敗丟 ApiError。
 */
export async function apiFetch<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, params, auth = true, signal } = opts;
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const headers: Record<string, string> = { Accept: "application/json" };
  // FormData 交給瀏覽器自帶 multipart boundary,勿手動設 Content-Type
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(buildUrl(path, params), {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    signal,
  });

  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError("UNAUTHORIZED", "登入已過期,請重新登入", 401);
  }

  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    // 非 JSON 或空回應
    if (!res.ok) throw new ApiError("HTTP_ERROR", `HTTP ${res.status}`, res.status);
    return null as T;
  }

  if (!json.ok || json.error) {
    throw new ApiError(
      json.error?.code || "UNKNOWN",
      json.error?.message || "未知錯誤",
      res.status,
    );
  }
  return json.data as T;
}

/** 判斷 fetch 是否為「連不上後端」(用於 auto 模式回退 mock) */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError; // fetch 連線失敗
}

/**
 * 多請求 / 需資料轉接的端點通用包裝:依 mock 模式在「真實作 / mock」間切換。
 * - on  :直接走 mock(若有),否則走真實作
 * - off :一律真實作
 * - auto:先真實作,連不上後端且有 mock 時優雅回退(讓無後端 demo 不崩)
 */
export async function guarded<T>(
  realFn: () => Promise<T>,
  mockFn?: () => Promise<T> | T,
): Promise<T> {
  if (config.mockMode === "on") return mockFn ? await mockFn() : realFn();
  try {
    return await realFn();
  } catch (e) {
    if (config.mockMode === "auto" && mockFn && isNetworkError(e)) return await mockFn();
    throw e;
  }
}

export interface CallSpec<T> {
  path: string;
  method?: RequestOptions["method"];
  body?: unknown;
  params?: RequestOptions["params"];
  auth?: boolean;
  /** 後端是否已實作此端點(true=可打真 API) */
  real?: boolean;
  /** mock 適配:後端未實作時的回退資料來源 */
  mock?: () => Promise<T> | T;
}

/**
 * 統一呼叫入口:依 VITE_MOCK 模式在「真 API / mock 適配層」間切換。
 * - off:一律真 API
 * - on :一律 mock(純前端展示,後端不用起)
 * - auto:real=true 的端點打真 API,連不上或未實作時回退 mock;real=false 直接 mock
 */
export async function call<T>(spec: CallSpec<T>): Promise<T> {
  const { path, method, body, params, auth, real, mock } = spec;
  const doReal = () => apiFetch<T>(path, { method, body, params, auth });
  const doMock = async () => {
    if (!mock) return doReal();
    return await mock();
  };

  if (config.mockMode === "off") return doReal();
  if (config.mockMode === "on") return doMock();

  // auto
  if (real) {
    try {
      return await doReal();
    } catch (e) {
      // 連不上後端 → 若有 mock 則優雅回退(讓 demo 無後端也能看)
      if (mock && isNetworkError(e)) return doMock();
      throw e;
    }
  }
  return doMock();
}
