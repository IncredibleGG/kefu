# 客服系統競品功能全景 + 差異化機會報告

> 調研時間基準:2025 下半年 ~ 2026 現況
> 目的:為我方全新客服系統(乾淨室重寫,定位「AI 原生 + Telegram 強 + 可多租戶轉售」)提供競品全景與切入策略
> 已在對照的基準系統:tgo、cskefu(視為我方參考起點,不列入外部競品評比)

## 0. 摘要(TL;DR)

- **市場已進入「AI 原生 / Agentic」洗牌期**:2025-2026 主戰場從「AI 輔助坐席」轉向「AI Agent 自主結案(autonomous resolution)」。Gartner 預估成熟組織 2026-2029 才逐步逼近 80% 自主結案;超過 40% 的 agentic AI 專案預計 2027 前被砍。→ AI 是必做,但「做得穩、可信、知識同步快」才是真門檻,窗口還開著。
- **計價正從「按坐席」轉向「按結案量(per-resolution/outcome)」**:Intercom Fin 每結果 US$0.99、Zendesk 每結案約 US$1.5–2、HelpScout US$0.75、Freshdesk 每 session ~US$0.10–0.49。這是新行情錨點,也是使用者最痛的「AI 帳單失控」點。
- **Telegram 是西方商業 SaaS 的普遍盲區**:Intercom、Zendesk、HelpScout、LiveChat、Drift 原生都不支援 Telegram(需第三方橋接)。只有開源陣營(Chatwoot、Rocket.Chat、FreeScout 靠模組)原生支援。→ 我方「Telegram 強」的天然縫隙。
- **真・多租戶白牌轉售是巨大空白**:主流 SaaS 幾乎都不給;開源裡只有 Helpy Pro、Faveo 等少數做到,但它們 AI 弱、體驗老舊。Chatwoot 也不是真多租戶。→ 我方「可轉售」的第二個縫隙。
- **一句話策略**:抄齊「全渠道+工單+知識庫+自動化+報表」標配線;護城河押在 (a) AI 原生且計費透明可控、(b) Telegram/WhatsApp 一等公民、(c) 為 MSP/代理商設計的真多租戶白牌轉售。

## 1. 競品功能全景矩陣

圖例:● 強/原生完整 ・ ◐ 有但一般/需加購 ・ ○ 弱或需第三方 ・ — 無

### 1A. 開源陣營

| 功能維度 | Chatwoot | Zammad | FreeScout | Rocket.Chat | Erxes | Papercups | Helpy | Tawk.to |
|---|---|---|---|---|---|---|---|---|
| Telegram | ● 原生 | ◐ | ◐ 付費模組 | ● 原生 | ◐ | ○ | ○ | ○ |
| WhatsApp | ● 原生 | ◐ | ◐ 付費模組 | ● | ◐ | ○ | ○ | ○ |
| AI/LLM/RAG | ◐ Captain(GPT,額度制) | ○ 弱 | ◐ AI 模組 | ◐ 需 Ent | ○ | — | ○ | ◐ Apollo 加購 |
| 真人坐席協作 | ● | ● | ● | ● | ● | ◐ | ● | ◐ |
| 工單 | ◐ 對話式 | ● 純工單強 | ● 共享信箱 | ◐ | ● | ○ | ● | ◐ |
| 知識庫 | ● | ◐ | ◐ 模組 | ◐ | ● | ○ | ● | ● 免費 |
| 自動化/工作流 | ● | ● 觸發/SLA/巨集 | ◐ 模組 | ◐ | ◐ | ○ | ◐ | ◐ |
| 報表分析 | ● 完整 | ◐ | ◐ 模組 | ◐ | ◐ | ○ | ◐ | ◐ |
| 多語言 | ● | ● | ● | ● | ● | ◐ | ● | ● |
| 多租戶/白牌 | ○ 單帳號(非真多租) | ○ | ○ | ◐ 隊列隔離 | ◐ | — | ● 真多租+子網域+DB隔離 | ○ 僅去品牌 |
| API/Webhook | ● | ● | ◐ 模組 | ● | ● | ● | ◐ | ◐ |
| 授權/定價 | MIT 自架免費;雲 $19起 | AGPLv3 免費;雲 €7–27+ | 核心免費;模組一次性 $3–29 | MIT 核心;Starter $0(≤50用戶) | 開源自架 | 開源(維護模式) | 開源核心;Pro 多租戶 | 完全免費,靠加購 |

