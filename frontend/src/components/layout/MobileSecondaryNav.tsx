import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { groupSecondary, isSecondaryActive, secondaryLabel, type NavItem, type SecondaryItem } from "./nav";

/**
 * 手機二級導覽(僅 < md;插在頂欄與內容之間,取代 SecondarySidebar)。
 * - 一般區塊:可橫向捲動的 chip 列,作用中的 chip 自動捲進可見範圍。
 * - 項目帶分組(設定區 27 項):顯示「目前項目 ▾」按鈕,點開底部清單依分組列出全部項目。
 * - 頁面本身已有分頁列(nav.inPageTabs:報表 / AI / 知識庫)或無二級項目:不渲染。
 */
export function MobileSecondaryNav({ section }: { section: NavItem }) {
  const items = section.secondary ?? [];
  if (!items.length || section.inPageTabs) return null;
  return items.some((i) => i.group) ? (
    <SecondarySheetPicker section={section} items={items} />
  ) : (
    <SecondaryChips items={items} />
  );
}

function SecondaryChips({ items }: { items: SecondaryItem[] }) {
  const { t } = useTranslation();
  const location = useLocation();
  const activeRef = useRef<HTMLAnchorElement>(null);

  // 作用中 chip 捲到列中央(只捲 chip 列本身;以實際座標差計算,RTL 同樣適用)
  useEffect(() => {
    const el = activeRef.current;
    const row = el?.parentElement;
    if (!el || !row) return;
    const a = el.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    const delta = a.left + a.width / 2 - (b.left + b.width / 2);
    if (Math.abs(delta) > 1) row.scrollBy({ left: delta, behavior: "smooth" });
  }, [location.pathname, location.search]);

  return (
    <nav
      aria-label={t("mobile.secondaryNav", "子選單")}
      className="flex shrink-0 select-none gap-2 overflow-x-auto border-b border-border bg-card px-4 py-2 scrollbar-none md:hidden"
    >
      {items.map((item) => {
        const active = isSecondaryActive(item, location.pathname, location.search);
        return (
          <Link
            key={item.to}
            ref={active ? activeRef : undefined}
            to={item.to}
            // chip 屬分頁切換:取代目前紀錄,返回鍵直接離開本區而非逐一倒退
            replace
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-sm transition-colors pointer-coarse:h-10 pointer-coarse:px-4",
              active
                ? "border-brand bg-brand/10 font-medium text-brand"
                : "border-border text-muted-foreground active:bg-accent",
            )}
          >
            {secondaryLabel(item, t)}
          </Link>
        );
      })}
    </nav>
  );
}

function SecondarySheetPicker({ section, items }: { section: NavItem; items: SecondaryItem[] }) {
  const { t } = useTranslation();
  const location = useLocation();
  // 開啟時記下當下位置;導頁(位置改變)即自動關閉,不需額外 effect
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === location.key;

  const current = items.find((i) => isSecondaryActive(i, location.pathname, location.search));
  const sectionLabel = t(section.labelKey);
  const groups = groupSecondary(items);

  return (
    <div className="flex shrink-0 items-center border-b border-border bg-card px-4 py-2 md:hidden">
      <Sheet open={open} onOpenChange={(o) => setOpenAt(o ? location.key : null)}>
        <button
          type="button"
          onClick={() => setOpenAt(location.key)}
          aria-haspopup="dialog"
          className="flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium active:bg-accent pointer-coarse:h-10"
        >
          <span className="text-muted-foreground">{sectionLabel}</span>
          {current && (
            <>
              <span aria-hidden className="text-muted-foreground">/</span>
              <span className="truncate">{secondaryLabel(current, t)}</span>
            </>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
        <SheetContent side="bottom" description={t("mobile.secondaryPickerDesc", "選擇要前往的項目")}>
          <SheetHeader>
            <SheetTitle>{sectionLabel}</SheetTitle>
          </SheetHeader>
          <nav aria-label={sectionLabel} className="-mx-2 flex flex-col gap-3">
            {groups.map((g) => (
              <div key={g.key ?? "_rest"} className="flex flex-col">
                {g.labelKey && (
                  <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(g.labelKey, { defaultValue: g.label })}
                  </div>
                )}
                {g.items.map((item) => {
                  const active = item === current;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-11 items-center justify-between gap-2 rounded-md px-3 text-sm transition-colors",
                        active ? "bg-brand/12 font-medium text-brand" : "text-foreground active:bg-accent",
                      )}
                    >
                      <span className="truncate">{secondaryLabel(item, t)}</span>
                      {active && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  );
}
