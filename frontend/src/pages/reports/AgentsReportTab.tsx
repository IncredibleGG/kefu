/** 坐席績效分頁:各坐席接待量 / 平均首應 / 平均處理 / 回覆訊息數。
 *  資料來源:/reporting/agents/performance + conversations/volume + queue/wait-times。 */
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { reportsApi, fmtDuration, type AgentPerf } from "@/api/quality";
import { KpiCard, SectionCard, QueryState, TOOLTIP_STYLE } from "./_shared";

export function AgentsReportTab() {
  const { t } = useTranslation();

  const perf = useQuery({
    queryKey: ["reports", "agents", "performance"],
    queryFn: () => reportsApi.agentsPerformance(),
  });
  const volume = useQuery({
    queryKey: ["reports", "agents", "volume"],
    queryFn: () => reportsApi.conversationsVolume(),
  });
  const wait = useQuery({
    queryKey: ["reports", "agents", "wait"],
    queryFn: () => reportsApi.queueWaitTimes(),
  });

  const agents: AgentPerf[] = perf.data?.agents ?? [];
  const chartData = [...agents]
    .sort((a, b) => b.reception - a.reception)
    .slice(0, 10)
    .map((a) => ({
      name: a.display_name ?? t("reports.unknownAgent"),
      [t("reports.colReception")]: a.reception,
      [t("reports.colReplies")]: a.reply_messages,
    }));

  return (
    <div className="space-y-4">
      {/* KPI 列 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label={t("reports.kpiTotalSessions")}
          value={volume.isLoading ? "…" : String(volume.data?.total ?? 0)}
        />
        <KpiCard
          label={t("reports.kpiActiveAgents")}
          value={perf.isLoading ? "…" : String(agents.length)}
        />
        <KpiCard
          label={t("reports.kpiQueued")}
          value={wait.isLoading ? "…" : String(wait.data?.currently_queued ?? 0)}
        />
        <KpiCard
          label={t("reports.kpiAvgWait")}
          value={wait.isLoading ? "…" : fmtDuration(wait.data?.avg_wait_seconds)}
          hint={
            wait.data?.answered_sessions != null
              ? t("reports.answeredHint", { count: wait.data.answered_sessions })
              : undefined
          }
        />
      </div>

      {/* 各坐席接待量 / 回覆數 */}
      <SectionCard title={t("reports.agentVolumeTitle")}>
        <QueryState
          isLoading={perf.isLoading}
          isError={perf.isError}
          isEmpty={chartData.length === 0}
          onRetry={() => perf.refetch()}
          emptyText={t("reports.emptyAgents")}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} margin={{ left: -20, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip cursor={{ fill: "hsl(var(--accent))" }} contentStyle={TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey={t("reports.colReception")} fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
              <Bar dataKey={t("reports.colReplies")} fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </QueryState>
      </SectionCard>

      {/* 明細表 */}
      <SectionCard title={t("reports.agentTableTitle")}>
        <QueryState
          isLoading={perf.isLoading}
          isError={perf.isError}
          isEmpty={agents.length === 0}
          onRetry={() => perf.refetch()}
          emptyText={t("reports.emptyAgents")}
          skeletonHeight={200}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t("reports.colAgent")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("reports.colReception")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("reports.colFirstResponse")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("reports.colHandle")}</th>
                  <th className="py-2 text-right font-medium">{t("reports.colReplies")}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.staff_id ?? a.display_name ?? Math.random()} className="border-b border-border/50">
                    <td className="py-2 pr-4">{a.display_name ?? t("reports.unknownAgent")}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{a.reception}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {fmtDuration(a.avg_first_response_seconds)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {fmtDuration(a.avg_handle_seconds)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{a.reply_messages}</td>
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
