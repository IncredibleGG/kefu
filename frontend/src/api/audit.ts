/** 稽核 / 操作日誌 API(W7 首版)。
 *  對齊後端 /api/v1/audit(見 backend/app/api/v1/audit.py),沿用 ./client 的 call()
 *  (自動解 {ok,data,error} 信封、帶 Bearer)。型別就地定義,不動共用 types/index.ts。
 */
import { call } from "./client";

/** 單筆稽核記錄。 */
export interface AuditLogEntry {
  id: string;
  /** ISO8601 時間;可能為 null(理論上不會) */
  created_at: string | null;
  actor_staff_id: string | null;
  /** 操作者顯示名(後端回填);系統/自動操作可能為 null */
  actor_name: string | null;
  /** 動作,如 "POST /api/v1/iam/staff" */
  action: string;
  /** 目標型別,如 "staff" / "roles" / "channel" */
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
}

/** 分頁列表回應。 */
export interface AuditListResp {
  items: AuditLogEntry[];
  total: number;
  page: number;
  size: number;
}

/** 查詢條件(全部選填)。 */
export interface AuditQuery {
  page?: number;
  size?: number;
  /** 動作模糊比對 */
  action?: string;
  actor_staff_id?: string;
  /** 目標型別精確比對 */
  target_type?: string;
  /** 起始時間(含),ISO8601 */
  start?: string;
  /** 結束時間(含),ISO8601 */
  end?: string;
}

export const auditApi = {
  /** 查稽核日誌:租戶隔離、倒序、可篩選+分頁。 */
  list: (query: AuditQuery = {}) =>
    call<AuditListResp>({
      path: "/api/v1/audit",
      params: {
        page: query.page,
        size: query.size,
        action: query.action || undefined,
        actor_staff_id: query.actor_staff_id || undefined,
        target_type: query.target_type || undefined,
        start: query.start || undefined,
        end: query.end || undefined,
      },
      real: true,
      mock: async () => ({
        items: [],
        total: 0,
        page: query.page ?? 1,
        size: query.size ?? 20,
      }),
    }),
};
