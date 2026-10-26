# kefu 原生客戶端:架構與實作契約

> 狀態:開發中(2026-10-22 起)。本文件同時是**平行開發的單一事實來源**:各工作包依此實作,介面以本文為準;實作與本文衝突時先改本文再改碼。

## 1. 決策摘要

| 項目 | 決定 |
|---|---|
| 產品 | **坐席全功能 App**:依角色(admin / supervisor / agent)顯示功能;桌面 ≈ 網頁,手機為行動優化版面 |
| 技術 | 共用現有 `frontend/` React 19 程式碼,**打包進原生殼**(不是遠端網址包殼) |
| 桌面 | **Tauri 2.12**(Windows、macOS),專案在 `frontend/src-tauri/` |
| 手機 | **Capacitor 8.5**(iOS、Android),專案在 `frontend/capacitor.config.ts`、`frontend/android/`、`frontend/ios/` |
| 品牌 | 單一 kefu 品牌;首次啟動在 App 內設定伺服器(預設 `https://kf.56k.cc`)再登入。品牌唯一來源:`clients/branding/brand.json` |
| 發佈 | 先出可安裝開發版(未簽章);簽章與商店帳號日後補 |
| 編譯 | 全部在 **GitHub Actions**;本機只做輕量檢查(`tsc`、`vite build`) |

## 2. 固定常數

| 名稱 | 值 |
|---|---|
| App ID / bundle identifier | `cc.kf56k.kefu`(Android 規定每段需字母開頭,故不用 `cc.56k.kf`;送審前可改,上架後不可改) |
| productName / appName | `kefu` |
| 版本 | `0.1.0`(CI 以 `clients/scripts/sync-brand.mjs` 注入) |
| URL scheme | `kefu` |
| 預設伺服器 | `https://kf.56k.cc` |
| Origin | macOS `tauri://localhost`、Windows `http://tauri.localhost`、iOS `capacitor://localhost`、Android `https://localhost`(**上線後不可改**,改了 localStorage 會遺失) |
| 前端原生產物 | `frontend/dist-native/`(`npm run build:native`;Tauri `frontendDist` 與 Capacitor `webDir` 共用) |
| Android 通知頻道 | `kefu_messages` |
| 最低系統 | macOS 13.3、iOS 16.4、Android WebView ≥ 111(Tailwind v4 需要 Safari 16.4 / Chrome 111) |

### Deep link

| URL | 用途 |
|---|---|
| `kefu://auth/callback?code=…&state=…` | 原生 SSO 回呼(PKCE 一次性 code) |
| `kefu://auth/callback?sso_error=CODE&state=…` | 原生 SSO 失敗 |
| `kefu://setup?server=https%3A%2F%2Fexample.com` | 佈建連結:預填伺服器網址(**一律要使用者確認**才套用,不可靜默切換) |

### 儲存鍵

- localStorage(同步讀取用的記憶體鏡像):`kefu-token`、`kefu-auth`(zustand persist)、`kefu-server`、`kefu-device-id`
- 原生持久儲存(真正的事實來源,啟動時讀進 localStorage):桌面 `tauri-plugin-store` 檔案 `kefu.json`、手機 `@capacitor/preferences`;鍵名 `server`、`token`、`deviceId`

## 3. 前端平台層(`frontend/src/lib/server.ts`、`frontend/src/lib/platform/`)

所有原生外掛一律在 `platform === "tauri"` / `"capacitor"` 分支內 **動態 import**,web bundle 不得被汙染。

