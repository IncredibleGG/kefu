/** 聯絡人批量匯入:以 ./client 的 apiFetch 自建 multipart 上傳 CSV。
 *  apiFetch 會自動帶 Bearer、處理 {ok,data} 信封並回傳 data(即匯入結果)。 */
import { apiFetch } from "./client";

/** 單列匯入錯誤(row = CSV 第幾列,含表頭時資料自第 2 列起)。 */
export interface ContactImportError {
  row: number;
  reason: string;
}

/** 批量匯入結果:建立 / 更新 / 略過數 + 逐列錯誤。 */
export interface ContactImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: ContactImportError[];
}

/** 遇到重複(相同 email 或電話)的處理策略。 */
export type OnDuplicate = "update" | "skip";

/**
 * 上傳 CSV 檔批量匯入聯絡人。
 * @param file CSV 檔(首列為表頭)
 * @param onDuplicate 重複時更新既有或略過(預設更新)
 */
export async function importContactsCsv(
  file: File,
  onDuplicate: OnDuplicate = "update",
): Promise<ContactImportResult> {
  const form = new FormData();
  form.append("file", file);
  return apiFetch<ContactImportResult>(
    `/api/v1/visitor/contacts/import?on_duplicate=${onDuplicate}`,
    { method: "POST", body: form },
  );
}

/** 前端產生的 CSV 範本內容(含表頭與一列範例;供使用者下載參考格式)。 */
export const CONTACT_IMPORT_TEMPLATE =
  "name,email,phone,company,note\n" +
  "王小明,ming@example.com,0912345678,範例科技,VIP 客戶\n";
