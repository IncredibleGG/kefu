# 集大成客服系統 — 功能盤點與產品規格報告

> 素材:tgo(AI 原生客服,Python/FastAPI 微服務)與 cskefu 春松客服(Java/Spring Boot 單體)。乾淨室產品規格:僅描述功能與行為、只列資料模型概念關係,不複製原始碼、不照抄 DDL。日期 2026-09-23。

## 0. 定位速覽

| 面向 | tgo | cskefu |
|---|---|---|
| 哲學 | **AI 原生**,組建 AI 智能體團隊,人工是補位 | **人工坐席原生**,機器人靠外接輔助 |
| 架構 | 微服務(8 Python 服務+Go Agent+多前端/SDK),Kafka 事件流 | 單體 Spring Boot,MySQL+Redis+ActiveMQ |
| IM | WuKongIM(WebSocket)+SSE 串流 | 自研 WebSocket |
| 成熟度 | AI/RAG/工作流/MCP 深;質檢/BI/呼叫中心薄 | 運營功能完整;AI 靠外接 Chatopera 雲 |
| 多租戶 | Project 原生多租戶 | Organ 組織機構+多管理員隔離 |
| 授權 | 開源(需確認) | 春松公有授權 v1.0(**有維權訴訟史,商用前務必法務評估**) |

**一句話**:tgo 的 AI 大腦是天花板,cskefu 的坐席工作台/質檢/報表/呼叫中心/CRM 是地基。新系統 = cskefu 運營骨架 + tgo AI 大腦。

## 1. 功能對照矩陣(✅完整 🟡部分 ❌無 🔌靠外接)

**多渠道接入**:tgo 有原生渠道歸一化層,行動端 SDK(iOS/Flutter/小程式)、企業 IM(飛書/釘釘/企微/Slack/Telegram/郵件)全渠道 → **tgo 強**;cskefu 獨有**呼叫中心/電話(FreeSWITCH/SIP、外呼任務、分機)**與 **Facebook Messenger(含 Shopify/OTN)** → 這兩塊 **cskefu 強**。網頁 Widget 兩家平手。

**AI 機器人/LLM**:tgo 全面領先 — 多模型(OpenAI/Anthropic/Gemini/Qwen)、多 Agent、SSE 串流、上下文記憶、內建 AI 工具;cskefu 需綁 Chatopera 雲。cskefu 唯一優勢是「即用性」(85% 客戶直接上線)。

**知識庫/RAG**:**tgo 壓倒性** — 文檔/QA/網站三類知識庫、pgvector 混合檢索、多供應商 Embedding、非同步處理、QA 調試界面;cskefu 幾乎無。

**真人坐席工作台**:各有所長。cskefu 強在運營細節(坐席狀態機、快捷語模板、**服務小結**、坐席間轉接、**監控干預**、企業內部群聊);tgo 強在 AI 交互與結構化 UI 卡片(訂單/物流/商品)。會話分配:tgo 有 **LLM 智能分配**,cskefu 有成熟**技能組+規則路由**(互補)。

**訪客/CRM**:cskefu 的聯絡人 CRM 深(細粒度欄位、備註、黑名單、離線留言、主動邀請)→ **cskefu 強**;tgo 獨有 **AI 訪客洞察/畫像/自動打標** → tgo 強。

**工單**:**兩家皆無**真正工單引擎(cskefu 僅留言+服務記錄近似)→ 新系統需自建。

**質檢**:**cskefu 強** — 歷史會話質檢、**滿意度 CSAT/等級**、服務反饋、坐席監控實時干預;tgo 僅 AI 情緒分析工具。

**報表/BI**:cskefu 有坐席報表 + **Cube/Dimension/Measure/DrillDown 自助多維分析** → **cskefu 強**;tgo 有 AI 用量統計(工具/檢索用量)。

**多租戶**:tgo 的 Project 模型雲原生、每實體帶 project_id → **tgo 強**;cskefu 靠 organ 過濾。

**權限/角色**:cskefu 的 Role/RoleAuth/Acl + 組織機構樹(Organ/OrganRole/OrganUser)最成熟 → **cskefu 強**。

**計費**:**兩家皆無**訂閱/帳單(tgo 有用量計量可作資料源)→ 需自建。

**工作流/自動化**:**tgo 獨門** — DAG 引擎,節點含 start/end/llm/api/condition/classifier/agent/tool/answer/input/timer/webhook/event,含變數系統與執行追蹤;cskefu 僅靜態 RouterRules + JobTask 排程。