備註:Papercups **已進維護模式,無新功能**,不建議作為活躍競品參考。

### 1B. 商業 SaaS 陣營

| 功能維度 | Intercom | Zendesk | Freshdesk | Crisp | LiveChat | Tidio | Drift | HelpScout |
|---|---|---|---|---|---|---|---|---|
| Telegram | ○ 需第三方 | ○ 需第三方 | ○ 需第三方 | ● 原生 | ○ | ◐ | ○ | ○ |
| WhatsApp | ● | ● | ● | ● | ● | ● | ◐ | ◐ |
| AI 旗艦 | ● **Fin**(標竿) | ● **AI Agents** | ● **Freddy**(三件套) | ◐ AI chatbot | ◐ Copilot內含 | ● **Lyro**(跑 Claude) | ◐ Revenue AI | ◐ AI Answers/Drafts 全內含 |
| RAG 知識問答 | ● | ● | ● | ◐ | ◐ | ● | ◐ | ● |
| 坐席 Copilot | ● | ● 加購$50 | ● | ◐ | ● 內含 | ◐ | ◐ | ● |
| 工單 | ◐ 對話式 | ● 業界標竿 | ● 強 | ◐ Plus才有 | ◐ | ◐ | ○ | ● 簡潔強 |
| 知識庫 | ● | ● | ● | ● | ● | ◐ | ◐ | ● |
| 自動化/工作流 | ● | ● 業界最強 | ● | ◐ | ● | ◐ | ● 銷售路由 | ◐ |
| 報表分析 | ● | ● 業界最強 | ● | ◐ | ● | ◐ | ● | ◐ |
| 多語言 | ● | ● | ● | ● | ● | ● | ◐ | ● |
| 多租戶/白牌 | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| API/Webhook | ● | ● 生態最大 | ● | ● | ● | ◐ | ◐ | ● |
| 定價模式 | 坐席費+Fin $0.99/結果 | 坐席$19–115+ AI$1.5–2/結案+Copilot$50 | 坐席分層+Freddy分開計 | 整包 $0/45/95/295 | 純坐席 $20–59 透明 | 平台費+Lyro按對話$39/100起 | 無公開價,企業級$2500+/月 | 按聯絡人數+AI$0.75/結案 |

各家強項一句話:Intercom=AI Agent 標竿+per-outcome 開創者;Zendesk=企業級全能王(工單/自動化/報表/生態最深,也最貴最複雜);Freshdesk=高性價比平替;Crisp=中小企業整包平價+渠道多(含 Telegram 原生);LiveChat=純 Live Chat 老牌+計價最透明;Tidio=電商友善+Lyro(跑 Anthropic Claude)好用;Drift=B2B 銷售對話(非傳統客服);HelpScout=小團隊/Email 首選+AI 全內含+per-resolution 最便宜($0.75)。

## 2. 標配 vs 進階

**普遍標配(必做,不做即出局)**:全渠道統一收件匣(網頁+Email+FB/IG+WhatsApp)、真人坐席協作(共享收件匣/指派/內部備註/碰撞偵測/預設回覆)、知識庫+客戶自助、基礎自動化(規則觸發/路由/營業時間)、AI 知識庫問答(RAG,2025 起已成標配)、AI 坐席 Copilot、報表分析、多語言、API/Webhook、坐席行動 App。

**進階功能(少數人做好,可差異化)**:AI Agent 自主結案(執行動作而非只答問)、Agentic tool calling 串後端、AI QA 稽核+Insights、語音/視訊/電話渠道、進階 SLA/巨集、**真多租戶白牌(空白最大)**、**Telegram 原生一等公民(僅 Crisp/Chatwoot/Rocket.Chat)**、合規/資料主權(自架/審計/DLP)、主動式訊息/訪客追蹤、可視化 Bot 建構器。

## 3. 定價與商業模式(行情錨點)

