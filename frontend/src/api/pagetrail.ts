/**
 * W6 頁面軌跡(page trail)坐席讀取封裝。
 *
 * 後端(純新增於 channel.py):
 *   GET /api/v1/channel/visitors/{visitor_id}/pageviews?limit=N
 *   需坐席 JWT(CurrentStaff),tenant 隔離,回該訪客最近 N 筆(倒序,最新在前)。
 *
 * 本檔不動 endpoints.ts,單獨提供型別化取數(沿用 client.ts 的信封 / 認證 / mock 行為)。
 */
import { call } from "@/api/client";

/** 單筆頁面瀏覽記錄(對齊後端 PageView 序列化欄位)。 */
export interface PageViewItem {
  id: string;
  url: string;
  title: string | null;
  referrer: string | null;
  /** ISO 8601 時間字串;理論上恆有值,保留 null 以防序列化缺漏。 */
  occurred_at: string | null;
}

/** GET .../pageviews 回應。 */
export interface PageViewsResp {
  pageviews: PageViewItem[];
}

/** 取某訪客最近的頁面瀏覽軌跡(倒序,最新在前)。 */
export function fetchVisitorPageViews(
  visitorId: string,
  limit = 50,
): Promise<PageViewsResp> {
  return call<PageViewsResp>({
    path: `/api/v1/channel/visitors/${encodeURIComponent(visitorId)}/pageviews`,
    method: "GET",
    params: { limit },
    real: true,
  });
}
