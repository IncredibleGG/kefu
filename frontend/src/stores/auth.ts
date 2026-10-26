import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/config";
import type { Staff } from "@/types";
import { authApi } from "@/api/endpoints";
import { setUnauthorizedHandler } from "@/api/client";
import { agentSocket } from "@/api/realtime";
import { queryClient } from "@/lib/query";
import { apiUrl, clearToken, getToken, registerServerSwitchHooks, setToken } from "@/lib/server";
import { getDeviceId, setBadge } from "@/lib/platform";
import { useNotify } from "@/stores/notify";

/** 撤銷推播裝置的逾時(登出不可被網路卡住)。 */
const DEVICE_REVOKE_TIMEOUT_MS = 3000;

interface LogoutOptions {
  /** 是否先向後端撤銷本裝置推播登記(預設 true;401 觸發的登出 token 已失效,略過)。 */
  revokeDevice?: boolean;
}

interface AuthState {
  token: string | null;
  staff: Staff | null;
  /** 平台超級管理員旗標:僅登入回應帶回(/me 不含),故於登入時記住並持久化。
   *  用於守衛 /platform 一級路由與帳號選單入口。 */
  isPlatformAdmin: boolean;
  status: "idle" | "loading" | "authed" | "error";
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  loadMe: () => Promise<void>;
  /** 登出:本地狀態同步清除(呼叫端可立即導向 /login);回傳的 Promise 在裝置撤銷請求結束後 resolve。 */
  logout: (opts?: LogoutOptions) => Promise<void>;
}

/**
 * 取目前坐席角色的 selector:一律用這個,不要寫 `useAuth((s) => s.staff?.roles ?? [])`。
 * Zustand v5 以參照比較 selector 結果;`?? []` 在 staff 尚未載入(或沒有 roles)時每次都回傳
 * 新陣列,會被當成狀態改變而無限重繪(React error #185 Maximum update depth exceeded)。
 * 這裡回傳模組層級的同一個空陣列,參照穩定。
 */
const EMPTY_ROLES: string[] = [];
export const selectRoles = (s: AuthState): string[] => s.staff?.roles ?? EMPTY_ROLES;

/**
 * 後端換發 access token(自助改密 / 本人於 IAM 改密 / 2FA 啟用或停用):伺服器已撤銷變更前
 * 簽發的所有 token,本次 session 改用新 token 續用,並讓即時連線以新 token 重連。
 * 回應未帶 token(mock / 舊版伺服器 / 管理員改他人密碼)則不動作。
 */
export function adoptRotatedToken(token: string | null | undefined): void {
  if (!token) return;
  setToken(token);
  useAuth.setState({ token });
  agentSocket.refreshToken();
}

/* --------------------------- 推播裝置登記標記 --------------------------- */
/** usePushRegistration 成功 POST /devices 後呼叫;登出時據此撤銷。 */
export function markDeviceRegistered(): void {
  try {
    localStorage.setItem(STORAGE_KEYS.deviceRegistered, "1");
  } catch {
    /* 忽略 */
  }
}

function takeDeviceRegistered(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.deviceRegistered) === "1";
    localStorage.removeItem(STORAGE_KEYS.deviceRegistered);
    return v;
  } catch {
    return false;
  }
}

/** DELETE /api/v1/devices/{device_id}(盡力而為、短逾時;用原生 fetch 避免 401 再觸發登出)。 */
async function revokeDevice(token: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEVICE_REVOKE_TIMEOUT_MS);
  try {
    await fetch(apiUrl(`/api/v1/devices/${encodeURIComponent(getDeviceId())}`), {
      method: "DELETE",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
  } catch {
    /* 忽略:裝置之後會因 token 失效 / 重新登記而被覆蓋 */
  } finally {
    clearTimeout(timer);
  }
}

let loggingOut = false;

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      // token 的事實來源是 lib/server(kefu-token + 原生儲存);store 只保留同步副本供路由守衛訂閱
      token: getToken(),
      staff: null,
      isPlatformAdmin: false,
      status: "idle",
      error: null,

      async login(email, password) {
        set({ status: "loading", error: null });
        try {
          const res = await authApi.login(email, password);
          // token 寫入 lib/server(localStorage + 原生儲存,供 api client / WS 讀取)
          setToken(res.access_token);
          // 先載入 /me 再一次寫入 token + staff(理由同 api/authExtra.finalizeSession:
          // 避免路由在 staff 為 null 時就依 token 導向)
          try {
            await get().loadMe();
          } catch (meErr) {
            clearToken();
            throw meErr;
          }
          // is_platform_admin 僅登入回應帶回;記住並持久化(/me 不含此欄位)
          set({ token: res.access_token, isPlatformAdmin: Boolean(res.is_platform_admin), status: "authed" });
        } catch (e) {
          set({ status: "error", error: e instanceof Error ? e.message : "登入失敗" });
          throw e;
        }
      },

      async loadMe() {
        const me = await authApi.me();
        set({ staff: me });
      },

      logout(opts = {}) {
        if (loggingOut) return Promise.resolve();
        loggingOut = true;
        try {
          const token = getToken();
          const registered = takeDeviceRegistered();
          // 先送出撤銷請求(帶目前 token),再清 token;本地狀態同步清除,不等網路
          const revoke =
            opts.revokeDevice !== false && registered && token ? revokeDevice(token) : Promise.resolve();
          clearToken();
          set({ token: null, staff: null, isPlatformAdmin: false, status: "idle", error: null });
          // 清掉上一位使用者的未讀、快取、角標與即時連線
          useNotify.setState({ unread: {}, activeSessionId: null });
          agentSocket.disconnect();
          queryClient.clear();
          void setBadge(0);
          return revoke;
        } finally {
          loggingOut = false;
        }
      },
    }),
    {
      name: STORAGE_KEYS.auth,
      // token 不再寫進 kefu-auth(單一來源在 lib/server);還原時一律以 getToken() 為準
      partialize: (s) => ({ staff: s.staff, isPlatformAdmin: s.isPlatformAdmin }),
      merge: (persisted, current) => ({
        ...current,
        ...((persisted as Partial<AuthState> | undefined) ?? {}),
        token: getToken(),
      }),
    },
  ),
);

/**
 * initPlatform() 把原生儲存的 token 讀回 localStorage 之後呼叫:讓 store 與 lib/server 的 token 一致
 * (store 建立時原生值可能尚未載入)。token 不一致時以 lib/server 為準。
 */
export function syncAuthToken(): void {
  const t = getToken();
  const s = useAuth.getState();
  if (s.token === t) return;
  useAuth.setState(t ? { token: t } : { token: null, staff: null, isPlatformAdmin: false });
}

// 換伺服器(lib/server.setServerBase):舊伺服器上登出 → 清空登入狀態 / 快取 / 即時連線
registerServerSwitchHooks({
  logout: () => useAuth.getState().logout(),
  reset: () => {
    useAuth.setState({ token: null, staff: null, isPlatformAdmin: false, status: "idle", error: null });
    useNotify.setState({ unread: {}, activeSessionId: null });
    queryClient.clear();
    agentSocket.disconnect();
  },
});

// api client 401 → 自動登出(觸發路由守衛導回 /login);token 已失效,不必撤銷裝置
setUnauthorizedHandler(() => {
  void useAuth.getState().logout({ revokeDevice: false });
});
