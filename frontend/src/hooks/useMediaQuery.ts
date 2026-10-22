import { useCallback, useSyncExternalStore } from "react";

/** 手機版面斷點:< 768px(與 Tailwind md 斷點互補;767.98 避免小數像素落在兩者之間)。 */
export const MOBILE_QUERY = "(max-width: 767.98px)";
/** 主要輸入為觸控(觸控筆電的主輸入仍是滑鼠/觸控板,不算)。 */
export const COARSE_QUERY = "(pointer: coarse)";

function getMql(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

/** 訂閱 media query(SSR / 不支援時回 false)。 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = getMql(query);
      if (!mql) return () => undefined;
      // Safari < 14 只有 addListener
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => getMql(query)?.matches ?? false, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** 是否為手機版面寬度(< 768px)。 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** 主要輸入是否為觸控。 */
export function useIsCoarse(): boolean {
  return useMediaQuery(COARSE_QUERY);
}
