# 新客服系統 — 總藍圖(集大成)

> 綜合三份調研:[功能](report-product.md)(tgo×cskefu)、[UI/UX](report-ui.md)、[競品全景](report-competitors.md)。
> 定位:**AI 原生的開源客服平台,Telegram 一等公民,一套實例即可白牌轉售**。乾淨室重寫,不抄碼。2026-09-23。

## 一、產品定位與三根護城河

市場現況:AI 客服進入「Agent 自主結案」洗牌期;西方 SaaS 幾乎都不原生支援 Telegram;真多租戶白牌轉售是巨大空白;per-resolution 計費讓客戶帳單失控。

**三根護城河(集中火力)**:
1. **AI 原生 + 計費可控** — RAG/tool calling/坐席 Copilot 做進核心;**BYO LLM Key**(客戶自帶 OpenAI/Anthropic/本地模型 Key)消滅帳單失控;可溯源回答 + 信心分數 + 低信心自動轉真人(對抗 Gartner 警告的「40% AI 專案因不可信而失敗」)。
2. **Telegram / WhatsApp 一等公民** — Telegram 做到 Bot API + 群組/頻道客服 + 內聯鍵盤流程 + 檔案貼圖 + Payments;WhatsApp 走 Meta Cloud API。比 Chatwoot 更深。
3. **真多租戶白牌轉售** — 一套實例、子網域 + 資料隔離、租戶級品牌/主題/自訂網域、租戶級用量與計費儀表板。對手僅 Helpy/Faveo(AI 弱、體驗老)。

## 二、技術棧(定案建議)

- **前端**:React 19 + TypeScript + Vite + Tailwind v4 + **shadcn/ui(Radix)**(乾淨室最安全,元件複製進自家庫無品牌綁定);狀態 Zustand + TanStack Query;即時 WebSocket;富文本 TipTap;工作流 React Flow;圖表 Recharts/ECharts。**棄用 iframe/jQuery/layui**。
- **後端**:沿用 tgo 世代思路(Python/FastAPI 或按團隊技能選型),但**不照抄其微服務拆分**;MVP 可先單體 + 清晰模組邊界,避免 15 微服務的營運重擔。
- **資料**:PostgreSQL(+ pgvector 做 RAG)、Redis;報表/BI 後期上 ClickHouse 或物化視圖。
- **AI**:**Provider 可插拔層**(切勿像 cskefu 綁死單一雲);對話記憶 + RAG + Agent tool calling 進核心資料模型。

## 三、資料模型核心概念(自行設計,不抄任一方 DDL)

核心實體:Tenant、Organization/Department、Staff、Role/Permission、SkillGroup、Visitor↔Contact(渠道臨時身份 vs 持久客戶,支援跨渠道合併)、Channel、Session、Message、AI Agent、KnowledgeCollection+Document/QAPair、Tool/MCP Tool、Workflow+Execution、Ticket、Tag(多型關聯)、ServiceSummary/QualityRecord/CSAT、UsageRecord。

六大設計要點:①Session「當前處理者」須能 AI↔人 平滑切換並記轉接歷史;②Visitor 與 Contact 分離、可跨渠道合併;③標籤用單一多型關聯表;④UsageRecord 從第一天就記(為計費);⑤Tenant ID 下沉每張業務表;⑥質檢/BI 讀已關閉會話快照,與即時聊天路徑解耦。

## 四、模組取捨(來源:誰的做法)

| 模組 | 採用方向 |
|---|---|
| 多渠道歸一化 | tgo 思路 + Telegram/WhatsApp 做深(護城河) |
| AI/LLM/RAG/工作流/MCP | tgo 全採(核心競爭力),Provider 可插拔 |
| 坐席工作台 | cskefu 運營細節(排隊/狀態/快捷語/小結/轉接/監控) + tgo AI 交互與富卡片 |
| 會話分配 | 混合:預設規則路由 + 可選 LLM 智能分配 |
| 訪客/CRM | cskefu CRM 深度 + tgo AI 畫像/自動標籤 |
| 質檢/CSAT | cskefu 全採 + tgo AI 自動質檢打分 |
| 報表/BI | 借鑑 cskefu 多維理念,現代方案實作 |
| 多租戶 | tgo Project 模型 + 白牌轉售層(自建) |
| RBAC/組織樹 | cskefu 成熟做法 |
| **工單、計費** | **自建**(兩家皆空白) |

## 五、UI 資訊架構(窄圖示主欄 + 展開二級側欄)

工作台 / 訪客·CRM / AI / 知識庫 / 渠道 / 報表 / 設定;頂欄含**坐席狀態切換**(tgo 缺)、全域搜尋、通知。首次登入走安裝精靈 + Onboarding。設計風格:中性灰底 + 自訂品牌色(避開 cskefu 綠、tgo 藍)、亮暗雙主題、8pt 網格、WCAG AA。

**坐席工作台(重點投入)= 三欄**:左會話清單(我的/未分配/排隊/在線 Tabs、渠道角標、未讀優先);中對話區(Markdown/富卡片、hover 訊息級操作含質檢標旗、輸入框上方 AI 回覆建議條、TipTap 富文本 + `/` 快捷語);右情境面板(訪客資訊+CRM / AI 洞察 / 知識庫聯想 / 歷史 / 本會話搜尋,可拖曳折疊)。結束會話彈服務小結沉澱進 CRM 與報表。

## 六、路線圖

**MVP(跑通「訪客→AI/人工→關閉」全鏈路)**:多租戶+組織/坐席/RBAC → 網頁 Widget + Telegram + 渠道歸一化 → 即時會話/訊息 + 三欄坐席工作台 → AI Agent(多模型+上下文+BYO Key)→ 知識庫/RAG(文檔+QA)→ handoff + 規則式技能組路由 → 訪客/聯絡人 + 標籤。

**第二階段(運營成熟)**:質檢+CSAT+服務小結+監控干預 → 多渠道擴充(WhatsApp/微信/Email)→ 報表/BI → LLM 智能分配 → AI 畫像/情緒/自動標籤 → 快捷語/黑名單/離線留言/主動邀請。

**第三階段(平台化與變現)**:工作流 DAG 引擎 → MCP 工具商店+插件運行時 → **工單系統(自建)** → **計費/訂閱 + 白牌轉售儀表板(自建,護城河)** → 行動端 SDK/自助多維報表 → 呼叫中心(SIP)/Facebook 海外渠道。

## 七、風險與紀律

- **授權合規**:乾淨室重寫、不抄碼是硬要求(cskefu 春松授權 v1.0 有主動維權訴訟史;tgo 授權亦需法務審)。品牌/Logo/配色全部換掉。功能與點子可自由借鑑,程式碼與 schema DDL 不得照抄。
- **取捨紀律**:標配求「齊」、護城河求「深」、企業級重功能(語音話務/大工單/App 市集)求「緩」。
- **兩大自建空白**:工單引擎、計費系統,需預留設計工時。
- **別重蹈 tgo 的坑**(見 kefu.md 審計):token 加密、chat_type 過濾、webhook/polling 二選一、不要 15 微服務過度拆分。
