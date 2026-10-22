/** 平台 adapter:Capacitor 8 手機(iOS / Android)。所有 Capacitor 外掛一律在此動態 import。
 *  - 推播:@capacitor/push-notifications。Android 在沒有 google-services.json 時呼叫 register()
 *    會讓原生端拋 IllegalStateException 直接閃退,故需建置旗標 VITE_FCM_ENABLED=on 才會註冊。
 *  - 本機通知頻道:kefu_messages(Android 8+ 必須先建頻道)。 */
import type { Adapter, NativeKey, OsKind } from "./index";
import { handleBackButton } from "@/lib/mobile/backButton";
import i18n from "@/lib/i18n";

const CHANNEL_ID = "kefu_messages";
const PUSH_TIMEOUT_MS = 15_000;

// Android 原生外掛(frontend/android/.../KefuNativePlugin.java):回報是否注入了 google-services.json。
// 只註冊一次;iOS 沒有這個外掛,呼叫會以 UNIMPLEMENTED 拒絕。
type KefuNativePlugin = { getInfo(): Promise<{ firebaseConfigured: boolean; messagesChannelId?: string }> };
let kefuNative: KefuNativePlugin | null = null;
async function firebaseConfigured(): Promise<boolean> {
  try {
    if (!kefuNative) {
      const { registerPlugin } = await import("@capacitor/core");
      kefuNative = registerPlugin<KefuNativePlugin>("KefuNative");
    }
    return (await kefuNative.getInfo())?.firebaseConfigured === true;
  } catch {
    return false;
  }
}

/** tag → 正 32 位元整數通知 id(同 tag 會覆蓋同一則通知,不堆疊刷屏)。 */
function idFromTag(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (Math.imul(31, h) + tag.charCodeAt(i)) | 0;
  return (h & 0x7fffffff) || 1;
}

/** 物件值全部轉成字串(push data / notification extra 交給上層一律 Record<string,string>)。 */
function toStringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val != null) out[k] = typeof val === "string" ? val : String(val);
    }
  }
  return out;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.readAsDataURL(blob);
  });
}

function parseOsVersion(os: OsKind): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (os === "android") return /Android\s+([\d.]+)/i.exec(ua)?.[1] ?? "";
  if (os === "ios") return (/OS\s+(\d+(?:_\d+)*)/i.exec(ua)?.[1] ?? "").replace(/_/g, ".");
  return "";
}

