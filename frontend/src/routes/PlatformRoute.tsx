import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/stores/auth";

/**
 * 平台超管路由守衛(一級路由 /platform 專用):
 * - 無 token → 導回登入。
 * - 有 token 但尚未載入 /me → 補抓一次(與 ProtectedRoute 一致)。
 * - 非 is_platform_admin → 導回首頁(一般坐席不得進入平台後台)。
 * is_platform_admin 由登入時記入 auth store 並持久化(/me 不含此欄位)。
 */
export function PlatformRoute() {
  const { token, staff, isPlatformAdmin, loadMe } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (token && !staff) {
      void loadMe().catch(() => {
        /* 401 由 client 統一處理 */
      });
    }
  }, [token, staff, loadMe]);

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (!isPlatformAdmin) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
