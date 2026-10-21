/** ============================================================
 *  即時層:坐席 WebSocket(/ws/agent)。
 *  - 真後端:連 ws(s)://<api>/ws/agent?token=...,收 { type, payload, ts }
 *  - 後端未就緒 / mock 模式:啟動 mock 事件產生器,定時模擬訪客新訊息,
 *    讓工作台在無後端時也能看到「即時」效果。
 *  ============================================================ */
import { config } from "@/lib/config";
import { STORAGE_KEYS } from "@/lib/config";
import type { Message, WsEvent } from "@/types";
import { _mockPushVisitorMessage, _mockSessionIds } from "./mock";

type Listener = (ev: WsEvent) => void;
export type ConnState = "connecting" | "open" | "closed" | "mock";

const MOCK_LINES = [
  "請問還在嗎?",
  "我剛剛試了還是不行 😥",
  "好的,那我等你回覆。",
  "可以幫我看一下訂單 #A2231 嗎?",
  "謝謝你的協助!",
  "這個優惠可以延到下週嗎?",
];

export class AgentSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: ConnState) => void>();
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private state: ConnState = "closed";
  private retry = 0;
  private stopped = false;
  private sessionId: string | null = null;
  private reopening = false;

  connect() {
    this.stopped = false;
    if (config.mockMode === "on") {
      this.startMock();
      return;
    }
    this.openReal();
  }

  /**
   * 設定「當前開啟的會話」。真連線時會重連 /ws/agent 並帶上 ?session_id=,
   * 讓後端額外訂閱該會話頻道,使該會話的逐則 message.new 免刷新即時到達。
   * 傳 null 取消該會話訂閱。
   */
  setActiveSession(id: string | null) {
    if (this.sessionId === id) return;
    this.sessionId = id;
    if (config.mockMode === "on") return;
    // 已在真連線 → 立即重連以套用新的會話訂閱;尚未連線則由後續 connect() 帶上。
    if (this.ws || this.state === "open" || this.state === "connecting") {
      this.reopen();
    }
  }

  /** 主動重連(套用新的 session 訂閱),不走斷線退避,盡量無縫。 */
  private reopen() {
    if (this.stopped) return;
    if (!this.ws) {
      this.openReal();
      return;
    }
    this.reopening = true;
    this.ws.close();
  }

  private setState(s: ConnState) {
    this.state = s;
    this.stateListeners.forEach((l) => l(s));
  }

  private openReal() {
    try {
      const token = localStorage.getItem(STORAGE_KEYS.token) ?? "";
      // base 為空 → 用當前網頁 origin(同源,經 nginx 反代 /ws);否則用設定的 API base
      const rawBase = config.apiBase
        ? config.apiBase
        : `${window.location.protocol}//${window.location.host}`;
      const base = rawBase.replace(/^http/, "ws").replace(/\/$/, "");
      this.setState("connecting");
      const qs = new URLSearchParams({ token });
      // 帶上當前開啟的會話 → 後端額外訂閱該會話頻道(收該會話 message.new)
      if (this.sessionId) qs.set("session_id", this.sessionId);
      const ws = new WebSocket(`${base}/ws/agent?${qs.toString()}`);
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 0;
        this.setState("open");
      };
      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data) as WsEvent;
          this.emit(ev);
        } catch {
          /* 忽略非 JSON */
        }
      };
      ws.onclose = () => {
        // 主動重連(切換會話訂閱):立即重開,不走退避
        if (this.reopening) {
          this.reopening = false;
          this.ws = null;
          if (!this.stopped) this.openReal();
          return;
        }
        this.onDrop();
      };
      ws.onerror = () => ws.close();
    } catch {
      this.onDrop();
    }
  }

  private onDrop() {
    if (this.stopped) return;
    this.retry += 1;
    // auto 模式:連不上就回退 mock,讓 demo 持續有事件
    if (config.mockMode === "auto" && this.retry >= 2) {
      this.startMock();
      return;
    }
    this.setState("closed");
    setTimeout(() => !this.stopped && this.openReal(), Math.min(1000 * this.retry, 5000));
  }

  private startMock() {
    if (this.mockTimer) return;
    this.setState("mock");
    this.mockTimer = setInterval(() => {
      const ids = _mockSessionIds();
      if (!ids.length) return;
      const sessionId = ids[Math.floor(Math.random() * ids.length)];
      const text = MOCK_LINES[Math.floor(Math.random() * MOCK_LINES.length)];
      const msg = _mockPushVisitorMessage(sessionId, text);
      this.emit({ type: "message.new", payload: msg, ts: msg.ts });
    }, 12_000);
  }

  private emit(ev: WsEvent) {
    this.listeners.forEach((l) => l(ev));
  }

  /** 送出封包(真連線才有效) */
  send(type: WsEvent["type"], payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload, ts: new Date().toISOString() }));
    }
  }

  onEvent(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onState(l: (s: ConnState) => void) {
    this.stateListeners.add(l);
    l(this.state);
    return () => this.stateListeners.delete(l);
  }

  disconnect() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
    this.setState("closed");
  }
}

/** 單例:整個坐席台共用一條連線 */
export const agentSocket = new AgentSocket();

export type NewMessagePayload = Message;
