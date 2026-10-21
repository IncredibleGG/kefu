# kefu 前端 — 坐席工作台

AI 原生客服平台的坐席工作台前端(乾淨室重寫,不含 tgo/cskefu 任何原始碼、圖片、品牌/Logo/配色)。

## 技術棧

React 19 · TypeScript · Vite · Tailwind v4 · shadcn/ui(Radix)· Zustand · TanStack Query · React Router · lucide-react · i18next · Recharts · TipTap · WebSocket。

## 快速開始

```bash
cd frontend
cp .env.example .env.local      # 可選;不改也能跑
npm install
npm run dev                     # http://localhost:5173
```

> **後端未起也能看畫面**:預設 `VITE_MOCK=auto`,認證會嘗試打真 API,連不上時自動回退 mock;
> 其餘尚未接的端點一律走 mock 適配層(`src/api/mock/`)。登入頁用任意帳密即可進入(mock)。

### 環境變數(`.env.local`)

| 變數 | 預設 | 說明 |
|---|---|---|
| `VITE_API_BASE` | `http://localhost:8000` | 後端 API 基底;dev server 已對 `/api`、`/ws` 代理到此 |
| `VITE_MOCK` | `auto` | `auto`=真 API + 未實作回退 mock;`on`=全 mock;`off`=全真 API |

### 指令

- `npm run dev` — 開發伺服器(HMR)
- `npm run build` — 型別檢查 + 打包到 `dist/`
- `npm run preview` — 預覽打包結果
- `npm run lint` — 僅型別檢查(`tsc --noEmit`)

## 目錄結構(重點)

```
src/
  api/
    client.ts        fetch 封裝:{ok,data,error} 信封、Bearer、401 導回登入、mock 路由
    endpoints.ts     所有端點定義(每個標明 real / mock)
    hooks.ts         TanStack Query hooks
    realtime.ts      坐席 WebSocket(/ws/agent);無後端時回退 mock 事件
    mock/            mock 適配層(集中一處,方便換真 API):data.ts 資料、index.ts 函式
  components/
    ui/              shadcn 風格共用元件(Radix):button/input/card/tabs/dialog/…
    layout/          IconRail(窄圖示主欄)、SecondarySidebar、TopBar、AppLayout、nav 設定
    workspace/       三欄坐席工作台:ConversationList / ConversationView / ContextPanel
                     MessageBubble / MessageComposer(TipTap)/ SuggestionBar / ServiceSummaryDialog
  pages/             各路由頁(工作台 + 訪客/AI/知識庫/渠道/報表/設定 骨架)
  routes/            router 與路由守衛 ProtectedRoute
  stores/            Zustand:auth(登入/JWT/持久化)、ui(主題/坐席狀態/面板)
  lib/               utils、config、i18n、markdown、channels(渠道 meta)
  locales/           i18next 語系(zh-Hant 預設、en)
  styles/index.css   設計系統 tokens(亮/暗雙主題、8pt、圓角、品牌強調色)
  types/             領域型別(對齊後端概念模型)
```

## 設計系統

- 中性灰底(slate/zinc)+ **可調品牌強調色**(紫羅蘭,避開純綠/純藍),於 `styles/index.css` 的 `--brand` 一處替換即改品牌。
- **亮/暗雙主題**:CSS 變數 + `.dark` 類名;頂欄與登入頁可切換,已防首屏閃爍。
- 8pt 網格、圓角 6–10px、WCAG AA 對比、細自動隱藏捲軸、焦點可見。

## 與後端對接

- 統一信封 `{ ok, data, error, request_id }`;認證 `Authorization: Bearer <jwt>`;401 自動登出導回登入。
- 已接真 API:`POST /api/v1/auth/login`、`GET /api/v1/auth/me`。
- 其餘端點路徑已依 `docs/DEV-PLAN.md` 契約預先寫好(見 `src/api/endpoints.ts`),
  後端就緒後把該端點的 `real` 設為 `true` 即切換為真 API。
- WebSocket:`/ws/agent`(封包 `{ type, payload, ts }`)。