```ts
// src/lib/server.ts
export type ServerInfo = {
  app: string; api_version: number; server_version?: string; min_app_version?: string;
  features: { google_sso: boolean; saml: boolean; push: boolean };
};
export const DEFAULT_SERVER: string;                 // import.meta.env.VITE_DEFAULT_SERVER ?? "https://kf.56k.cc"
export function getServerBase(): string;             // web: config.apiBase(""=同源);native: 已存伺服器或 ""
export function getServerOrigin(): string;           // API 的絕對 origin(webhook 等給第三方回呼的網址);web 且 base 為空時 = window.location.origin
export function pageOrigin(): string;                // 給「人」開啟的連結用:web = window.location.origin(頁面網域),native = getServerOrigin()
export function serverHost(): string;                // new URL(pageOrigin()).host(白牌品牌查詢用)
export function hasServer(): boolean;                // web 恆為 true
export function normalizeServerUrl(input: string): string; // 補 https://、去尾斜線;native 只接受 https(localhost/127.0.0.1 除外)
export function probeServer(url: string): Promise<{ ok: boolean; info?: ServerInfo; error?: string }>; // /health + /api/v1/public/server-info
export function setServerBase(url: string): Promise<void>; // 寫入原生儲存;觸發 onServerChange
export function onServerChange(cb: () => void): () => void;
export function apiUrl(path: string, params?: Record<string, unknown>): string; // 取代 client.ts buildUrl
export function wsUrl(path: string, params?: Record<string, string>): string;   // http→ws
export function fileUrl(u?: string | null): string | null; // "/…" → 伺服器前綴;絕對網址原樣
export function publicUrl(path: string): string;     // pageOrigin() + path(邀請 / 重設密碼 / Help Center / embed.js)
export function getToken(): string | null;
export function setToken(t: string): void;           // 同步寫 localStorage,非同步寫原生儲存
export function clearToken(): void;
```

```ts
// src/lib/platform/index.ts(web.ts / tauri.ts / capacitor.ts 三個 adapter)
export type PlatformKind = "web" | "tauri" | "capacitor";
export const platform: PlatformKind;
export const os: "windows" | "macos" | "linux" | "ios" | "android" | "web";
export const isNative: boolean; export const isDesktopApp: boolean; export const isMobileApp: boolean;
export const appVersion: string;
export function initPlatform(): Promise<void>;       // main.tsx render 前呼叫:讀原生儲存→localStorage、連結攔截器、resume/online/deep-link 監聽、native 時解除 SW
export function notificationSupported(): boolean;
export function getNotificationPermission(): Promise<"granted" | "denied" | "default">;
export function requestNotificationPermission(): Promise<boolean>;
export function notify(o: { title: string; body?: string; tag?: string; sessionId?: string }): Promise<boolean>;
export function setBadge(count: number): Promise<void>;
export function isAppForeground(): boolean;
export function openExternal(url: string): Promise<void>;
export function saveFile(blob: Blob, filename: string): Promise<void>; // 桌面:存檔對話框;手機:Filesystem + Share
export function onResume(cb: () => void): () => void;
export function onPause(cb: () => void): () => void;
export function onOnline(cb: () => void): () => void;
export function onDeepLink(cb: (url: string) => void): () => void;
export function startExternalAuth(url: string): Promise<void>;          // 系統瀏覽器開啟
export function pushRegister(): Promise<{ token: string } | null>;     // 僅手機;無 Firebase 設定時回 null,不得拋錯
export function onPushTap(cb: (data: Record<string, string>) => void): () => void;
export function getDeviceId(): string;               // 穩定 UUID,存在原生儲存
```

桌面 Rust 指令(`invoke`):`set_unread(count: u32)` 更新系統匣提示與 Dock 角標/Windows 工作列疊加圖示(前端 `setBadge` 先夾成非負整數);`show_main_window()`(Rust 端已註冊,前端目前未呼叫)。

實作補充:
- `probeServer`:`/api/v1/public/server-info` 回 404(舊版伺服器)仍視為連線成功、`info` 為 undefined;`app !== "kefu"` 判定為不是 kefu 伺服器。`normalizeServerUrl` 不合法時丟 `ServerUrlError`(`empty` / `invalid_url` / `https_required`)。
- `min_app_version` 高於 App 版本時只顯示「請更新 App」提示,**不阻擋**登入。
- 冷啟動時才到的 deep link / 推播點擊,平台層暫存 30 秒,晚訂閱的監聽者仍收得到。
- 佈建連結 `kefu://setup`:伺服器設定頁開著時由設定頁自己的確認卡處理;否則已設定伺服器時由 `ServerGate` 跳確認框,再經設定頁探測通過才切換。
- 桌面通知(`tauri-plugin-notification`)沒有點擊回呼:點通知只會把視窗帶到前景,不會導向該會話。

