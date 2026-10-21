// 訪客端 WebSocket:連 /ws/widget?tenant_id=&session_id= 訂閱會話頻道,
// 把後端推來的事件(message.new / message / session.closed …)交給 onEvent。
// 具指數退避重連;連續失敗達上限時呼叫 onGiveUp,讓上層切換輪詢 fallback。

import { wsOrigin } from "./api";
import type { RealtimeEvent, WidgetConfig } from "./types";

export interface WsHandlers {
  onEvent: (ev: RealtimeEvent) => void;
  onStatus: (status: "connecting" | "open" | "closed") => void;
  onGiveUp: () => void;
}

export class WidgetSocket {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private retries = 0;
  private readonly maxRetries = 5;
  private timer: number | null = null;

  constructor(
    private readonly cfg: WidgetConfig,
    private readonly tenantId: string,
    private readonly sessionId: string,
    private readonly h: WsHandlers,
    // 訪客身分:後端 /ws/widget 要求 visitor_external_id 與會話歸屬相符才准連線(防越權竊聽/偽冒)
    private readonly visitorExternalId: string = "",
  ) {}

  private url(): string {
    let q = `tenant_id=${encodeURIComponent(this.tenantId)}&session_id=${encodeURIComponent(this.sessionId)}`;
    if (this.visitorExternalId) q += `&visitor_external_id=${encodeURIComponent(this.visitorExternalId)}`;
    return `${wsOrigin(this.cfg.apiBase)}/ws/widget?${q}`;
  }

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  /**
   * 送出控制訊息(如 sneak-peek 的 draft 草稿預覽)。僅在連線開啟時送出,
   * 未連線 / 送出失敗一律安靜略過——控制訊息為加值,不可影響核心送收訊。
   */
  send(data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(data));
    } catch {
      /* noop:控制訊息送出失敗不致命 */
    }
  }

  private open(): void {
    this.h.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      this.h.onStatus("open");
    };
    ws.onmessage = (msg) => {
      let data: RealtimeEvent;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      this.h.onEvent(data);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
    ws.onclose = () => {
      this.h.onStatus("closed");
      if (this.closedByUs) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.retries >= this.maxRetries) {
      this.h.onGiveUp();
      return;
    }
    const delay = Math.min(1000 * 2 ** this.retries, 15000);
    this.retries += 1;
    this.timer = window.setTimeout(() => this.open(), delay);
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }
}
