import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { visibleNav } from "./nav";
import { useAuth } from "@/stores/auth";

/** 窄圖示主欄(64px):品牌標記 + 一級導覽(依角色過濾)。
 *
 *  動態展開:預設只顯示圖示;滑鼠移入時整條平滑展開為 224px、在圖示右側顯示每個
 *  項目的名稱(浮層覆蓋在內容之上,不推擠版面;圖示位置固定不跳動)。
 */
export function IconRail() {
  const { t } = useTranslation();
  const { staff } = useAuth();
  const location = useLocation();
  const items = visibleNav(staff?.roles ?? ["agent"]);

  return (
    // 外層固定 64px 佔位,內層絕對定位可在 hover 時擴張為浮層,內容區不位移
    <div className="relative z-40 h-full w-16 shrink-0">
      <nav
        className={cn(
          "group absolute inset-y-0 left-0 flex w-16 flex-col gap-1 overflow-hidden",
          "bg-sidebar py-3 text-sidebar-foreground shadow-lg shadow-black/10",
          "transition-[width] duration-200 ease-out hover:w-56",
        )}
        aria-label={t("layout.primaryNav", { defaultValue: "主導覽" })}
      >
        {/* 品牌標記(40px 方塊在 64px 收合寬度置中:pl-3 = 12,12+20=32) */}
        <div className="mb-2 flex h-10 items-center pl-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground shadow-sm">
            <MessagesSquare className="h-5 w-5" />
          </div>
          <span className="ml-4 whitespace-nowrap text-sm font-semibold opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            kefu
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-1">
          {items.map((item) => {
            const active = location.pathname.startsWith(item.to);
            const Icon = item.icon;
            const label = t(item.labelKey);
            return (
              <NavLink
                key={item.key}
                to={item.to}
                title={label}
                aria-label={label}
                className={cn(
                  // pl-[22px] 讓 20px 圖示在 64px 收合寬度時水平置中(左 22 + 半徑 10 = 32),
                  // 展開時圖示位置不變、名稱在右側淡入
                  "mx-2 flex h-11 items-center rounded-lg pl-[14px] transition-colors",
                  active
                    ? "bg-brand/20 text-white"
                    : "text-sidebar-foreground hover:bg-white/10 hover:text-white",
                )}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="ml-4 whitespace-nowrap text-sm opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                  {label}
                </span>
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
