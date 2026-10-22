import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  Languages,
  Loader2,
  LogOut,
  MessagesSquare,
  Moon,
  ShieldCheck,
  User,
} from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/stores/auth";
import { useUi } from "@/stores/ui";
import { useNotify } from "@/stores/notify";
import { useBrand } from "@/stores/brand";
import { LANGUAGES, setLanguage } from "@/lib/i18n";
import { agentStatusMeta } from "@/lib/channels";
import { appVersion, isNative } from "@/lib/platform";
import { serverHost } from "@/lib/server";
import { initials, cn } from "@/lib/utils";
import type { AgentStatus } from "@/types";
import {
  groupSecondary,
  isSecondaryActive,
  secondaryLabel,
  sectionForPath,
  visibleNav,
  type NavItem,
} from "./nav";

const STATUSES: AgentStatus[] = ["online", "busy", "away", "offline"];

/**
 * 手機導覽抽屜(僅 < md 使用;由底部「更多」或頂欄漢堡鈕開啟,從 start 側滑出)。
 * 內容:個人資料、坐席狀態、完整一級導覽與可展開的二級項目、語言、主題、平台入口、登出。
 * 開關狀態由 AppLayout 管理,路由一變即自動關閉。
 */
export function MobileNavDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="start"
        description={t("mobile.drawer.desc", "導覽、坐席狀態與帳號設定")}
        className="gap-4 pe-3 select-none"
      >
        {/* Radix 關閉時會卸載內容:每次開啟都以目前區塊為預設展開 */}
        <DrawerBody />
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const staff = useAuth((s) => s.staff);
  const isPlatformAdmin = useAuth((s) => s.isPlatformAdmin);
  const logout = useAuth((s) => s.logout);
  const { theme, toggleTheme, agentStatus } = useUi();
  const brandName = useBrand((s) => s.name);
  const unread = useNotify((s) => s.unread);
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  const items = visibleNav(staff?.roles ?? ["agent"]);
  const current = sectionForPath(location.pathname);
  const [expanded, setExpanded] = useState<string | null>(current.key);

  return (
    <>
      {/* 品牌 */}
      <div className="flex items-center gap-3 pe-10">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground shadow-sm">
          <MessagesSquare className="h-5 w-5" aria-hidden />
        </div>
        <SheetTitle className="truncate">{brandName || "kefu"}</SheetTitle>
      </div>

      {/* 個人資料(點擊前往個人設定) */}
      <Link
        to="/settings?tab=profile"
        className="flex items-center gap-3 rounded-lg border border-border p-3 active:bg-accent"
      >
        <span className="relative shrink-0">
          <Avatar className="h-10 w-10">
            <AvatarFallback>{initials(staff?.display_name)}</AvatarFallback>
          </Avatar>
          <span className="absolute -bottom-0.5 -end-0.5 rounded-full bg-card p-0.5">
            <StatusDot className={agentStatusMeta[agentStatus].dot} />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{staff?.display_name}</span>
          <span className="truncate text-xs text-muted-foreground">{staff?.email}</span>
          {!!staff?.roles.length && (
            <span className="mt-1 flex flex-wrap gap-1">
              {staff.roles.map((r) => (
                <Badge key={r} variant="secondary">
                  {r}
                </Badge>
              ))}
            </span>
          )}
        </span>
        <User className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>

      <AgentStatusPicker />

      {/* 完整導覽 */}
      <nav aria-label={t("layout.primaryNav", { defaultValue: "主導覽" })} className="-mx-1 flex flex-col gap-0.5">
        {items.map((item) => (
          <NavRow
            key={item.key}
            item={item}
            active={item.key === current.key}
            expanded={expanded === item.key}
            onToggle={() => setExpanded((k) => (k === item.key ? null : item.key))}
            badge={item.key === "workspace" ? totalUnread : 0}
          />
        ))}
      </nav>

      {/* 偏好:語言 / 主題 */}
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <label className="flex min-h-11 items-center gap-3 px-2 text-sm">
          <Languages className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t("common.language")}</span>
          <LanguageSelect />
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 px-2 text-sm">
          <Moon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t("mobile.drawer.darkMode", "深色模式")}</span>
          <Switch checked={theme === "dark"} onCheckedChange={toggleTheme} aria-label={t("topbar.theme")} />
        </label>
      </div>

      {/* 帳號動作 */}
      <div className="flex flex-col gap-0.5 border-t border-border pt-3">
        {isPlatformAdmin && (
          <Link to="/platform" className={actionRowClass}>
            <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            {t("platform.menuEntry")}
          </Link>
        )}
        <button
          type="button"
          onClick={() => {
            void logout();
            navigate("/login");
          }}
          className={cn(actionRowClass, "text-destructive")}
        >
          <LogOut className="h-4 w-4 shrink-0" aria-hidden />
          {t("topbar.logout")}
        </button>
      </div>

      {/* 原生 App:版本與目前伺服器(方便回報問題) */}
      {isNative && (
        <p className="mt-auto px-2 text-[11px] text-muted-foreground">
          {t("mobile.drawer.version", { defaultValue: "版本 {{version}}", version: appVersion })}
          {serverHost() ? ` · ${serverHost()}` : ""}
        </p>
      )}
    </>
  );
}

