import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { IconRail } from "./IconRail";
import { SecondarySidebar } from "./SecondarySidebar";
import { TopBar } from "./TopBar";
import { MobileTabBar } from "./MobileTabBar";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { MobileSecondaryNav } from "./MobileSecondaryNav";
import { MobileSearchSheet } from "./GlobalSearch";
import { navItems } from "./nav";
import { CommandPalette } from "@/components/CommandPalette";
import { useUi } from "@/stores/ui";
import { useAuth } from "@/stores/auth";
import { useNotify } from "@/stores/notify";
import { useAgentSocket } from "@/hooks/useAgentSocket";
import { agentSocket } from "@/api/realtime";
import { setNotificationNavigator } from "@/lib/notifications";
import { isNative, requestNotificationPermission } from "@/lib/platform";
import { usePushRegistration } from "@/hooks/usePushRegistration";
import { useIsMobile } from "@/hooks/useMediaQuery";
import i18n from "@/lib/i18n";
import type { WsEvent } from "@/types";

/** 舊版後端 payload 沒帶 handler_staff_id 時,從會話列表快取判斷該會話是否由我負責。 */
function sessionAssignedTo(qc: QueryClient, sessionId: string, staffId: string): boolean {
  type S = { id?: string; assignee_id?: string };
  const pick = (data: unknown): S[] => {
    if (Array.isArray(data)) return data as S[];
    if (data && typeof data === "object") {
      const d = data as { items?: unknown; pages?: unknown[] };
      if (Array.isArray(d.items)) return d.items as S[];
      if (Array.isArray(d.pages)) return d.pages.flatMap((p) => pick(p));
    }
    return [];
  };
  for (const key of [["sessions"], ["sessions-inbox"]]) {
    for (const [, data] of qc.getQueriesData({ queryKey: key })) {
      const hit = pick(data).find((x) => x?.id === sessionId);
      if (hit) return hit.assignee_id === staffId;
    }
  }
  return false;
}

/** 原生殼:本次執行是否已在登入後請求過通知權限。 */
let nativePermissionAsked = false;

/** 應用主框架:窄圖示主欄 + 展開二級側欄 + 頂欄 + 內容區
 *  手機版面(< md):圖示欄 / 二級側欄隱藏,改為 頂欄 + 二級 chip 列 + 內容 + 底部分頁列,導覽收進抽屜;
 *  /workspace/:sessionId 進入沉浸模式(隱藏頂欄與分頁列,由對話標頭兼當頂欄)。≥ md 維持原樣。 */
