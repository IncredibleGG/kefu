/**
 * 桌面通知(Browser Notification API)封裝。
 *
 * 定位:純副作用工具。是否「該」彈桌面通知(使用者在 notify store 的桌面開關)
 * 由呼叫端(stores/notify.ts 的 notifyEvent)決定並先行判斷;本模組只負責
 * 「在允許的情況下把通知彈出來」,不讀寫偏好狀態,避免與 store 形成循環相依。
 *
 * 規則:
 * - 權限沿用 TopBar 於使用者手勢時取得的授權(這裡只讀狀態,不主動請求)。
 * - 前景分頁時不打擾(未讀徽章 + 標題閃爍已足夠),僅在分頁隱藏 / 失焦時彈出。
 * - 點擊:聚焦視窗並導向對應會話(/workspace/{sessionId}),或執行自訂 onClick。
 *
 * 提示音沿用既有 lib/notify.ts 的 playPing(由 store 依音效開關觸發),本模組不重複實作。
 */
import { notificationSupported, notificationPermission } from "@/lib/notify";

/** 導頁函式:由 AppLayout 於掛載時注入 react-router 的 navigate,使點擊可導頁。 */
type NavigateFn = (path: string) => void;
let _navigate: NavigateFn | null = null;

/** 註冊 / 解除導頁函式(AppLayout 掛載時注入,卸載時清除)。 */
export function setNotificationNavigator(fn: NavigateFn | null): void {
  _navigate = fn;
}

/** App 圖示(桌面通知左側),沿用網站 favicon。 */
const APP_ICON = "/favicon.svg";

export interface DesktopNotifyInput {
  /** 通知標題(必填)。 */
  title: string;
  /** 內文摘要。 */
  body?: string;
  /** 同 tag 的通知會相互覆蓋(同一會話多則不堆疊刷屏)。 */
  tag?: string;
  /** 點擊後導向的會話;有值且未指定 onClick 時導到 /workspace/{sessionId}。 */
  sessionId?: string;
  /** 自訂點擊行為(優先於 sessionId 導頁)。 */
  onClick?: () => void;
}

/**
 * 彈出一則桌面通知(需瀏覽器支援且已授權)。
 * 未支援 / 未授權 / 分頁在前景 → 靜默略過並回傳 false;實際彈出回傳 true。
 */
export function pushDesktopNotification(input: DesktopNotifyInput): boolean {
  if (!notificationSupported() || notificationPermission() !== "granted") return false;
  // 分頁在前景時不打擾(避免與正在操作的坐席重複干擾)
  if (typeof document !== "undefined" && document.visibilityState === "visible") return false;
  try {
    const n = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      icon: APP_ICON,
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* 忽略 */
      }
      if (input.onClick) input.onClick();
      else if (input.sessionId && _navigate) _navigate(`/workspace/${input.sessionId}`);
      n.close();
    };
    return true;
  } catch {
    /* 部分環境建立 Notification 會丟例外,靜默略過 */
    return false;
  }
}
