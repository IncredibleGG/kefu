/** 坐席即時監控分頁:列出各坐席當前進行中的會話。
 *  無「全租戶活躍會話」單一端點,故先取坐席清單(iamApi.staff),再逐一查
 *  /quality/agent-monitor/{staff_id} 聚合;refetchInterval 10s 近即時刷新。 */
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Circle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { iamApi } from "@/api/endpoints";
import { reportsApi, type MonitorSession } from "@/api/quality";
import type { StaffLite } from "@/types";
import { KpiCard, SectionCard, QueryState } from "./_shared";

const REFETCH_MS = 10_000;

interface AgentMonitorRow {
  staff: StaffLite;
  active_sessions: MonitorSession[];
  count: number;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString();
}

export function MonitorReportTab() {
  const { t } = useTranslation();

  const monitor = useQuery({
    queryKey: ["reports", "monitor"],
    queryFn: async (): Promise<AgentMonitorRow[]> => {
      const staff = await iamApi.staff();
      const rows = await Promise.all(
        staff.map(async (s) => {
          try {
            const m = await reportsApi.agentMonitor(s.id);
            return { staff: s, active_sessions: m.active_sessions, count: m.count };
          } catch {
            // 個別坐席查詢失敗不拖垮整體監控
            return { staff: s, active_sessions: [], count: 0 };
          }
        }),
      );
      return rows.sort((a, b) => b.count - a.count);
    },
    refetchInterval: REFETCH_MS,
  });

  const rows = monitor.data ?? [];
  const activeRows = rows.filter((r) => r.count > 0);
  const totalSessions = rows.reduce((sum, r) => sum + r.count, 0);
  const busyAgents = activeRows.length;

  return (
    <div className="space-y-4">
      {/* KPI 列 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label={t("reports.kpiActiveSessions")}
          value={monitor.isLoading ? "…" : String(totalSessions)}
        />
        <KpiCard
          label={t("reports.kpiBusyAgents")}
          value={monitor.isLoading ? "…" : String(busyAgents)}
          hint={t("reports.ofTotalAgents", { count: rows.length })}
        />
        <KpiCard label={t("reports.kpiTotalAgents")} value={monitor.isLoading ? "…" : String(rows.length)} />
        <Card>
          <CardContent className="flex flex-col justify-center p-4">
            <p className="text-xs text-muted-foreground">{t("reports.autoRefresh")}</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium">
              <RefreshCw
                className={`h-3.5 w-3.5 ${monitor.isFetching ? "animate-spin text-primary" : "text-muted-foreground"}`}
              />
              {t("reports.everySeconds", { s: REFETCH_MS / 1000 })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 各坐席活躍會話 */}
      <SectionCard title={t("reports.monitorTitle")}>
        <QueryState
          isLoading={monitor.isLoading}
          isError={monitor.isError}
          isEmpty={activeRows.length === 0}
          onRetry={() => monitor.refetch()}
          emptyText={t("reports.emptyMonitor")}
          skeletonHeight={220}
        >
          <div className="space-y-4">
            {activeRows.map((row) => (
              <div key={row.staff.id} className="rounded-lg border border-border">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Circle className="h-2.5 w-2.5 fill-success text-success" />
                    <span className="text-sm font-medium">
                      {row.staff.display_name || t("reports.unknownAgent")}
                    </span>
                    {row.staff.status && (
                      <Badge variant="outline" className="text-[10px]">
                        {row.staff.status}
                      </Badge>
                    )}
                  </div>
                  <Badge variant="secondary">{t("reports.sessionCount", { count: row.count })}</Badge>
                </div>
                <div className="divide-y divide-border/50">
                  {row.active_sessions.map((s) => (
                    <div key={s.session_id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">
                            {t(`reports.sessionStatus_${s.status}`, s.status)}
                          </Badge>
                          {s.handler_type && (
                            <span className="text-xs text-muted-foreground">{s.handler_type}</span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {s.last_message
                            ? `${s.last_message.sender_type}: ${s.last_message.content}`
                            : t("reports.noMessages")}
                        </p>
                      </div>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {fmtTime(s.updated_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </QueryState>
      </SectionCard>
    </div>
  );
}
