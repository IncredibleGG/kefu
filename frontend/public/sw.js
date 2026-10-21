/* kefu 坐席台 Service Worker(手寫,無外部依賴)
 * 職責:
 *  1. 快取 app shell 與同源靜態資源,離線可開(navigation 走 network-first,離線回退快取 index.html)。
 *  2. 版本化快取;activate 時清除舊版快取。
 *  3. 絕不快取 API(/api、/ws)與 Vite dev 專用資源,避免髒資料 / 打斷 HMR。
 *
 * 版本升級方式:改 CACHE_VERSION → activate 會清掉不同版本的舊快取。
 */
const CACHE_VERSION = "v1";
const CACHE_NAME = `kefu-pwa-${CACHE_VERSION}`;

/* 預先快取的 app shell(缺任何一個都不讓 install 失敗) */
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 逐一加入,單一資源失敗不影響整體安裝
      await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("kefu-pwa-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

/* 允許頁面主動要求立即接管(pwa.ts 於偵測到新版時可 postMessage） */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/* 判斷是否為「不該碰」的請求(API / WS / Vite dev 模組 / 跨域) */
function shouldBypass(url, request) {
  if (request.method !== "GET") return true;
  if (url.origin !== self.location.origin) return true; // 跨域(含 CDN)一律放行
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/ws")) return true; // 動態 API 不快取
  // Vite dev 專用路徑(生產環境不會出現)
  if (
    p.startsWith("/@") ||
    p.startsWith("/src/") ||
    p.startsWith("/node_modules/") ||
    url.searchParams.has("t") ||
    url.searchParams.has("import")
  ) {
    return true;
  }
  return false;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (shouldBypass(url, request)) return; // 交給瀏覽器預設處理

  // 導覽請求(換頁 / 首開):network-first,離線回退 app shell
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put("/index.html", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (
            (await cache.match("/index.html")) ||
            (await cache.match("/")) ||
            new Response("離線中且無快取內容", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
          );
        }
      })(),
    );
    return;
  }

  // 靜態資源:cache-first,取回後順手寫入快取
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        // 僅快取成功的同源基本回應
        if (fresh && fresh.status === 200 && fresh.type === "basic") {
          cache.put(request, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        // 圖示等取不到時回退快取(可能 undefined → 讓瀏覽器顯示失敗)
        return cached || Response.error();
      }
    })(),
  );
});