export function createCapacitorAdapter(): Adapter {
  let fg = typeof document === "undefined" || document.visibilityState === "visible";
  let os: OsKind = "android";
  let channelReady: Promise<void> | null = null;

  async function ensureChannel(): Promise<void> {
    if (os !== "android") return;
    if (!channelReady) {
      channelReady = (async () => {
        const { LocalNotifications } = await import("@capacitor/local-notifications");
        await LocalNotifications.createChannel({
          id: CHANNEL_ID,
          name: i18n.t("native.notify.channelName", { defaultValue: "訊息通知" }),
          description: i18n.t("native.notify.channelDesc", { defaultValue: "新訊息、指派與轉接提醒" }),
          importance: 4,
          vibration: true,
        });
      })().catch(() => {
        channelReady = null;
      });
    }
    await channelReady;
  }

  return {
    async init(hooks) {
      const { Capacitor } = await import("@capacitor/core");
      const p = Capacitor.getPlatform();
      os = p === "ios" ? "ios" : "android";
      const result: Awaited<ReturnType<Adapter["init"]>> = { os, osVersion: parseOsVersion(os), storage: {} };

      // 1) 原生持久儲存
      try {
        const { Preferences } = await import("@capacitor/preferences");
        for (const key of ["server", "token", "deviceId"] as NativeKey[]) {
          try {
            const { value } = await Preferences.get({ key });
            result.storage![key] = value;
          } catch {
            /* 單鍵失敗略過 */
          }
        }
      } catch {
        /* 外掛不可用 */
      }

      // 2) App:版本、前景狀態、deep link、返回鍵
      try {
        const { App } = await import("@capacitor/app");
        try {
          result.appVersion = (await App.getInfo()).version;
        } catch {
          /* 忽略 */
        }
        try {
          fg = (await App.getState()).isActive;
        } catch {
          /* 忽略 */
        }
        await App.addListener("appStateChange", ({ isActive }) => {
          fg = isActive;
          hooks.refreshForeground();
        });
        await App.addListener("appUrlOpen", ({ url }) => hooks.emitDeepLink(url));
        await App.addListener("backButton", ({ canGoBack }) => {
          void handleBackButton(canGoBack, () => App.minimizeApp());
        });
        try {
          const launch = await App.getLaunchUrl();
          if (launch?.url) hooks.emitDeepLink(launch.url);
        } catch {
          /* 忽略 */
        }
      } catch {
        /* 忽略 */
      }

      // 3) 網路恢復 → 立即重連
      try {
        const { Network } = await import("@capacitor/network");
        await Network.addListener("networkStatusChange", ({ connected }) => {
          if (connected) hooks.emitOnline();
        });
      } catch {
        /* 忽略 */
      }

      // 4) 點擊本機通知 / 推播 → 交給 onPushTap(導向 /workspace/{session_id})
      try {
        const { LocalNotifications } = await import("@capacitor/local-notifications");
        await LocalNotifications.addListener("localNotificationActionPerformed", (a) => {
          const extra = toStringRecord(a.notification?.extra);
          if (extra.session_id) hooks.emitPushTap({ type: extra.type ?? "message", ...extra });
        });
      } catch {
        /* 忽略 */
      }
      try {
        const { PushNotifications } = await import("@capacitor/push-notifications");
        // 只掛監聽不呼叫 register(),不會觸發 Firebase 初始化
        await PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
          hooks.emitPushTap(toStringRecord(a.notification?.data));
        });
      } catch {
        /* 忽略 */
      }

      // 5) 狀態列配色跟隨主題(<html class="dark">)
      try {
        const { StatusBar, Style } = await import("@capacitor/status-bar");
        const apply = () => {
          const dark = document.documentElement.classList.contains("dark");
          void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => undefined);
        };
        apply();
        new MutationObserver(apply).observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });
      } catch {
        /* 忽略 */
      }

      // 6) 鍵盤彈出 → 把聚焦的輸入框捲進可視範圍
      try {
        const { Keyboard } = await import("@capacitor/keyboard");
        await Keyboard.addListener("keyboardDidShow", () => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return;
          const editable =
            el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
          if (editable) {
            setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
          }
        });
      } catch {
        /* 忽略 */
      }

      return result;
    },

    async storageSet(key, value) {
      const { Preferences } = await import("@capacitor/preferences");
      if (value == null) await Preferences.remove({ key });
      else await Preferences.set({ key, value });
    },

    notificationSupported: () => true,

    async getNotificationPermission() {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const { display } = await LocalNotifications.checkPermissions();
      if (display === "granted") return "granted";
      if (display === "denied") return "denied";
      return "default";
    },

    async requestNotificationPermission() {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      let { display } = await LocalNotifications.checkPermissions();
      if (display !== "granted" && display !== "denied") {
        display = (await LocalNotifications.requestPermissions()).display;
      }
      if (display === "granted") void ensureChannel();
      return display === "granted";
    },

    async notify(o) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const { display } = await LocalNotifications.checkPermissions();
      if (display !== "granted") return false;
      await ensureChannel();
      const tag = o.tag || o.sessionId || o.title;
      await LocalNotifications.schedule({
        notifications: [
          {
            id: idFromTag(tag),
            title: o.title,
            body: o.body ?? "",
            channelId: os === "android" ? CHANNEL_ID : undefined,
            threadIdentifier: o.sessionId,
            group: o.sessionId,
            extra: o.sessionId ? { type: "message", session_id: o.sessionId } : undefined,
          },
        ],
      });
      return true;
    },

    async setBadge(count) {
      const { Badge } = await import("@capawesome/capacitor-badge");
      if (count > 0) await Badge.set({ count });
      else await Badge.clear();
    },

    isAppForeground: () => fg && (typeof document === "undefined" || document.visibilityState === "visible"),

    async openExternal(url) {
      if (/^https?:/i.test(url)) {
        const { Browser } = await import("@capacitor/browser");
        await Browser.open({ url });
      } else {
        // mailto: / tel: 交給系統處理
        window.location.href = url;
      }
    },

    async saveFile(blob, filename) {
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([
        import("@capacitor/filesystem"),
        import("@capacitor/share"),
      ]);
      const data = await blobToBase64(blob);
      const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
      try {
        await Share.share({ title: filename, files: [uri], dialogTitle: filename });
      } catch (e) {
        // 使用者關閉分享面板不視為錯誤
        const msg = e instanceof Error ? e.message : String(e);
        if (!/cancel/i.test(msg)) throw e;
      }
    },

    async startExternalAuth(url) {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url });
    },

    async pushRegister() {
      // iOS:@capacitor/push-notifications 回傳的是 APNs token,後端走 FCM HTTP v1 用不了;
      // 在 iOS 殼加入 Firebase Messaging(且有付費 Apple 帳號簽章)之前不註冊,也不跳推播權限詢問。
      if (os === "ios") return null;
      // Android 未注入 google-services.json 時 register() 會原生閃退(JS 接不住):
      // 建置旗標 + 執行期向原生外掛確認,兩層都通過才註冊。
      if (os === "android") {
        if (import.meta.env.VITE_FCM_ENABLED !== "on") return null;
        if (!(await firebaseConfigured())) return null;
      }
      const { PushNotifications } = await import("@capacitor/push-notifications");
      return await new Promise<{ token: string } | null>((resolve) => {
        let done = false;
        const handles: { remove: () => Promise<void> }[] = [];
        const finish = (v: { token: string } | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          handles.forEach((h) => void h.remove().catch(() => undefined));
          resolve(v);
        };
        const timer = setTimeout(() => finish(null), PUSH_TIMEOUT_MS);
        void (async () => {
          try {
            let perm = await PushNotifications.checkPermissions();
            if (perm.receive !== "granted" && perm.receive !== "denied") {
              perm = await PushNotifications.requestPermissions();
            }
            if (perm.receive !== "granted") return finish(null);
            handles.push(
              await PushNotifications.addListener("registration", (t) =>
                finish(t?.value ? { token: t.value } : null),
              ),
            );
            handles.push(await PushNotifications.addListener("registrationError", () => finish(null)));
            await PushNotifications.register();
          } catch {
            finish(null);
          }
        })();
      });
    },

    appReady() {
      void import("@capacitor/splash-screen")
        .then(({ SplashScreen }) => SplashScreen.hide())
        .catch(() => undefined);
    },
  };
}
