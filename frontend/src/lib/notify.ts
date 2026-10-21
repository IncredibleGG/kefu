/**
 * 通知副作用工具:提示音(WebAudio,免資產)、瀏覽器桌面通知(需授權一次)、
 * 分頁標題未讀閃爍。皆為純副作用,狀態/偏好在 stores/notify.ts。
 */

/* ----------------------------- 提示音 ----------------------------- */
let _audioCtx: AudioContext | null = null;

/** 播放一段短促「叮」提示音。用 WebAudio 合成,不需音檔資產。 */
export function playPing() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    _audioCtx = _audioCtx ?? new Ctx();
    const ctx = _audioCtx;
    // 使用者手勢後才可 resume;失敗則靜默
    if (ctx.state === "suspended") void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    /* 忽略:部分環境無 WebAudio 或被策略擋下 */
  }
}

/* --------------------------- 桌面通知 --------------------------- */

/** 是否支援瀏覽器 Notification。 */
export function notificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** 目前授權狀態。 */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationSupported()) return "unsupported";
  return Notification.permission;
}

/**
 * 請求桌面通知授權(僅在 default 狀態下彈一次)。回傳最終權限。
 * 必須由使用者手勢觸發(如點開通知開關),否則瀏覽器可能忽略。
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** 顯示一則桌面通知(已授權時)。點擊聚焦視窗並可選導頁。 */
export function showDesktopNotification(
  title: string,
  body: string,
  opts: { tag?: string; onClick?: () => void } = {},
) {
  if (!notificationSupported() || Notification.permission !== "granted") return;
  // 分頁在前景時不打擾(未讀閃爍已足夠)
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  try {
    const n = new Notification(title, { body, tag: opts.tag });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* 忽略 */
  }
}

/* --------------------------- 標題閃爍 --------------------------- */
let _flashTimer: ReturnType<typeof setInterval> | null = null;
let _baseTitle = typeof document !== "undefined" ? document.title : "";

/** 開始/更新分頁標題未讀閃爍。count<=0 或分頁回前景時停止。 */
export function setTitleUnread(count: number) {
  if (typeof document === "undefined") return;
  if (count <= 0 || document.visibilityState === "visible") {
    stopTitleFlash();
    return;
  }
  const badge = `(${count}) `;
  if (_flashTimer) clearInterval(_flashTimer);
  let on = false;
  _flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? `🔴 ${badge}${_baseTitle}` : `${badge}${_baseTitle}`;
  }, 1000);
  // 立即先顯示一次
  document.title = `${badge}${_baseTitle}`;
}

/** 停止閃爍並還原標題。 */
export function stopTitleFlash() {
  if (_flashTimer) {
    clearInterval(_flashTimer);
    _flashTimer = null;
  }
  if (typeof document !== "undefined") document.title = _baseTitle;
}

/** 記錄目前標題為基底(App 掛載後呼叫一次)。 */
export function initTitleBase() {
  if (typeof document !== "undefined") _baseTitle = document.title.replace(/^🔴?\s*(\(\d+\)\s*)?/, "");
}
