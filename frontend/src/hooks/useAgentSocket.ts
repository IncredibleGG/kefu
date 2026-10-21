import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentSocket, type ConnState } from "@/api/realtime";
import { qk } from "@/api/hooks";
import { mapMessage, mapWsMessage, type RawMessage } from "@/api/adapters";
import { onResume } from "@/lib/platform";
import type { Message, WsEvent } from "@/types";

/**
 * 掛載坐席台 WebSocket:連線 /ws/agent,將事件寫進 TanStack Query 快取。
 * 通知(未讀 / 音效 / 系統通知)統一由 AppLayout 的事件監聽轉給 stores/notify.notifyEvent,
 * 此處不再重複計未讀或彈通知。
 * 斷線重連 / App 回前景後刷新會話列表與當前會話訊息(斷線期間的事件後端不會補送)。
 * 後端未就緒時 realtime 層會自動回退 mock 事件(僅 mockMode !== "off")。
 */
export function useAgentSocket() {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnState>("closed");

  useEffect(() => {
    agentSocket.connect();
    // 斷線期間漏掉的事件不會補送:斷線後重新連上 / App 回前景時刷新列表與訊息
    // (切換會話的主動重連不經 closed 狀態,不會觸發)
    let dropped = false;
    const refetchAll = () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["sessions-inbox"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
    };
    const offState = agentSocket.onState((s) => {
      setState(s);
      if (s === "closed") dropped = true;
      else if (s === "open" && dropped) {
        dropped = false;
        refetchAll();
      }
    });
    const offResume = onResume(refetchAll);
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
          // 更新會話列表(活躍排序 / 預覽);通知由 AppLayout 統一處理
          qc.invalidateQueries({ queryKey: ["sessions"] });
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
          const sid = (ev.payload as { session_id?: string })?.session_id;
          if (sid) qc.invalidateQueries({ queryKey: qk.messages(sid) });
          qc.invalidateQueries({ queryKey: ["sessions"] });
          // 指派 / 轉接給我的通知由 AppLayout 統一處理
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
      offResume();
      offEvent();
      agentSocket.disconnect();
    };
  }, [qc]);

  return state;
}
