import { apiUrl, getToken } from "@/lib/server";
import { saveFile } from "@/lib/platform";
import { triggerUnauthorized } from "@/api/client";

/**
 * 帶 Bearer 下載檔案(CSV 匯出等)。因需要 Authorization 標頭,不能用純 <a href>,
 * 故 fetch 成 blob 後交給平台層存檔(web:<a download>;桌面:存檔對話框;手機:分享面板)。
 * path 為 API 路徑(如 /api/v1/exports/tickets.csv)。
 */
export async function downloadFile(
  path: string,
  filename?: string,
  params?: Record<string, string | number | undefined>,
): Promise<void> {
  const clean: Record<string, string | number> = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") clean[k] = v;
    }
  }
  const token = getToken();
  const res = await fetch(apiUrl(path, clean), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    // 與 apiFetch 一致:token 過期 → 走既有登出流程
    triggerUnauthorized();
    throw new Error("登入已過期,請重新登入");
  }
  if (!res.ok) throw new Error(`匯出失敗 (${res.status})`);
  const blob = await res.blob();
  await saveFile(blob, filename || "export.csv");
}
