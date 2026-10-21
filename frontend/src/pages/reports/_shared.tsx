/** 報表分頁共用零件:KPI 卡、區塊卡、查詢狀態(載入 / 錯誤 / 空)、圖表樣式常數。
 *  乾淨室新增檔;僅供 reports/ 子頁使用,不外洩到其他頁。 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Recharts 分類色(沿用全域 chart tokens) */
export const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

/** Recharts tooltip 統一外觀 */
export const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
} as const;

/** KPI 卡片:標題 + 主數值 + 選填提示 */
export function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** 標準區塊卡:標題 + 內容 */
export function SectionCard({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * 查詢狀態包裝:依序處理 載入 / 錯誤 / 空 / 內容。
 * - isLoading:骨架
 * - isError:錯誤訊息 + 選填重試
 * - isEmpty:空狀態文案
 * - 其餘:children
 */
export function QueryState({
  isLoading,
  isError,
  isEmpty,
  onRetry,
  emptyText,
  skeletonHeight = 240,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  isEmpty?: boolean;
  onRetry?: () => void;
  emptyText?: string;
  skeletonHeight?: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (isLoading) return <Skeleton style={{ height: skeletonHeight }} className="w-full" />;
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-muted-foreground">{t("reports.loadError")}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            {t("reports.retry")}
          </button>
        )}
      </div>
    );
  }
  if (isEmpty) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {emptyText ?? t("reports.empty")}
      </div>
    );
  }
  return <>{children}</>;
}
