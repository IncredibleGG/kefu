# kefu 建置進度追蹤(Phase 2:基礎完整 + 競品持平)

## 基礎完整 P0(三份競品審計交集 · 10 項)
| # | 項目 | 後端 | 前端/widget |
|---|---|---|---|
| 1 | 營業時間+離線自動回覆 | 🔄 3a-2(settings model+public API) | 🔄 widget / ⬜ 設定頁 |
| 2 | 快捷回覆(取代寫死清單)+管理 | 🔄 3a-1(canned CRUD) | ⬜ composer `/`接真API + 設定頁 |
| 3 | 會話中私密備註 | 🔄 3a-1(note) | ⬜ 備註輸入+區分顯示 |
| 4 | 桌面+聲音+title 未讀通知 | (前端為主) | ⬜ 通知 |
| 5 | 轉接指定坐席/組 UI+目標通知 | ✅ 後端已支援 handoff 帶 target | ⬜ 前端選擇對話框 |
| 6 | pre-chat 表單 | 🔄 3a-2(prechat 設定) | 🔄 widget |
| 7 | 離線留言表單 | 🔄 3a-2 | 🔄 widget |
| 8 | widget 營業時間顯示+離線切換 | 🔄 3a-2 | 🔄 widget |
| 9 | 訪客端 CSAT 評分(滿意度真實來源) | ✅ CSAT 端點已存在 | 🔄 widget |
| 10 | 設定頁補齊(承載 2/4/1/品牌) | — | ⬜ 前端設定頁 |

## 套餐/翻譯 gating
- ✅ 後端套餐(Free/Pro/Enterprise)+ gating seams + /features
- ⬜ 前端套餐/訂閱頁 + 翻譯付費 provider gating UI

## 已完成並部署
核心對話迴路、AI(RAG+gpt-5.5+引用/信心/轉人/Copilot)、翻譯(Google 雙向)、回覆即認領/接手、即時免刷新、widget 附件/表情/圖片、後端上傳。

## 進行中 agent
- 3a-1 canned/notes/tags/transfer(後端)
- 3a-2 search/settings(營業時間)/AI摘要(後端)
- widget pre-chat/離線/CSAT/品牌(widget 前端)

## 下一步(這批後)
1. 部署 backend+widget(補 schema:新 model + plan 3 欄)
2. 前端工作台 wave:快捷回覆UI/私密備註/通知/轉接選擇/全域搜尋/設定頁/套餐頁/翻譯 gating(序列做,避免 endpoints.ts/types.ts 衝突)
3. 派多個「產品經理」agent 分區測試 → 修穩 → 回報使用者
