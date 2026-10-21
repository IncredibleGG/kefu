/** 自訂欄位定義(FieldDefinition)API 客戶端。
 *  後端 /api/v1/fields:租戶自訂工單 / 聯絡人欄位 schema(CRUD)。
 *  直接沿用 ./client 的 call()(走 {ok,data,error} 信封);本模組獨立於
 *  endpoints.ts,依檔案擁有權規範自建。 */
import { call } from "./client";

/** 自訂欄位型別(對齊後端 FIELD_TYPES)。 */
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "checkbox"
  | "url";

/** 可掛載實體(對齊後端 FIELD_ENTITIES)。 */
export type FieldEntity = "ticket" | "contact";

/** 對齊後端 fields._serialize 的回應結構。 */
export interface FieldDefinition {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  field_type: FieldType;
  options: string[];
  required: boolean;
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
}

/** 建立自訂欄位的輸入。 */
export interface FieldCreateInput {
  entity?: FieldEntity;
  key: string;
  label: string;
  field_type: FieldType;
  options?: string[] | null;
  required?: boolean;
  sort_order?: number;
}

/** 更新自訂欄位的輸入(entity / key 不可改)。 */
export interface FieldUpdateInput {
  label?: string;
  field_type?: FieldType;
  options?: string[] | null;
  required?: boolean;
  sort_order?: number;
}

export const fieldsApi = {
  /** 列出某實體的自訂欄位定義(依 sort_order 升冪)。後端回 {items,total},此處攤平為陣列。 */
  list: (entity: FieldEntity = "ticket") =>
    call<{ items: FieldDefinition[]; total: number }>({
      path: "/api/v1/fields",
      params: { entity },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r.items ?? []),

  /** 建立自訂欄位(需 field.manage / admin)。 */
  create: (body: FieldCreateInput) =>
    call<FieldDefinition>({
      path: "/api/v1/fields",
      method: "POST",
      body: { entity: "ticket", ...body },
      real: true,
    }),

  /** 更新自訂欄位(需 field.manage / admin)。 */
  update: (id: string, body: FieldUpdateInput) =>
    call<FieldDefinition>({
      path: `/api/v1/fields/${id}`,
      method: "PATCH",
      body,
      real: true,
    }),

  /** 刪除自訂欄位(軟刪;需 field.manage / admin)。 */
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/fields/${id}`,
      method: "DELETE",
      real: true,
    }),
};
