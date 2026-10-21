# kefu 開發總計畫(乾淨室重寫)

> 代號 **kefu**(後端 Python package = `app`,可日後改品牌)。依據 [BLUEPRINT.md](BLUEPRINT.md)。
> 決策定案(2026-09-23):後端 **FastAPI 單體**;MVP 範圍**較大**(含質檢/報表/工單);測試在**遠端伺服器**;開發期 LLM 用 **OpenAI**(產品本身 BYO-Key 可換供應商)。

## 0. 開發方法:主幹先行,再多 agent 並行

```
階段一 立地基(序列,我親自做)  ← 現在
  repo 骨架 + 設定/DB/認證核心 + 資料模型 + 【API 契約】 + 設計系統
        │  API 契約 = 各 agent 的共同接口,定好才能平行不打架
        ▼
階段二 模組並行(多 agent,依契約各寫各的)
  租戶/RBAC · 坐席工作台 · AI/RAG · 渠道接入 · 知識庫 · 訪客CRM · 工單 · 質檢/CSAT · 報表 · 計費
        ▼
階段三 整合 + 你測(我串起來、docker 部署到遠端伺服器,你點測回饋)
```

## 1. 技術棧(定案)

- **後端**:Python 3.12 + FastAPI + SQLAlchemy 2.0(async)+ Alembic + Pydantic v2;Celery(或 arq)跑背景任務(RAG 索引、渠道 polling、報表聚合);uvicorn。
- **DB**:PostgreSQL 16 + **pgvector**(RAG);Redis(快取/佇列/即時 pub-sub)。
- **即時**:WebSocket(坐席台與 widget)。
- **前端**:React 19 + TypeScript + Vite + Tailwind v4 + **shadcn/ui**;Zustand + TanStack Query;TipTap;React Flow;Recharts。
- **AI**:Provider 可插拔層(`app/services/llm/`),開發期預設 OpenAI;支援 BYO-Key(租戶自帶)。
- **部署**:docker-compose(postgres/redis/backend/worker/frontend/nginx),目標遠端伺服器。

## 2. 模組邊界(= agent 分工單位,彼此以 API 契約 + DB 模型解耦)

| # | 模組 | 職責 | 依賴 |
|---|---|---|---|
| M1 | tenancy | 租戶/組織/部門/白牌設定;租戶隔離中介層 | 核心(先做) |
| M2 | iam | 認證(JWT)、坐席、角色權限 RBAC、技能組 | M1 |
| M3 | conversation | 會話/訊息/當前處理者/handoff/WebSocket | M1,M2 |
| M4 | visitor | 訪客↔聯絡人(CRM)、跨渠道合併、標籤、軌跡 | M1 |
| M5 | channel | 渠道歸一化;Web Widget、**Telegram**、Email(MVP);WhatsApp/微信(後) | M3,M4 |
| M6 | ai | AI Agent、LLM Provider 抽象、對話記憶、tool calling、Copilot/回覆建議 | M3,M7 |
| M7 | knowledge | 知識庫(文檔/QA/網站)、pgvector RAG 檢索、可溯源 | M1 |
| M8 | routing | 會話分配:規則式技能組路由 + 可選 LLM 智能分配 | M2,M3 |
| M9 | ticket | 工單(自建):建立/指派/狀態/關聯會話與聯絡人 | M3,M4 |
| M10 | quality | 質檢標註、CSAT 滿意度、服務小結、坐席監控干預 | M3 |
| M11 | reporting | 會話量/坐席績效/排隊/滿意度/質檢報表 | M3,M10 |
| M12 | billing | 用量計量(UsageRecord)、訂閱/帳單、白牌轉售儀表板 | M1 |

## 3. API 契約約定(所有模組共守)

