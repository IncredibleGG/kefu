/** Android 返回鍵處理(docs/NATIVE-CLIENTS.md §5):
 *  1) 關閉最上層 Radix 浮層(Dialog / Sheet / Popover / DropdownMenu / Select…)— 對它 dispatch Escape;
 *  2) 否則可返回時 history.back();
 *  3) 否則縮小 App(不直接結束,保留 WS 與登入狀態)。
 *  由 lib/platform/capacitor.ts 的 App.addListener("backButton") 呼叫。 */

/** Radix 開啟中的浮層選擇器(依 DOM 順序,後出現者在上層)。 */
const OPEN_LAYER_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  "[data-radix-popper-content-wrapper] [data-state=\"open\"]",
].join(",");

/** 嘗試關閉最上層浮層;有關閉回 true。 */
export function closeTopLayer(): boolean {
  if (typeof document === "undefined") return false;
  const layers = document.querySelectorAll<HTMLElement>(OPEN_LAYER_SELECTOR);
  if (!layers.length) return false;
  const top = layers[layers.length - 1];
  // Radix DismissableLayer 在 document 監聽 keydown Escape,且只關閉最上層
  const ev = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  } as KeyboardEventInit);
  top.dispatchEvent(ev);
  return true;
}

/** react-router 會在 history.state.idx 記錄目前位置索引;>0 代表 App 內還有上一頁。 */
function routerCanGoBack(): boolean | null {
  try {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    return typeof idx === "number" ? idx > 0 : null;
  } catch {
    return null;
  }
}

/**
 * 返回鍵主流程。
 * @param canGoBack WebView 回報的是否可返回(Capacitor BackButtonListenerEvent.canGoBack)
 * @param minimize  縮小 App(App.minimizeApp)
 */
export async function handleBackButton(canGoBack: boolean, minimize: () => Promise<void>): Promise<void> {
  if (closeTopLayer()) return;
  // 有 router 索引時以它為準(避免退回已被 replace 的登入頁等);沒有時才採用 WebView 的判斷
  const routerBack = routerCanGoBack();
  if (routerBack ?? canGoBack) {
    window.history.back();
    return;
  }
  try {
    await minimize();
  } catch {
    /* 忽略 */
  }
}