export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { sidebarExpanded, setSidebarExpanded } = useUi();
  const staffId = useAuth((s) => s.staff?.staff_id);
  const qc = useQueryClient();
  const isMobile = useIsMobile();

  // ⌘K / Ctrl+K 全域命令列面板開關
  const [cmdkOpen, setCmdkOpen] = useState(false);

  // 手機導覽抽屜 / 全螢幕搜尋:記下開啟當下的 location.key,導頁(key 改變)即自動關閉;
  // 視窗拉寬到 ≥ md 時也一併關閉(兩者只屬於手機版面)。
  const [navOpenAt, setNavOpenAt] = useState<string | null>(null);
  const [searchOpenAt, setSearchOpenAt] = useState<string | null>(null);
  const navOpen = isMobile && navOpenAt === location.key;
  const searchOpen = isMobile && searchOpenAt === location.key;

  // 沉浸模式:手機上開著單一會話時,頂欄與底部分頁列讓位給對話畫面(純 CSS 判斷寬度,不影響 ≥ md)
  const immersive = useMatch("/workspace/:sessionId") !== null;

  // 掛載一次全域坐席 WebSocket(整站共用):只負責資料層快取更新;通知由下方監聽統一觸達。
  useAgentSocket();

  // 手機 App:登入後登記推播裝置;點擊推播 / 本機通知 → 導向對應會話
  usePushRegistration();

  // 原生殼:系統通知預設開啟,登入後請求一次權限(拒絕則關閉開關,與 TopBar 開關行為一致)
  useEffect(() => {
    if (!isNative || !staffId || nativePermissionAsked) return;
    nativePermissionAsked = true;
    if (!useNotify.getState().desktop) return;
    void requestNotificationPermission().then((granted) => {
      if (!granted) useNotify.getState().setDesktop(false);
    });
  }, [staffId]);

  // 桌面通知點擊 → 導向對應會話:注入 react-router 的 navigate。
  useEffect(() => {
    setNotificationNavigator((path) => navigate(path));
    return () => setNotificationNavigator(null);
  }, [navigate]);

  // 全域通知監聽:訂閱坐席 WS(登入後才連線),把「與我相關」的事件轉給 notify store 統一觸達
  // (未讀 + 音效 + 系統通知;stores/notify.notifyEvent 是唯一出口,含 message_id 去重)。
  // 新版後端事件已擴充(docs/NATIVE-CLIENTS.md §4.2);舊 payload 缺欄位時維持舊行為。
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
        preview?: string;
        message_id?: string;
        id?: string;
        handler_staff_id?: string | null;
        assignee_staff_id?: string;
        actor?: string;
        action?: string;
        from_staff_id?: string | null;
        mentioned_staff_ids?: string[];
        target_staff_id?: string;
        from_staff_name?: string;
        author_name?: string;
        note_id?: string;
        policy_name?: string;
        reason?: string;
      };
      const sid = p.session_id ?? p.sessionId;
      const visitorName = () => p.sender_name ?? i18n.t("native.notify.visitor", { defaultValue: "訪客" });

      switch (type) {
        // 坐席頻道:每則訊息都會發(新版帶 sender_type / handler_staff_id / preview)。
        // 訪客訊息且會話由我負責 → 計未讀 + 通知(notifyEvent 內部處理「正在看且在前景」的抑制)。
        case "session.activity": {
          if (!sid || p.sender_type !== "visitor") break; // 舊版 payload 無 sender_type:不通知
          const mine =
            p.handler_staff_id !== undefined
              ? p.handler_staff_id === staffId
              : sessionAssignedTo(qc, sid, staffId);
          if (!mine) break;
          notify.notifyEvent("message", {
            sessionId: sid,
            from: visitorName(),
            text: p.preview ?? p.content,
            messageId: p.message_id,
            pushed: true, // 伺服器也會推給負責坐席
          });
          break;
        }
        // 會話頻道(只有正在開著的會話):訪客訊息走同一出口,與 session.activity 以 message_id 去重;
        // 其他坐席在共享會話的新訊息(sender_type=human、非我本人)也提醒。
        case "message.new": {
          if (!sid) break;
          const msgId = p.message_id ?? p.id;
          if (p.sender_type === "visitor") {
            notify.notifyEvent("message", {
              sessionId: sid,
              from: visitorName(),
              text: p.content,
              messageId: msgId,
              // 伺服器只把訪客訊息推給負責坐席
              pushed:
                p.handler_staff_id !== undefined
                  ? p.handler_staff_id === staffId
                  : sessionAssignedTo(qc, sid, staffId),
            });
            break;
          }
          if (p.sender_type !== "human") break; // 跳過 ai / system / note
          const from = p.sender_id ?? p.staff_id;
          if (from && from === staffId) break; // 我自己送的不通知
          notify.notifyEvent("message", {
            sessionId: sid,
            from: p.sender_name,
            text: p.content,
            messageId: msgId,
          });
          break;
        }
        // 會話(新建 / 指派)落到「我」名下;actor 為我本人(自己認領)時不通知
        case "session.assigned":
        case "session.new": {
          const handler = p.handler_staff_id ?? p.assignee_staff_id ?? p.staff_id;
          if (handler && handler === staffId && p.actor !== staffId) {
            notify.notifyEvent("assigned", { sessionId: sid, dedupId: sid, pushed: type === "session.assigned" });
          }
          break;
        }
        // 轉接給我(他人操作):新版帶 from_staff_id;接管(takeover)是自己的動作,不通知
        case "handoff": {
          if (!sid || !p.handler_staff_id || p.handler_staff_id !== staffId) break;
          if (p.action && p.action !== "transfer") break;
          if (p.from_staff_id && p.from_staff_id === staffId) break;
          notify.notifyEvent("assigned", { sessionId: sid, dedupId: sid, pushed: true });
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
        // 其餘(note.new / session.opened / session.closed / typing / presence / pong)
        // 由 useAgentSocket 或各視圖處理,或無需通知。
        default:
          break;
      }
    });
    return () => {
      off();
    };
  }, [staffId, qc]);

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

  const openNav = () => setNavOpenAt(location.key);

  return (
    // h-full(非 100vh):跟著 #root 高度,手機鍵盤彈出 / 網址列伸縮時不會被裁切。
    // safe-area:左右一律內縮(橫向瀏海);≥ md 上下也內縮(iPad App 狀態列 / Home 指示條)。
    // 桌面瀏覽器與桌面殼的 safe-area 皆為 0,版面與原本相同;< md 的上下由頂欄 / 分頁列 / 對話畫面自行延伸處理。
    <div className="flex h-full w-full overflow-hidden bg-background ps-safe pe-safe md:pt-safe md:pb-safe">
      {/* contents:≥ md 不產生額外盒子,排版與原本完全相同;< md 整個隱藏 */}
      <div className="contents max-md:hidden">
        <IconRail />
        {hasSecondary && (
          <SecondarySidebar section={section} onCollapse={() => setSidebarExpanded(false)} />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 沉浸模式:TopBar 只以 CSS 隱藏(保持掛載,未讀角標 / 標題閃爍效果照常) */}
        <TopBar
          onToggleSidebar={() => setSidebarExpanded(!sidebarExpanded)}
          onOpenMobileNav={openNav}
          onOpenSearch={() => setSearchOpenAt(location.key)}
          className={immersive ? "max-md:hidden" : undefined}
        />
        {/* 沉浸模式的上方 safe-area 由對話標頭自行延伸(ConversationView:max-md:pt-safe),此處不重複 */}
        <MobileSecondaryNav section={section} />
        {/* max-md:relative:手機上讓工作台對話疊層(absolute inset-0)以內容區為定位基準 */}
        <main className="min-h-0 flex-1 overflow-hidden max-md:relative">
          <Outlet />
        </main>
        {!immersive && <MobileTabBar onOpenMore={openNav} />}
      </div>
      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />
      <MobileNavDrawer open={navOpen} onOpenChange={(o) => setNavOpenAt(o ? location.key : null)} />
      <MobileSearchSheet open={searchOpen} onOpenChange={(o) => setSearchOpenAt(o ? location.key : null)} />
    </div>
  );
}