- 路徑前綴 `/api/v1/<module>`;RESTful;回應統一信封 `{ ok, data, error, request_id }`。
- 認證:`Authorization: Bearer <jwt>`;JWT 內含 `tenant_id`、`staff_id`、`roles`。
- **多租戶**:所有業務查詢一律經租戶中介層注入 `tenant_id` 過濾(禁止跨租戶洩漏);見 M1。
- 錯誤碼:模組前綴 + 語意碼(如 `IAM_INVALID_CREDENTIALS`)。
- 分頁:`?page=&size=`,回 `{ items, total, page, size }`。
- WebSocket:`/ws/agent`(坐席)、`/ws/widget`(訪客);訊息封包 `{ type, payload, ts }`。
- OpenAPI 自動產生(FastAPI),前端型別由 openapi 產生器同步。

## 3.5 服務層接口契約(seams)— 各模組只依賴這些函式簽名,不碰對方檔案

整合者(我)負責 `app/main.py` 路由註冊與 `app/models/__init__.py` 匯入;**agent 不要改這兩個檔、不要改 `app/core/*` 與 `app/config`**。跨模組呼叫一律走下列 seam(呼叫端用 `from ... import`,被呼叫端負責實作;未完成時呼叫端須 try/except 優雅降級)。

- **視覺者 M4** `app/services/visitor.py`:
  `async def get_or_create_visitor(db, tenant_id, channel_id, external_id, display_name=None, avatar_url=None) -> Visitor`
- **會話 M3** `app/services/conversation.py`:
  `async def get_or_open_session(db, tenant_id, channel_id, visitor_id) -> Session`
  `async def add_message(db, tenant_id, session_id, sender_type, content, sender_id=None, content_type="text", meta=None) -> Message`
  `async def close_session(db, tenant_id, session_id) -> None`
  即時推送:`app/services/realtime.py::async def publish(tenant_id, session_id, event: dict) -> None`(Redis pub/sub;WebSocket 端訂閱)
- **AI 派發 M6**(核心 seam)`app/services/dispatch.py`:
  `async def handle_inbound(db, tenant_id, session_id, message_id) -> None`
  職責:讀該會話上下文 → 若 session.handler_type=="ai" 則 RAG 檢索+LLM 產生回覆(附來源與信心分)→ 低信心或命中轉人規則則 handoff(改 handler_type、進佇列、發 realtime 事件)→ 否則 `add_message(sender_type="ai")` 並經渠道送出。
- **渠道送出 M5** `app/services/channel_out.py`:
  `async def send_to_visitor(db, tenant_id, session_id, text, content_type="text") -> None`(依 session→channel.type 選 adapter:web=WebSocket 推送、telegram=Bot API sendMessage)
- **知識檢索 M7** `app/services/rag.py`:
  `async def retrieve(db, tenant_id, query, top_k=5) -> list[dict]`(回 `[{content, source_ref, score}]`,供 dispatch 引用與溯源)
- **路由 M8** `app/services/routing.py`:
  `async def assign_session(db, tenant_id, session_id) -> uuid.UUID | None`(回指派到的 staff_id 或 None=留佇列)
- **計量 M12** `app/services/usage.py`:
  `async def record_usage(db, tenant_id, kind, quantity, meta=None) -> None`(dispatch 產生 LLM 回覆後呼叫)

渠道 inbound 標準流程(M5 實作):`get_or_create_visitor → get_or_open_session → add_message(sender_type="visitor") → dispatch.handle_inbound`。

## 4. 資料模型(核心實體,自行設計;概念見 BLUEPRINT 第三節)

先實作 M1–M7 需要的核心表:Tenant、Organization、Staff、Role、Permission、role_permission、staff_role、SkillGroup、Channel、Visitor、Contact、Session、Message、KnowledgeCollection、Document、QAPair、Tag、tag_relation(多型)、UsageRecord。工單/質檢/報表表於各模組階段補。

共同基底:每張業務表帶 `id(uuid)`、`tenant_id`、`created_at`、`updated_at`、`deleted_at`(軟刪)。

## 5. MVP 里程碑(較大範圍)

