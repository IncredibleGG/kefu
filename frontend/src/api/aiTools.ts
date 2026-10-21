import { apiFetch } from "./client";

/**
 * AI 工具呼叫(function calling)前端 API。
 *
 * 後端唯一真實來源是 `backend/app/services/ai/tools.py`(public_tool_list())。
 * 本檔的 BUILTIN_TOOLS 為其「靜態鏡像」,供:
 *   1) 後端列工具端點尚未掛載前的唯讀展示;
 *   2) 離線 / mock demo 的優雅回退。
 * 一旦主 session 掛上 `GET /api/v1/ai/tools`,list() 會優先採用後端回傳。
 */

/** 單一工具的參數(由後端 JSON Schema 攤平)。 */
export interface AiToolParam {
  name: string;
  type: string;
  description?: string | null;
  required: boolean;
}

/** 一個內建工具的展示中繼資料。 */
export interface AiToolSpec {
  name: string;
  description: string;
  category: string;
  /** 是否為唯讀工具(首版內建工具一律 true)。 */
  readonly: boolean;
  parameters: AiToolParam[];
}

/** list() 的正規化結果。source 指出資料來自後端或靜態鏡像。 */
export interface AiToolList {
  tools: AiToolSpec[];
  /** 租戶是否已啟用工具功能;後端未提供時為 null(未知)。 */
  featureEnabled: boolean | null;
  source: "backend" | "static";
}

/** 內建工具的靜態鏡像(對齊 tools.py 的 public_tool_list())。 */
export const BUILTIN_TOOLS: AiToolSpec[] = [
  {
    name: "search_knowledge",
    description:
      "在租戶知識庫中做語意檢索,取回與問題最相關的片段(含來源與相似度)。回答事實性 / 產品 / 政策問題前應先呼叫此工具取得依據。",
    category: "knowledge",
    readonly: true,
    parameters: [
      { name: "query", type: "string", description: "要檢索的問題或關鍵字", required: true },
      { name: "top_k", type: "integer", description: "取回筆數(1-20,預設 5)", required: false },
    ],
  },
  {
    name: "get_ticket_status",
    description: "依工單 ID 查詢該工單的目前狀態、優先級與時間戳(唯讀)。",
    category: "ticket",
    readonly: true,
    parameters: [{ name: "ticket_id", type: "string", description: "工單 UUID", required: true }],
  },
  {
    name: "get_session_status",
    description: "依會話 ID 查詢該會話的狀態與目前處理者(AI 或真人)(唯讀)。",
    category: "conversation",
    readonly: true,
    parameters: [{ name: "session_id", type: "string", description: "會話 UUID", required: true }],
  },
  {
    name: "get_business_hours",
    description: "查詢本客服的營業時間、離線留言,以及當下是否在營業時間內(唯讀)。",
    category: "settings",
    readonly: true,
    parameters: [],
  },
];

/** 後端 GET /ai/tools 預期形狀(經信封解包後的 data)。 */
interface ToolsResponse {
  tools?: AiToolSpec[] | null;
  feature_enabled?: boolean | null;
}

export const aiToolsApi = {
  /**
   * 取可用內建工具清單。
   * 優先打後端 `GET /api/v1/ai/tools`;端點尚未掛載 / 離線時回退靜態鏡像,
   * 確保工具檢視分頁在接線完成前也能唯讀展示,不會空白或報錯。
   */
  async list(): Promise<AiToolList> {
    try {
      const data = await apiFetch<ToolsResponse>("/api/v1/ai/tools");
      const tools = Array.isArray(data?.tools) && data.tools.length ? data.tools : BUILTIN_TOOLS;
      return {
        tools,
        featureEnabled: data?.feature_enabled ?? null,
        source: Array.isArray(data?.tools) ? "backend" : "static",
      };
    } catch {
      // 端點未掛載 / 後端未起 → 靜態鏡像,維持唯讀展示可用。
      return { tools: BUILTIN_TOOLS, featureEnabled: null, source: "static" };
    }
  },
};
