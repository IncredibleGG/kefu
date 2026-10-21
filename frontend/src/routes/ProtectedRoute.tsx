import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/stores/auth";

/** 路由守衛:無 token 導回登入;有 token 但尚未載入 /me 時補抓一次。 */
export function ProtectedRoute() {
  const { token, staff, loadMe } = useAuth();
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
  return <Outlet />;
}
