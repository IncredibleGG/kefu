/** 報表總覽分頁(乾淨室重整自原 ReportsPage 內容;移除 PageShell 由父層統一提供)。
 *  沿用 reportApi.overview() 聚合資料與 Recharts 圖表。
 *  在地化:reportApi.overview 只回穩定 key / 欄位,顯示字串一律走 t("reports.overview.*",
 *  { defaultValue })(對齊已修好的 DashboardPage);繁中源字串同步登錄於
 *  locales/_pending/overview2.json,真 locale 補齊前以下列繁中 defaultValue 回退(零回歸)。 */
import { useTranslation } from "react-i18next";
import { TrendingUp, TrendingDown, AlertCircle } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useReport } from "@/api/hooks";
import { cn } from "@/lib/utils";
import { CHART_COLORS, TOOLTIP_STYLE } from "./_shared";

/** KPI label 繁中回退(對應 reportApi.overview 的穩定 key)。 */
const KPI_LABEL_DEFAULTS: Record<string, string> = {
  total_sessions: "會話總數",
  ai_resolution: "AI 解決率",
  avg_wait: "平均等待",
  csat: "CSAT 滿意度",
};
/** 「越低越好」的 KPI:delta 上升代表變差,漲跌顏色語意需反轉(如平均等待)。
 *  其餘 KPI(會話量、AI 解決率、CSAT)皆為越高越好,不在此表即維持預設方向。 */
const KPI_LOWER_IS_BETTER: Record<string, boolean> = {
  avg_wait: true,
};
/** 圖表系列名繁中回退。 */
const CHART_DEFAULTS: Record<string, string> = {
  sessions: "會話量",
  ai_resolved: "AI 解決",
  satisfaction: "滿意度",
  reception: "接待",
};
/** 渠道分類名繁中回退(對應穩定 channelType)。 */
const CHANNEL_DEFAULTS: Record<string, string> = {
  web: "網頁",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  email: "Email",
  facebook: "Facebook",
  wechat: "微信",
  line: "LINE",
  other: "其他",
};

export function OverviewReportTab() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useReport();

  // 錯誤狀態(修正:先前 API 失敗因 data 為 undefined 而永久顯示骨架)
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-muted-foreground">{t("reports.loadError")}</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          {t("reports.retry")}
        </button>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  // 渠道 / 坐席分類名在地化(換顯示字串來源,不改數據流與圖表外觀)
  const channelLabel = (type: string) =>
    t(`reports.overview.channel.${type}`, { defaultValue: CHANNEL_DEFAULTS[type] ?? type });
  // 坐席未知(name 為 null)以 t() 在地化;真實坐席名為資料值原樣呈現
  const agentData = data.agentPerf.map((a) => ({
    name: a.name ?? t("reports.overview.unknownAgent", { defaultValue: "未知" }),
    handled: a.handled,
    satisfaction: a.satisfaction,
  }));

  return (
    <div className="space-y-4">
      {/* KPI 卡片列 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {data.kpi.map((k) => {
          const lowerIsBetter = KPI_LOWER_IS_BETTER[k.key] ?? false;
          // 箭頭方向反映實際數值升降(事實);顏色反映好壞(語意)。
          // 越低越好者(如平均等待):上升 = 負面(紅),下降 = 正面(綠)。
          const rising = k.delta >= 0;
          const positive = lowerIsBetter ? k.delta <= 0 : k.delta >= 0;
          return (
            <Card key={k.key}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">
                  {t(`reports.overview.kpi.${k.key}`, {
                    defaultValue: KPI_LABEL_DEFAULTS[k.key] ?? k.key,
                  })}
                </p>
                <p className="mt-1 text-2xl font-semibold tracking-tight">{k.value}</p>
                <p
                  className={cn(
                    "mt-1 flex items-center gap-1 text-xs",
                    positive ? "text-success" : "text-destructive",
                  )}
                >
                  {rising ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : (
                    <TrendingDown className="h-3 w-3" />
                  )}
                  {t("core.reportsVsLastWeek", { delta: Math.abs(k.delta) })}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* 趨勢圖 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("core.reportsTrend14d")}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.series.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">
              {t("reports.overview.emptySeries", { defaultValue: "尚無會話資料" })}
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={data.series} margin={{ left: -20, right: 8 }}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-2))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="g3" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-3))" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(var(--chart-3))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                {/* 左軸:會話量 / AI 解決(count);右軸:滿意度(百分比) */}
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={[0, 100]}
                  unit="%"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="count"
                  name={t("reports.overview.chart.sessions", { defaultValue: CHART_DEFAULTS.sessions })}
                  stroke="hsl(var(--chart-1))"
                  fill="url(#g1)"
                  strokeWidth={2}
                />
                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="ai_resolved"
                  name={t("reports.overview.chart.aiResolved", { defaultValue: CHART_DEFAULTS.ai_resolved })}
                  stroke="hsl(var(--chart-2))"
                  fill="url(#g2)"
                  strokeWidth={2}
                />
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="satisfaction"
                  name={t("reports.overview.chart.satisfaction", { defaultValue: CHART_DEFAULTS.satisfaction })}
                  stroke="hsl(var(--chart-3))"
                  fill="url(#g3)"
                  strokeWidth={2}
                  connectNulls
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 渠道分布 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("core.reportsChannelDistribution")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.channelBreakdown.length === 0 ? (
              <p className="py-12 text-center text-xs text-muted-foreground">
                {t("reports.overview.emptyChannel", { defaultValue: "尚無渠道資料" })}
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={data.channelBreakdown}
                    dataKey="value"
                    nameKey="channelType"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                  >
                    {data.channelBreakdown.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value, name) => [value, channelLabel(String(name))]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 12 }}
                    formatter={(value) => channelLabel(String(value))}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* 坐席績效 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("core.reportsAgentPerformance")}</CardTitle>
          </CardHeader>
          <CardContent>
            {agentData.length === 0 ? (
              <p className="py-12 text-center text-xs text-muted-foreground">
                {t("reports.overview.emptyAgents", { defaultValue: "尚無坐席績效資料" })}
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={agentData} margin={{ left: -20, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip cursor={{ fill: "hsl(var(--accent))" }} contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar
                    dataKey="handled"
                    name={t("reports.overview.chart.reception", { defaultValue: CHART_DEFAULTS.reception })}
                    fill="hsl(var(--chart-1))"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="satisfaction"
                    name={t("reports.overview.chart.satisfaction", { defaultValue: CHART_DEFAULTS.satisfaction })}
                    fill="hsl(var(--chart-3))"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
