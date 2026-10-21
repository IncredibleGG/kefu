/** ============================================================
 *  Mock 資料集(集中一處,方便日後換真 API)
 *  後端未完成的端點都從這裡取資料。
 *  ============================================================ */
import type {
  AiInsight,
  Channel,
  KbHit,
  KnowledgeCollection,
  Message,
  ReplySuggestion,
  Session,
} from "@/types";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

export const mockSessions: Session[] = [
  {
    id: "s-1001",
    visitor: {
      id: "v-1",
      display_name: "陳美玲",
      channel: "telegram",
      external_id: "tg:88213",
      location: "台北, 台灣",
      os: "iOS 18",
      browser: "Telegram",
      first_seen: ago(60 * 24 * 12),
      tags: ["VIP", "續約中"],
      contact: {
        id: "c-1",
        name: "陳美玲",
        email: "meiling@example.com",
        phone: "+886 912 345 678",
        company: "晴海設計",
        lifetime_value: 48200,
        note: "偏好 Telegram 聯繫,下午時段較活躍。",
      },
      custom: { 方案: "Pro 年繳", 來源: "官網廣告" },
    },
    channel: "telegram",
    handler_type: "human",
    assignee_id: "me",
    assignee_name: "我",
    tab: "mine",
    status: "open",
    last_message_preview: "我想確認一下續約的優惠還在嗎?",
    last_message_at: ago(2),
    unread: 2,
    tags: ["VIP"],
    skill_group: "銷售",
  },
  {
    id: "s-1002",
    visitor: {
      id: "v-2",
      display_name: "訪客 #4471",
      channel: "web",
      location: "高雄, 台灣",
      os: "Windows 11",
      browser: "Chrome 133",
      tags: [],
      first_seen: ago(35),
    },
    channel: "web",
    handler_type: "ai",
    tab: "unassigned",
    status: "open",
    last_message_preview: "請問你們有支援退款嗎?",
    last_message_at: ago(5),
    unread: 1,
    tags: ["退款"],
    skill_group: "客服一線",
  },
  {
    id: "s-1003",
    visitor: {
      id: "v-3",
      display_name: "John Carter",
      channel: "whatsapp",
      external_id: "wa:+1408...",
      location: "San Jose, US",
      tags: ["英文"],
      first_seen: ago(60 * 5),
    },
    channel: "whatsapp",
    handler_type: "bot",
    tab: "queue",
    status: "waiting",
    last_message_preview: "Still waiting for an agent…",
    last_message_at: ago(8),
    unread: 3,
    waiting_seconds: 316,
    tags: ["等待"],
    skill_group: "客服一線",
  },
  {
    id: "s-1004",
    visitor: {
      id: "v-4",
      display_name: "王建國",
      channel: "email",
      external_id: "jianguo@corp.com",
      tags: ["企業"],
      first_seen: ago(60 * 40),
    },
    channel: "email",
    handler_type: "human",
    assignee_id: "u-2",
    assignee_name: "林小葵",
    tab: "online",
    status: "open",
    last_message_preview: "附件是我們的需求清單,再麻煩了。",
    last_message_at: ago(22),
    unread: 0,
    tags: ["報價"],
    skill_group: "銷售",
  },
  {
    id: "s-1005",
    visitor: {
      id: "v-5",
      display_name: "訪客 #4480",
      channel: "web",
      location: "台中, 台灣",
      tags: [],
      first_seen: ago(12),
    },
    channel: "web",
    handler_type: "ai",
    tab: "queue",
    status: "waiting",
    last_message_preview: "帳號登不進去…",
    last_message_at: ago(3),
    unread: 1,
    waiting_seconds: 92,
    tags: ["技術"],
    skill_group: "技術支援",
  },
];

