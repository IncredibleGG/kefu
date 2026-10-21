/** 平台 adapter:Tauri 2 桌面(Windows / macOS)。所有 Tauri 外掛一律在此動態 import。
 *  桌面 Rust 指令(docs/NATIVE-CLIENTS.md §3):set_unread(count) 更新系統匣 / Dock 角標 / 工作列疊加圖示。 */
import type { Adapter, NativeKey, OsKind } from "./index";

type StoreLike = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
};

const STORE_FILE = "kefu.json";

export function createTauriAdapter(): Adapter {
  let store: StoreLike | null = null;
  let storePromise: Promise<StoreLike | null> | null = null;

  function getStore(): Promise<StoreLike | null> {
    if (store) return Promise.resolve(store);
    if (!storePromise) {
      storePromise = import("@tauri-apps/plugin-store")
        .then(({ load }) => load(STORE_FILE, { defaults: {}, autoSave: 100 }))
        .then((s) => {
          store = s as unknown as StoreLike;
          return store;
        })
        .catch(() => {
          storePromise = null;
          return null;
        });
    }
    return storePromise;
  }

  function foreground(): boolean {
    if (typeof document === "undefined") return true;
    return document.visibilityState === "visible" && document.hasFocus();
  }

  return {
    async init(hooks) {
      const result: Awaited<ReturnType<Adapter["init"]>> = { storage: {} };

      // 1) 原生持久儲存
      const s = await getStore();
      if (s) {
        for (const key of ["server", "token", "deviceId"] as NativeKey[]) {
          try {
            const v = await s.get<string>(key);
            result.storage![key] = typeof v === "string" ? v : null;
          } catch {
            /* 單鍵失敗略過 */
          }
        }
      }

      // 2) 作業系統 / 版本
      try {
        const osMod = await import("@tauri-apps/plugin-os");
        const p = osMod.platform();
        const map: Partial<Record<string, OsKind>> = { windows: "windows", macos: "macos", linux: "linux" };
        result.os = map[p] ?? "linux";
        result.osVersion = osMod.version();
      } catch {
        /* 外掛未啟用:沿用 UA 推測 */
      }
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        result.appVersion = await getVersion();
      } catch {
        /* 忽略 */
      }

      // 3) Deep link:冷啟動帶入的網址 + 執行中收到的網址(single-instance 轉發也走 onOpenUrl)
      try {
        const dl = await import("@tauri-apps/plugin-deep-link");
        await dl.onOpenUrl((urls) => urls.forEach((u) => hooks.emitDeepLink(u)));
        const current = await dl.getCurrent();
        current?.forEach((u) => hooks.emitDeepLink(u));
      } catch {
        /* 外掛未啟用 */
      }

      return result;
    },

    async storageSet(key, value) {
      const s = await getStore();
      if (!s) return;
      if (value == null) await s.delete(key);
      else await s.set(key, value);
      await s.save();
    },

    notificationSupported: () => true,

    async getNotificationPermission() {
      const n = await import("@tauri-apps/plugin-notification");
      return (await n.isPermissionGranted()) ? "granted" : "default";
    },

    async requestNotificationPermission() {
      const n = await import("@tauri-apps/plugin-notification");
      if (await n.isPermissionGranted()) return true;
      return (await n.requestPermission()) === "granted";
    },

    async notify(o) {
      const n = await import("@tauri-apps/plugin-notification");
      if (!(await n.isPermissionGranted())) return false;
      n.sendNotification({ title: o.title, body: o.body });
      return true;
    },

    async setBadge(count) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_unread", { count });
    },

    isAppForeground: foreground,

    async openExternal(url) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },

    async saveFile(blob, filename) {
      const [{ save }, { writeFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const path = await save({ defaultPath: filename });
      if (!path) return; // 使用者取消
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    },

    async startExternalAuth(url) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },

    async pushRegister() {
      // 桌面不使用 FCM:靠常駐系統匣 + WS + 本機通知
      return null;
    },
  };
}
