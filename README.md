# kefu

AI 原生、Telegram 一等公民、可多租戶白牌轉售的開源客服平台(乾淨室重寫)。

- 產品藍圖:[docs/BLUEPRINT.md](docs/BLUEPRINT.md)
- 開發計畫與模組分工:[docs/DEV-PLAN.md](docs/DEV-PLAN.md)
- 調研:[功能](docs/report-product.md) · [UI/UX](docs/report-ui.md) · [競品](docs/report-competitors.md)

## 技術棧
後端 Python/FastAPI 單體(SQLAlchemy async + Alembic) · PostgreSQL+pgvector · Redis · WebSocket。
前端(規劃)React 19 + Vite + Tailwind + shadcn/ui。

## 本地起步
```bash
cp .env.example .env          # 填 KEFU_OPENAI_API_KEY、KEFU_JWT_SECRET
docker compose up -d          # postgres(pgvector) + redis + backend
curl localhost:8000/health
```

## 目錄
```
backend/app/
  core/     設定、DB、回應信封、(認證中介層)
  models/   資料模型(tenancy/iam/visitor/conversation/knowledge/…)
  api/v1/   各模組路由(依 DEV-PLAN 的 M1–M12)
  services/ llm(Provider 可插拔,BYO-Key)、rag、routing…
  workers/  背景任務(RAG 索引、渠道 polling、報表聚合)
frontend/   (待建)
docs/       藍圖、開發計畫、調研報告
```
> 乾淨室重寫:功能借鑑 tgo/cskefu 與競品,程式碼與 schema 全部自寫,不含任一方原始碼/品牌/資產。