三大典範:
- **按坐席**(LiveChat $20–59、Zendesk $55–115、Zammad 雲 €7–27+、Freshdesk):可預測但擴編漲價。
- **按 AI 結案/結果**(Intercom **$0.99/結果**、Zendesk **$1.5–2/結案**、HelpScout **$0.75/結案**、Freshdesk **~$0.10–0.49/session**):帳單不可預測、易失控 = 最大新痛點。
- **平台整包/按對話**(Crisp $0/45/95/295、Tidio 平台費+Lyro $39/100 對話起):平價可預測,量大時貴。

關鍵洞察:開源自架 $0 授權已是基本盤(靠雲託管/企業功能/AI 額度/模組變現);**per-resolution 是新常態也是新痛點** →「透明、可設上限、可自帶 LLM Key(BYO-Key)」是強力賣點;Zendesk 式 AI 疊加收費(基礎費+Copilot$50+per-resolution+QA)招致反感,「AI 全內含」(HelpScout/LiveChat)正成反向賣點。

## 4. 差異化機會

痛點:(1) AI 帳單失控+疊加收費地獄;(2) Telegram 是西方 SaaS 結構性盲區(中東/東南亞/東歐/加密貨幣/跨境電商主力渠道);(3) 沒有為 MSP/代理商設計的真多租戶白牌(僅 Helpy/Faveo,但 AI 弱、體驗老);(4) 老系統 AI 是「後貼」非原生(知識同步慢、上下文割裂);(5) 知識庫同步慢/幻覺/不可追溯(40% AI 專案卡在知識衛生);(6) 開源 AI 弱、商業貴又鎖定,中間地帶空缺。

**我方三根護城河柱子**(定位標語草案:「AI 原生的開源客服平台,Telegram 一等公民,一套實例即可白牌轉售給你的每一個客戶」):
- **柱一 AI 原生+計費可控**:RAG 問答+Agent tool calling+坐席 Copilot 全原生;**BYO LLM Key**(客戶自帶 OpenAI/Anthropic/本地模型 Key)直接消滅帳單失控痛點、也利於合規;可溯源回答+信心分數+低信心自動轉真人。
- **柱二 Telegram/WhatsApp 一等公民**:Telegram 做到 Bot API+群組/頻道客服+內聯鍵盤按鈕流程+檔案貼圖+Telegram Payments;WhatsApp 走 Meta Cloud API 官方接入+範本訊息管理。做到比 Chatwoot 更深。
- **柱三 真多租戶白牌轉售**:一套實例、子網域+資料隔離、租戶級品牌/主題/自訂網域、租戶級用量與計費儀表板(讓轉售者能對其客戶收費);與 Helpy/Faveo 差異=我方 AI 原生、體驗現代。

## 5. 給我方的功能取捨建議

**A. 直接抄標配(MVP 必做)**:全渠道(MVP 核心=網頁 Widget+Email+Telegram+WhatsApp;FB/IG/LINE 次階段)、真人坐席協作全套、知識庫+自助、基礎自動化、AI RAG 問答+坐席 Copilot、基礎報表、多語言、API/Webhook、坐席 App。

**B. 護城河(重點投資做到更好)**:AI 原生架構(對話記憶+RAG+tool calling+可溯源+信心分數)、BYO LLM Key+透明可控計費(反 Zendesk 疊加收費)、Telegram/WhatsApp 深度整合、真多租戶白牌轉售、自架友善+現代開源授權(對打 Zammad/Chatwoot 但 AI 更強)。

**C. 不值得做/先別做**:語音/視訊/電話中心(重、Zendesk/Rocket.Chat 已霸)、銷售導向 Conversational Marketing/Revenue AI(Drift 式,偏離定位)、龐大 App 市集生態(短期拼不過 Zendesk,先做開放 API+少數關鍵整合)、AI QA 稽核+進階 Insights(MVP 後)、企業級重工單/複雜 SLA 升級鏈(先做輕量對話式工單)、大而全 XOS(Erxes 式,貪大拖慢)。

**取捨原則**:標配求「齊」(不缺項即可,別過度打磨);護城河求「深」(AI 原生/Telegram/多租戶白牌集中火力);企業級重功能求「緩」(語音/大工單/市集後置)。
