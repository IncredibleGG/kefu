/** 坐席排班(Work Scheduler)API 客戶端。
 *  後端 /api/v1/scheduling:每週循環班表(以分鐘表示上線時段)與「目前在班」查詢。
 *  直接沿用 ./client 的 call()(走 {ok,data,error} 信封);本模組獨立自建,
 *  不動 endpoints.ts。weekday 對齊後端:0=週一 … 6=週日。 */
import { call } from "./client";

/** 對齊後端 scheduling._shift_dict 的回應結構。 */
export interface Shift {
  id: string;
  staff_id: string;
  /** 0=週一 … 6=週日 */
  weekday: number;
  /** 從午夜起算的分鐘(0-1440) */
  start_minute: number;
  end_minute: number;
  enabled: boolean;
}

/** 整組覆寫班表時單一時段的輸入(0 ≤ start < end ≤ 1440)。 */
export interface ShiftInput {
  weekday: number;
  start_minute: number;
  end_minute: number;
  enabled: boolean;
}

export const schedulingApi = {
  /** 列出班表(可指定坐席);後端回 {items,total},此處攤平為陣列。 */
  listShifts: (staffId?: string) =>
    call<{ items: Shift[]; total: number }>({
      path: "/api/v1/scheduling/shifts",
      params: { staff_id: staffId },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r.items ?? []),

  /** 整組覆寫某坐席的每週班表(需 staff.manage)。 */
  setStaffShifts: (staffId: string, shifts: ShiftInput[]) =>
    call<{ staff_id: string; items: Shift[] }>({
      path: `/api/v1/scheduling/staff/${staffId}/shifts`,
      method: "PUT",
      body: { shifts },
      real: true,
    }),

  /** 目前「在班」的坐席 id 清單(依伺服器時間判斷);後端回物件,此處攤平為 id 陣列。 */
  onShift: () =>
    call<{ staff_ids: string[]; weekday: number; minute: number }>({
      path: "/api/v1/scheduling/on-shift",
      real: true,
      mock: async () => ({ staff_ids: [], weekday: 0, minute: 0 }),
    }).then((r) => r.staff_ids ?? []),
};
