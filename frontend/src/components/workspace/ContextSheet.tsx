import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, type To } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PanelRightClose, X } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useIsMobile, useMediaQuery } from "@/hooks/useMediaQuery";
import { useUi } from "@/stores/ui";
import type { Session } from "@/types";
import { ContextPanelBody, isContextTab, type ContextTab } from "./ContextPanel";

/** ≥ lg(1024px)才以固定右欄呈現情境面板;md–lg 改為浮層抽屜(已核准的唯一 ≥ md 版面變更)。 */
export const WIDE_QUERY = "(min-width: 1024px)";

/** 情境面板呈現方式:sheet = 手機底部面板;drawer = 平板(md–lg)右側抽屜;aside = 桌面固定右欄。 */
export type ContextPanelMode = "sheet" | "drawer" | "aside";

export function useContextPanelMode(): ContextPanelMode {
  const mobile = useIsMobile();
  const wide = useMediaQuery(WIDE_QUERY);
  return mobile ? "sheet" : wide ? "aside" : "drawer";
}

/** history state 標記:此 ?panel= 由本 App push 開啟(關閉時可用 navigate(-1) 退回,返回鍵即關閉)。 */
const PUSHED_FLAG = "kefuPanelPushed";

function stateObject(state: unknown): Record<string, unknown> {
  return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

/**
 * 情境面板開關狀態 = 網址參數 ?panel=info|insight|kb|history|trail|search(不進 store)。
 * - 開啟:push(返回鍵 / 瀏覽器上一頁會先關閉面板)。
 * - 關閉:若是本 App push 開的 → navigate(-1);深連結直接帶 ?panel= 進來的 → replace 移除參數。
 * - 切換分頁:replace(不堆疊歷史)。
 */
export function useContextPanelParam() {
  const location = useLocation();
  const navigate = useNavigate();
  const raw = new URLSearchParams(location.search).get("panel");
  const panel: ContextTab | null = isContextTab(raw) ? raw : null;
  // 防止同一個歷史位置重複 navigate(-1)(例如關閉事件連發)而多退一頁
  const closedAtKey = useRef<string | null>(null);

  const target = useCallback(
    (tab: ContextTab | null): To => {
      const sp = new URLSearchParams(location.search);
      if (tab) sp.set("panel", tab);
      else sp.delete("panel");
      const s = sp.toString();
      return { pathname: location.pathname, search: s ? `?${s}` : "", hash: location.hash };
    },
    [location.pathname, location.search, location.hash],
  );

  const openPanel = useCallback(
    (tab: ContextTab = "info") => {
      if (panel) {
        navigate(target(tab), { replace: true, state: location.state });
        return;
      }
      navigate(target(tab), { state: { ...stateObject(location.state), [PUSHED_FLAG]: true } });
    },
    [panel, navigate, target, location.state],
  );

  const closePanel = useCallback(() => {
    if (!panel || closedAtKey.current === location.key) return;
    closedAtKey.current = location.key;
    if (stateObject(location.state)[PUSHED_FLAG]) {
      navigate(-1);
      return;
    }
    const rest = { ...stateObject(location.state) };
    delete rest[PUSHED_FLAG];
    navigate(target(null), { replace: true, state: rest });
  }, [panel, navigate, target, location.key, location.state]);
  // 換到別的歷史位置(含瀏覽器「下一頁」回到同一筆)時解除防重複
  useEffect(() => {
    closedAtKey.current = null;
  }, [location.key]);

  const setPanelTab = useCallback(
    (tab: ContextTab) => navigate(target(tab), { replace: true, state: location.state }),
    [navigate, target, location.state],
  );

  return { panel, openPanel, closePanel, setPanelTab };
}

/**
 * 情境面板的浮層版本(由 ?panel= 驅動):
 * - side="bottom":手機底部 sheet,高 85dvh,分頁顯示文字並可橫向捲動。
 * - side="end":平板(md–lg)右側抽屜,寬度沿用桌面右欄的 rightPanelWidth(CSS 變數 --rpw)。
 * Radix Dialog 基礎:Esc / Android 返回鍵(lib/mobile/backButton 派送 Escape)都會走 closePanel。
 */
export function ContextSheet({ session, side }: { session: Session; side: "bottom" | "end" }) {
  const { t } = useTranslation();
  const { panel, closePanel, setPanelTab } = useContextPanelParam();
  const rightPanelWidth = useUi((s) => s.rightPanelWidth);
  const bottom = side === "bottom";
  const closeLabel = bottom ? t("misc.close") : t("panel.collapse");

  return (
    <Sheet
      open={panel !== null}
      onOpenChange={(o) => {
        if (!o) closePanel();
      }}
    >
      <SheetContent
        side={side}
        hideClose
        title={t("mobile.context.title", "訪客資訊與工具")}
        aria-describedby={undefined}
        className={
          bottom
            ? "h-[85dvh] gap-0 overflow-hidden p-0 pt-3"
            : "w-(--rpw) max-w-[85vw] gap-0 overflow-hidden p-0"
        }
        style={bottom ? undefined : ({ "--rpw": `${rightPanelWidth}px` } as React.CSSProperties)}
      >
        <ContextPanelBody
          session={session}
          tab={panel ?? "info"}
          onTabChange={setPanelTab}
          onClose={closePanel}
          closeLabel={closeLabel}
          closeIcon={bottom ? <X className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
          layout={bottom ? "sheet" : "panel"}
          // SheetContent 的 safe-area 內距被 p-0 取代,改由本體補上(瀏海 / Home 指示條)
          className={bottom ? "pb-safe ps-safe pe-safe" : "pt-safe pb-safe pe-safe"}
        />
      </SheetContent>
    </Sheet>
  );
}