export const mockMessages: Record<string, Message[]> = {
  "s-1001": [
    {
      id: "m1",
      session_id: "s-1001",
      sender_type: "system",
      content_type: "system",
      content: "會話由 Telegram 建立,分配給技能組「銷售」",
      ts: ago(30),
    },
    {
      id: "m2",
      session_id: "s-1001",
      sender_type: "visitor",
      sender_name: "陳美玲",
      content_type: "text",
      content: "你好,我是 Pro 年繳的用戶,想問續約優惠。",
      ts: ago(28),
      status: "read",
    },
    {
      id: "m3",
      session_id: "s-1001",
      sender_type: "ai",
      sender_name: "AI 助理",
      content_type: "markdown",
      content:
        "您好!目前 **老客戶續約** 可享 **85 折**,並延長 30 天有效期。需要我幫您試算嗎?",
      ts: ago(27),
      ai: {
        confidence: 0.92,
        sources: [
          { title: "續約優惠政策 2026Q3", ref: "KB#pricing-42", score: 0.88 },
        ],
      },
    },
    {
      id: "m4",
      session_id: "s-1001",
      sender_type: "system",
      content_type: "system",
      content: "AI 信心足夠,已由 AI 自動回覆;客戶追問後轉真人「我」接手",
      ts: ago(20),
    },
    {
      id: "m5",
      session_id: "s-1001",
      sender_type: "visitor",
      sender_name: "陳美玲",
      content_type: "text",
      content: "我想確認一下續約的優惠還在嗎?下週才有空處理。",
      ts: ago(2),
      status: "delivered",
      flagged: false,
    },
  ],
  "s-1002": [
    {
      id: "n1",
      session_id: "s-1002",
      sender_type: "visitor",
      sender_name: "訪客 #4471",
      content_type: "text",
      content: "請問你們有支援退款嗎?",
      ts: ago(5),
      status: "delivered",
    },
  ],
  "s-1003": [
    {
      id: "w1",
      session_id: "s-1003",
      sender_type: "visitor",
      sender_name: "John Carter",
      content_type: "text",
      content: "Hi, I was charged twice this month.",
      ts: ago(10),
    },
    {
      id: "w2",
      session_id: "s-1003",
      sender_type: "visitor",
      sender_name: "John Carter",
      content_type: "text",
      content: "Still waiting for an agent…",
      ts: ago(8),
    },
  ],
  "s-1004": [
    {
      id: "e1",
      session_id: "s-1004",
      sender_type: "visitor",
      sender_name: "王建國",
      content_type: "text",
      content: "附件是我們的需求清單,再麻煩了。",
      ts: ago(22),
    },
    {
      id: "e2",
      session_id: "s-1004",
      sender_type: "agent",
      sender_name: "林小葵",
      content_type: "text",
      content: "收到,我今天整理好報價回覆您。",
      ts: ago(20),
      status: "read",
    },
  ],
  "s-1005": [
    {
      id: "t1",
      session_id: "s-1005",
      sender_type: "visitor",
      sender_name: "訪客 #4480",
      content_type: "text",
      content: "帳號登不進去,一直說密碼錯誤。",
      ts: ago(3),
    },
  ],
};

export const mockSuggestions: Record<string, ReplySuggestion[]> = {
  "s-1001": [
    {
      id: "sg1",
      kind: "ai",
      confidence: 0.9,
      text: "您好美玲!老客戶續約 85 折仍然有效,期限到本月底。要我先幫您鎖定這個優惠嗎?",
    },
    {
      id: "sg2",
      kind: "kb",
      source: "續約優惠政策 2026Q3",
      text: "續約可享 85 折並延長 30 天,VIP 另有專屬顧問。",
    },
  ],
  "s-1002": [
    {
      id: "sg3",
      kind: "ai",
      confidence: 0.86,
      text: "我們支援 7 天內無條件退款,超過則依方案比例計算。需要我協助您申請嗎?",
    },
    { id: "sg4", kind: "kb", source: "退款政策", text: "7 天鑑賞期全額退款。" },
  ],
};

