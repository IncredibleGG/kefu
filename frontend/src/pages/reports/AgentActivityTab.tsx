/** 坐席工時 / 活動報表分頁(對齊 LiveChat 的 Agent activity / work time):
 *  逐坐席的處理會話數、送出訊息數、活躍小時(工時近似)、首末活動、平均首應 / 處理時長,
 *  以及逐日活動趨勢。並在同頁附「排程 / 訂閱式報表」管理 UI(列表 / 建 / 刪 / 啟停)。
 *
 *  資料層:後端 GET /api/v1/reporting/agent-activity?days=N(report.view、租戶隔離、
 *  常數次 SQL 聚合、無 N+1);排程訂閱走 /api/v1/reporting/schedules CRUD。
 *  就地以 @/api/client 的 call() 取用(不新增 api 模組檔);沿用 reports/_shared 元件與範式。 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { CalendarClock, Clock, Mail, Plus, Trash2, Users } from "lucide-react";
import { call } from "@/api/client";
import { fmtDuration } from "@/api/quality";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { KpiCard, SectionCard, QueryState, TOOLTIP_STYLE } from "./_shared";

type Days = 7 | 30 | 90;

/** 逐坐席活動明細(後端 agent-activity.agents 的一列) */
interface AgentActivityItem {
  staff_id: string;
  display_name: string | null;
  handled_sessions: number;
  sent_messages: number;
  active_hours: number;
  first_activity: string | null;
  last_activity: string | null;
  avg_first_response_seconds: number | null;
  avg_handle_seconds: number | null;
}

/** 逐日活動(訊息數 + 活躍坐席數) */
interface DailyActivity {
  day: string;
  messages: number;
  active_agents: number;
}

interface AgentActivityReport {
  days: number;
  agents: AgentActivityItem[];
  daily: DailyActivity[];
}

/** 排程 / 訂閱式報表 */
type ReportType = "overview" | "agents" | "sales" | "satisfaction" | "activity";
type Frequency = "daily" | "weekly" | "monthly";
type ReportFormat = "summary" | "csv";

interface ReportSchedule {
  id: string;
  name: string;
  report_type: ReportType;
  frequency: Frequency;
  recipients: string[];
  format: ReportFormat;
  last_run_at: string | null;
  next_run_at: string | null;
  is_active: boolean;
  created_at?: string | null;
}

interface ScheduleInput {
  name: string;
  report_type: ReportType;
  frequency: Frequency;
  recipients: string[];
  format: ReportFormat;
  is_active: boolean;
}

const REPORT_TYPES: ReportType[] = ["overview", "agents", "sales", "satisfaction", "activity"];
const FREQUENCIES: Frequency[] = ["daily", "weekly", "monthly"];
const FORMATS: ReportFormat[] = ["summary", "csv"];

/** 就地 API(不新增 api 模組檔;沿用 client.call 的信封 / Bearer / mock 處理) */
const activityApi = {
  activity: (days: number) =>
    call<AgentActivityReport>({
      path: "/api/v1/reporting/agent-activity",
      params: { days },
      real: true,
      mock: async () => ({ days, agents: [], daily: [] }),
    }),
  listSchedules: () =>
    call<ReportSchedule[]>({
      path: "/api/v1/reporting/schedules",
      real: true,
      mock: async () => [],
    }),
  createSchedule: (body: ScheduleInput) =>
    call<ReportSchedule>({ path: "/api/v1/reporting/schedules", method: "POST", body, real: true }),
  updateSchedule: (id: string, body: Partial<ScheduleInput>) =>
    call<ReportSchedule>({
      path: `/api/v1/reporting/schedules/${id}`,
      method: "PATCH",
      body,
      real: true,
    }),
  deleteSchedule: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `/api/v1/reporting/schedules/${id}`,
      method: "DELETE",
      real: true,
    }),
};

