/** ============================================================
 *  即時層:坐席 WebSocket(/ws/agent)。
 *  - 真後端:連 wsUrl("/ws/agent", {token, session_id?, device_id, platform}),收 { type, payload, ts }
 *  - 斷線:指數退避 + jitter(上限 30 秒);App 回前景 / 網路恢復時 kick() 立即重連。
 *  - 心跳:每 25 秒送 {"type":"ping"};伺服器曾回過 pong 才啟用「10 秒沒 pong 視為斷線」
 *    (舊版伺服器不回 pong,不可因此判定斷線)。
 *  - close 4401(token 無效 / 帳號停用 / 已被撤銷):走既有 401 登出流程,不再重試;
 *    但若本機 token 已換新(改密 / 2FA 變更後後端回新 token),改以新 token 立即重連。
 *  - 前景 / 背景切換時送 {"type":"app_state","payload":{"foreground":bool}}(後端據此決定是否推播)。
 *  - mock 模式(mockMode !== "off"):on 直接 mock;auto 連不上兩次後回退 mock 事件產生器。
 *  ============================================================ */
import { config } from "@/lib/config";
import { getToken, wsUrl } from "@/lib/server";
import {
  clientPlatform,
  getDeviceId,
  isAppForeground,
  isMobileApp,
  onOnline,
  onPause,
  onResume,
} from "@/lib/platform";
import { apiFetch, triggerUnauthorized } from "./client";
import type { Message, WsEvent } from "@/types";
import { _mockPushVisitorMessage, _mockSessionIds } from "./mock";

type Listener = (ev: WsEvent) => void;
export type ConnState = "connecting" | "open" | "closed" | "mock";

