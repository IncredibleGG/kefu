/** 公司(Company)一等 CRM 實體 API。
 *  自建於此(不改 endpoints.ts):以 @/api/client 的 call() 對齊 {ok,data,error} 信封,
 *  data 即回傳值。全部走真 API(real:true;後端 /api/v1/company 由主 session 掛載)。
 *
 *  路徑對應後端 app/api/v1/company.py(前綴 /api/v1/company):
 *    GET    /api/v1/company                        列表(?q 搜尋名稱/網域、分頁)
 *    POST   /api/v1/company                        建立
 *    GET    /api/v1/company/{id}                    詳情(含 contact_count)
 *    PATCH  /api/v1/company/{id}                    更新
 *    DELETE /api/v1/company/{id}                    軟刪
 *    GET    /api/v1/company/{id}/contacts           該公司的聯絡人(?q)
 *    POST   /api/v1/company/{id}/contacts/{cid}     歸屬聯絡人到公司
 *    DELETE /api/v1/company/{id}/contacts/{cid}     移除歸屬
 *  另借用既有聯絡人搜尋端點(挑選要加入公司的聯絡人):
 *    GET    /api/v1/visitor/contacts?q=             聯絡人清單(bare array)
 */
import { call } from "./client";

/** 公司主檔。 */
export interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  notes: string | null;
  attributes: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 公司詳情:主檔 + 底下聯絡人數。 */
export interface CompanyDetail extends Company {
  contact_count: number;
}

/** 公司列表回應(分頁信封)。 */
export interface CompanyList {
  items: Company[];
  total: number;
  limit: number;
  offset: number;
}

/** 歸屬於公司的聯絡人(精簡)。 */
export interface CompanyContact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  is_blocked: boolean;
}

/** 聯絡人搜尋結果(來自既有 /visitor/contacts;取需要的欄位)。 */
export interface ContactLite {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** 建立 / 更新公司的輸入(更新為部分欄位)。 */
export interface CompanyInput {
  name?: string;
  domain?: string | null;
  industry?: string | null;
  size?: string | null;
  notes?: string | null;
  attributes?: Record<string, unknown> | null;
}

export const companyApi = {
  /** 公司列表(q 模糊搜尋名稱/網域;分頁)。 */
  list: (params: { q?: string; limit?: number; offset?: number } = {}) =>
    call<CompanyList>({
      path: "/api/v1/company",
      params: {
        q: params.q || undefined,
        limit: params.limit ?? 20,
        offset: params.offset ?? 0,
      },
      real: true,
    }),

  /** 公司詳情。 */
  get: (id: string) => call<CompanyDetail>({ path: `/api/v1/company/${id}`, real: true }),

  /** 建立公司(name 必填)。 */
  create: (body: CompanyInput & { name: string }) =>
    call<Company>({ path: "/api/v1/company", method: "POST", body, real: true }),

  /** 更新公司(僅送出有變更的欄位)。 */
  update: (id: string, body: CompanyInput) =>
    call<Company>({ path: `/api/v1/company/${id}`, method: "PATCH", body, real: true }),

  /** 軟刪公司(其聯絡人歸屬置空)。 */
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/company/${id}`,
      method: "DELETE",
      real: true,
    }),

  /** 該公司底下的聯絡人(q 模糊搜尋)。 */
  contacts: (id: string, q?: string) =>
    call<CompanyContact[]>({
      path: `/api/v1/company/${id}/contacts`,
      params: { q: q || undefined },
      real: true,
    }),

  /** 把聯絡人歸屬到公司。 */
  assignContact: (id: string, contactId: string) =>
    call<CompanyContact>({
      path: `/api/v1/company/${id}/contacts/${contactId}`,
      method: "POST",
      real: true,
    }),

  /** 移除聯絡人的公司歸屬。 */
  unassignContact: (id: string, contactId: string) =>
    call<{ contact_id: string; company_id: string; removed: boolean }>({
      path: `/api/v1/company/${id}/contacts/${contactId}`,
      method: "DELETE",
      real: true,
    }),

  /** 借用既有聯絡人搜尋(挑選要加入公司的聯絡人);回 bare array。 */
  searchContacts: (q: string) =>
    call<ContactLite[]>({
      path: "/api/v1/visitor/contacts",
      params: { q: q || undefined, limit: 20 },
      real: true,
    }),
};
