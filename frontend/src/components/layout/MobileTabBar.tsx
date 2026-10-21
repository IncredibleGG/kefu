import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { useNotify } from "@/stores/notify";
import { mobileTabItems, type NavItem } from "./nav";

/** 手機底部分頁列(僅 < md 顯示):工作台(未讀數)、工單、訪客、依角色的第 4 格(總覽 / 知識庫)、更多。
 *  放在版面正常流裡(非 fixed),內容區不需另外預留底部空間;底部自動留 Home 指示條的 safe-area。 */
export function MobileTabBar({ onOpenMore, className }: { onOpenMore: () => void; className?: string }) {
  const { t } = useTranslation();
  const location = useLocation();
  // 選取穩定參照(不在 selector 內建立新陣列,避免 zustand 每次判定為變更)
  const roles = useAuth((s) => s.staff?.roles);
  const unread = useNotify((s) => s.unread);
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  const items = mobileTabItems(roles ?? ["agent"]);
  // 目前路徑不屬於任何分頁 → 「更多」呈作用中(表示位置在抽屜導覽裡)
  const inTabs = items.some((n) => location.pathname.startsWith(n.to));

  return (
    <nav
      aria-label={t("mobile.tabBar", "主要分頁")}
      className={cn(
        "flex shrink-0 select-none items-stretch border-t border-border bg-card pb-safe md:hidden",
        className,
      )}
    >
      {items.map((item) => (
        <TabLink key={item.key} item={item} badge={item.key === "workspace" ? totalUnread : 0} />
      ))}
      <button
        type="button"
        onClick={onOpenMore}
        aria-haspopup="dialog"
        className={cn(tabClass, inTabs ? inactiveClass : activeClass)}
      >
        <Menu className="h-5 w-5" aria-hidden />
        <span className="max-w-full truncate">{t("mobile.tab.more", "更多")}</span>
      </button>
    </nav>
  );
}

const tabClass =
  "relative flex h-14 min-w-12 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] leading-tight transition-colors";
const activeClass = "font-medium text-brand";
const inactiveClass = "text-muted-foreground active:text-foreground";

function TabLink({ item, badge }: { item: NavItem; badge: number }) {
  const Icon = item.icon;
  const { t } = useTranslation();
  // 短標籤(mobileLabelKey)優先;未翻譯時退回一級導覽名稱
  const label = item.mobileLabelKey
    ? t(item.mobileLabelKey, { defaultValue: item.mobileLabel ?? t(item.labelKey) })
    : t(item.labelKey);
  return (
    <NavLink
      to={item.to}
      // 工作台:/workspace/:id 也算作用中(NavLink 預設即以前綴比對)
      className={({ isActive }) => cn(tabClass, isActive ? activeClass : inactiveClass)}
      aria-label={badge > 0 ? t("mobile.tab.unreadLabel", { defaultValue: "{{label}},{{count}} 則未讀", label, count: badge }) : undefined}
    >
      <span className="relative">
        <Icon className="h-5 w-5" aria-hidden />
        {badge > 0 && (
          <span
            aria-hidden
            className="absolute -end-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span className="max-w-full truncate">{label}</span>
    </NavLink>
  );
}
