// 後端對接:URL 組裝、開會話、送訊、輪詢歷史。
// 端點契約(以 backend/app/api/v1/channel.py、conversation.py 為準):
//   POST {apiBase}/api/v1/channel/web/{channelKey}/session   建立/開啟會話
//   POST {apiBase}/api/v1/channel/web/{channelKey}/message    訪客送訊(觸發 AI dispatch)
//   WS   {apiBase}/ws/widget?tenant_id=&session_id=          接收會話頻道事件
//   GET  {apiBase}/api/v1/conversation/sessions/{id}          歷史/輪詢(需坐席 JWT)

import type {
  Envelope,
  ProactiveRule,
  PublicSettings,
  SessionOpenData,
  WidgetConfig,
} from "./types";

/** 去除尾斜線;空字串代表同源相對路徑。 */
export function normBase(apiBase: string): string {
  return (apiBase || "").replace(/\/+$/, "");
}

/** 把後端回傳的相對 url(如 `/api/v1/channel/files/xxx`)解析成可用位址。
 *  絕對 http(s) 原樣回傳;以 `/` 開頭者接上 apiBase(空 = 同源相對);其餘原樣。 */
export function resolveUrl(apiBase: string, url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return normBase(apiBase) + url;
  return url;
}

/** 由 apiBase 推導 WebSocket 根位址(相對則用當前頁面 origin)。 */
export function wsOrigin(apiBase: string): string {
  const base = normBase(apiBase);
  if (base) {
    return base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  }
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}`;
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new Error(`HTTP ${res.status}:回應非 JSON`);
  }
  if (!res.ok || !body || body.ok === false) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body.data as T;
}

/**
 * 抓渠道公開設定(外觀 / 營業狀態 / pre-chat)。無需 JWT。
 * 端點以 GET /api/v1/settings/public/{channel_key} 為準;相容信封 { ok,data } 或裸物件。
 * 任何失敗(404 / 非 JSON / 網路)回傳 null,由呼叫端走預設,絕不拋出。
 */
export async function fetchPublicSettings(
  cfg: WidgetConfig,
): Promise<PublicSettings | null> {
  try {
    const url = `${normBase(cfg.apiBase)}/api/v1/settings/public/${encodeURIComponent(cfg.channelKey)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object") {
      const env = body as Envelope<PublicSettings>;
      // 信封格式:取 data;否則視為裸設定物件。
      if ("data" in env || "ok" in env) {
        if (env.ok === false) return null;
        return (env.data as PublicSettings) || null;
      }
      return body as PublicSettings;
    }
    return null;
  } catch {
    return null;
  }
}

/** 一條規則至少要有 message 與可辨識的 trigger.type 才算有效。 */
function isValidRule(r: unknown): r is ProactiveRule {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  const trigger = o.trigger as { type?: unknown } | undefined;
  return (
    typeof o.message === "string" &&
    o.message.length > 0 &&
    !!trigger &&
    typeof trigger.type === "string"
  );
}

/**
 * 抓渠道公開的主動式訊息規則(無需 JWT)。GET /api/v1/proactive/public/{channel_key}。
 * 相容信封 { ok,data } 或裸陣列;任何失敗(404 / 非 JSON / 網路)一律回空陣列,絕不拋出。
 */
export async function fetchProactiveRules(cfg: WidgetConfig): Promise<ProactiveRule[]> {
  try {
    if (!cfg.channelKey) return [];
    const url = `${normBase(cfg.apiBase)}/api/v1/proactive/public/${encodeURIComponent(cfg.channelKey)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    let list: unknown = body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const env = body as Envelope<ProactiveRule[]>;
      if (env.ok === false) return [];
      list = env.data;
    }
    if (!Array.isArray(list)) return [];
    return list.filter(isValidRule);
  } catch {
    return [];
  }
}

/** CSAT 提交預設端點(對齊 backend/app/api/v1/quality.py 的公開提交路徑)。 */
export const DEFAULT_CSAT_ENDPOINT = "/api/v1/quality/csat";

/**
 * 訪客提交 CSAT 評分(公開,無 JWT)。預設 POST /api/v1/quality/csat。
 * body { session_id, rating:1..5, comment? };tenant 由後端以 session 反查。
 * endpoint 選填:W6 邀評旗標 meta.csat_invite.submit_endpoint 可覆寫(呼叫端須先
 * 驗證為同源相對路徑);缺省即用 DEFAULT_CSAT_ENDPOINT。
 */
export async function submitCsat(
  cfg: WidgetConfig,
  sessionId: string,
  rating: number,
  comment?: string,
  endpoint?: string,
): Promise<void> {
  const url = `${normBase(cfg.apiBase)}${endpoint || DEFAULT_CSAT_ENDPOINT}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      rating,
      comment: comment || undefined,
    }),
  });
  await parseEnvelope<unknown>(res);
}