/** 心跳間隔 / pong 逾時 / 退避上限(docs/NATIVE-CLIENTS.md §4.2) */
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** 後端認證失敗的 close code */
const CLOSE_UNAUTHORIZED = 4401;

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
  private stopped = true;
  private sessionId: string | null = null;
  private reopening = false;
  /** 退避重連計時器(kick / disconnect 時取消) */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 心跳計時器 */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  /** 目前伺服器是否支援應用層 pong(收過一次即視為支援;disconnect / 換伺服器時重置) */
  private pongSupported = false;
  /** 平台事件(resume / pause / online)取消函式 */
  private platformOffs: (() => void)[] = [];
  /** 目前連線所帶的 token(token 換發後據此判斷是否需以新 token 重連) */
  private connToken: string | null = null;

  connect() {
    this.stopped = false;
    this.bindPlatform();
    if (config.mockMode === "on") {
      this.startMock();
      return;
    }
    if (this.ws) return; // 已在連線中
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
    if (config.mockMode === "on" || this.state === "mock") return;
    // 已在真連線 → 立即重連以套用新的會話訂閱;尚未連線則由後續 connect() 帶上。
    if (this.ws || this.state === "open" || this.state === "connecting") {
      this.reopen();
    }
  }

  /**
   * 立即恢復連線(App 回前景 / 網路恢復時呼叫):重置退避。
   * - 未連線 → 立刻重連;
   * - 已連線且伺服器支援 pong → 送一次 ping 驗證(10 秒沒回就重連);
   * - 已連線但不支援 pong → 手機上直接重開(背景期間 socket 多半已被系統切斷),桌面 / web 不動作。
   */
  kick() {
    if (this.stopped || this.state === "mock" || config.mockMode === "on") return;
    this.retry = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.ws = null;
      this.openReal();
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING) return;
    if (this.pongSupported) this.sendPing();
    else if (isMobileApp) this.reopen();
  }

  /**
   * token 已換發(改密 / 2FA 變更後後端撤銷舊 token、回新 token):以新 token 重連,
   * 免得舊連線在伺服器定期複查時被 4401 關閉。未連線 / mock 時不動作(下次連線自然帶新 token)。
   */
  refreshToken() {
    if (this.stopped || this.state === "mock" || config.mockMode === "on") return;
    if (this.ws && getToken() !== this.connToken) this.reopen();
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

  /** 掛上平台事件(只掛一次;disconnect 時解除)。 */
  private bindPlatform() {
    if (this.platformOffs.length) return;
    this.platformOffs = [
      onResume(() => {
        this.sendAppState(true);
        this.kick();
      }),
      onPause(() => this.sendAppState(false)),
      onOnline(() => this.kick()),
    ];
  }

  private unbindPlatform() {
    this.platformOffs.forEach((off) => off());
    this.platformOffs = [];
  }

  private sendRaw(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        /* 忽略 */
      }
    }
  }

  private sendAppState(foreground: boolean) {
    this.sendRaw({ type: "app_state", payload: { foreground } });
  }

  private sendPing() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.sendRaw({ type: "ping" });
    // 只有確認伺服器會回 pong 才計逾時(舊版伺服器不回,不可誤判斷線)
    if (this.pongSupported && !this.pongTimer) {
      const ws = this.ws;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        // 半開連線收不到伺服器的 close frame,onclose 可能要等瀏覽器 closing 逾時(約 60 秒)才觸發:
        // 先解除參照(之後該 socket 的 onclose / onmessage 皆被 this.ws !== ws 忽略)再直接走斷線重連。
        this.stopHeartbeat();
        this.ws = null;
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
        this.onDrop();
      }, PONG_TIMEOUT_MS);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private openReal() {
    if (this.stopped) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      const token = getToken() ?? "";
      this.connToken = token;
      const params: Record<string, string> = {
        token,
        device_id: getDeviceId(),
        platform: clientPlatform(),
      };
      // 帶上當前開啟的會話 → 後端額外訂閱該會話頻道(收該會話 message.new)
      if (this.sessionId) params.session_id = this.sessionId;
      this.setState("connecting");
      const ws = new WebSocket(wsUrl("/ws/agent", params));
      this.ws = ws;
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.retry = 0;
        this.setState("open");
        this.sendAppState(isAppForeground());
        this.startHeartbeat();
      };
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        try {
          const ev = JSON.parse(e.data) as WsEvent;
          if (ev?.type === "pong") {
            this.pongSupported = true;
            if (this.pongTimer) {
              clearTimeout(this.pongTimer);
              this.pongTimer = null;
            }
          }
          this.emit(ev);
        } catch {
          /* 忽略非 JSON */
        }
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return; // 已被新連線取代
        this.stopHeartbeat();
        this.ws = null;
        // 主動重連(切換會話訂閱):立即重開,不走退避
        if (this.reopening) {
          this.reopening = false;
          if (!this.stopped) this.openReal();
          return;
        }
        // 認證失敗:走既有 401 登出流程(清 token → 路由守衛導回登入),不再重試。
        // 例外:被撤銷的是舊 token、本機已換發新 token(改密 / 2FA 變更)→ 以新 token 立即重連。
        if (e.code === CLOSE_UNAUTHORIZED) {
          const current = getToken();
          if (current && current !== token) {
            if (!this.stopped) this.openReal();
            return;
          }
          this.stopped = true;
          this.setState("closed");
          triggerUnauthorized();
          return;
        }
        this.onDrop();
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
      };
    } catch {
      this.ws = null;
      this.onDrop();
    }
  }

  private onDrop() {
    if (this.stopped) return;
    this.retry += 1;
    // auto 模式:連不上就回退 mock,讓 demo 持續有事件(off 模式永不回退)
    if (config.mockMode === "auto" && this.retry >= 2) {
      this.startMock();
      return;
    }
    this.setState("closed");
    // 舊版伺服器在 accept 前就以 4401 拒絕,瀏覽器只看到 1006:連續失敗時用 REST 驗一次 token,
    // 若已過期 apiFetch 的 401 會觸發既有登出流程,避免用過期 token 無限重試。
    if (this.retry === 3 && getToken()) {
      void apiFetch("/api/v1/auth/me").catch(() => undefined);
    }
    // 指數退避 + jitter:base = 1s·2^(n-1)(上限 30s),實際等待 base 的 50%–100%
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.retry - 1, 10));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.openReal();
    }, delay);
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
    this.unbindPlatform();
    this.stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.reopening = false;
    const ws = this.ws;
    this.ws = null; // 先解除參照:onclose 不再觸發重連
    try {
      ws?.close();
    } catch {
      /* 忽略 */
    }
    this.retry = 0;
    this.pongSupported = false;
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
    this.setState("closed");
  }
}

/** 單例:整個坐席台共用一條連線 */
export const agentSocket = new AgentSocket();

export type NewMessagePayload = Message;
