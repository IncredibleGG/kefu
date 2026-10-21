# kefu widget(訪客前台聊天 widget)

輕量、可嵌入的訪客聊天 widget:右下角氣泡 → 聊天面板,訪客送訊給 kefu 客服系統,
即時收 AI/真人回覆(**WebSocket 優先,連不上輪詢 fallback**),支援基本 Markdown。
無框架、單一 `embed.js`(IIFE + Shadow DOM,與宿主頁隔離),約 16 KB(gzip ~6 KB)。

> 乾淨室自寫,未引用 tgo/cskefu 任何程式碼。只用 backend 既有公開渠道契約。

## 目錄

```
widget/
  src/
    embed.ts      入口:讀 <script data-*> / window.KefuWidgetConfig,自動或手動 init
    widget.ts     KefuWidget:氣泡+面板、開會話、送訊、WS/輪詢接收、訊息去重
    api.ts        端點組裝、開會話、送訊、輪詢歷史
    ws.ts         /ws/widget 連線 + 指數退避重連 + 失敗轉輪詢
    markdown.ts   極簡且安全的 Markdown → HTML(先轉義再格式化)
    styles.ts     Shadow DOM 內樣式
    types.ts      設定與型別
  demo/index.html 測試頁(可填 apiBase / channelKey / tenantId / agentToken)
  scripts/postbuild.mjs  build 後把 demo 複製成 dist/index.html
  Dockerfile      多階段:node build → nginx 靜態服務
  nginx.conf      靜態 + /api /ws 反代到 backend:8000
  vite.config.ts  lib/IIFE 單檔輸出 dist/embed.js
```

## 嵌入方式

### 方式 A:一行 `<script>`(建議)

把下面貼進任意網站(同源反代情境,`apiBase` 留空即可):

```html
<script
  src="https://<widget 服務網域>/embed.js"
  data-channel-key="貼上 web 渠道的 public_key"
  data-api-base=""
  data-tenant-id="租戶 UUID"
  data-title="線上客服"
  data-primary-color="#2563eb"></script>
```

- 只要有 `data-channel-key` 就自動初始化,右下角出現氣泡。
- `data-api-base` 留空 = 同源相對路徑(推薦,透過反代);跨網域則填後端根位址。

### 方式 B:JS 手動初始化

```html
<script src="https://<widget 服務網域>/embed.js"></script>
<script>
  window.KefuWidget.init({
    apiBase: "",                 // 同源
    channelKey: "PUBLIC_KEY",
    tenantId: "TENANT_UUID",     // 走 WS 接收回覆
    title: "線上客服",
  });
</script>
```

> 若想「只載入不自動起」,在載入 embed.js 前設
> `window.KefuWidgetConfig = { manualInit: true }`,之後自行呼叫 `KefuWidget.init(...)`。

## 設定項

| 參數 | data-* | 說明 |
| --- | --- | --- |
| `apiBase` | `data-api-base` | API 根位址;留空 = 同源相對路徑 |
| `channelKey` | `data-channel-key` | **必填**,web 渠道 `public_key`,定位渠道 |
| `tenantId` | `data-tenant-id` | 租戶 UUID;用於 `/ws/widget` 即時接收回覆 |
| `agentToken` | `data-agent-token` | 選填坐席 JWT;WS 連不上時輪詢歷史 fallback(**僅測試用**) |
| `displayName` | `data-display-name` | 訪客顯示名 |
| `title` | `data-title` | 面板標題 |
| `greeting` | `data-greeting` | 首開歡迎語(不送後端) |
| `primaryColor` | `data-primary-color` | 主題色 |
| `autoOpen` | `data-auto-open` | 載入即展開面板 |
| `pollIntervalMs` | `data-poll-interval-ms` | 輪詢間隔,預設 3000 |

## channelKey 從哪來?

`channelKey` = 後端 `Channel.config.public_key`。取得方式(需坐席 JWT):

```bash
# 1) 建一個 web 渠道
curl -X POST https://<api>/api/v1/channel \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"type":"web","name":"官網 widget"}'
# 2) 或列出既有渠道,取 web 渠道的 config.public_key
curl https://<api>/api/v1/channel -H "Authorization: Bearer <JWT>"
```

回應 `data.config.public_key` 即 `channelKey`。`tenantId` 為該渠道所屬租戶 id
(與登入坐席同租戶,可從 JWT payload 的 `tenant_id` 取得)。

## 後端對接端點(以 backend 原始碼為準)

- 開會話:`POST {apiBase}/api/v1/channel/web/{channelKey}/session`
  body `{ visitor_external_id?, display_name? }` → `data.{ session_id, visitor_external_id, channel_id }`
- 送訊(訪客,**會觸發 AI dispatch**):`POST {apiBase}/api/v1/channel/web/{channelKey}/message`
  body `{ visitor_external_id, text, content_type, display_name? }`
- 接收回覆:`WS {apiBase}/ws/widget?tenant_id={tenantId}&session_id={sessionId}`
  推送封包 `{ type:"message.new", payload:{ sender_type, content, content_type, message_id }, ts }`
- 輪詢 fallback(需坐席 JWT):`GET {apiBase}/api/v1/conversation/sessions/{sessionId}` → `data.messages[]`

回應信封統一 `{ ok, data, error, request_id }`。

## 本地測試

```bash
npm install
npm run build          # 產出 dist/embed.js + dist/index.html(demo)
npm run preview        # 或用任意靜態伺服器開 dist/
# 例:python3 -m http.server 8899 --directory dist  → http://localhost:8899
```

demo 頁填入 `apiBase`(對同源反代測試填 widget 服務自身位址,如 `http://localhost:18091`)、
`channelKey`、`tenantId`,按「載入 widget」即可端到端測。

> 純前端(無後端)開 demo 只驗證 UI:送訊會顯示「建立會話失敗」提示,屬正常。

## Docker / compose

`Dockerfile`(node build → nginx)與 `nginx.conf`(靜態 + `/api`、`/ws` 反代到 `backend:8000`)已就緒。
加進根目錄 `docker-compose.yml`:

```yaml
  widget:
    restart: unless-stopped
    build: ./widget
    depends_on:
      - backend
    ports:
      - "18091:80"    # host 18091 -> nginx(CF tunnel 可指向此)
```

widget 服務自帶 `/api`、`/ws` 反代,故 `apiBase` 用同源相對路徑即可,嵌入方無跨域問題。
