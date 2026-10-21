import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "@/api/client";
import { markDeviceRegistered, useAuth } from "@/stores/auth";
import {
  appVersion,
  getDeviceId,
  isMobileApp,
  onPushTap,
  os,
  osVersion,
  pushRegister,
} from "@/lib/platform";
import i18n from "@/lib/i18n";

/**
 * 推播登記(掛在 AppLayout,登入後每次掛載 / 換人登入各登記一次;後端為 upsert):
 * - 手機 App:pushRegister() 取得 token 後 POST /api/v1/devices
 *   {token, platform, device_id, app_version, os_version?, locale};任何失敗一律忽略
 *   (沒有 Firebase 設定 / 使用者拒絕 / 伺服器舊版沒有此端點)。
 * - 點擊推播或本機通知 → 導向 /workspace/{session_id}。
 */
export function usePushRegistration(): void {
  const navigate = useNavigate();
  const token = useAuth((s) => s.token);
  const staffId = useAuth((s) => s.staff?.staff_id);

  useEffect(() => {
    return onPushTap((data) => {
      const sid = data?.session_id;
      if (sid) navigate(`/workspace/${encodeURIComponent(sid)}`);
    });
  }, [navigate]);

  useEffect(() => {
    if (!isMobileApp || !token || !staffId) return;
    let cancelled = false;
    void (async () => {
      const res = await pushRegister();
      if (!res?.token || cancelled) return;
      try {
        await apiFetch<{ id: string; push_enabled: boolean }>("/api/v1/devices", {
          method: "POST",
          body: {
            token: res.token,
            platform: os === "ios" ? "ios" : "android",
            device_id: getDeviceId(),
            app_version: appVersion,
            os_version: osVersion || undefined,
            locale: i18n.language || undefined,
          },
        });
        markDeviceRegistered();
      } catch {
        /* 忽略:舊版伺服器 / 網路錯誤;下次登入再試 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, staffId]);
}
