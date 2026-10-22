import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  Volume2,
  MonitorSmartphone,
  Sun,
  Moon,
  LogOut,
  User,
  ChevronDown,
  PanelLeft,
  Menu,
  Search,
  Check,
  ShieldCheck,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusDot } from "@/components/ui/status-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { GlobalSearch } from "./GlobalSearch";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useAuth } from "@/stores/auth";
import { useUi } from "@/stores/ui";
import { useNotify } from "@/stores/notify";
import { setTitleUnread, initTitleBase } from "@/lib/notify";
import {
  isNative,
  notificationSupported,
  requestNotificationPermission,
  setBadge,
} from "@/lib/platform";
import { agentStatusMeta } from "@/lib/channels";
import { initials, cn } from "@/lib/utils";
import type { AgentStatus } from "@/types";

const STATUSES: AgentStatus[] = ["online", "busy", "away", "offline"];

export function TopBar({
  onToggleSidebar,
  onOpenMobileNav,
  onOpenSearch,
  className,
}: {
  onToggleSidebar: () => void;
  /** 手機版面(< md):漢堡鈕開啟導覽抽屜 */
  onOpenMobileNav?: () => void;
  /** 手機版面(< md):搜尋圖示開啟全螢幕搜尋 */
  onOpenSearch?: () => void;
  /** 附加到 header(例如沉浸模式以 max-md:hidden 隱藏;隱藏時仍掛載,角標 / 標題效果照常) */
  className?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { staff, logout, isPlatformAdmin } = useAuth();
  const { theme, toggleTheme, agentStatus, setAgentStatus, statusSyncing, statusError, clearStatusError } =
    useUi();
  const unread = useNotify((s) => s.unread);
  const sound = useNotify((s) => s.sound);
  const desktop = useNotify((s) => s.desktop);
  const setSound = useNotify((s) => s.setSound);
  const setDesktop = useNotify((s) => s.setDesktop);
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  // App 掛載後記錄標題基底
  useEffect(() => {
    initTitleBase();
  }, []);

  // 未讀總數變動 → 原生角標(Dock / 工作列 / 系統匣 / 手機圖示);web 更新分頁標題閃爍(歸零則還原)
  useEffect(() => {
    void setBadge(totalUnread);
    if (!isNative) setTitleUnread(totalUnread);
  }, [totalUnread]);

  // 開啟系統通知需先取得授權(使用者手勢觸發)
  async function toggleDesktop() {
    if (desktop) {
      setDesktop(false);
      return;
    }
    setDesktop(await requestNotificationPermission());
  }
  const canNotify = notificationSupported();

  return (
    <header
      className={cn(
        "flex h-13 shrink-0 items-center gap-3 border-b border-border bg-card px-3 py-2.5",
        // 手機版面:頂部延伸到瀏海 / 狀態列下方(高度與上內距各加 safe-top),間距收窄
        "max-md:h-[calc(3.25rem+var(--safe-top))] max-md:gap-1 max-md:px-2 max-md:pt-[calc(0.625rem+var(--safe-top))]",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleSidebar}
        aria-label={t("layout.toggleSidebar")}
        className="max-md:hidden"
      >
        <PanelLeft className="h-4 w-4" />
      </Button>

      {/* 手機版面:漢堡鈕(取代 PanelLeft,開啟導覽抽屜) */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onOpenMobileNav}
        aria-label={t("mobile.openMenu", "開啟選單")}
        aria-haspopup="dialog"
        className="md:hidden pointer-coarse:size-10 [&_svg]:size-5"
      >
        <Menu />
      </Button>

      {/* 全域搜尋(手機版面改由搜尋圖示開啟全螢幕搜尋) */}
      <GlobalSearch className="max-md:hidden" />

      <div className="flex-1" />

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onOpenSearch}
        aria-label={t("common.search")}
        aria-haspopup="dialog"
        className="md:hidden pointer-coarse:size-10 [&_svg]:size-5"
      >
        <Search />
      </Button>

      {/* 坐席狀態同步失敗指示(不靜默):點擊清除 */}
      {statusError && (
        <SimpleTooltip
          label={
            statusError === "no_staff"
              ? t("status.syncNoStaff", { defaultValue: "無法取得坐席身分,狀態未同步" })
              : t("status.syncFailed", { defaultValue: "狀態切換失敗,請重試" })
          }
          side="bottom"
        >
          <button
            type="button"
            onClick={clearStatusError}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 pointer-coarse:min-h-10 pointer-coarse:min-w-10 pointer-coarse:justify-center"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("status.syncErrorShort", { defaultValue: "狀態未同步" })}</span>
          </button>
        </SimpleTooltip>
      )}

      {/* 坐席狀態切換(同步到後端 Staff.status) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2 max-md:hidden">
            {statusSyncing ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : (
              <StatusDot className={agentStatusMeta[agentStatus].dot} pulse={agentStatus === "online"} />
            )}
            <span className="text-xs">{t(`status.${agentStatus}`)}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("layout.agentStatus")}</DropdownMenuLabel>
          {STATUSES.map((s) => (
            <DropdownMenuItem key={s} onClick={() => setAgentStatus(s)}>
              <StatusDot className={agentStatusMeta[s].dot} />
              <span className="flex-1">{t(`status.${s}`)}</span>
              {agentStatus === s && <Check className="h-4 w-4 text-brand" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 語言切換(手機版面移到導覽抽屜;contents 讓 ≥ md 的排版與原本完全相同) */}
      <div className="contents max-md:hidden">
        <LanguageSwitcher />
      </div>

      {/* 主題切換 */}
      <SimpleTooltip label={t("topbar.theme")} side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          aria-label={t("topbar.theme")}
          className="max-md:hidden"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </SimpleTooltip>

      {/* 通知 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative pointer-coarse:size-10 max-md:[&_svg]:size-5"
            aria-label={t("topbar.notifications")}
          >
            <Bell className="h-4 w-4" />
            {totalUnread > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                {totalUnread > 99 ? "99+" : totalUnread}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 max-md:max-w-[calc(100vw-1rem)]">
          <DropdownMenuLabel>{t("topbar.notifications")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/* 通知偏好開關 */}
          <div className="space-y-2 p-2">
            <label className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm">
              <span className="flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-muted-foreground" />
                {t("layout.soundNotification")}
              </span>
              <Switch checked={sound} onCheckedChange={setSound} aria-label={t("layout.soundNotificationToggle")} />
            </label>
            <label
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm",
                canNotify ? "cursor-pointer" : "opacity-50",
              )}
            >
              <span className="flex items-center gap-2">
                <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
                {t("layout.desktopNotification")}
              </span>
              <Switch
                checked={desktop}
                onCheckedChange={toggleDesktop}
                disabled={!canNotify}
                aria-label={t("layout.desktopNotificationToggle")}
              />
            </label>
          </div>
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {totalUnread > 0
              ? t("layout.unreadSummary", { total: totalUnread, sessions: Object.keys(unread).length })
              : t("layout.noUnread")}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 帳號選單 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-2 rounded-md p-1 hover:bg-accent",
              "pointer-coarse:min-h-10 pointer-coarse:min-w-10 pointer-coarse:justify-center",
            )}
          >
            <span className="relative flex shrink-0">
              <Avatar className="h-7 w-7">
                <AvatarFallback>{initials(staff?.display_name)}</AvatarFallback>
              </Avatar>
              {/* 手機版面:狀態下拉隱藏,改在頭像角落顯示狀態點 */}
              <span className="absolute -bottom-0.5 -end-0.5 rounded-full bg-card p-px md:hidden">
                <StatusDot className={cn(agentStatusMeta[agentStatus].dot, "block h-2 w-2")} />
              </span>
            </span>
            <span className="hidden text-sm font-medium sm:block">{staff?.display_name}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="font-medium">{staff?.display_name}</span>
              <span className="text-xs font-normal text-muted-foreground">{staff?.email}</span>
            </div>
          </DropdownMenuLabel>
          <div className="px-2 pb-1.5">
            {staff?.roles.map((r) => (
              <Badge key={r} variant="secondary" className="mr-1">
                {r}
              </Badge>
            ))}
          </div>
          <DropdownMenuSeparator />
          {isPlatformAdmin && (
            <>
              <DropdownMenuItem onClick={() => navigate("/platform")}>
                <ShieldCheck className="h-4 w-4" />
                {t("platform.menuEntry")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => navigate("/settings?tab=profile")}>
            <User className="h-4 w-4" />
            {t("topbar.profile")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              logout();
              navigate("/login");
            }}
          >
            <LogOut className="h-4 w-4" />
            {t("topbar.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