**原生建置環境** `frontend/.env.native`(已入庫:根目錄 `.gitignore` 以 `!frontend/.env.native` 放行;缺檔時 `sync-brand.mjs` 依契約建立):`VITE_PLATFORM=native`、`VITE_MOCK=off`(**必須**,否則伺服器連不上時會靜默改用假資料;另外 runtime 在原生環境一律強制 mock off)、`VITE_DEFAULT_SERVER=https://kf.56k.cc`、`VITE_FCM_ENABLED=off`(Android 沒有 `google-services.json` 時呼叫推播 `register()` 會原生閃退,所以 Android 只有此旗標為 `on` 才註冊;`android.yml` 有注入 `GOOGLE_SERVICES_JSON_B64` 時以環境變數覆寫成 `on`)。native mode 的 Vite 建置要移除 PWA(manifest、`sw.js`)與 `status.html`、`features.html`、`shots/`,但保留 `webview-too-old.html`。

## 4. 後端契約

### 4.1 新增 / 變更的 REST

| 端點 | 內容 |
|---|---|
| `GET /api/v1/public/server-info`(免登入) | `{app:"kefu", api_version:1, server_version, min_app_version:"0.1.0", features:{google_sso, saml, push}}` |
| `POST /api/v1/auth/login` | body 新增選填 `tenant`(slug)。email **不分大小寫**。密碼正確且對到多個**啟用中**租戶又沒帶 tenant 時,回 `{requires_tenant_selection:true, tenants:[{slug,name}]}`(HTTP 200,依名稱排序;密碼錯一律 401,不揭露租戶),客戶端(web 與原生都支援)顯示工作區選擇後帶 tenant 重送。限流改 `login:{ip}:{email}` 10 次/300 秒 + `login-ip:{ip}` 200 次/300 秒 |
| `GET /api/v1/auth/me` | 新增 `tenant:{id,name,slug}` |
| 邀請 / 重設密碼 | 回應新增絕對網址 `invite_link` / `reset_link`(保留原相對欄位) |
| `POST /api/v1/devices` | `{token, platform:"ios"\|"android"\|"desktop", device_id, app_version, os_version?, locale?}` → 以 `(staff_id, device_id)` upsert;回 `{id, push_enabled}`。`token` 最長 2048、全域唯一(同一 token 搬到新的坐席 / 裝置);`device_id` 須符合 `^[A-Za-z0-9._:-]{1,128}$`;桌面可省略 token(後端合成 `desktop:{device_id}`,只登記不推送);每人最多 10 台未撤銷裝置 |
| `DELETE /api/v1/devices/{device_id}` | 只能撤銷自己的;登出時**先呼叫這個再清 token** |
| `GET /api/v1/devices` | 列出自己的裝置(不回 token;`include_revoked=true` 含已撤銷) |
| `POST /api/v1/auth/sso/exchange` | `{code, code_verifier}` → 與登入成功相同的 `{access_token, token_type, staff_id, is_platform_admin}` |

**原生 SSO(PKCE)**:`GET /api/v1/auth/oauth/google/start?client=native&redirect_uri=kefu://auth/callback&state=<app_state>&code_challenge=<b64url>&code_challenge_method=S256`;回呼成功 302 到 `kefu://auth/callback?code=…&state=…`(code 一次性、60 秒),失敗 `?sso_error=…&state=…`。`redirect_uri` 必須與 `KEFU_NATIVE_REDIRECT_URIS`(預設 `kefu://auth/callback`)**完全相等**。Web 流程同時補上 OAuth `state`(防 login CSRF)。SAML `GET /api/v1/saml/login/{slug}` 接受同樣參數。

**CORS**:未捕獲例外的 500 回應也要帶 CORS 標頭;`expose_headers` 加 `X-Request-Id, Content-Disposition`;白名單模式自動併入四個原生 origin;`allow_credentials` 維持 False。

