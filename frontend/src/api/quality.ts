/** 報表 / 質檢 / 滿意度 資料層(乾淨室新增)。
 *
 *  為何自建:endpoints.ts 的 reportApi 只把 /reporting 各端點包在 overview() /
 *  dashboard() 內部聚合,未提供「單端點、帶型別」的方法;qualityApi 雖有 csat /
 *  quality-record / agent-monitor,但回傳未帶型別(call() 無泛型)。本模組以
 *  ./client 的 call() 補齊「坐席績效 / 滿意度 / 質檢 / 坐席監控」四張報表所需的
 *  typed 方法,供 reports/ 子頁就地以 React Query 取用。皆為 GET,租戶隔離由後端
 *  依 JWT 處理。 */
import { call } from "./client";

/* ------------------------------- 通用型別 ------------------------------- */
export interface DateRange {
  start?: string;
  end?: string;
  skill_group_id?: string;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

function rangeParams(p?: DateRange) {
  return { start: p?.start, end: p?.end, skill_group_id: p?.skill_group_id };
}

/* ------------------------------- 坐席績效 ------------------------------- */
export interface AgentPerf {
  staff_id: string | null;
  display_name: string | null;
  reception: number;
  avg_first_response_seconds: number | null;
  avg_handle_seconds: number | null;
  reply_messages: number;
}
export interface AgentsPerformance {
  agents: AgentPerf[];
}

export interface ConversationsVolume {
  total: number;
  by_status: Record<string, number>;
  daily: { day: string; count: number }[];
}

export interface QueueWaitTimes {
  currently_queued: number;
  answered_sessions: number;
  avg_wait_seconds: number | null;
  max_wait_seconds: number | null;
}

/* ------------------------------ 滿意度 / 質檢 ------------------------------ */
export interface SatisfactionSummary {
  responses: number;
  avg_score: number | null;
  /** key = 分數字串 "1".."5",value = 份數 */
  distribution: Record<string, number>;
}

export interface QualitySummary {
  reviewed: number;
  avg_score: number | null;
  /** key = 質檢分類 label,value = 筆數 */
  by_status: Record<string, number>;
}

export interface CsatItem {
  id: string;
  session_id: string;
  rating: number;
  level: string | null;
  comment: string | null;
  created_at: string | null;
}

export interface QualityRecordItem {
  id: string;
  target_type: string;
  session_id: string | null;
  message_id: string | null;
  reviewer_staff_id: string | null;
  score: number | null;
  label: string | null;
  note: string | null;
  is_sampled: boolean;
  created_at: string | null;
}

/* ------------------------------- 坐席監控 ------------------------------- */
export interface MonitorLastMessage {
  sender_type: string;
  content: string;
  created_at: string | null;
}
export interface MonitorSession {
  session_id: string;
  status: string;
  handler_type: string | null;
  visitor_id: string;
  channel_id: string;
  updated_at: string | null;
  last_message: MonitorLastMessage | null;
}
export interface AgentMonitor {
  staff_id: string;
  active_sessions: MonitorSession[];
  count: number;
}

/* --------------------------------- API --------------------------------- */
export const reportsApi = {
  /** 坐席績效:接待數 / 平均首應 / 平均處理 / 真人回覆訊息數。 */
  agentsPerformance: (p?: DateRange) =>
    call<AgentsPerformance>({
      path: "/api/v1/reporting/agents/performance",
      params: rangeParams(p),
      real: true,
    }),

  /** 會話量:總數 / 依狀態 / 逐日。 */
  conversationsVolume: (p?: DateRange) =>
    call<ConversationsVolume>({
      path: "/api/v1/reporting/conversations/volume",
      params: rangeParams(p),
      real: true,
    }),

  /** 排隊 / 等待時長。 */
  queueWaitTimes: (p?: DateRange) =>
    call<QueueWaitTimes>({
      path: "/api/v1/reporting/queue/wait-times",
      params: rangeParams(p),
      real: true,
    }),

  /** CSAT 彙總:平均分 / 樣本數 / 各分數分佈。 */
  satisfactionSummary: (p?: Pick<DateRange, "start" | "end">) =>
    call<SatisfactionSummary>({
      path: "/api/v1/reporting/satisfaction",
      params: { start: p?.start, end: p?.end },
      real: true,
    }),

  /** 質檢彙總:已質檢筆數 / 平均分 / 依分類(label)分佈。 */
  qualitySummary: (p?: Pick<DateRange, "start" | "end">) =>
    call<QualitySummary>({
      path: "/api/v1/reporting/quality",
      params: { start: p?.start, end: p?.end },
      real: true,
    }),

  /** CSAT 明細列表(分頁)。 */
  listCsat: (opts: { session_id?: string; page?: number; size?: number } = {}) =>
    call<PagedResult<CsatItem>>({
      path: "/api/v1/quality/csat",
      params: { session_id: opts.session_id, page: opts.page, size: opts.size },
      real: true,
    }),

  /** 質檢紀錄列表(分頁;is_sampled=true 即抽檢)。 */
  listQualityRecords: (
    opts: {
      target_type?: string;
      is_sampled?: boolean;
      reviewer_staff_id?: string;
      page?: number;
      size?: number;
    } = {},
  ) =>
    call<PagedResult<QualityRecordItem>>({
      path: "/api/v1/quality/quality-record",
      params: {
        target_type: opts.target_type,
        is_sampled: opts.is_sampled,
        reviewer_staff_id: opts.reviewer_staff_id,
        page: opts.page,
        size: opts.size,
      },
      real: true,
    }),

  /** 單一坐席目前進行中的會話摘要(坐席即時監控用)。 */
  agentMonitor: (staffId: string) =>
    call<AgentMonitor>({
      path: `/api/v1/quality/agent-monitor/${staffId}`,
      real: true,
    }),
};

/* -------------------------------- helpers -------------------------------- */
/** 秒數格式化為易讀時長(供首應 / 處理 / 等待時長顯示)。 */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
