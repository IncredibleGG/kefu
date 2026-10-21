/**
 * AI 對話測試(Playground)API 客戶端。
 *
 * 對應後端 POST /api/v1/playground/chat(CurrentStaff、tenant 隔離)。
 * 該端點不建立真實 Session / Message、不寫庫,純沙盒測試,因此直接走真 API
 * (apiFetch),不接 mock 回退。
 */
import { apiFetch } from "./client";

/** 一則對話訊息(送給後端時只帶 role + content)。 */
export interface PlaygroundMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** RAG 引用來源(對應提示詞內的 [1][2]…)。 */
export interface PlaygroundSource {
  index: number;
  content: string | null;
  source_ref: Record<string, unknown> | null;
  score: number | null;
}

/** 本次實際生效的設定(後端回傳,供前端顯示用了哪些參數)。 */
export interface PlaygroundConfig {
  provider: string;
  model: string;
  system_prompt: string | null;
  temperature: number;
  top_k: number;
  confidence_threshold: number;
  handoff_enabled: boolean;
  collection_ids: string[] | null;
}

/** /playground/chat 回應。 */
export interface PlaygroundReply {
  query: string;
  answer: string;
  confidence: number;
  sources: PlaygroundSource[];
  would_handoff: boolean;
  handoff_reason: string | null;
  config: PlaygroundConfig;
}

/** /playground/chat 請求:對話歷史 + 可選的測試參數覆寫。 */
export interface PlaygroundChatRequest {
  messages: PlaygroundMessage[];
  provider?: string | null;
  model?: string | null;
  system_prompt?: string | null;
  collection_ids?: string[] | null;
  confidence_threshold?: number | null;
  temperature?: number | null;
  top_k?: number | null;
  handoff_enabled?: boolean | null;
}

export const playgroundApi = {
  /** 送出一輪對話測試,取得 AI 回覆 + 信心分 + 引用來源 + 是否會轉人工。 */
  chat: (body: PlaygroundChatRequest) =>
    apiFetch<PlaygroundReply>("/api/v1/playground/chat", {
      method: "POST",
      body,
    }),
};