### 4.2 WebSocket `/ws/agent?token=&session_id=&device_id=&platform=`

- 認證失敗(缺 token、token 無效/過期、帳號停用/刪除、租戶停用)→ **先 accept 再 `close(4401)`**,客戶端才看得到原因;客戶端收到 4401 走登出流程、不再重連。**連線期間**伺服器約每 60 秒複查一次(帳號撤銷 / 租戶停用 / JWT 過期),不通過同樣 `close(4401)`;複查時 DB 故障則放行(同 REST)。
- 伺服器端事件轉發中斷(例如 Redis 訂閱失敗)→ `close(1011)`,客戶端依退避重連並重新訂閱;連線至少維持 5 秒才關,避免 Redis 持續故障時每秒重連打爆 DB。`/ws/widget` 同樣處理。
- 客戶端 `{"type":"ping"}`(純文字 JSON frame)→ 伺服器 `{"type":"pong","payload":{},"ts":…}`;客戶端每 25 秒 ping,**收過至少一次 pong 之後**才啟用「10 秒沒 pong 視為斷線重連」(舊版伺服器不回 pong,不會被誤判)。
- 客戶端 `{"type":"app_state","payload":{"foreground":true|false}}`。
- 上線狀態改用 Redis 連線登記(`kefu:ws:{staff_id}` hash,TTL 120 秒,伺服器每 30 秒自行刷新):第一條連線出現才設 online、最後一條結束(3 秒寬限)才設 offline;使用者手動設的忙碌/離開不被覆蓋;手動設「離線」以 Redis 標記 `kefu:status:manual-offline:{staff_id}` 記錄,重連時不會被改回 online(改設其他狀態即清除)。下線更新後若同時有新連線出現,會改回 online(防競態)。Redis 不可用時 fail-open(退回連上即上線、斷線即離線)。
- `session.activity` payload 擴充:`message_id, sender_type, content_type, preview(≤80 字、已卡號遮罩), handler_type, handler_staff_id, status, visitor_id`。
- `session.assigned` 擴充:`handler_staff_id`、`actor`(`"auto"` 或操作者 staff id;搶單認領時為本人;操作者未知時為 null)。原 `staff_id` 保留以向後相容。
- 轉接事件(`handoff`)擴充:`from_staff_id`(**執行動作的人**,與轉接 system 訊息 meta 一致)、`previous_handler_staff_id`(動作前的負責坐席)、`note`(僅 /transfer 有值);`/transfer` 另帶 `target_staff_id`、`target_skill_group_id`。handoff 事件只發坐席頻道,不進訪客的會話頻道。

### 4.3 推播(程式碼就緒;沒設定時完全不動作)

- 環境變數:`KEFU_FCM_SERVICE_ACCOUNT_JSON`(JSON 內容或檔案路徑)、`KEFU_FCM_PROJECT_ID`(選填)、`KEFU_PUSH_PREVIEW`(預設 true)。
- FCM HTTP v1 涵蓋 Android 與 iOS(APNs 經 FCM)。**限制:iOS 需付費 Apple 帳號簽章才收得到推播**;Android 未簽章版可收。
- **已知缺口(iOS)**:`@capacitor/push-notifications` 在 iOS 回的是 APNs device token,不是 FCM registration token;目前 iOS 會把 APNs token 送到 `POST /devices`,後端呼叫 FCM 失敗後把該筆標為 revoked(不會出錯)。要讓 iOS 收到推播,需在 iOS 殼加 Firebase Messaging 換成 FCM token,或後端讓 iOS 直接走 APNs。
- 撤銷權杖:FCM 回 `UNREGISTERED`,或 HTTP 400 + `INVALID_ARGUMENT`;單純 404(可能是 project id 設錯)不撤銷。
- 觸發:新訪客訊息(推給負責坐席)、指派給我、轉接給我;該坐席任何裝置有前景連線時不推;同會話 15 秒內合併。
- push `data`:`{type:"message"|"assigned"|"transfer", session_id, tenant_id}`;點擊開啟 `/workspace/{session_id}`。

## 5. 原生殼

