import { config, STORAGE_KEYS } from "@/lib/config";

/**
 * 帶 Bearer 下載檔案(CSV 匯出等)。因需要 Authorization 標頭,不能用純 <a href>,
 * 故 fetch 成 blob 後觸發瀏覽器下載。path 為 API 路徑(如 /api/v1/exports/tickets.csv)。
 */
export async function downloadFile(
  path: string,
  filename?: string,
  params?: Record<string, string | number | undefined>,
): Promise<void> {
  const base = config.apiBase.replace(/\/$/, "");
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
  }
  const url = (base || "") + path + (qs.toString() ? `?${qs.toString()}` : "");
  let token: string | null = null;
  try {
    token = localStorage.getItem(STORAGE_KEYS.token);
  } catch {
    /* ignore */
  }
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`匯出失敗 (${res.status})`);
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename || "export.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}