export const mockInsights: Record<string, AiInsight> = {
  "s-1001": {
    intent: "續約 / 優惠查詢",
    sentiment: "positive",
    summary: "VIP 老客戶想確認續約 85 折是否仍有效,傾向下週處理。",
    suggested_actions: ["確認優惠效期", "主動提供鎖定連結", "標記為銷售機會"],
    risk: "無明顯流失風險",
  },
  "s-1002": {
    intent: "退款諮詢",
    sentiment: "neutral",
    summary: "新訪客詢問是否支援退款,尚未表明具體訂單。",
    suggested_actions: ["說明退款政策", "詢問訂單編號"],
    risk: "低",
  },
  "s-1003": {
    intent: "重複扣款申訴",
    sentiment: "negative",
    summary: "英文用戶反映本月被扣款兩次,已等待逾 5 分鐘,情緒偏負面。",
    suggested_actions: ["優先接手", "查核扣款紀錄", "致歉並加速處理"],
    risk: "中高:等待過久 + 帳務爭議",
  },
};

export const mockKbHits: Record<string, KbHit[]> = {
  "s-1001": [
    {
      id: "kb1",
      title: "續約優惠政策 2026Q3",
      snippet: "老客戶續約享 85 折,VIP 另有專屬顧問與延長 30 天…",
      collection: "銷售話術",
      score: 0.88,
    },
    {
      id: "kb2",
      title: "VIP 權益總覽",
      snippet: "優先客服、專屬顧問、年度回饋金…",
      collection: "產品文件",
      score: 0.71,
    },
  ],
  "s-1002": [
    {
      id: "kb3",
      title: "退款政策",
      snippet: "7 天鑑賞期內可全額退款,逾期依比例…",
      collection: "客服 FAQ",
      score: 0.83,
    },
  ],
};

export const mockCollections: KnowledgeCollection[] = [
  { id: "kc1", name: "客服 FAQ", type: "qa", doc_count: 128, hit_rate: 0.74, updated_at: ago(60 * 3) },
  { id: "kc2", name: "產品文件", type: "document", doc_count: 56, hit_rate: 0.62, updated_at: ago(60 * 26) },
  { id: "kc3", name: "官網爬取", type: "website", doc_count: 340, hit_rate: 0.48, updated_at: ago(60 * 50) },
  { id: "kc4", name: "銷售話術", type: "qa", doc_count: 42, hit_rate: 0.81, updated_at: ago(60 * 8) },
];

export const mockChannels: Channel[] = [
  { id: "ch1", type: "web", name: "官網網頁掛件", enabled: true, status: "connected", meta: { 網域: "shop.example.com" } },
  { id: "ch2", type: "telegram", name: "Telegram 客服 Bot", enabled: true, status: "connected", meta: { bot: "@kefu_demo_bot" } },
  { id: "ch3", type: "whatsapp", name: "WhatsApp Cloud API", enabled: false, status: "disconnected" },
  { id: "ch4", type: "email", name: "support@example.com", enabled: true, status: "connected" },
  { id: "ch5", type: "wechat", name: "微信公眾號", enabled: false, status: "disconnected" },
];

/** 報表:近 14 天會話量 / 滿意度 */
export const mockReportSeries = Array.from({ length: 14 }).map((_, i) => {
  const d = new Date(now - (13 - i) * 86400_000);
  return {
    date: `${d.getMonth() + 1}/${d.getDate()}`,
    會話量: 40 + Math.round(Math.sin(i / 2) * 12 + Math.random() * 10 + i),
    AI解決: 20 + Math.round(Math.sin(i / 2) * 8 + Math.random() * 6 + i * 0.6),
    滿意度: 80 + Math.round(Math.cos(i / 3) * 6 + Math.random() * 4),
  };
});

export const mockChannelBreakdown = [
  { name: "Telegram", value: 42 },
  { name: "網頁", value: 30 },
  { name: "WhatsApp", value: 14 },
  { name: "Email", value: 9 },
  { name: "其他", value: 5 },
];

export const mockAgentPerf = [
  { name: "我", 接待: 38, 滿意度: 96 },
  { name: "林小葵", 接待: 44, 滿意度: 92 },
  { name: "張偉", 接待: 29, 滿意度: 88 },
  { name: "AI 助理", 接待: 120, 滿意度: 85 },
];

/** mock 登入用的假坐席 */
export const mockStaff = {
  staff_id: "me",
  tenant_id: "t-demo",
  email: "agent@demo.kefu",
  display_name: "示範坐席",
  roles: ["agent", "admin"],
};
