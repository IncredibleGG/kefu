import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { IconRail } from "./IconRail";
import { SecondarySidebar } from "./SecondarySidebar";
import { TopBar } from "./TopBar";
import { navItems } from "./nav";
import { CommandPalette } from "@/components/CommandPalette";
import { useUi } from "@/stores/ui";
import { useAuth } from "@/stores/auth";
import { useNotify } from "@/stores/notify";
import { useAgentSocket } from "@/hooks/useAgentSocket";
import { agentSocket } from "@/api/realtime";
import { setNotificationNavigator } from "@/lib/notifications";
import type { WsEvent } from "@/types";

/** 應用主框架:窄圖示主欄 + 展開二級側欄 + 頂欄 + 內容區 */
export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { sidebarExpanded, setSidebarExpanded } = useUi();
  const staffId = useAuth((s) => s.staff?.staff_id);

  // ⌘K / Ctrl+K 全域命令列面板開關
  const [cmdkOpen, setCmdkOpen] = useState(false);

  // 掛載一次全域坐席 WebSocket(整站共用):負責資料層快取更新,
  // 並已對「訪客新訊息 / handoff 指派給我」觸發通知。
  useAgentSocket();

  // 桌面通知點擊 → 導向對應會話:注入 react-router 的 navigate。
  useEffect(() => {
    setNotificationNavigator((path) => navigate(path));
    return () => setNotificationNavigator(null);
  }, [navigate]);

  // 全域通知監聽:訂閱既有坐席 WS(登入後才連線),把「目前只更新資料層、
  // 尚未觸達坐席」的事件轉給 notify store 統一觸達(未讀 + 音效 + 桌面)。
  // 刻意不重複 useAgentSocket 已處理的 message.new(訪客)與 handoff,避免重複未讀 / 音效。
  useEffect(() => {
    if (!staffId) return; // 需登入取得 staffId 才能比對「是否與我相關」
    const off = agentSocket.onEvent((ev: WsEvent) => {
      const notify = useNotify.getState();
      // 部分事件(session.queued / mention / sla)不在 WsEvent 型別聯集中,以字串比較避免型別窄化誤判
      const type = ev.type as string;
      const p = (ev.payload ?? {}) as {
        session_id?: string;
        sessionId?: string;
        sender_type?: string;
        sender_id?: string;
        staff_id?: string;
        sender_name?: string;
        content?: string;
        message_id?: string;
        id?: string;
        handler_staff_id?: string;
        assignee_staff_id?: string;
        mentioned_staff_ids?: string[];
        target_staff_id?: string;
        from_staff_name?: string;
        author_name?: string;
        note_id?: string;
        policy_name?: string;
        reason?: string;
      };
      const sid = p.session_id ?? p.sessionId;

      switch (type) {
        // 訪客新訊息由既有 useAgentSocket 觸發;此處僅補「其他坐席」在共享會話的新訊息
        // (原始 payload 的 sender_type=human 才是坐席;非我本人、非正在看的會話)。
        case "message.new": {
          if (!sid) break;
          if (p.sender_type !== "human") break; // 跳過 visitor / ai / system / note
          const from = p.sender_id ?? p.staff_id;
          if (from && from === staffId) break; // 我自己送的不通知
          notify.notifyEvent("message", {
            sessionId: sid,
            from: p.sender_name,
            text: p.content,
            dedupId: p.message_id ?? p.id,
          });
          break;
        }
        // 會話(新建 / 指派)落到「我」名下:useAgentSocket 只處理 handoff,這裡補指派事件
        case "session.assigned":
        case "session.new": {
          const handler = p.handler_staff_id ?? p.assignee_staff_id ?? p.staff_id;
          if (handler && handler === staffId) {
            notify.notifyEvent("assigned", { sessionId: sid, dedupId: `${handler}:${sid ?? ""}` });
          }
          break;
        }
        // 新會話進入佇列(待接待,尚未指派)→ 提醒團隊
        case "session.queued":
        case "session.enqueued": {
          notify.notifyEvent("queued", { sessionId: sid, dedupId: sid });
          break;
        }
        // @提及:僅在提及對象包含我時觸達
        case "mention": {
          const targets = Array.isArray(p.mentioned_staff_ids) ? p.mentioned_staff_ids : [];
          if (p.target_staff_id === staffId || targets.includes(staffId)) {
            notify.notifyEvent("mention", {
              sessionId: sid,
              from: p.from_staff_name ?? p.author_name,
              text: p.content,
              dedupId: p.message_id ?? p.note_id,
            });
          }
          break;
        }
        // SLA 逾時 / 即將違約
        case "sla":
        case "sla.warning":
        case "sla.breach": {
          notify.notifyEvent("sla", {
            sessionId: sid,
            text: p.policy_name ?? p.reason,
            dedupId: `${type}:${sid ?? ""}`,
          });
          break;
        }
        // 其餘(handoff / note.new / session.activity / session.opened / session.closed /
        // typing / presence / pong)由既有 useAgentSocket 或各視圖處理,或無需通知。
        default:
          break;
      }
    });
    return () => {
      off();
    };
  }, [staffId]);

  // 全域快捷鍵:⌘K(Mac)/ Ctrl+K 切換命令列面板
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCmdkOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 依當前路徑找出所屬一級區塊
  const section = useMemo(
    () => navItems.find((n) => location.pathname.startsWith(n.to)) ?? navItems[0],
    [location.pathname],
  );

  const hasSecondary = (section.secondary?.length ?? 0) > 0 && sidebarExpanded;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <IconRail />
      {hasSecondary && (
        <SecondarySidebar section={section} onCollapse={() => setSidebarExpanded(false)} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onToggleSidebar={() => setSidebarExpanded(!sidebarExpanded)} />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />
    </div>
  );
}
