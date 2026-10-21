import { Link } from "react-router-dom";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  Legend,
  BarChart,
  Bar,
} from "recharts";
import {
  Users,
  MessagesSquare,
  Clock,
  Smile,
  ArrowRight,
  AlertCircle,
  Rocket,
  CheckCircle2,
  Radio,
  Code2,
  BookOpen,
  Bot,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/api/hooks";
import { onboardingApi, onboardingKeys } from "@/api/onboarding";

const KPI_ICONS = [MessagesSquare, Users, Clock, Smile];
const PIE_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

/** 儀表板顯示字串的繁中預設值:reportApi.dashboard 只回穩定 key,顯示字串一律走
 *  t("dashboard.*", { defaultValue })。真 locale 檔補齊 dashboard.* 前以下列繁中回退,
 *  與既有 zh-Hant 顯示完全一致(零回歸);繁中源字串同步登錄於 locales/_pending/dashi18n.json。
 *  插值採 i18next 的 {{var}} 語法。 */
const KPI_LABEL_DEFAULTS: Record<string, string> = {
  sessions_today: "今日會話量",
  online_agents: "在線坐席",
  queue_wait: "佇列等待",
  csat: "滿意度 CSAT",
};
const KPI_HINT_DEFAULTS: Record<string, string> = {
  cumulative: "累計 {{total}}",
  of_total: "共 {{total}} 位",
  avg_wait: "平均 {{seconds}}s",
  no_wait_data: "無等待資料",
  responses: "{{count}} 份評分",
};
const STATUS_DEFAULTS: Record<string, string> = {
  open: "進行中",
  queued: "排隊中",
  closed: "已結束",
};

/** onboarding 各步驟的展示中繼資料:圖示、文案鍵(附繁中 defaultValue)、未完成時的前往連結。
 *  key 對齊後端 /onboarding/status 回傳的 step.key。 */
interface OnboardingStepMeta {
  icon: LucideIcon;
  titleKey: string;
  title: string;
  descKey: string;
  desc: string;
  to: string;
}

const ONBOARDING_STEP_META: Record<string, OnboardingStepMeta> = {
  channel: {
    icon: Radio,
    titleKey: "onboarding.step.channel.title",
    title: "建立第一個渠道",
    descKey: "onboarding.step.channel.desc",
    desc: "接上網站聊天、Telegram 或 Email,開始接收訪客訊息。",
    to: "/channels",
  },
  widget: {
    icon: Code2,
    titleKey: "onboarding.step.widget.title",
    title: "安裝網站聊天小工具",
    descKey: "onboarding.step.widget.desc",
    desc: "建立 web 渠道並嵌入你的網站,讓訪客直接對話。",
    to: "/channels",
  },
  knowledge: {
    icon: BookOpen,
    titleKey: "onboarding.step.knowledge.title",
    title: "建立知識庫",
    descKey: "onboarding.step.knowledge.desc",
    desc: "上傳文件或問答,讓 AI 依你的內容準確回答。",
    to: "/knowledge",
  },
  ai: {
    icon: Bot,
    titleKey: "onboarding.step.ai.title",
    title: "設定 AI 代理",
    descKey: "onboarding.step.ai.desc",
    desc: "選擇模型與知識庫,啟用自動回覆與轉真人規則。",
    to: "/ai",
  },
  staff: {
    icon: Users,
    titleKey: "onboarding.step.staff.title",
    title: "邀請團隊成員",
    descKey: "onboarding.step.staff.desc",
    desc: "新增坐席一起處理對話,不再只有管理員一人。",
    to: "/settings?tab=staff",
  },
  channel_live: {
    icon: Zap,
    titleKey: "onboarding.step.channel_live.title",
    title: "啟用渠道",
    descKey: "onboarding.step.channel_live.desc",
    desc: "把渠道設為啟用,正式對外開始接收對話。",
    to: "/channels",
  },
};

/** 新手 onboarding 首次使用清單卡(對齊 LiveChat Home 的 to-do):進度條 + 逐步引導。
 *  全部完成(或尚無資料 / 載入失敗)則不顯示,避免干擾老租戶。 */
function OnboardingCard() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: onboardingKeys.status,
    queryFn: () => onboardingApi.status(),
  });

  // 尚未取得資料時不佔版面;全部完成則隱藏整張卡。
  if (!data || data.total <= 0 || data.done_count >= data.total) return null;

  const pct = Math.round((data.done_count / data.total) * 100);

  return (
    <Card className="mb-4 border-brand/30">
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-brand" />
            <CardTitle className="text-sm">{t("onboarding.title", { defaultValue: "開始設定" })}</CardTitle>
          </div>
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            {t("onboarding.progress", {
              defaultValue: "{{done}}/{{total}} 已完成",
              done: data.done_count,
              total: data.total,
            })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("onboarding.subtitle", { defaultValue: "完成這些步驟,讓你的客服系統正式上線。" })}
        </p>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-1">
          {data.steps.map((step) => {
            const meta = ONBOARDING_STEP_META[step.key];
            if (!meta) return null;
            const Icon = step.done ? CheckCircle2 : meta.icon;
            return (
              <li
                key={step.key}
                className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50"
              >
                <Icon className={cn("h-5 w-5 shrink-0", step.done ? "text-emerald-500" : "text-muted-foreground")} />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      step.done && "text-muted-foreground line-through",
                    )}
                  >
                    {t(meta.titleKey, { defaultValue: meta.title })}
                  </p>
                  <p className="text-xs text-muted-foreground">{t(meta.descKey, { defaultValue: meta.desc })}</p>
                </div>
                {!step.done && (
                  <Button variant="ghost" size="sm" asChild className="shrink-0">
                    <Link to={meta.to}>
                      {t("onboarding.goto", { defaultValue: "前往" })}
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Admin Console 總覽儀表板:KPI + 會話量趨勢 + 狀態分布 + 坐席接待,數據接 reporting。 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useDashboard();

  return (
    <PageShell
      title={t("core.dashboardTitle")}
      description={t("core.dashboardDescription")}
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to="/reports">
            {t("core.dashboardDetailReport")} <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      }
    >
      {/* 新手引導清單:僅新租戶(未完成)顯示,老租戶自動隱藏 */}
      <OnboardingCard />
      {isError ? (
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
      ) : isLoading || !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* KPI 卡片列 */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {data.kpi.map((k, i) => {
              const Icon = KPI_ICONS[i % KPI_ICONS.length];
              const hint = k.hintKey
                ? t(`dashboard.hint.${k.hintKey}`, {
                    ...k.hintParams,
                    defaultValue: KPI_HINT_DEFAULTS[k.hintKey] ?? "",
                  })
                : "";
              return (
                <Card key={k.key}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {t(`dashboard.kpi.${k.key}`, { defaultValue: KPI_LABEL_DEFAULTS[k.key] ?? k.key })}
                      </p>
                      <Icon className="h-4 w-4 text-muted-foreground/60" />
                    </div>
                    <p className="mt-1 text-2xl font-semibold tracking-tight">{k.value}</p>
                    {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* 會話量趨勢 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("core.dashboardDailyVolume")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.volumeSeries.length === 0 ? (
                <p className="py-12 text-center text-xs text-muted-foreground">{t("core.dashboardNoVolumeData")}</p>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={data.volumeSeries} margin={{ left: -20, right: 8 }}>
                    <defs>
                      <linearGradient id="dashVol" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="count"
                      name={t("dashboard.chart.volume", { defaultValue: "會話量" })}
                      stroke="hsl(var(--chart-1))"
                      fill="url(#dashVol)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 會話狀態分布 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t("core.dashboardStatusDistribution")}</CardTitle>
              </CardHeader>
              <CardContent>
                {data.statusBreakdown.length === 0 ? (
                  <p className="py-12 text-center text-xs text-muted-foreground">{t("core.dashboardNoData")}</p>
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie
                        data={data.statusBreakdown}
                        dataKey="value"
                        nameKey="statusKey"
                        innerRadius={55}
                        outerRadius={90}
                        paddingAngle={2}
                      >
                        {data.statusBreakdown.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(value, name) => [
                          value,
                          t(`dashboard.status.${String(name)}`, {
                            defaultValue: STATUS_DEFAULTS[String(name)] ?? String(name),
                          }),
                        ]}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 12 }}
                        formatter={(value) =>
                          t(`dashboard.status.${String(value)}`, {
                            defaultValue: STATUS_DEFAULTS[String(value)] ?? String(value),
                          })
                        }
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* 坐席接待量 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t("core.dashboardAgentReceptionTop")}</CardTitle>
              </CardHeader>
              <CardContent>
                {data.agentPerf.length === 0 ? (
                  <p className="py-12 text-center text-xs text-muted-foreground">{t("core.dashboardNoAgentData")}</p>
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={data.agentPerf} margin={{ left: -20, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                      <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
                      <Tooltip
                        cursor={{ fill: "hsl(var(--accent))" }}
                        contentStyle={{
                          background: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Bar
                        dataKey="handled"
                        name={t("dashboard.chart.reception", { defaultValue: "接待" })}
                        fill="hsl(var(--chart-1))"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </PageShell>
  );
}