export async function openSession(
  cfg: WidgetConfig,
  visitorExternalId?: string,
): Promise<SessionOpenData> {
  const url = `${normBase(cfg.apiBase)}/api/v1/channel/web/${encodeURIComponent(cfg.channelKey)}/session`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      visitor_external_id: visitorExternalId,
      display_name: cfg.displayName,
    }),
  });
  return parseEnvelope<SessionOpenData>(res);
}

export async function sendMessage(
  cfg: WidgetConfig,
  visitorExternalId: string,
  text: string,
  contentType = "text",
): Promise<void> {
  const url = `${normBase(cfg.apiBase)}/api/v1/channel/web/${encodeURIComponent(cfg.channelKey)}/message`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      visitor_external_id: visitorExternalId,
      text,
      content_type: contentType,
      display_name: cfg.displayName,
    }),
  });
  await parseEnvelope<{ session_id: string | null }>(res);
}

/**
 * 上報一次頁面瀏覽(公開,無 JWT)。POST /api/v1/channel/web/{channelKey}/pageview。
 * body { visitor_external_id, url, title?, referrer? };後端對齊 get_or_create_visitor
 * 身份鍵定位/建立訪客並寫 PageView。任何失敗(網路 / 404 / 非 JSON)一律靜默吞掉,
 * 絕不拋出,不影響聊天流程。keepalive 讓 SPA 換頁 / 卸載當下的上報仍有機會送達。
 */
export async function reportPageView(
  cfg: WidgetConfig,
  visitorExternalId: string,
  url: string,
  title?: string,
  referrer?: string,
): Promise<void> {
  try {
    if (!cfg.channelKey || !visitorExternalId || !url) return;
    const endpoint = `${normBase(cfg.apiBase)}/api/v1/channel/web/${encodeURIComponent(cfg.channelKey)}/pageview`;
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitor_external_id: visitorExternalId,
        url,
        title: title || undefined,
        referrer: referrer || undefined,
      }),
      keepalive: true,
    });
  } catch {
    /* 頁面軌跡為加值功能,失敗靜默降級 */
  }
}

/** 上傳成功後的檔案資訊(後端 /upload 回傳)。 */
export interface UploadedFile {
  url: string;
  id: string;
  filename: string;
  content_type: string;
  size: number;
}

/** 上傳一個附件到 web 渠道;用 XHR 以取得進度回報。回傳檔案資訊(含相對 url)。 */
export function uploadFile(
  cfg: WidgetConfig,
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<UploadedFile> {
  const url = `${normBase(cfg.apiBase)}/api/v1/channel/web/${encodeURIComponent(cfg.channelKey)}/upload`;
  return new Promise<UploadedFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      const body = xhr.response as Envelope<UploadedFile> | null;
      if (xhr.status >= 200 && xhr.status < 300 && body && body.ok && body.data) {
        resolve(body.data);
      } else {
        reject(new Error(body?.error?.message || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("網路錯誤,上傳失敗"));
    const fd = new FormData();
    fd.append("file", file, file.name);
    xhr.send(fd);
  });
}

export interface HistoryMessage {
  id: string;
  session_id: string;
  sender_type: string;
  content_type: string;
  content: string;
  created_at: string | null;
}

/** 用坐席 JWT 拉會話歷史(輪詢 fallback)。回傳由舊到新排序的訊息。 */
export async function fetchHistory(
  cfg: WidgetConfig,
  sessionId: string,
): Promise<HistoryMessage[]> {
  if (!cfg.agentToken) throw new Error("缺少 agentToken,無法輪詢歷史");
  const url = `${normBase(cfg.apiBase)}/api/v1/conversation/sessions/${encodeURIComponent(sessionId)}?limit=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.agentToken}` },
  });
  const data = await parseEnvelope<{ messages: HistoryMessage[] }>(res);
  return data.messages || [];
}

/**
 * 公開訪客歷史(無需 agentToken):用 channelKey + session_id + visitor_external_id 還原對話。
 * 端點 GET /api/v1/channel/web/{channelKey}/sessions/{sessionId}/messages?visitor_external_id=...。
 * 後端以 channel+visitor 驗證會話歸屬(越權防護),僅回訪客可見訊息;回由舊到新排序。
 */
export async function fetchPublicHistory(
  cfg: WidgetConfig,
  sessionId: string,
  visitorExternalId: string,
): Promise<HistoryMessage[]> {
  const base = normBase(cfg.apiBase);
  const key = encodeURIComponent(cfg.channelKey);
  const sid = encodeURIComponent(sessionId);
  const vid = encodeURIComponent(visitorExternalId);
  const url = `${base}/api/v1/channel/web/${key}/sessions/${sid}/messages?visitor_external_id=${vid}&limit=100`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await parseEnvelope<{ messages: HistoryMessage[] }>(res);
  return data.messages || [];
}