**MCP/工具擴充/插件**:**tgo 獨門** — MCP 工具商店(OpenAPI Schema 自動轉表單)、插件運行時、坐席端/訪客端 CLI+MCP Server(40+ 命令)、GitHub 式可下載 Skills、設備遠端控制;cskefu 完全沒有。

## 2. 「集大成」逐模組取捨

- 多渠道:採 **tgo 歸一化層** + 補 cskefu **呼叫中心/Facebook**
- AI/LLM、RAG、工作流、MCP/插件:**tgo 全採**(核心競爭力,且避免綁死單一雲)
- 坐席工作台:**cskefu 運營細節**(狀態/快捷語/小結/轉接/監控)+ tgo AI 交互與卡片
- 會話分配:**混合** — 預設規則路由(穩定可控)+ 可選 LLM 智能分配(進階)
- 訪客/CRM:**cskefu CRM 深度** + tgo **AI 畫像/自動標籤**
- 質檢:**cskefu 全採** + tgo AI 自動質檢打分
- 報表/BI:借鑑 cskefu 多維分析**理念**,實作改用現代方案(ClickHouse/物化視圖)
- 多租戶:**tgo Project 模型**
- 權限/角色:**cskefu RBAC + 組織樹**
- 工單、計費:**自建**(兩家空白)

## 3. 資料模型關鍵概念(僅概念關係,不抄 DDL)

核心實體:Tenant/Project(租戶頂層邊界)、Organization/Department(組織樹)、Staff(坐席)、Role/Permission、SkillGroup、Visitor(渠道臨時身份)與 Contact(持久客戶主體)、Channel、Session(會話)、Message、AI Agent、KnowledgeCollection+Document/QAPair、Tool/MCP Tool、Workflow+Execution、Ticket(新設計)、Tag+TagRelation、ServiceSummary/QualityRecord/CSAT、UsageRecord。

關鍵關聯:
```
Tenant 1─* Organization 1─* Staff *─* Role *─* Permission ; Staff *─* SkillGroup
Contact 1─* Visitor (跨渠道身份合併) ; Visitor 1─* Session ; Channel 1─* Session
Session 1─* Message ; Session *─1 (AI Agent | Staff) 當前處理者,可 AI↔人 轉移(handoff)
Session 1─0..1 ServiceSummary/QualityRecord/CSAT
AI Agent *─* Tool ; AI Agent *─* KnowledgeCollection 1─* Document/QAPair
Workflow 1─* WorkflowExecution
Ticket *─1 Contact ; Ticket 0..1─1 Session ; Ticket *─1 Staff(指派)
Tag *─* {Visitor|Contact|Session|Ticket} 多型關聯
UsageRecord *─1 {Tenant, AI Agent, Session}
AssignmentRule 1─1 Project(規則式 或 LLM 式)
```

設計要點:①會話「當前處理者」須能 AI↔人 平滑切換並記轉接歷史;②訪客與聯絡人分離、支援跨渠道合併;③標籤用單一多型關聯表;④用量從第一天就記(為日後計費);⑤租戶 ID 下沉每張業務表;⑥質檢/BI 讀已關閉會話快照,與即時聊天路徑解耦。

## 4. 模組優先級

**MVP(跑通「訪客→AI/人工→關閉」全鏈路)**:①多租戶+組織/坐席/RBAC ②網頁 Widget+渠道歸一化 ③即時會話/訊息+坐席工作台基礎 ④AI Agent+多模型+上下文 ⑤知識庫/RAG(文檔+QA)⑥handoff+規則式技能組路由 ⑦訪客/聯絡人+標籤。

**第二階段(運營成熟)**:⑧質檢+CSAT+服務小結+監控干預 ⑨多渠道擴充 ⑩報表/BI(固定報表)⑪LLM 智能分配 ⑫AI 畫像/情緒/自動標籤 ⑬快捷語/黑名單/離線留言/主動邀請。

**第三階段(平台化)**:⑭工作流 DAG 引擎 ⑮MCP 工具商店+插件運行時 ⑯工單系統 ⑰計費/訂閱 ⑱行動端 SDK/網站抓取知識庫/自助多維報表 ⑲呼叫中心(SIP)/Facebook 海外渠道。

## 5. 風險

- **授權合規**:cskefu 春松授權 v1.0 有主動維權訴訟史,乾淨室重寫、不抄碼是必要的;tgo 授權也需確認商用衍生。務必法務先審兩者 LICENSE。
- **不照抄 schema**:cskefu `uk_*`/`cs_*` 與 tgo `api_*`/`ai_*` 表僅供理解功能。
- **AI 供應商抽象**:切勿像 cskefu 綁死單一雲,保留 Provider 可插拔層。
- **兩大自建空白**:工單引擎與計費系統,需預留設計工時。
