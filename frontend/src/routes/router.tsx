import { createBrowserRouter, Navigate } from "react-router-dom";
import { ProtectedRoute } from "./ProtectedRoute";
import { PlatformRoute } from "./PlatformRoute";
import { AppLayout } from "@/components/layout/AppLayout";
import { PlatformLayout } from "@/components/layout/PlatformLayout";
import { PlatformPage } from "@/pages/platform/PlatformPage";
import { LoginPage } from "@/pages/LoginPage";
import { RegisterPage } from "@/pages/RegisterPage";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { AcceptInvitePage } from "@/pages/AcceptInvitePage";
import { WorkspacePage } from "@/pages/WorkspacePage";
import { DashboardPage } from "@/pages/DashboardPage";
import { VisitorsPage } from "@/pages/VisitorsPage";
import { CompanyPage } from "@/pages/CompanyPage";
import { AiPage } from "@/pages/AiPage";
import { KnowledgePage } from "@/pages/KnowledgePage";
import { ChannelsPage } from "@/pages/ChannelsPage";
import { ReportsPage } from "@/pages/ReportsPage";
import { TicketsPage } from "@/pages/TicketsPage";
import { RoutingPage } from "@/pages/RoutingPage";
import { OrganizationPage } from "@/pages/OrganizationPage";
import { ResellerPage } from "@/pages/ResellerPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { BillingPage } from "@/pages/BillingPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { PublicHelpCenter } from "@/pages/PublicHelpCenter";
import { useAuth, selectRoles } from "@/stores/auth";

/** 登入首頁:管理員 / 主管 → 總覽儀表板;其餘坐席 → 工作台。 */
function RootRedirect() {
  const roles = useAuth(selectRoles);
  const isAdmin = roles.includes("admin") || roles.includes("supervisor");
  return <Navigate to={isAdmin ? "/dashboard" : "/workspace"} replace />;
}

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  { path: "/forgot-password", element: <ForgotPasswordPage /> },
  { path: "/reset-password", element: <ResetPasswordPage /> },
  { path: "/accept-invite", element: <AcceptInvitePage /> },
  // 對外公開自助中心(無登入守衛):/help/:slug,例 /help/demo
  { path: "/help/:slug", element: <PublicHelpCenter /> },
  // 平台超管後台(一級路由,僅 is_platform_admin 可進;獨立框架,與租戶工作台分離)
  {
    element: <PlatformRoute />,
    children: [
      {
        element: <PlatformLayout />,
        children: [{ path: "/platform", element: <PlatformPage /> }],
      },
    ],
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: "/", element: <RootRedirect /> },
          { path: "/dashboard", element: <DashboardPage /> },
          { path: "/workspace", element: <WorkspacePage /> },
          { path: "/workspace/:sessionId", element: <WorkspacePage /> },
          { path: "/visitors", element: <VisitorsPage /> },
          { path: "/company", element: <CompanyPage /> },
          { path: "/tickets", element: <TicketsPage /> },
          { path: "/routing", element: <RoutingPage /> },
          { path: "/ai", element: <AiPage /> },
          { path: "/knowledge", element: <KnowledgePage /> },
          { path: "/channels", element: <ChannelsPage /> },
          { path: "/reports", element: <ReportsPage /> },
          { path: "/organization", element: <OrganizationPage /> },
          { path: "/reseller", element: <ResellerPage /> },
          { path: "/settings", element: <SettingsPage /> },
          { path: "/billing", element: <BillingPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
]);
