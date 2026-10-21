import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/config";
import { iamApi } from "@/api/endpoints";
import { useAuth } from "@/stores/auth";
import type { AgentStatus } from "@/types";

type Theme = "light" | "dark";

/** 坐席狀態同步結果碼:交由 UI(TopBar)本地化為訊息,避免在 store 耦合 i18n。 */
export type StatusSyncError = "sync_failed" | "no_staff";

interface UiState {
  theme: Theme;
  agentStatus: AgentStatus;
  /** 坐席狀態是否正在同步後端(PATCH /iam/staff/{id}/status) */
  statusSyncing: boolean;
  /** 狀態同步失敗代碼(null=無錯誤);供 UI 明確回饋,不靜默 */
  statusError: StatusSyncError | null;
  sidebarExpanded: boolean; // 二級側欄是否展開
  rightPanelCollapsed: boolean; // 工作台右欄折疊
  rightPanelWidth: number; // 可拖曳寬度
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  setAgentStatus: (s: AgentStatus) => void;
  clearStatusError: () => void;
  setSidebarExpanded: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setRightPanelWidth: (w: number) => void;
}

function applyTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem(STORAGE_KEYS.theme, t);
  } catch {
    /* ignore */
  }
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme:
        (typeof document !== "undefined" && document.documentElement.classList.contains("dark")
          ? "dark"
          : "light") as Theme,
      agentStatus: "online",
      statusSyncing: false,
      statusError: null,
      sidebarExpanded: true,
      rightPanelCollapsed: false,
      rightPanelWidth: 340,

      toggleTheme() {
        const next: Theme = get().theme === "dark" ? "light" : "dark";
        applyTheme(next);
        set({ theme: next });
      },
      setTheme(t) {
        applyTheme(t);
        set({ theme: t });
      },
      setAgentStatus(s) {
        const prev = get().agentStatus;
        if (prev === s) return;
        // 樂觀更新本地 UI,同時把狀態同步到後端:讓 Staff.status 真的改變,
        // 智慧路由(依線上/忙碌挑坐席)才選得到人;不再是純前端 no-op。
        set({ agentStatus: s, statusSyncing: true, statusError: null });
        const staffId = useAuth.getState().staff?.staff_id;
        if (!staffId) {
          // 尚未登入 / 取不到坐席身分:無法同步後端 → 回滾並明確回饋(不靜默)
          set({ agentStatus: prev, statusSyncing: false, statusError: "no_staff" });
          return;
        }
        void iamApi
          .setStaffStatus(staffId, s)
          .then(() => set({ statusSyncing: false, statusError: null }))
          .catch(() =>
            // 後端切換失敗 → 回滾本地顯示避免與後端不一致,並回饋錯誤
            set({ agentStatus: prev, statusSyncing: false, statusError: "sync_failed" }),
          );
      },
      clearStatusError() {
        set({ statusError: null });
      },
      setSidebarExpanded(v) {
        set({ sidebarExpanded: v });
      },
      setRightPanelCollapsed(v) {
        set({ rightPanelCollapsed: v });
      },
      setRightPanelWidth(w) {
        set({ rightPanelWidth: Math.min(600, Math.max(280, w)) });
      },
    }),
    {
      name: STORAGE_KEYS.ui,
      partialize: (s) => ({
        theme: s.theme,
        agentStatus: s.agentStatus,
        sidebarExpanded: s.sidebarExpanded,
        rightPanelCollapsed: s.rightPanelCollapsed,
        rightPanelWidth: s.rightPanelWidth,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);
