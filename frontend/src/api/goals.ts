/** 目標 / 銷售追蹤(Goals & Sales)API:對齊後端 /api/v1/goals。
 *  沿用 ./client 的 call()(自動解 {ok,data,error} 信封 / Bearer / mock)。
 *  型別就地定義(不動共用 types/index.ts)。 */
import { call } from "@/api/client";

/** 目標型別:url(到達指定網址)| event(自訂事件)| manual(坐席手動標記)。 */
export type GoalKind = "url" | "event" | "manual";

/** 比對條件:url 型用 url_contains;event 型用 event_name;manual 無。 */
export interface GoalConfig {
  url_contains?: string;
  event_name?: string;
  [k: string]: unknown;
}

export interface Goal {
  id: string;
  name: string;
  kind: GoalKind;
  config: GoalConfig | null;
  /** 每次達成的價值(以「分」為單位)。 */
  value_cents: number;
  currency: string;
  is_active: boolean;
  created_at?: string | null;
}

export interface GoalInput {
  name: string;
  kind: GoalKind;
  config?: GoalConfig | null;
  value_cents: number;
  currency: string;
  is_active: boolean;
}

/** 手動標記達成(manual 型)可選歸因 / 覆寫欄位。 */
export interface GoalAchieveInput {
  session_id?: string;
  visitor_id?: string;
  value_cents?: number;
}

/** summary 內單一目標的近 N 天達成聚合。 */
export interface GoalSummaryItem {
  id: string;
  name: string;
  kind: GoalKind;
  currency: string;
  value_cents: number;
  is_active: boolean;
  conversions: number;
  total_value_cents: number;
}

export interface GoalSummary {
  days: number;
  goals: GoalSummaryItem[];
}

/** 銷售追蹤:各幣別成交總覽。 */
export interface SalesTotal {
  currency: string;
  conversions: number;
  total_value_cents: number;
}

/** 銷售追蹤:逐目標明細(窗內有成交的目標)。 */
export interface SalesGoalItem {
  id: string;
  name: string;
  kind: GoalKind;
  currency: string;
  conversions: number;
  total_value_cents: number;
}

/** 銷售追蹤:逐坐席排行(staff_id 為 null=未歸因;多幣別時同坐席按幣別分列)。 */
export interface SalesAgentItem {
  staff_id: string | null;
  display_name: string | null;
  currency: string;
  conversions: number;
  total_value_cents: number;
}

/** 銷售追蹤彙總:近 N 天成交總覽 / 逐目標明細 / 逐坐席排行。 */
export interface SalesReport {
  days: number;
  totals: SalesTotal[];
  goals: SalesGoalItem[];
  agents: SalesAgentItem[];
}

export const goalsApi = {
  /** 目標清單(最新在前)。後端回陣列。 */
  list: () =>
    call<Goal[]>({ path: "/api/v1/goals", real: true, mock: async () => [] }),

  create: (body: GoalInput) =>
    call<Goal>({ path: "/api/v1/goals", method: "POST", body, real: true }),

  update: (id: string, body: Partial<GoalInput>) =>
    call<Goal>({ path: `/api/v1/goals/${id}`, method: "PATCH", body, real: true }),

  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/goals/${id}`,
      method: "DELETE",
      real: true,
    }),

  /** manual 型手動標記達成 → 建一筆 GoalConversion。 */
  achieve: (id: string, body: GoalAchieveInput = {}) =>
    call<{
      id: string;
      goal_id: string;
      visitor_id: string | null;
      session_id: string | null;
      value_cents: number;
      occurred_at: string | null;
    }>({ path: `/api/v1/goals/${id}/achieve`, method: "POST", body, real: true }),

  /** 各目標近 N 天達成次數與總價值。 */
  summary: (days = 30) =>
    call<GoalSummary>({
      path: "/api/v1/goals/summary",
      params: { days },
      real: true,
      mock: async () => ({ days, goals: [] }),
    }),

  /** 銷售追蹤彙總(後端 /reporting/sales,需 report.view):
   *  近 N 天成交總覽(分幣別)、逐目標明細、逐坐席排行。 */
  sales: (days = 30) =>
    call<SalesReport>({
      path: "/api/v1/reporting/sales",
      params: { days },
      real: true,
      mock: async () => ({ days, totals: [], goals: [], agents: [] }),
    }),
};
