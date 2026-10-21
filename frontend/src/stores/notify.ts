import { create } from "zustand";
import { persist } from "zustand/middleware";
import i18n from "@/lib/i18n";
import { playPing } from "@/lib/notify";
import { pushDesktopNotification } from "@/lib/notifications";

/**
 * 通知偏好 + 未讀計數 + 事件觸達統一入口。
 * - sound / desktop:開關存 localStorage(persist),供頂欄切換。
 * - unread:各會話未讀數(記憶體態,不持久);activeSessionId 為「正在看的會話」,
 *   收到其新訊息不計未讀。
 * - notifyEvent:即時事件(新訊息 / 指派 / 佇列 / @提及 / SLA)的統一觸達入口,
 *   一次處理「未讀計數 + 音效 + 桌面通知」,並做去重 / 節流避免刷屏。
 */

/** 可觸達通知的事件種類。 */
export type NotifyKind = "message" | "assigned" | "queued" | "mention" | "sla";

/** notifyEvent 的酬載(欄位皆為選填,依 kind 取用)。 */
export interface NotifyPayload {
  /** 關聯會話;有值時計未讀 / 點擊桌面通知可導頁。 */
  sessionId?: string;
  /** 來源名稱(訪客 / 坐席),用於標題。 */
  from?: string;
  /** 內文摘要(訊息預覽等)。 */
  text?: string;
  /** 去重鍵(如 messageId);缺省則用 kind + sessionId。 */
  dedupId?: string;
}

interface NotifyState {
  sound: boolean;
  desktop: boolean; // 瀏覽器桌面通知
  unread: Record<string, number>;
  activeSessionId: string | null;
  setSound: (v: boolean) => void;
  setDesktop: (v: boolean) => void;
  setActiveSession: (id: string | null) => void;
  bump: (sessionId: string) => void;
  clear: (sessionId: string) => void;
  totalUnread: () => number;
  /** 即時事件統一觸達:更新未讀 + 依開關播音效 + 彈桌面通知(含去重 / 節流)。 */
  notifyEvent: (kind: NotifyKind, payload?: NotifyPayload) => void;
}

/* --------------------------- 去重 / 節流(模組態) --------------------------- */
/** 同一事件(重連回放 / 多路徑轉發)在此視窗內只觸達一次。 */
const DEDUP_MS = 4000;
/** 音效最短間隔,避免短時間大量事件連續刷屏。 */
const SOUND_THROTTLE_MS = 1500;
const _seen = new Map<string, number>();
let _lastSound = 0;

function dedupHit(sig: string, now: number): boolean {
  const last = _seen.get(sig);
  if (last != null && now - last < DEDUP_MS) return true;
  _seen.set(sig, now);
  // 惰性清理,避免 Map 無限增長
  if (_seen.size > 128) {
    for (const [k, ts] of _seen) if (now - ts > DEDUP_MS) _seen.delete(k);
  }
  return false;
}

/** 依事件種類組出通知標題 / 內文(繁中回退,鍵暫存於 _pending/notify.json)。 */
function buildText(kind: NotifyKind, p: NotifyPayload): { title: string; body?: string } {
  const t = i18n.t.bind(i18n);
  const who = p.from ?? t("notify.someone", { defaultValue: "同事" });
  const preview = p.text?.trim().slice(0, 80) || undefined;
  switch (kind) {
    case "message":
      return {
        title: t("notify.message.title", { defaultValue: "{{from}} 傳來新訊息", from: who }),
        body: preview ?? t("notify.message.body", { defaultValue: "你有一則新訊息" }),
      };
    case "assigned":
      return {
        title: t("notify.assigned.title", { defaultValue: "會話已指派給你" }),
        body: t("notify.assigned.body", { defaultValue: "有一個會話已指派給你,請前往接待" }),
      };
    case "queued":
      return {
        title: t("notify.queued.title", { defaultValue: "有新會話進入佇列" }),
        body: t("notify.queued.body", { defaultValue: "佇列中有等待接待的會話" }),
      };
    case "mention":
      return {
        title: t("notify.mention.title", { defaultValue: "{{from}} 在會話中提及你", from: who }),
        body: preview ?? t("notify.mention.body", { defaultValue: "你在一則內部備註中被提及" }),
      };
    case "sla":
      return {
        title: t("notify.sla.title", { defaultValue: "SLA 逾時提醒" }),
        body: preview ?? t("notify.sla.body", { defaultValue: "有會話觸發 SLA 提醒,請儘快處理" }),
      };
  }
}

export const useNotify = create<NotifyState>()(
  persist(
    (set, get) => ({
      sound: true,
      desktop: false,
      unread: {},
      activeSessionId: null,

      setSound: (v) => set({ sound: v }),
      setDesktop: (v) => set({ desktop: v }),
      setActiveSession: (id) => {
        // 進入會話即清該會話未讀
        if (id) {
          const next = { ...get().unread };
          delete next[id];
          set({ activeSessionId: id, unread: next });
        } else {
          set({ activeSessionId: id });
        }
      },
      bump: (sessionId) => {
        if (get().activeSessionId === sessionId) return; // 正在看不計未讀
        set((s) => ({ unread: { ...s.unread, [sessionId]: (s.unread[sessionId] ?? 0) + 1 } }));
      },
      clear: (sessionId) => {
        set((s) => {
          if (!(sessionId in s.unread)) return s;
          const next = { ...s.unread };
          delete next[sessionId];
          return { unread: next };
        });
      },
      totalUnread: () => Object.values(get().unread).reduce((a, b) => a + b, 0),

      notifyEvent: (kind, payload = {}) => {
        const { sessionId } = payload;
        const now = Date.now();

        // 1) 去重:同事件短時間內只處理一次
        const sig = `${kind}:${sessionId ?? "-"}:${payload.dedupId ?? ""}`;
        if (dedupHit(sig, now)) return;

        // 2) 未讀:綁定會話的事件才計數;bump 內部已跳過「正在看的會話」
        const countsUnread =
          kind === "message" || kind === "mention" || kind === "assigned" || kind === "queued";
        const isActive = sessionId != null && get().activeSessionId === sessionId;
        if (countsUnread && sessionId) get().bump(sessionId);

        // 正在看的會話,其新訊息 / 提及不再以音效 / 桌面打擾(未讀也已跳過)
        if (isActive && (kind === "message" || kind === "mention")) return;

        const { title, body } = buildText(kind, payload);

        // 3) 音效(節流):尊重音效開關
        if (get().sound && now - _lastSound >= SOUND_THROTTLE_MS) {
          _lastSound = now;
          playPing();
        }

        // 4) 桌面通知:尊重桌面開關(實際彈出仍受權限 / 前景分頁限制,見 lib/notifications)
        if (get().desktop) {
          pushDesktopNotification({ title, body, tag: sessionId ?? kind, sessionId });
        }
      },
    }),
    {
      name: "kefu-notify",
      // 只持久化偏好開關,未讀數為記憶體態
      partialize: (s) => ({ sound: s.sound, desktop: s.desktop }),
    },
  ),
);
