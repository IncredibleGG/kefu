import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PanelLeftClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { NavItem } from "./nav";

/** 展開式二級側欄:顯示當前一級區塊的子項目 */
export function SecondarySidebar({
  section,
  onCollapse,
}: {
  section: NavItem;
  onCollapse: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const current = location.pathname + location.search;

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-13 items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold">{t(section.labelKey)}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label={t("layout.collapse")}>
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {section.secondary?.map((item) => {
          // labelKey 優先(供 i18n 翻譯);缺鍵時退回硬編 label,再退回路徑,確保不破圖
          const label = item.labelKey
            ? t(item.labelKey, { defaultValue: item.label ?? item.to })
            : (item.label ?? item.to);
          const active = current === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-brand/12 font-medium text-brand"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
