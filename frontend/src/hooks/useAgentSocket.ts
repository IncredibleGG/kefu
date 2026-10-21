import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentSocket, type ConnState } from "@/api/realtime";
import { qk } from "@/api/hooks";
import { mapMessage, mapWsMessage, type RawMessage } from "@/api/adapters";
import { useNotify } from "@/stores/notify";
import { useAuth } from "@/stores/auth";
import { playPing, showDesktopNotification, setTitleUnread } from "@/lib/notify";
import type { Message, WsEvent } from "@/types";

/** 依偏好觸發提示音 / 桌面通知 / 標題未讀閃爍。 */
function fireNotification(title: string, body: string, sessionId?: string) {
  const n = useNotify.getState();
  if (n.sound) playPing();
  if (n.desktop) showDesktopNotification(title, body, { tag: sessionId });
  setTitleUnread(n.totalUnread());
}

/**
 * 掛載坐席台 WebSocket:連線 /ws/agent,將事件寫進 TanStack Query 快取,
 * 並在「新訪客訊息 / 會話指派給我」時觸發通知(提示音 + 桌面通知 + 標題閃爍 + 未讀徽章)。
 * 後端未就緒時 realtime 層會自動回退 mock 事件。
 */
export function useAgentSocket() {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnState>("closed");

  useEffect(() => {
    agentSocket.connect();
    const offState = agentSocket.onState(setState);
    const offEvent = agentSocket.onEvent((ev: WsEvent) => {
      switch (ev.type) {
        case "message.new": {
          // 後端 payload 為原始形狀({message_id, sender_type=human...}),需轉接
          const msg = mapWsMessage(ev.payload, ev.ts);
          if (!msg.session_id) break;
          // 追加到該會話快取(以 id 去重;快取存在時才追加,避免未開啟會話堆積)
          qc.setQueryData<Message[]>(qk.messages(msg.session_id), (old) => {
            if (!old) return old;
            if (old.some((m) => m.id === msg.id)) return old;
            return [...old, msg];
          });
          // 更新會話列表(活躍排序 / 預覽)
          qc.invalidateQueries({ queryKey: ["sessions"] });
          // 通知:僅對「訪客新訊息」且非正在檢視的會話計未讀並提示
          if (msg.sender_type === "visitor") {
            const notify = useNotify.getState();
            notify.bump(msg.session_id);
            if (notify.activeSessionId !== msg.session_id) {
              const preview = msg.content?.slice(0, 60) || "傳來新訊息";
              fireNotification(`${msg.sender_name ?? "訪客"} 傳來新訊息`, preview, msg.session_id);
            }
          }
          break;
        }
        case "note.new": {
          // 坐席私密內部備註:後端已於 payload 帶 {session_id, message_id, author_staff_id, content}
          const p = ev.payload as {
            session_id?: string;
            message_id?: string;
            author_staff_id?: string;
            content?: string;
          };
          if (!p.session_id || !p.message_id) break;
          const note = mapMessage(
            {
              id: p.message_id,
              session_id: p.session_id,
              sender_type: "note",
              sender_id: p.author_staff_id ?? null,
              content_type: "text",
              content: p.content ?? "",
              meta: { author_staff_id: p.author_staff_id },
              created_at: ev.ts ?? new Date().toISOString(),
            } as RawMessage,
          );
          qc.setQueryData<Message[]>(qk.messages(p.session_id), (old) => {
            if (!old) return old;
            if (old.some((m) => m.id === note.id)) return old;
            return [...old, note];
          });
          break;
        }
        case "session.activity": {
          // 安全網:當前開啟的會話(其 messages query 為 active)會被 refetch,
          // 即使會話頻道 message.new 因重連空窗漏收,也能免刷新補上。
          const sid = (ev.payload as { session_id?: string })?.session_id;
          if (sid) qc.invalidateQueries({ queryKey: qk.messages(sid) });
          qc.invalidateQueries({ queryKey: ["sessions"] });
          break;
        }
        case "session.opened":
        case "handoff":
        case "session.closed": {
          // 認領 / 轉接 / 結束 → 列表即時更新;若牽涉當前會話也刷新其訊息
          const p = ev.payload as { session_id?: string; handler_staff_id?: string; action?: string };
          const sid = p?.session_id;
          if (sid) qc.invalidateQueries({ queryKey: qk.messages(sid) });
          qc.invalidateQueries({ queryKey: ["sessions"] });
          // 通知:會話被指派/轉接給「我」
          const myId = useAuth.getState().staff?.staff_id;
          if (
            ev.type === "handoff" &&
            sid &&
            myId &&
            p.handler_staff_id === myId &&
            useNotify.getState().activeSessionId !== sid
          ) {
            fireNotification("會話已指派給你", "有一個會話已轉接 / 指派給你,請前往接待", sid);
          }
          break;
        }
        // 相容舊事件名
        case "session.new":
        case "session.assigned":
        case "session.handoff":
          qc.invalidateQueries({ queryKey: ["sessions"] });
          break;
        default:
          break;
      }
    });
    return () => {
      offState();
      offEvent();
      agentSocket.disconnect();
    };
  }, [qc]);

  return state;
}
