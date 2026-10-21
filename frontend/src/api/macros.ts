/** 巨集(Macro)API:對齊後端 /api/v1/macros(CRUD)。
 *  沿用 ./client 的 call()(自動解 {ok,data,error} 信封)。
 *  型別就地定義(不動共用 types/index.ts)。 */
import { call } from "./client";

/** 巨集動作型別(對齊後端 MACRO_ACTION_TYPES)。 */
export type MacroActionType = "reply" | "set_status" | "add_tags" | "assign" | "add_note";

/** 單一動作。依 type 使用不同欄位:
 *  - reply / add_note → content
 *  - set_status       → value(例:resolved / closed)
 *  - add_tags         → tags(標籤 id 陣列)
 *  - assign           → staff_id(省略 = 指派給自己) */
export interface MacroAction {
  type: MacroActionType;
  content?: string;
  value?: string;
  tags?: string[];
  staff_id?: string;
}

export interface Macro {
  id: string;
  name: string;
  description?: string | null;
  actions: MacroAction[];
  is_active: boolean;
  created_at?: string | null;
}

export interface MacroInput {
  name: string;
  description?: string | null;
  actions: MacroAction[];
  is_active: boolean;
}

export const macrosApi = {
  /** 巨集清單(可依啟用狀態 / 名稱過濾)。後端回 {items,total},此處攤平為陣列。 */
  list: (opts: { is_active?: boolean; q?: string } = {}) =>
    call<{ items: Macro[]; total: number }>({
      path: "/api/v1/macros",
      params: { is_active: opts.is_active, q: opts.q },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r.items ?? []),

  get: (id: string) => call<Macro>({ path: `/api/v1/macros/${id}`, real: true }),

  create: (body: MacroInput) =>
    call<Macro>({ path: "/api/v1/macros", method: "POST", body, real: true }),

  update: (id: string, body: Partial<MacroInput>) =>
    call<Macro>({ path: `/api/v1/macros/${id}`, method: "PATCH", body, real: true }),

  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/macros/${id}`,
      method: "DELETE",
      real: true,
    }),
};