- **Tauri**:視窗 1280×800、最小 380×560(窄於 768px 自動套手機版面);`backgroundThrottling: disabled`;關閉視窗 = 縮到系統匣,系統匣選單「結束」才真正退出;single-instance(第一個註冊,含 deep-link);window-state;macOS ad-hoc 簽章 `signingIdentity: "-"`;CSP 允許 `connect-src https: wss:`、`img-src https: data: blob:`。
- **Capacitor**:`android.minWebViewVersion: 111` + `errorPath: "webview-too-old.html"`;iOS deployment target 16.4;Keyboard resize native;註冊 `kefu://`;推播權限在登入後請求;Android 返回鍵順序:關最上層浮層 → 頁面覆寫(`setBackOverride`,例如伺服器設定頁開著時只關設定頁、絕不移動背後隱藏的 router)→ 有上一頁(react-router `history.state.idx > 0`)才 `history.back()` → 縮小 App。原生 SSO 的 PKCE 暫存(verifier/state)存 localStorage、5 分鐘有效、用過即清,以撐過系統在瀏覽器登入期間回收 App。
- **Android 簽章**:CI 用共用 keystore(PKCS12、alias `kefu`;secrets `ANDROID_DEBUG_KEYSTORE_B64` / `ANDROID_DEBUG_KEYSTORE_PASSWORD`),`app/build.gradle` 由 `KEFU_ANDROID_KEYSTORE` 指定,建置後檢查憑證 SHA-256(`android.yml` 的 `ANDROID_CERT_SHA256`),不符就失敗。只有 tag 與 main 的建置拿 keystore(缺 secret 就失敗);PR 與其他分支刻意用 AGP 隨機簽章、只警告,因為公開的 PR artifact 不該能覆蓋安裝正式版。同一把 key 新版才能直接覆蓋安裝;v0.1.0 與共用簽章上線前 CI 產出的 APK 都不是正式簽章(多為 AGP 每次隨機產生;PR #5 早期幾次建置用的 key 已作廢重產),從它們升級要先解除安裝一次。

## 6. CI / 產物

| Workflow | Runner | 產物 |
|---|---|---|
| `ci.yml` | ubuntu | 後端 pytest、前端 tsc + 登入/原生 SSO 單元測試(`node src/components/auth/__tests__/run.mjs`)+ web build + native build、widget build |
| `desktop.yml` | windows + macos | `kefu-desktop-windows-x64`(.msi + .exe)、`kefu-desktop-macos`(.dmg) |
| `android.yml` | ubuntu | `kefu-android-debug.apk` |
| `ios.yml` | macos | `kefu-ios-simulator.zip`、`kefu-ios-unsigned.ipa` |
| `release.yml` | tag `v*` | 以上全部 + GitHub Release(預先發行版,可直接下載) |

## 7. 平行開發規則(所有工作包必守)

1. **只在** `/Volumes/Ti600/Claude/kefu` 工作;**絕不**修改 `/Users/lakeville/Documents/claude/kefu`(過時副本)。
2. **只改自己工作包擁有的檔案**。共用檔案(`backend/app/main.py`、`docker-compose.yml` 等)若被列為「可附加」,一律用 **Edit 局部修改,禁止整檔覆寫**。
3. **不准改 `frontend/package.json` / lockfile**(依賴已統一裝好)。
4. **不准改 `frontend/src/locales/**`**。新字串寫 `t("key", "繁中預設文字")`,並把 key 與繁中文字記到 `frontend/src/locales/_pending/<工作包代號>.json`(巢狀 JSON),最後由 i18n 工作包統一合併並補齊 16 語翻譯。
5. 不 commit、不 push。程式碼註解沿用現有風格(繁體中文)。
6. 檢查指令:前端 `cd frontend && npm run lint && npm run build:native`;後端 `cd backend && /Users/lakeville/Documents/claude/kefu/backend/.venv/bin/python -m pytest -q -p no:cacheprovider`(目前基線:0 失敗)。
7. 原生編譯(Rust / Gradle / Xcode)**不在本機跑**,交給 GitHub Actions。
