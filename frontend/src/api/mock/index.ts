/** ============================================================
 *  Mock 適配層(集中一處):把假資料包成與真 API 相同形狀。
 *  換真 API 時,只需把對應 endpoint 的 real 設為 true 並移除 mock。
 *  ============================================================ */
import { sleep, uid } from "@/lib/utils";
import type {
  AiInsight,
  KbHit,
  KnowledgeCollection,
  Message,
  Paged,
  ReplySuggestion,
  Session,
  SessionTab,
  Staff,
  Channel,
} from "@/types";
import {
  mockAgentPerf,
  mockChannelBreakdown,
  mockChannels,
  mockCollections,
  mockInsights,
  mockKbHits,
  mockMessages,
  mockReportSeries,
  mockSessions,
  mockStaff,
  mockSuggestions,
} from "./data";

// 用可變副本模擬伺服器狀態
const sessions = structuredClone(mockSessions);
const messages: Record<string, Message[]> = structuredClone(mockMessages);

export const mockApi = {
  async login(_email: string): Promise<{ access_token: string; token_type: string; staff_id: string }> {
    await sleep(400);
    return { access_token: "mock-token." + uid(), token_type: "bearer", staff_id: mockStaff.staff_id };
  },
  async me(): Promise<Staff> {
    await sleep(150);
    return { ...mockStaff };
  },
  async listSessions(tab: SessionTab, q?: string): Promise<Paged<Session>> {
    await sleep(250);
    let items = sessions.filter((s) => (tab === "mine" ? s.assignee_id === "me" : s.tab === tab || tab === "online"));
    if (tab === "online") items = sessions.filter((s) => s.status !== "closed");
    if (q) items = items.filter((s) => s.visitor.display_name.includes(q) || s.last_message_preview.includes(q));
    return { items, total: items.length, page: 1, size: items.length };
  },
  async getSession(id: string): Promise<Session | undefined> {
    await sleep(120);
    return sessions.find((s) => s.id === id);
  },
  async listMessages(sessionId: string): Promise<Message[]> {
    await sleep(200);
    return messages[sessionId] ? structuredClone(messages[sessionId]) : [];
  },
  async sendMessage(sessionId: string, content: string, contentType: Message["content_type"] = "text"): Promise<Message> {
    await sleep(180);
    const msg: Message = {
      id: uid(),
      session_id: sessionId,
      sender_type: "agent",
      sender_name: "我",
      content_type: contentType,
      content,
      ts: new Date().toISOString(),
      status: "sent",
    };
    (messages[sessionId] ||= []).push(msg);
    const s = sessions.find((x) => x.id === sessionId);
    if (s) {
      s.last_message_preview = content.replace(/[#*`]/g, "").slice(0, 40);
      s.last_message_at = msg.ts;
      s.unread = 0;
    }
    return msg;
  },
  async flagMessage(sessionId: string, messageId: string, flagged: boolean): Promise<void> {
    await sleep(80);
    const m = messages[sessionId]?.find((x) => x.id === messageId);
    if (m) m.flagged = flagged;
  },
  async suggestions(sessionId: string): Promise<ReplySuggestion[]> {
    await sleep(300);
    return mockSuggestions[sessionId] ?? [];
  },
  async insight(sessionId: string): Promise<AiInsight | null> {
    await sleep(200);
    return mockInsights[sessionId] ?? null;
  },
  async kbHits(sessionId: string): Promise<KbHit[]> {
    await sleep(220);
    return mockKbHits[sessionId] ?? [];
  },
  async collections(): Promise<KnowledgeCollection[]> {
    await sleep(180);
    return structuredClone(mockCollections);
  },
  async channels(): Promise<Channel[]> {
    await sleep(160);
    return structuredClone(mockChannels);
  },
  async report(): Promise<{
    series: typeof mockReportSeries;
    channelBreakdown: typeof mockChannelBreakdown;
    agentPerf: typeof mockAgentPerf;
    kpi: { label: string; value: string; delta: number }[];
  }> {
    await sleep(260);
    return {
      series: mockReportSeries,
      channelBreakdown: mockChannelBreakdown,
      agentPerf: mockAgentPerf,
      kpi: [
        { label: "今日會話", value: "312", delta: 8.4 },
        { label: "AI 自動解決率", value: "63%", delta: 3.1 },
        { label: "平均首回應", value: "42s", delta: -12.0 },
        { label: "CSAT 滿意度", value: "94%", delta: 1.6 },
      ],
    };
  },
};

/** 內部:提供給 mock WebSocket 產生新訊息事件 */
export function _mockPushVisitorMessage(sessionId: string, content: string): Message {
  const msg: Message = {
    id: uid(),
    session_id: sessionId,
    sender_type: "visitor",
    sender_name: sessions.find((s) => s.id === sessionId)?.visitor.display_name,
    content_type: "text",
    content,
    ts: new Date().toISOString(),
    status: "delivered",
  };
  (messages[sessionId] ||= []).push(msg);
  const s = sessions.find((x) => x.id === sessionId);
  if (s) {
    s.last_message_preview = content.slice(0, 40);
    s.last_message_at = msg.ts;
    s.unread += 1;
  }
  return msg;
}

export function _mockSessionIds(): string[] {
  return sessions.map((s) => s.id);
}
