/**
 * 對外公開 Help Center(自助中心)API —— 專供 `PublicHelpCenter` 頁面使用。
 *
 * 設計原則:
 *  - 完全獨立、自帶 `fetch`,不依賴 client/endpoints/hooks(那些帶 Bearer / 401 導登入,
 *    公開頁面不需要也不應觸發)。
 *  - 路徑經 lib/server 的 apiUrl 組裝:web 為同源相對路徑 `/api/v1/helpcenter/...`(或 VITE_API_BASE),
 *    原生殼則補上使用者設定的伺服器。
 *  - 解析統一信封 `{ ok, data, error, request_id }`,失敗丟 `HelpCenterError`。
 *  - 租戶以網址 slug 定位(demo 租戶 slug=demo)。
 */

import { apiUrl } from "@/lib/server";

const BASE = "/api/v1/helpcenter";

// ----------------------------- 型別(對應後端公開序列化欄位) -----------------------------
export interface HelpCollection {
  id: string;
  slug: string | null;
  name: string;
  source_type: string;
}

export interface HelpArticleListItem {
  id: string;
  collection_id: string;
  title: string;
  excerpt: string;
  chunk_index: number;
  created_at: string | null;
}

export interface HelpArticle {
  id: string;
  collection_id: string;
  title: string;
  content: string;
  source: string | null;
  chunk_index: number;
  created_at: string | null;
}

export interface HelpFaq {
  id: string;
  collection_id: string;
  question: string;
  answer: string;
}

export interface HelpArticlesPage {
  tenant_slug: string;
  collection: string | null;
  items: HelpArticleListItem[];
  total: number;
  page: number;
  size: number;
}

export interface HelpFaqsPage {
  tenant_slug: string;
  collection: string | null;
  items: HelpFaq[];
  total: number;
  page: number;
  size: number;
}

export interface HelpSearchResult {
  tenant_slug: string;
  query: string;
  articles: HelpArticleListItem[];
  faqs: HelpFaq[];
}

interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  request_id?: string | null;
}

// ----------------------------- 錯誤型別 -----------------------------
export class HelpCenterError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus = 0) {
    super(message);
    this.name = "HelpCenterError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ----------------------------- 底層 GET -----------------------------
function buildQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

async function get<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  // apiUrl:web 維持同源 / apiBase;原生殼補上使用者設定的伺服器(否則會打到 App 自己的 origin)
  const res = await fetch(apiUrl(`${BASE}${path}`) + buildQuery(params), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });

  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    throw new HelpCenterError("HTTP_ERROR", `HTTP ${res.status}`, res.status);
  }

  if (!json.ok || json.error) {
    throw new HelpCenterError(
      json.error?.code || "UNKNOWN",
      json.error?.message || "讀取失敗",
      res.status,
    );
  }
  return json.data as T;
}

// slug 走路徑,做最小編碼避免特殊字元破壞 URL
const seg = (s: string) => encodeURIComponent(s);

// ----------------------------- 對外 API -----------------------------
export function fetchCollections(slug: string, signal?: AbortSignal) {
  return get<{ tenant_slug: string; collections: HelpCollection[] }>(
    `/${seg(slug)}/collections`,
    undefined,
    signal,
  );
}

export function fetchArticles(
  slug: string,
  opts: { collection?: string; page?: number; size?: number } = {},
  signal?: AbortSignal,
) {
  return get<HelpArticlesPage>(
    `/${seg(slug)}/articles`,
    { collection: opts.collection, page: opts.page, size: opts.size },
    signal,
  );
}

export function fetchArticle(slug: string, id: string, signal?: AbortSignal) {
  return get<HelpArticle>(`/${seg(slug)}/articles/${seg(id)}`, undefined, signal);
}

export function fetchFaqs(
  slug: string,
  opts: { collection?: string; page?: number; size?: number } = {},
  signal?: AbortSignal,
) {
  return get<HelpFaqsPage>(
    `/${seg(slug)}/faqs`,
    { collection: opts.collection, page: opts.page, size: opts.size },
    signal,
  );
}

export function searchHelp(slug: string, q: string, signal?: AbortSignal) {
  return get<HelpSearchResult>(`/${seg(slug)}/search`, { q }, signal);
}
