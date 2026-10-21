/** 知識庫內容管理 API(乾淨室自建;**不改 endpoints.ts**)。
 *  對齊後端 app/api/v1/knowledge.py 的 collection / document / QA CRUD + 發布端點。
 *  一律走 {ok,data,error} 信封(apiFetch 已解包 data);multipart 交瀏覽器帶 boundary。
 *  註:endpoints.ts 的 knowledgeApi 只有部分方法(且集合列表經 mapCollection 丟掉發布欄位),
 *  故內容管理頁改用本模組直取後端原形(含 is_published / public_slug / doc_count)。 */
import { apiFetch } from "./client";

const BASE = "/api/v1/knowledge";

/** 集合來源類型(後端 CollectionIn.source_type 支援值)。 */
export type KnowledgeSourceType = "document" | "qa" | "website";

/** GET /collections 回列(對齊後端 _collection_dict,保留發布欄位與文件數)。 */
export interface ManagedCollection {
  id: string;
  name: string;
  source_type: string;
  is_published: boolean;
  public_slug: string | null;
  created_at: string;
  doc_count: number;
  hit_rate: number | null;
}

/** 文件切塊列(對齊 _document_dict;一份來源文本會切成多列 chunk,共用 title/source_ref)。 */
export interface KnowledgeDocument {
  id: string;
  collection_id: string;
  title: string | null;
  content: string;
  source_ref: { file?: string; [k: string]: unknown } | null;
  chunk_index: number;
  embedded: boolean;
}

/** QA 問答對(對齊 _qa_dict)。 */
export interface KnowledgeQaPair {
  id: string;
  collection_id: string;
  question: string;
  answer: string;
  embedded: boolean;
}

/** 發布狀態回應(對齊 _publish_payload)。 */
export interface PublishState {
  id: string;
  is_published: boolean;
  public_slug: string | null;
  tenant_slug: string | null;
  /** 可直接分享給終端使用者的公開閱讀頁(相對同源路徑,如 /help/demo?c=slug)。 */
  public_url: string | null;
  public_base: string | null;
}

/** 檔案上傳入庫回應。 */
export interface UploadResult {
  collection_id: string;
  filename: string | null;
  chunks: number;
}

/** 純文字建檔回應(含切出的 chunk 列)。 */
export interface CreateDocResult {
  collection_id: string;
  chunks: number;
  documents: KnowledgeDocument[];
}

export interface DeleteResult {
  id: string;
  deleted: boolean;
}

/** React Query key 工廠(內容管理專用命名空間,與 hooks.ts 的 ["collections"] 不撞)。 */
export const kkeys = {
  collections: ["knowledge", "manage", "collections"] as const,
  documents: (collectionId: string) => ["knowledge", "manage", "documents", collectionId] as const,
  qa: (collectionId: string) => ["knowledge", "manage", "qa", collectionId] as const,
};

export const knowledgeContentApi = {
  /* --------------------------- collections --------------------------- */
  listCollections: () => apiFetch<ManagedCollection[]>(`${BASE}/collections`),
  createCollection: (name: string, source_type: KnowledgeSourceType) =>
    apiFetch<ManagedCollection>(`${BASE}/collections`, {
      method: "POST",
      body: { name, source_type },
    }),
  deleteCollection: (id: string) =>
    apiFetch<DeleteResult>(`${BASE}/collections/${id}`, { method: "DELETE" }),

  /* ------------------------------ publish ------------------------------ */
  publish: (id: string) =>
    apiFetch<PublishState>(`${BASE}/collections/${id}/publish`, { method: "POST" }),
  unpublish: (id: string) =>
    apiFetch<PublishState>(`${BASE}/collections/${id}/unpublish`, { method: "POST" }),

  /* ----------------------------- documents ----------------------------- */
  listDocuments: (collectionId: string) =>
    apiFetch<KnowledgeDocument[]>(`${BASE}/collections/${collectionId}/documents`),
  createDocument: (collectionId: string, content: string, title?: string) =>
    apiFetch<CreateDocResult>(`${BASE}/collections/${collectionId}/documents`, {
      method: "POST",
      body: { content, title: title || undefined },
    }),
  uploadDocument: (collectionId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiFetch<UploadResult>(`${BASE}/collections/${collectionId}/documents/upload`, {
      method: "POST",
      body: form,
    });
  },
  deleteDocument: (documentId: string) =>
    apiFetch<DeleteResult>(`${BASE}/documents/${documentId}`, { method: "DELETE" }),

  /* ------------------------------- QA -------------------------------- */
  listQa: (collectionId: string) =>
    apiFetch<KnowledgeQaPair[]>(`${BASE}/collections/${collectionId}/qa`),
  createQa: (collectionId: string, question: string, answer: string) =>
    apiFetch<KnowledgeQaPair>(`${BASE}/collections/${collectionId}/qa`, {
      method: "POST",
      body: { question, answer },
    }),
  updateQa: (qaId: string, body: { question?: string; answer?: string }) =>
    apiFetch<KnowledgeQaPair>(`${BASE}/qa/${qaId}`, { method: "PATCH", body }),
  deleteQa: (qaId: string) =>
    apiFetch<DeleteResult>(`${BASE}/qa/${qaId}`, { method: "DELETE" }),
};

/** 把後端文件切塊列依「來源」分組(同一次上傳/建檔的 chunk 收攏成一張卡)。 */
export interface DocumentGroup {
  key: string;
  /** 顯示名(檔名優先,其次標題,最後退回切塊 id)。 */
  name: string;
  chunks: KnowledgeDocument[];
  embeddedCount: number;
}

export function groupDocuments(docs: KnowledgeDocument[]): DocumentGroup[] {
  const map = new Map<string, DocumentGroup>();
  for (const d of docs) {
    const file = d.source_ref?.file;
    const key = file ? `f:${file}` : d.title ? `t:${d.title}` : `id:${d.id}`;
    const name = file ?? d.title ?? d.content.slice(0, 24);
    let g = map.get(key);
    if (!g) {
      g = { key, name, chunks: [], embeddedCount: 0 };
      map.set(key, g);
    }
    g.chunks.push(d);
    if (d.embedded) g.embeddedCount += 1;
  }
  // 每組內依 chunk_index 排序,方便閱讀
  for (const g of map.values()) g.chunks.sort((a, b) => a.chunk_index - b.chunk_index);
  return [...map.values()];
}
