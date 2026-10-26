# kefu

[![CI](https://github.com/IncredibleGG/kefu/actions/workflows/ci.yml/badge.svg)](https://github.com/IncredibleGG/kefu/actions/workflows/ci.yml)
[![desktop](https://github.com/IncredibleGG/kefu/actions/workflows/desktop.yml/badge.svg)](https://github.com/IncredibleGG/kefu/actions/workflows/desktop.yml)
[![android](https://github.com/IncredibleGG/kefu/actions/workflows/android.yml/badge.svg)](https://github.com/IncredibleGG/kefu/actions/workflows/android.yml)
[![ios](https://github.com/IncredibleGG/kefu/actions/workflows/ios.yml/badge.svg)](https://github.com/IncredibleGG/kefu/actions/workflows/ios.yml)

AI 原生、可多租戶白牌轉售的客服平台(乾淨室自研)。全渠道收件匣、知識庫 RAG、AI 代理與流程機器人、工單 CRM、路由排班、報表銷售,網頁與 Windows / macOS / iOS / Android 原生坐席 App 共用同一套工作台。

- 線上 demo:<https://kf.56k.cc>(功能介紹 <https://kf.56k.cc/features.html>)
- 原生 App 下載:[Releases](https://github.com/IncredibleGG/kefu/releases)
- 原生 App 架構與介面契約:[docs/NATIVE-CLIENTS.md](docs/NATIVE-CLIENTS.md)
- 產品藍圖與調研:[docs/BLUEPRINT.md](docs/BLUEPRINT.md) · [功能](docs/report-product.md) · [UI/UX](docs/report-ui.md) · [競品](docs/report-competitors.md)

## 組成

| 元件 | 技術 | 位置 |
|---|---|---|
| 後端 API | Python 3.12 · FastAPI(async)· SQLAlchemy 2 · PostgreSQL + pgvector · Redis · WebSocket | `backend/` |
| 坐席工作台(網頁) | React 19 · Vite · Tailwind v4 · shadcn/Radix · Zustand · TanStack Query · 16 種語言 | `frontend/` |
| 桌面 App(Windows、macOS) | Tauri 2,打包同一份前端 | `frontend/src-tauri/` |
| 手機 App(iOS、Android) | Capacitor 8,打包同一份前端 | `frontend/android/`、`frontend/ios/` |
| 訪客聊天掛件 | 零依賴、Shadow DOM 單檔 `embed.js` | `widget/` |

## 本地起步

```bash
cp .env.example .env          # 填 KEFU_OPENAI_API_KEY;正式環境務必改 KEFU_JWT_SECRET
docker compose up -d          # postgres(pgvector)+ redis + backend + 前端 + widget
curl localhost:18000/health   # 後端;坐席工作台在 http://localhost:18090
docker compose exec backend python -m app.seed   # 建 demo 租戶,印出 admin@demo.local 的隨機密碼
```

要指定 demo 管理員密碼時,執行 seed 加 `-e KEFU_DEMO_ADMIN_PASSWORD=…`。repo 是公開的,不要把任何真的密碼寫進程式碼或文件。

後端測試(與 CI 相同):

```bash
cd backend && uv sync --locked --extra dev && uv run --no-sync pytest -q
```

## 原生 App

四個平台的安裝檔都由 GitHub Actions 建置,推 `v*` tag 時自動發佈到 Releases。首次開啟 App 會詢問伺服器網址(預設 `https://kf.56k.cc`),再以坐席帳號登入。

| 平台 | 安裝檔 | 說明 |
|---|---|---|
| Windows | `.exe`(NSIS)/ `.msi` | 未簽章:SmartScreen 出現時按「其他資訊 → 仍要執行」 |
| macOS | `.dmg` | ad-hoc 簽章:首次開啟到「系統設定 → 隱私權與安全性」按「強制打開」 |
| Android | `.apk` | 允許「安裝未知來源的應用程式」後安裝。Releases 與 main 分支 CI 建出的 APK 用正式簽章,可互相覆蓋安裝;裝過 v0.1.0 或 PR / 其他分支 CI 的 APK,先解除安裝一次 |
| iOS | 模擬器 `.zip`、未簽章 `.ipa` | `.ipa` 以 Sideloadly / AltStore 用 Apple ID 重新簽章安裝 |

本機只需 Node 22+ 做前端檢查:`cd frontend && npm ci && npm run lint && npm run build:native`;原生編譯(Rust、Gradle、Xcode)一律在 CI 進行。端到端登入測試見 [e2e/README.md](e2e/README.md)。

## 目錄

```
backend/app/
  core/      設定、DB、回應信封、認證相依、CORS / 對外網址
  models/    資料模型(tenancy / iam / conversation / knowledge / billing / device …)
  api/v1/    各模組路由
  services/  llm(可插拔、BYO-Key)、rag、routing、realtime、presence、push …
  workers/   背景任務
frontend/
  src/lib/server.ts、src/lib/platform/   執行期伺服器設定與原生橋接(web / tauri / capacitor)
  src-tauri/ android/ ios/                原生殼
widget/      訪客掛件
clients/     品牌來源(brand.json、圖示)與版本注入腳本
e2e/         CI 端到端登入測試(Maestro、WebDriver)
docs/        架構契約、藍圖、調研報告
```

> 乾淨室自研:功能借鑑開源專案與競品,程式碼與 schema 全部自寫,不含任一方原始碼 / 品牌 / 資產。
