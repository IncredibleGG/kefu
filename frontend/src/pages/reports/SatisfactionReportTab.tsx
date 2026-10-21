/** 滿意度 / 質檢分頁:
 *  - CSAT 彙總(平均分 / 樣本數 / 各分數分佈) + 明細列表(/quality/csat)
 *  - 質檢彙總(reviewed / avg_score / by_status(label))(/reporting/quality)
 *  - 質檢紀錄列表(/quality/quality-record) */
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Legend,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { reportsApi } from "@/api/quality";
import { KpiCard, SectionCard, QueryState, CHART_COLORS, TOOLTIP_STYLE } from "./_shared";

function fmtScore(v: number | null | undefined, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function SatisfactionReportTab() {
  const { t } = useTranslation();

  const csat = useQuery({
    queryKey: ["reports", "satisfaction", "summary"],
    queryFn: () => reportsApi.satisfactionSummary(),
  });
  const quality = useQuery({
    queryKey: ["reports", "quality", "summary"],
    queryFn: () => reportsApi.qualitySummary(),
  });
  const csatList = useQuery({
    queryKey: ["reports", "satisfaction", "list"],
    queryFn: () => reportsApi.listCsat({ page: 1, size: 20 }),
  });
  const records = useQuery({
    queryKey: ["reports", "quality", "records"],
    queryFn: () => reportsApi.listQualityRecords({ page: 1, size: 20 }),
  });

  // CSAT 分數分佈:固定 1..5,缺者補 0
  const dist = csat.data?.distribution ?? {};
  const distData = [1, 2, 3, 4, 5].map((n) => ({
    score: t("reports.starLabel", { n }),
    count: dist[String(n)] ?? 0,
  }));
  const hasDist = distData.some((d) => d.count > 0);

  // 質檢分類分佈
  const byStatus = quality.data?.by_status ?? {};
  const statusData = Object.entries(byStatus).map(([name, value]) => ({ name, value }));

  const csatPct = csat.data?.avg_score != null ? Math.round((csat.data.avg_score / 5) * 100) : null;

  return (
    <div className="space-y-4">
      {/* KPI 列 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label={t("reports.kpiCsatAvg")}
          value={csat.isLoading ? "…" : fmtScore(csat.data?.avg_score, 2)}
          hint={csatPct != null ? t("reports.csatPctHint", { pct: csatPct }) : undefined}
        />
        <KpiCard
          label={t("reports.kpiCsatResponses")}
          value={csat.isLoading ? "…" : String(csat.data?.responses ?? 0)}
        />
        <KpiCard
          label={t("reports.kpiReviewed")}
          value={quality.isLoading ? "…" : String(quality.data?.reviewed ?? 0)}
        />
        <KpiCard
          label={t("reports.kpiQualityAvg")}
          value={quality.isLoading ? "…" : fmtScore(quality.data?.avg_score, 1)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* CSAT 分數分佈 */}
        <SectionCard title={t("reports.csatDistTitle")}>
          <QueryState
            isLoading={csat.isLoading}
            isError={csat.isError}
            isEmpty={!hasDist}
            onRetry={() => csat.refetch()}
            emptyText={t("reports.emptyCsat")}
          >
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={distData} margin={{ left: -20, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="score" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip cursor={{ fill: "hsl(var(--accent))" }} contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="count" name={t("reports.csatCount")} radius={[4, 4, 0, 0]}>
                  {distData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </QueryState>
        </SectionCard>

        {/* 質檢分類分佈 */}
        <SectionCard title={t("reports.qualityByLabelTitle")}>
          <QueryState
            isLoading={quality.isLoading}
            isError={quality.isError}
            isEmpty={statusData.length === 0}
            onRetry={() => quality.refetch()}
            emptyText={t("reports.emptyQuality")}
          >
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={statusData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={2}
                >
                  {statusData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </QueryState>
        </SectionCard>
      </div>

      {/* CSAT 明細列表 */}
      <SectionCard title={t("reports.csatListTitle")}>
        <QueryState
          isLoading={csatList.isLoading}
          isError={csatList.isError}
          isEmpty={(csatList.data?.items?.length ?? 0) === 0}
          onRetry={() => csatList.refetch()}
          emptyText={t("reports.emptyCsat")}
          skeletonHeight={180}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t("reports.colRating")}</th>
                  <th className="py-2 pr-4 font-medium">{t("reports.colLevel")}</th>
                  <th className="py-2 pr-4 font-medium">{t("reports.colComment")}</th>
                  <th className="py-2 font-medium">{t("reports.colTime")}</th>
                </tr>
              </thead>
              <tbody>
                {(csatList.data?.items ?? []).map((c) => (
                  <tr key={c.id} className="border-b border-border/50">
                    <td className="py-2 pr-4 tabular-nums">{"★".repeat(c.rating)}</td>
                    <td className="py-2 pr-4">
                      {c.level ? <Badge variant="secondary">{c.level}</Badge> : "—"}
                    </td>
                    <td className="max-w-xs truncate py-2 pr-4">{c.comment ?? "—"}</td>
                    <td className="py-2 text-muted-foreground">{fmtTime(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </SectionCard>

      {/* 質檢紀錄列表 */}
      <SectionCard title={t("reports.recordsTitle")}>
        <QueryState
          isLoading={records.isLoading}
          isError={records.isError}
          isEmpty={(records.data?.items?.length ?? 0) === 0}
          onRetry={() => records.refetch()}
          emptyText={t("reports.emptyRecords")}
          skeletonHeight={180}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t("reports.colTarget")}</th>
                  <th className="py-2 pr-4 font-medium">{t("reports.colLabel")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("reports.colScore")}</th>
                  <th className="py-2 pr-4 font-medium">{t("reports.colSampled")}</th>
                  <th className="py-2 pr-4 font-medium">{t("reports.colNote")}</th>
                  <th className="py-2 font-medium">{t("reports.colTime")}</th>
                </tr>
              </thead>
              <tbody>
                {(records.data?.items ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className="py-2 pr-4">
                      <Badge variant="outline">{t(`reports.target_${r.target_type}`, r.target_type)}</Badge>
                    </td>
                    <td className="py-2 pr-4">{r.label ?? "—"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{r.score ?? "—"}</td>
                    <td className="py-2 pr-4">
                      {r.is_sampled ? <Badge variant="secondary">{t("reports.sampled")}</Badge> : "—"}
                    </td>
                    <td className="max-w-xs truncate py-2 pr-4">{r.note ?? "—"}</td>
                    <td className="py-2 text-muted-foreground">{fmtTime(r.created_at)}</td>
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
