import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/config";
import type { Staff } from "@/types";
import { authApi } from "@/api/endpoints";
import { setUnauthorizedHandler } from "@/api/client";

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
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      staff: null,
      isPlatformAdmin: false,
      status: "idle",
      error: null,

      async login(email, password) {
        set({ status: "loading", error: null });
        try {
          const res = await authApi.login(email, password);
          // token 同步寫入 localStorage(供 api client 讀取)
          localStorage.setItem(STORAGE_KEYS.token, res.access_token);
          // is_platform_admin 僅登入回應帶回;記住並持久化(/me 不含此欄位)
          set({ token: res.access_token, isPlatformAdmin: Boolean(res.is_platform_admin) });
          await get().loadMe();
          set({ status: "authed" });
        } catch (e) {
          set({ status: "error", error: e instanceof Error ? e.message : "登入失敗" });
          throw e;
        }
      },

      async loadMe() {
        const me = await authApi.me();
        set({ staff: me });
      },

      logout() {
        localStorage.removeItem(STORAGE_KEYS.token);
        set({ token: null, staff: null, isPlatformAdmin: false, status: "idle", error: null });
      },
    }),
    {
      name: STORAGE_KEYS.auth,
      partialize: (s) => ({ token: s.token, staff: s.staff, isPlatformAdmin: s.isPlatformAdmin }),
    },
  ),
);

// api client 401 → 自動登出(觸發路由守衛導回 /login)
setUnauthorizedHandler(() => {
  useAuth.getState().logout();
});
