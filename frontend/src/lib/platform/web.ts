/** 平台 adapter:瀏覽器(沿用既有行為:Notification API、分頁標題未讀、新分頁開連結、<a download> 存檔)。 */
import type { Adapter } from "./index";
import {
  notificationSupported as webNotificationSupported,
  notificationPermission,
  requestNotificationPermission as webRequestPermission,
} from "@/lib/notify";
import { pushDesktopNotification } from "@/lib/notifications";

export function createWebAdapter(): Adapter {
  return {
    async init() {
      return {};
    },
    async storageSet() {
      /* web 不使用原生儲存 */
    },
    notificationSupported: () => webNotificationSupported(),
    async getNotificationPermission() {
      const p = notificationPermission();
      if (p === "granted") return "granted";
      if (p === "denied" || p === "unsupported") return "denied";
      return "default";
    },
    async requestNotificationPermission() {
      return (await webRequestPermission()) === "granted";
    },
    async notify(o) {
      // 前景分頁 / 未授權時 pushDesktopNotification 內部會略過
      return pushDesktopNotification({ title: o.title, body: o.body, tag: o.tag, sessionId: o.sessionId });
    },
    async setBadge() {
      /* web 由 TopBar 的 setTitleUnread 顯示未讀(分頁標題),此處不動作 */
    },
    isAppForeground: () => typeof document === "undefined" || document.visibilityState === "visible",
    async openExternal(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    async saveFile(blob, filename) {
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 延後釋放:部分瀏覽器在 click 後同步 revoke 會取消下載
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    },
    async startExternalAuth(url) {
      window.location.href = url;
    },
    async pushRegister() {
      return null;
    },
  };
}