const actionRowClass =
  "flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-start text-sm transition-colors active:bg-accent";

/** 一級導覽列 + 可展開的二級項目(設定區依分組顯示)。 */
function NavRow({
  item,
  active,
  expanded,
  onToggle,
  badge,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  badge: number;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const Icon = item.icon;
  const label = t(item.labelKey);
  const secondary = item.secondary ?? [];
  const subId = `mobile-nav-sub-${item.key}`;

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          "flex items-center rounded-md transition-colors",
          active ? "bg-brand/12 text-brand" : "text-foreground",
        )}
      >
        <NavLink
          to={item.to}
          aria-current={active ? "page" : undefined}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-sm font-medium active:bg-accent"
        >
          <Icon className="h-5 w-5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
          {badge > 0 && (
            <span className="ms-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-semibold text-destructive-foreground">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </NavLink>
        {secondary.length > 0 && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={subId}
            aria-label={t("mobile.drawer.toggleSub", { defaultValue: "展開 {{label}} 子選單", label })}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-accent"
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden />
          </button>
        )}
      </div>

      {secondary.length > 0 && expanded && (
        <div id={subId} className="ms-6 flex flex-col border-s border-border py-1 ps-2">
          {groupSecondary(secondary).map((g) => (
            <div key={g.key ?? "_rest"} className="flex flex-col">
              {g.labelKey && (
                <div className="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(g.labelKey, { defaultValue: g.label })}
                </div>
              )}
              {g.items.map((sub) => {
                const on = isSecondaryActive(sub, location.pathname, location.search);
                return (
                  <Link
                    key={sub.to}
                    to={sub.to}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "flex min-h-10 items-center rounded-md px-2 text-sm transition-colors active:bg-accent",
                      on ? "font-medium text-brand" : "text-muted-foreground",
                    )}
                  >
                    <span className="truncate">{secondaryLabel(sub, t)}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 坐席狀態(移自 TopBar 下拉;同步後端,失敗明確回饋不靜默)。 */
function AgentStatusPicker() {
  const { t } = useTranslation();
  const { agentStatus, setAgentStatus, statusSyncing, statusError, clearStatusError } = useUi();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        {t("layout.agentStatus")}
        {statusSyncing && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      </div>
      <div role="radiogroup" aria-label={t("layout.agentStatus")} className="grid grid-cols-4 gap-1.5">
        {STATUSES.map((s) => {
          const on = agentStatus === s;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setAgentStatus(s)}
              className={cn(
                "flex h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-md border px-1 text-[11px] transition-colors",
                on ? "border-brand bg-brand/10 font-medium text-brand" : "border-border text-muted-foreground active:bg-accent",
              )}
            >
              <StatusDot className={agentStatusMeta[s].dot} />
              <span className="max-w-full truncate">{t(`status.${s}`)}</span>
            </button>
          );
        })}
      </div>
      {statusError && (
        <button
          type="button"
          onClick={clearStatusError}
          className="flex min-h-10 items-center gap-2 rounded-md bg-destructive/10 px-2 text-start text-xs font-medium text-destructive"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {statusError === "no_staff"
            ? t("status.syncNoStaff", { defaultValue: "無法取得坐席身分,狀態未同步" })
            : t("status.syncFailed", { defaultValue: "狀態切換失敗,請重試" })}
        </button>
      )}
    </div>
  );
}

/** 抽屜內的語言選單(原生 select:手機上會跳出系統選擇器,觸控友善)。 */
function LanguageSelect() {
  const { i18n, t } = useTranslation();
  return (
    <select
      aria-label={t("common.language")}
      value={i18n.language}
      onChange={(e) => setLanguage(e.target.value)}
      className="h-10 max-w-[55%] cursor-pointer rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/40"
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.native}
        </option>
      ))}
    </select>
  );
}
