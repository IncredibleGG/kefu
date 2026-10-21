/** 銷售追蹤分頁(對齊 LiveChat 的 Goals & Sales tracker):把目標達成(GoalConversion)
 *  併入報表——近 N 天總成交數 / 成交總覽(分幣別)、逐坐席 sales 排行、逐目標明細。
 *
 *  資料層:後端 GET /api/v1/reporting/sales?days=N(report.view、租戶隔離、單趟 SQL 聚合)。
 *  就地以 goalsApi.sales 取用;沿用 reports/_shared 元件與 InsightsReportTab 的分頁範式。 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Trophy, ShoppingBag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { goalsApi, type GoalKind } from "@/api/goals";
import { KpiCard, SectionCard, QueryState } from "./_shared";

type Days = 7 | 30 | 90;

/** 分 → 顯示金額(保留兩位小數)+ 幣別。 */
function formatMoney(cents: number, currency: string): string {
  const amount = (cents || 0) / 100;
  return `${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export function SalesReportTab() {
  const { t } = useTranslation();
  const [days, setDays] = useState<Days>(30);

  const q = useQuery({
    queryKey: ["reports", "sales", days],
    queryFn: () => goalsApi.sales(days),
  });

  const data = q.data;
  const totals = data?.totals ?? [];
  const agents = data?.agents ?? [];
  const goals = data?.goals ?? [];

  const kindLabels = useMemo(
    () => ({
      url: t("goals.kind.url", { defaultValue: "到達網址" }),
      event: t("goals.kind.event", { defaultValue: "自訂事件" }),
      manual: t("goals.kind.manual", { defaultValue: "手動標記" }),
    }),
    [t],
  ) as Record<GoalKind, string>;

  // 總成交數(跨幣別可直接相加);成交坐席數(排除未歸因列)
  const totalConversions = totals.reduce((s, x) => s + x.conversions, 0);
  const sellerCount = agents.filter((a) => a.staff_id).length;

  // 總金額(單一幣別直接顯示;多幣別於「成交總覽」逐列呈現,KPI 顯示幣別數)
  const revenueValue = q.isLoading
    ? "…"
    : totals.length === 1
      ? formatMoney(totals[0].total_value_cents, totals[0].currency)
      : totals.length === 0
        ? "—"
        : t("sales.multiCurrency", {
            count: totals.length,
            defaultValue: `${totals.length} 種幣別`,
          });

  const DayButton = ({ value, label }: { value: Days; label: string }) => (
    <Button
      variant={days === value ? "default" : "outline"}
      size="sm"
      onClick={() => setDays(value)}
      aria-pressed={days === value}
    >
      {label}
    </Button>
  );

  const agentName = (a: { staff_id: string | null; display_name: string | null }) =>
    a.display_name ?? (a.staff_id ? t("sales.unknownAgent", { defaultValue: "未知坐席" }) : t("sales.unattributed", { defaultValue: "未歸因" }));

  return (
    <div className="space-y-4">
      {/* 標題列 + 天數切換 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <ShoppingBag className="h-4 w-4 text-primary" />
            {t("sales.title", { defaultValue: "銷售追蹤" })}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("sales.subtitle", {
              defaultValue: "目標達成成交、金額與逐坐席業績排行",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DayButton value={7} label={t("sales.days7", { defaultValue: "近 7 天" })} />
          <DayButton value={30} label={t("sales.days30", { defaultValue: "近 30 天" })} />
          <DayButton value={90} label={t("sales.days90", { defaultValue: "近 90 天" })} />
        </div>
      </div>

      {/* KPI 列 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard
          label={t("sales.kpiConversions", { defaultValue: "總成交數" })}
          value={q.isLoading ? "…" : String(totalConversions)}
          hint={t("sales.kpiConversionsHint", {
            days,
            defaultValue: `近 ${days} 天`,
          })}
        />
        <KpiCard
          label={t("sales.kpiRevenue", { defaultValue: "總成交金額" })}
          value={revenueValue}
        />
        <KpiCard
          label={t("sales.kpiSellers", { defaultValue: "成交坐席數" })}
          value={q.isLoading ? "…" : String(sellerCount)}
        />
      </div>

      {/* 成交總覽(分幣別):多幣別時逐列呈現各幣別的成交數與金額 */}
      {totals.length > 1 && (
        <SectionCard title={t("sales.totalsTitle", { defaultValue: "成交總覽(分幣別)" })}>
          <ul className="space-y-2">
            {totals.map((tot) => (
              <li
                key={tot.currency}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="font-medium">{tot.currency}</span>
                <span className="flex items-center gap-3 tabular-nums text-muted-foreground">
                  <span>
                    {t("sales.conversionsN", {
                      count: tot.conversions,
                      defaultValue: `${tot.conversions} 筆`,
                    })}
                  </span>
                  <span className="text-foreground">
                    {formatMoney(tot.total_value_cents, tot.currency)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* 逐坐席 sales 排行 */}
      <SectionCard title={t("sales.agentsTitle", { defaultValue: "坐席業績排行" })}>
        <QueryState
          isLoading={q.isLoading}
          isError={q.isError}
          isEmpty={agents.length === 0}
          onRetry={() => q.refetch()}
          emptyText={t("sales.emptyAgents", { defaultValue: "近期尚無成交記錄" })}
          skeletonHeight={200}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">#</th>
                  <th className="py-2 pr-4 font-medium">
                    {t("sales.colAgent", { defaultValue: "坐席" })}
                  </th>
                  <th className="py-2 pr-4 text-right font-medium">
                    {t("sales.colConversions", { defaultValue: "成交數" })}
                  </th>
                  <th className="py-2 text-right font-medium">
                    {t("sales.colRevenue", { defaultValue: "成交金額" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a, i) => (
                  <tr
                    key={`${a.staff_id ?? "none"}-${a.currency}`}
                    className="border-b border-border/50"
                  >
                    <td className="py-2 pr-4 tabular-nums text-muted-foreground">
                      {i < 3 ? (
                        <Trophy
                          className={
                            i === 0
                              ? "h-4 w-4 text-warning"
                              : i === 1
                                ? "h-4 w-4 text-muted-foreground"
                                : "h-4 w-4 text-amber-700"
                          }
                        />
                      ) : (
                        i + 1
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={a.staff_id ? "" : "text-muted-foreground italic"}>
                        {agentName(a)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{a.conversions}</td>
                    <td className="py-2 text-right tabular-nums font-medium">
                      {formatMoney(a.total_value_cents, a.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </SectionCard>

      {/* 逐目標明細 */}
      <SectionCard title={t("sales.goalsTitle", { defaultValue: "目標明細" })}>
        <QueryState
          isLoading={q.isLoading}
          isError={q.isError}
          isEmpty={goals.length === 0}
          onRetry={() => q.refetch()}
          emptyText={t("sales.emptyGoals", { defaultValue: "近期尚無達成的目標" })}
          skeletonHeight={160}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">
                    {t("sales.colGoal", { defaultValue: "目標" })}
                  </th>
                  <th className="py-2 pr-4 font-medium">
                    {t("sales.colKind", { defaultValue: "型別" })}
                  </th>
                  <th className="py-2 pr-4 text-right font-medium">
                    {t("sales.colConversions", { defaultValue: "成交數" })}
                  </th>
                  <th className="py-2 text-right font-medium">
                    {t("sales.colRevenue", { defaultValue: "成交金額" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {goals.map((g) => (
                  <tr key={g.id} className="border-b border-border/50">
                    <td className="py-2 pr-4">
                      <span className="truncate font-medium">{g.name}</span>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant="outline" className="text-[10px]">
                        {kindLabels[g.kind] ?? g.kind}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{g.conversions}</td>
                    <td className="py-2 text-right tabular-nums font-medium">
                      {formatMoney(g.total_value_cents, g.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}