- **里程碑 A(核心鏈路)**:M1 租戶+M2 認證/RBAC → M5 Web Widget + Telegram → M3 三欄坐席台(WebSocket)→ M4 訪客/CRM。可跑「訪客發訊→坐席回覆→關閉」。
- **里程碑 B(AI)**:M6 AI Agent(OpenAI)+ M7 知識庫 RAG + M8 handoff/路由。可跑「AI 自動回覆→低信心轉真人」。
- **里程碑 C(運營)**:M9 工單 + M10 質檢/CSAT/服務小結 + M11 報表。
- **里程碑 D(變現)**:M12 用量計量 + 白牌轉售儀表板。

## 6. 待你提供(不阻擋階段一)

- 遠端測試伺服器的位址與 SSH 存取方式(部署時需要)。
- 在中央金鑰表 `keys.env` 加一行 OpenAI key,變數名建議 `KEFU_OPENAI_API_KEY`(只告訴我變數名,我用 getkey 讀)。
- 是否已有正式品牌名(否則先用代號 kefu)。

---

## Phase 2 待辦(2026-09-23,使用者追加,需全做好並自測)

**自主推進原則**:使用者不再逐個回報 bug。我要把功能做完 → 派多個「產品經理」agent 全面測試 → 依回報修到基本功能穩 → 才回報使用者。

1. **翻譯(雙向,原文+譯文)**
   - **預設 provider = Google 翻譯免費公開端點**(`translate.googleapis.com/translate_a/single`,免 key、零成本)。
   - 進階(**付費**,由套餐控管):`ours`=我方 LLM(gpt-5.5)翻譯;`custom`=客戶自訂翻譯 API(端點/key 由租戶設定)。
   - 出站:訪客只看譯文;坐席看原文+譯文。入站:坐席看原文+譯文,訪客看自己原文。
2. **會話行為**:回覆即認領(auto-claim)、明確「接手」按鈕、**即時更新免刷新**、狀態即時(等待↔服務中)。
3. **轉接目標**:轉接(⇄)要能選「指定坐席 / 技能組」,不只丟回佇列。
4. **套餐 / 訂閱方案(billing)**:定義方案與各方案解鎖的功能(如「我方翻譯 API」「custom 翻譯」為付費);方案管理 UI + 功能 gating(未購買則該功能停用/提示升級)。
5. **附件 / 表情 / 圖片**:widget 與坐席台雙邊都要能傳圖/檔、插入 emoji、正確顯示。
6. **補資料缺口**:會話列表預覽/未讀/標籤、知識庫命中率/文件數、渠道連線狀態、報表逐日/渠道維度、訪客列表標籤、取消質檢旗。
7. **測試**:派多個 agent 分區演練(訪客端、坐席端、AI、翻譯、附件、套餐、多租戶隔離),收集 bug,修到基本功能穩。

## Phase 4 待辦(2026-09-23,使用者追加)

### 進階渠道/平台(進行中)
- WhatsApp(Meta Cloud API)、Facebook Messenger 渠道(收發)
- 對外 Webhook(事件外送+簽章+重試)+ 開放 REST API(API key 認證)
- 公開 Help Center(知識庫發布成自助中心)
- PWA(坐席後台可安裝+推播)

### 坐席後台多語言 i18n(獨立一路,排在前端功能之後做)
原因:需把幾十個元件的**寫死中文字串全部抽成 i18n key**,動到幾乎所有前端檔,必須與其他前端編輯**序列化**,且最後做才能涵蓋全部畫面。用 Workflow 按頁面分組並行(抽字串→翻譯)。
- 語言集:繁中/简中/English/日本語/한국어/Español/Français/Deutsch/Português/Русский/ไทย/Tiếng Việt/Bahasa Indonesia/العربية(RTL)
- 語言切換器(頂欄或個人設定),每坐席各自選;Arabic RTL 版面
- 既有 i18next(zh-Hant/en)為基礎擴充;widget 端亦可後續多語