/** ISO 時間 → 本地可讀字串;空值 → 破折號。 */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** 收件人輸入(逗號 / 分號 / 空白分隔)→ 去空白去重陣列。 */
function parseRecipients(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const v = part.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function AgentActivityTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [days, setDays] = useState<Days>(30);

  const q = useQuery({
    queryKey: ["reports", "agent-activity", days],
    queryFn: () => activityApi.activity(days),
  });

  const agents = q.data?.agents ?? [];
  const daily = q.data?.daily ?? [];

  // KPI:活躍坐席、送出訊息總數、處理會話總數、活躍工時總和(小時)
  const totalMessages = agents.reduce((s, a) => s + a.sent_messages, 0);
  const totalSessions = agents.reduce((s, a) => s + a.handled_sessions, 0);
  const totalActiveHours = agents.reduce((s, a) => s + a.active_hours, 0);

  const msgLabel = t("agentActivity.chartMessages", { defaultValue: "送出訊息" });
  const sessLabel = t("agentActivity.chartSessions", { defaultValue: "處理會話" });
  const dayMsgLabel = t("agentActivity.chartDailyMessages", { defaultValue: "每日訊息" });

  // 逐坐席圖(前 10 名,依送出訊息排序)
  const agentChart = useMemo(
    () =>
      [...agents]
        .sort((a, b) => b.sent_messages - a.sent_messages)
        .slice(0, 10)
        .map((a) => ({
          name: a.display_name ?? t("agentActivity.unknownAgent", { defaultValue: "未知坐席" }),
          [msgLabel]: a.sent_messages,
          [sessLabel]: a.handled_sessions,
        })),
    [agents, msgLabel, sessLabel, t],
  );

  // 逐日圖
  const dailyChart = useMemo(
    () =>
      daily.map((d) => ({
        name: d.day.slice(5, 10), // MM-DD
        [dayMsgLabel]: d.messages,
      })),
    [daily, dayMsgLabel],
  );

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

  return (
    <div className="space-y-4">
      {/* 標題列 + 天數切換 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Clock className="h-4 w-4 text-primary" />
            {t("agentActivity.title", { defaultValue: "坐席工時 / 活動" })}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("agentActivity.subtitle", {
              defaultValue: "由訊息 / 會話時間戳推導的坐席活動與近似工時",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DayButton value={7} label={t("agentActivity.days7", { defaultValue: "近 7 天" })} />
          <DayButton value={30} label={t("agentActivity.days30", { defaultValue: "近 30 天" })} />
          <DayButton value={90} label={t("agentActivity.days90", { defaultValue: "近 90 天" })} />
        </div>
      </div>

      {/* KPI 列 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label={t("agentActivity.kpiActiveAgents", { defaultValue: "活躍坐席" })}
          value={q.isLoading ? "…" : String(agents.length)}
        />
        <KpiCard
          label={t("agentActivity.kpiMessages", { defaultValue: "送出訊息總數" })}
          value={q.isLoading ? "…" : String(totalMessages)}
        />
        <KpiCard
          label={t("agentActivity.kpiSessions", { defaultValue: "處理會話總數" })}
          value={q.isLoading ? "…" : String(totalSessions)}
        />
        <KpiCard
          label={t("agentActivity.kpiActiveHours", { defaultValue: "活躍工時(近似)" })}
          value={q.isLoading ? "…" : t("agentActivity.hoursN", { count: totalActiveHours, defaultValue: `${totalActiveHours} 小時` })}
        />
      </div>

      {/* 逐坐席活動圖 */}
      <SectionCard title={t("agentActivity.byAgentTitle", { defaultValue: "各坐席活動(前 10)" })}>
        <QueryState
          isLoading={q.isLoading}
          isError={q.isError}
          isEmpty={agentChart.length === 0}
          onRetry={() => q.refetch()}
          emptyText={t("agentActivity.empty", { defaultValue: "近期尚無坐席活動" })}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={agentChart} margin={{ left: -20, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip cursor={{ fill: "hsl(var(--accent))" }} contentStyle={TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey={msgLabel} fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
              <Bar dataKey={sessLabel} fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </QueryState>
      </SectionCard>

      {/* 逐日活動趨勢 */}
      <SectionCard title={t("agentActivity.dailyTitle", { defaultValue: "逐日活動趨勢" })}>
        <QueryState
          isLoading={q.isLoading}
          isError={q.isError}
          isEmpty={dailyChart.length === 0}
          onRetry={() => q.refetch()}
          emptyText={t("agentActivity.empty", { defaultValue: "近期尚無坐席活動" })}
          skeletonHeight={220}
        >
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={dailyChart} margin={{ left: -20, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip cursor={{ fill: "hsl(var(--accent))" }} contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey={dayMsgLabel} fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </QueryState>
      </SectionCard>

      {/* 逐坐席明細表 */}
      <SectionCard title={t("agentActivity.tableTitle", { defaultValue: "坐席活動明細" })}>
        <QueryState
          isLoading={q.isLoading}
          isError={q.isError}
          isEmpty={agents.length === 0}
          onRetry={() => q.refetch()}
          emptyText={t("agentActivity.empty", { defaultValue: "近期尚無坐席活動" })}
          skeletonHeight={200}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">
                    {t("agentActivity.colAgent", { defaultValue: "坐席" })}
                  </th>
                  <th className="py-2 pr-4 text-right font-medium">
                    {t("agentActivity.colSessions", { defaultValue: "處理會話" })}
                  </th>
                  <th className="py-2 pr-4 text-right font-medium">
                    {t("agentActivity.colMessages", { defaultValue: "送出訊息" })}
                  </th>
                  <th className="py-2 pr-4 text-right font-medium">
                    {t("agentActivity.colActiveHours", { defaultValue: "活躍工時" })}
                  </th>
                  <th className="py-2 pr-4 text-right font-medium">
                    {t("agentActivity.colFirstResponse", { defaultValue: "平均首應" })}
                  </th>
                  <th className="py-2 pr-4 text-right font-medium">
                    {t("agentActivity.colHandle", { defaultValue: "平均處理" })}
                  </th>
                  <th className="py-2 text-right font-medium">
                    {t("agentActivity.colLastActivity", { defaultValue: "最後活動" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.staff_id} className="border-b border-border/50">
                    <td className="py-2 pr-4">
                      {a.display_name ?? t("agentActivity.unknownAgent", { defaultValue: "未知坐席" })}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{a.handled_sessions}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{a.sent_messages}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{a.active_hours}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {fmtDuration(a.avg_first_response_seconds)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {fmtDuration(a.avg_handle_seconds)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {fmtDateTime(a.last_activity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </SectionCard>

      {/* 排程 / 訂閱式報表管理 */}
      <ScheduleManager qc={qc} />
    </div>
  );
}

/** 排程 / 訂閱式報表管理:列表 + 建立 + 刪除 + 啟停。 */
function ScheduleManager({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation();

  const schedules = useQuery({
    queryKey: ["reports", "schedules"],
    queryFn: () => activityApi.listSchedules(),
  });

  const [name, setName] = useState("");
  const [reportType, setReportType] = useState<ReportType>("overview");
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [format, setFormat] = useState<ReportFormat>("summary");
  const [recipients, setRecipients] = useState("");

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["reports", "schedules"] });

  const createMut = useMutation({
    mutationFn: (body: ScheduleInput) => activityApi.createSchedule(body),
    onSuccess: () => {
      setName("");
      setRecipients("");
      invalidate();
    },
  });
  const toggleMut = useMutation({
    mutationFn: (v: { id: string; is_active: boolean }) =>
      activityApi.updateSchedule(v.id, { is_active: v.is_active }),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => activityApi.deleteSchedule(id),
    onSuccess: invalidate,
  });

  const list = schedules.data ?? [];

  const typeLabel = (rt: ReportType) =>
    t(`agentActivity.type.${rt}`, {
      defaultValue: {
        overview: "總覽",
        agents: "坐席績效",
        sales: "銷售追蹤",
        satisfaction: "滿意度",
        activity: "坐席活動",
      }[rt],
    });
  const freqLabel = (f: Frequency) =>
    t(`agentActivity.freq.${f}`, {
      defaultValue: { daily: "每日", weekly: "每週", monthly: "每月" }[f],
    });

  const canSubmit = name.trim().length > 0 && parseRecipients(recipients).length > 0 && !createMut.isPending;

  const onCreate = () => {
    if (!canSubmit) return;
    createMut.mutate({
      name: name.trim(),
      report_type: reportType,
      frequency,
      format,
      recipients: parseRecipients(recipients),
      is_active: true,
    });
  };

  const selectClass =
    "h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <SectionCard title={t("agentActivity.schedulesTitle", { defaultValue: "排程 / 訂閱式報表" })}>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("agentActivity.schedulesHint", {
          defaultValue: "定期把選定報表寄到指定信箱(需已設定 email 渠道 SMTP)。",
        })}
      </p>

      {/* 建立表單 */}
      <div className="mb-4 grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("agentActivity.fieldName", { defaultValue: "名稱" })}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("agentActivity.namePlaceholder", { defaultValue: "例:每週總覽" })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("agentActivity.fieldType", { defaultValue: "報表類型" })}
          </label>
          <select
            className={selectClass}
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ReportType)}
          >
            {REPORT_TYPES.map((rt) => (
              <option key={rt} value={rt}>
                {typeLabel(rt)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("agentActivity.fieldFrequency", { defaultValue: "頻率" })}
          </label>
          <select
            className={selectClass}
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as Frequency)}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {freqLabel(f)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {t("agentActivity.fieldFormat", { defaultValue: "格式" })}
          </label>
          <select
            className={selectClass}
            value={format}
            onChange={(e) => setFormat(e.target.value as ReportFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f === "csv"
                  ? t("agentActivity.formatCsv", { defaultValue: "CSV" })
                  : t("agentActivity.formatSummary", { defaultValue: "摘要" })}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label className="text-xs text-muted-foreground">
            {t("agentActivity.fieldRecipients", { defaultValue: "收件人(逗號分隔)" })}
          </label>
          <Input
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="ops@example.com, boss@example.com"
          />
        </div>
        <div className="flex items-end">
          <Button onClick={onCreate} disabled={!canSubmit} className="w-full sm:w-auto">
            <Plus className="h-4 w-4" />
            {t("agentActivity.create", { defaultValue: "新增訂閱" })}
          </Button>
        </div>
      </div>

      {/* 訂閱列表 */}
      <QueryState
        isLoading={schedules.isLoading}
        isError={schedules.isError}
        isEmpty={list.length === 0}
        onRetry={() => schedules.refetch()}
        emptyText={t("agentActivity.schedulesEmpty", { defaultValue: "尚無排程訂閱" })}
        skeletonHeight={160}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-4 font-medium">
                  {t("agentActivity.colScheduleName", { defaultValue: "名稱" })}
                </th>
                <th className="py-2 pr-4 font-medium">
                  {t("agentActivity.colScheduleType", { defaultValue: "類型" })}
                </th>
                <th className="py-2 pr-4 font-medium">
                  {t("agentActivity.colScheduleFreq", { defaultValue: "頻率" })}
                </th>
                <th className="py-2 pr-4 font-medium">
                  {t("agentActivity.colScheduleRecipients", { defaultValue: "收件人" })}
                </th>
                <th className="py-2 pr-4 font-medium">
                  {t("agentActivity.colScheduleNextRun", { defaultValue: "下次執行" })}
                </th>
                <th className="py-2 pr-4 text-center font-medium">
                  {t("agentActivity.colScheduleActive", { defaultValue: "啟用" })}
                </th>
                <th className="py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="border-b border-border/50">
                  <td className="py-2 pr-4 font-medium">{s.name}</td>
                  <td className="py-2 pr-4">
                    <Badge variant="outline" className="text-[10px]">
                      {typeLabel(s.report_type)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <CalendarClock className="h-3.5 w-3.5" />
                      {freqLabel(s.frequency)}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className="inline-flex items-center gap-1 text-muted-foreground"
                      title={s.recipients.join(", ")}
                    >
                      <Mail className="h-3.5 w-3.5" />
                      {t("agentActivity.recipientsN", {
                        count: s.recipients.length,
                        defaultValue: `${s.recipients.length} 位`,
                      })}
                    </span>
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-muted-foreground">
                    {fmtDateTime(s.next_run_at)}
                  </td>
                  <td className="py-2 pr-4 text-center">
                    <Switch
                      checked={s.is_active}
                      onCheckedChange={(v) => toggleMut.mutate({ id: s.id, is_active: v })}
                      aria-label={t("agentActivity.colScheduleActive", { defaultValue: "啟用" })}
                    />
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMut.mutate(s.id)}
                      aria-label={t("agentActivity.delete", { defaultValue: "刪除" })}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>

      {/* 未有活躍坐席時的柔性提示(避免空白頁面誤解為壞掉) */}
      {list.length === 0 && !schedules.isLoading && (
        <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          {t("agentActivity.schedulesTip", {
            defaultValue: "建立訂閱後,系統會依頻率自動寄出報表。",
          })}
        </p>
      )}
    </SectionCard>
  );
}
