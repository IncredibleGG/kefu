/** ============================================================
 *  伺服器資訊快取(GET /api/v1/public/server-info,免登入)。
 *  原生登入頁依 features 決定是否顯示 Google / SAML 按鈕,並比對 min_app_version 提示更新。
 *  - 以伺服器 base 為 key 的記憶體快取(成功 10 分鐘、失敗 1 分鐘),同一時間只發一個請求。
 *  - 伺服器設定頁探測成功後以 primeServerInfo() 預先填入,登入頁不必再打一次。
 *  - 舊版伺服器沒有此端點(404)→ 視為 null(不顯示原生 SSO 按鈕,不擋登入)。
 *  ============================================================ */
import { useEffect, useState } from "react";
import { getServerBase, onServerChange, type ServerInfo } from "@/lib/server";

const OK_TTL = 10 * 60_000;
const FAIL_TTL = 60_000;

const cache = new Map<string, { info: ServerInfo | null; at: number }>();
const inflight = new Map<string, Promise<ServerInfo | null>>();

function keyOf(base: string): string {
  return base.replace(/\/+$/, "");
}

function isServerInfo(v: unknown): v is ServerInfo {
  return Boolean(v && typeof v === "object" && typeof (v as ServerInfo).app === "string");
}

/** 預先填入快取(伺服器設定頁探測成功時呼叫)。 */
export function primeServerInfo(base: string, info: ServerInfo | null | undefined): void {
  if (!base) return;
  cache.set(keyOf(base), { info: info ?? null, at: Date.now() });
}

/** 讀快取(未命中或過期回 undefined)。 */
export function peekServerInfo(base: string = getServerBase()): ServerInfo | null | undefined {
  const hit = cache.get(keyOf(base));
  if (!hit) return undefined;
  const ttl = hit.info ? OK_TTL : FAIL_TTL;
  if (Date.now() - hit.at > ttl) return undefined;
  return hit.info;
}

async function load(base: string): Promise<ServerInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}/api/v1/public/server-info`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown } | null;
    const data = j && typeof j === "object" && "data" in j ? j.data : j;
    if (!isServerInfo(data) || data.app !== "kefu") return null;
    return {
      ...data,
      features: {
        google_sso: Boolean(data.features?.google_sso),
        saml: Boolean(data.features?.saml),
        push: Boolean(data.features?.push),
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 取得伺服器資訊(走快取;永不拋錯,失敗回 null)。 */
export function fetchServerInfo(base: string = getServerBase()): Promise<ServerInfo | null> {
  const key = keyOf(base);
  const hit = peekServerInfo(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const p = load(key).then((info) => {
    cache.set(key, { info, at: Date.now() });
    inflight.delete(key);
    return info;
  });
  inflight.set(key, p);
  return p;
}

/**
 * React hook:目前伺服器的資訊。enabled=false 時不發請求(web 不需要)。
 * 回傳 info=undefined 表示載入中;null 表示取不到(舊伺服器或網路錯誤)。
 */
export function useServerInfo(enabled: boolean): ServerInfo | null | undefined {
  const [base, setBase] = useState(() => getServerBase());
  const [info, setInfo] = useState<ServerInfo | null | undefined>(() =>
    enabled ? peekServerInfo(getServerBase()) : null,
  );

  useEffect(() => onServerChange(() => setBase(getServerBase())), []);

  useEffect(() => {
    if (!enabled || !base) {
      setInfo(null);
      return;
    }
    let alive = true;
    const cached = peekServerInfo(base);
    setInfo(cached);
    if (cached === undefined) {
      void fetchServerInfo(base).then((v) => {
        if (alive) setInfo(v);
      });
    }
    return () => {
      alive = false;
    };
  }, [enabled, base]);

  return info;
}
