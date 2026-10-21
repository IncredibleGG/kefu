/** 白牌轉售商帳單總覽頁(乾淨室新增頁;三大護城河之一)。
 *  資料來源:api/reseller.ts(對齊後端 billing.py 的轉售儀表板端點)。
 *  - 概覽 KPI:下游租戶數 / 生效訂閱 / 總用量 / 預估總帳單。
 *  - 圖表(Recharts):各租戶預估費用(長條)、用量分佈(圓餅)。
 *  - 下游租戶清單表:方案 / 狀態 / 用量 / 預估費用,可下鑽單租戶明細。
 *  - inline React Query;載入 / 錯誤 / 空齊全;非轉售商(403)優雅顯示而非崩。
 *  文案走 t("reseller.*")(收於 locales/_pending/reseller.json,待併入 common.json)。 */
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import {
  Building2,
  BadgeCheck,
  Gauge,
  Receipt,
  AlertCircle,
  ShieldAlert,
  ArrowLeft,
  Eye,
  UserPlus,
  Ban,
  Play,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/api/client";
import { resellerApi, rkeys } from "@/api/reseller";
import type {
  ChargeEstimate,
  ResellerTenantRow,
  UsageByKind,
  OnboardTenantResult,
} from "@/api/reseller";

/** Recharts 分類色(沿用全域 chart tokens) */
const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
} as const;

function shortId(id: string): string {
  return `#${id.slice(0, 8)}`;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatNum(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
}

/** KPI 卡片:標題 + 主數值 + 選填提示 + 圖示 */
function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Building2;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="h-4 w-4 text-brand" />
          <span>{label}</span>
        </div>
        <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function ResellerPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  // 招募對話框開關
  const [onboardOpen, setOnboardOpen] = useState(false);
  // 停用/啟用:進行中鎖(記正在切換的 tenant_id)、錯誤回饋、樂觀狀態覆寫
  const [busyTenant, setBusyTenant] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);
  const [activeOverrides, setActiveOverrides] = useState<Record<string, boolean>>({});

  const overview = useQuery({
    queryKey: rkeys.overview(),
    queryFn: () => resellerApi.overview(),
    // 認證/授權錯誤(401/403)不重試,避免非轉售商連打
    retry: (count, err) => {
      if (err instanceof ApiError && (err.httpStatus === 401 || err.httpStatus === 403)) return false;
      return count < 1;
    },
  });

  const kindLabel = (kind: string) => t(`reseller.kind.${kind}`, { defaultValue: kind });

  const data = overview.data;
  const tenants: ResellerTenantRow[] = data?.tenants ?? [];
  const totals: UsageByKind = data?.totals ?? {};

  // 幣別:取名下第一筆帳單幣別,無則 USD
  const currency = tenants[0]?.charges.currency ?? "USD";
  const estimatedTotal = useMemo(
    () => tenants.reduce((sum, tt) => sum + (tt.charges.total ?? 0), 0),
    [tenants],
  );
  const activeSubs = useMemo(
    () => tenants.filter((tt) => tt.subscription.status === "active").length,
    [tenants],
  );
  const totalUsage = useMemo(
    () => Object.values(totals).reduce((sum, v) => sum + (v ?? 0), 0),
    [totals],
  );

  // 各租戶預估費用(長條圖資料)
  const costData = useMemo(
    () =>
      tenants.map((tt) => ({
        name: tt.plan?.name ? `${tt.plan.name} ${shortId(tt.tenant_id)}` : shortId(tt.tenant_id),
        cost: Number((tt.charges.total ?? 0).toFixed(2)),
      })),
    [tenants],
  );

  // 用量分佈(圓餅圖資料)
  const usageData = useMemo(
    () =>
      Object.entries(totals)
        .filter(([, v]) => v > 0)
        .map(([kind, v]) => ({ name: kindLabel(kind), value: Number(v.toFixed(2)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [totals, t],
  );

  // 失效總覽 query(前綴比對,涵蓋各時間區間變體),讓新租戶/狀態變更立即反映
  const invalidateOverview = () => {
    void qc.invalidateQueries({ queryKey: ["reseller", "overview"] });
  };

  // 停用/啟用名下下游:停用需二次確認;成功後樂觀覆寫 + 失效總覽
  async function toggleActive(row: ResellerTenantRow, next: boolean) {
    const label = row.name ?? shortId(row.tenant_id);
    if (
      !next &&
      !window.confirm(
        t("reseller.confirmSuspend", {
          defaultValue: "確定要停用「{{name}}」嗎?停用後該租戶所有坐席將無法登入。",
          name: label,
        }),
      )
    ) {
      return;
    }
    setBusyTenant(row.tenant_id);
    setRowError(null);
    try {
      const res = next
        ? await resellerApi.activateTenant(row.tenant_id)
        : await resellerApi.suspendTenant(row.tenant_id);
      setActiveOverrides((m) => ({ ...m, [row.tenant_id]: res.is_active }));
      invalidateOverview();
    } catch (e) {
      setRowError({
        id: row.tenant_id,
        msg: e instanceof Error ? e.message : t("reseller.actionFailed", { defaultValue: "操作失敗,請重試" }),
      });
    } finally {
      setBusyTenant(null);
    }
  }

  const forbidden = overview.error instanceof ApiError && overview.error.httpStatus === 403;

  return (
    <PageShell title={t("reseller.pageTitle")} description={t("reseller.pageDescription")}>
      {/* 載入中 */}
      {overview.isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      ) : forbidden ? (
        /* 非轉售商:優雅顯示,不崩 */
        <Card className="mx-auto mt-10 max-w-lg border-warning/40 bg-warning/5">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <ShieldAlert className="h-10 w-10 text-warning" />
            <h2 className="text-lg font-semibold">{t("reseller.notResellerTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("reseller.notResellerDesc")}</p>
          </CardContent>
        </Card>
      ) : overview.isError ? (
        /* 其他錯誤 */
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="text-sm text-muted-foreground">{t("reseller.loadError")}</p>
          <button
            type="button"
            onClick={() => overview.refetch()}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            {t("reseller.retry")}
          </button>
        </div>
      ) : tenants.length === 0 ? (
        /* 空狀態:名下尚無租戶 */
        <Card className="mx-auto mt-10 max-w-lg">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground/50" />
            <h2 className="text-lg font-semibold">{t("reseller.empty")}</h2>
            <p className="text-sm text-muted-foreground">{t("reseller.emptyDesc")}</p>
            <Button className="mt-2" onClick={() => setOnboardOpen(true)}>
              <UserPlus className="h-4 w-4" /> {t("reseller.onboardBtn", { defaultValue: "開通下游客戶" })}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* KPI 列 */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard
              icon={Building2}
              label={t("reseller.kpiTenantCount")}
              value={formatNum(data?.tenant_count ?? tenants.length)}
              hint={t("reseller.kpiTenantHint")}
            />
            <KpiCard
              icon={BadgeCheck}
              label={t("reseller.kpiActiveSubs")}
              value={formatNum(activeSubs)}
              hint={t("reseller.kpiActiveHint", { count: tenants.length })}
            />
            <KpiCard
              icon={Gauge}
              label={t("reseller.kpiTotalUsage")}
              value={formatNum(totalUsage)}
              hint={t("reseller.kpiUsageHint", { count: Object.keys(totals).length })}
            />
            <KpiCard
              icon={Receipt}
              label={t("reseller.kpiEstimatedTotal")}
              value={formatMoney(estimatedTotal, currency)}
            />
          </div>

          {/* 下鑽:單租戶明細(選取時顯示於頂部) */}
          {selectedTenant && (
            <TenantDetail
              tenantId={selectedTenant}
              currency={currency}
              kindLabel={kindLabel}
              onBack={() => setSelectedTenant(null)}
            />
          )}

          {/* 圖表 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t("reseller.chartCostTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {costData.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">{t("reseller.chartEmpty")}</p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={costData} margin={{ left: -20, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                      <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                      <Tooltip
                        cursor={{ fill: "hsl(var(--accent))" }}
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number) => formatMoney(v, currency)}
                      />
                      <Bar
                        dataKey="cost"
                        name={t("reseller.cost")}
                        fill="hsl(var(--chart-1))"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t("reseller.chartUsageTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {usageData.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">{t("reseller.chartEmpty")}</p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie
                        data={usageData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={55}
                        outerRadius={90}
                        paddingAngle={2}
                      >
                        {usageData.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => formatNum(v)} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 下游租戶清單表 */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-sm">{t("reseller.tableTitle")}</CardTitle>
              <Button size="sm" onClick={() => setOnboardOpen(true)}>
                <UserPlus className="h-3.5 w-3.5" /> {t("reseller.onboardBtn", { defaultValue: "開通下游客戶" })}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-2 py-2 font-medium">{t("reseller.colTenant")}</th>
                      <th className="px-2 py-2 font-medium">{t("reseller.colPlan")}</th>
                      <th className="px-2 py-2 font-medium">{t("reseller.colStatus")}</th>
                      <th className="px-2 py-2 font-medium">{t("reseller.colUsage")}</th>
                      <th className="px-2 py-2 text-right font-medium">{t("reseller.colEstimated")}</th>
                      <th className="px-2 py-2 text-right font-medium">{t("reseller.colAction")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map((tt) => {
                      const usageEntries = Object.entries(tt.usage).filter(([, v]) => v > 0);
                      // 有效啟用狀態:樂觀覆寫 > 總覽回應 is_active > 預設啟用
                      const rowActive = activeOverrides[tt.tenant_id] ?? tt.is_active ?? true;
                      const busy = busyTenant === tt.tenant_id;
                      return (
                        <tr key={tt.tenant_id} className="border-b border-border/60 last:border-0">
                          <td className="px-2 py-2.5">
                            <div className="flex flex-col gap-0.5">
                              {tt.name && <span className="font-medium">{tt.name}</span>}
                              <span className="font-mono text-xs text-muted-foreground">{shortId(tt.tenant_id)}</span>
                            </div>
                          </td>
                          <td className="px-2 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <span>{tt.plan?.name ?? t("reseller.noPlan")}</span>
                              {tt.subscription.byo_key && (
                                <Badge variant="secondary">{t("reseller.byoKey")}</Badge>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={tt.subscription.status === "active" ? "success" : "secondary"}>
                                {tt.subscription.status}
                              </Badge>
                              {!rowActive && (
                                <Badge variant="destructive">{t("reseller.suspended", { defaultValue: "已停用" })}</Badge>
                              )}
                            </div>
                          </td>
                          <td className="max-w-[16rem] px-2 py-2.5">
                            {usageEntries.length === 0 ? (
                              <span className="text-xs text-muted-foreground">{t("reseller.noUsage")}</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {usageEntries
                                  .map(([kind, v]) => `${kindLabel(kind)} ${formatNum(v)}`)
                                  .join(" · ")}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2.5 text-right font-medium">
                            {formatMoney(tt.charges.total ?? 0, tt.charges.currency)}
                          </td>
                          <td className="px-2 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setSelectedTenant(tt.tenant_id)}
                              >
                                <Eye className="h-3.5 w-3.5" /> {t("reseller.viewDetail")}
                              </Button>
                              {rowActive ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:text-destructive"
                                  disabled={busy}
                                  onClick={() => void toggleActive(tt, false)}
                                >
                                  {busy ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Ban className="h-3.5 w-3.5" />
                                  )}
                                  {busy ? t("reseller.processing", { defaultValue: "處理中…" }) : t("reseller.suspend", { defaultValue: "停用" })}
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => void toggleActive(tt, true)}
                                >
                                  {busy ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Play className="h-3.5 w-3.5" />
                                  )}
                                  {busy ? t("reseller.processing", { defaultValue: "處理中…" }) : t("reseller.activate", { defaultValue: "啟用" })}
                                </Button>
                              )}
                            </div>
                            {rowError?.id === tt.tenant_id && (
                              <p className="mt-1 text-xs text-destructive">{rowError.msg}</p>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 招募對話框(受控;非轉售商狀態下無觸發入口故恆為關) */}
      <OnboardTenantDialog
        open={onboardOpen}
        onOpenChange={setOnboardOpen}
        onOnboarded={invalidateOverview}
      />
    </PageShell>
  );
}

/** 開通下游客戶對話框:表單 → onboardTenant → 顯示開通結果 + 交付憑證提醒。
 *  成功時透過 onOnboarded 讓父層失效總覽 query,使新租戶立即出現於清單。 */
function OnboardTenantDialog({
  open,
  onOpenChange,
  onOnboarded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onOnboarded: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OnboardTenantResult | null>(null);

  function reset() {
    setName("");
    setEmail("");
    setPassword("");
    setDisplayName("");
    setSlug("");
    setSubmitting(false);
    setError(null);
    setResult(null);
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset(); // 關閉時清空,下次重新開始
    onOpenChange(v);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const nm = name.trim();
    const em = email.trim();
    // 前端基本驗證(email 格式最終仍由後端 INVALID_EMAIL 把關)
    if (!nm) {
      setError(t("reseller.errNameRequired", { defaultValue: "請輸入下游名稱" }));
      return;
    }
    if (!em) {
      setError(t("reseller.errEmailRequired", { defaultValue: "請輸入管理員 email" }));
      return;
    }
    if (password.length < 6) {
      setError(t("reseller.errPasswordShort", { defaultValue: "密碼至少需 6 個字元" }));
      return;
    }
    setSubmitting(true);
    try {
      // 注意:不傳 reseller_tenant_id,後端由 JWT 自動帶入
      const res = await resellerApi.onboardTenant({
        name: nm,
        admin_email: em,
        admin_password: password,
        admin_display_name: displayName.trim() || undefined,
        slug: slug.trim() || undefined,
      });
      setResult(res);
      onOnboarded(); // 失效總覽 → 新租戶立即入列
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_EMAIL") {
        setError(t("reseller.errInvalidEmail", { defaultValue: "管理員 email 格式不正確" }));
      } else {
        setError(err instanceof Error ? err.message : t("reseller.onboardFailed", { defaultValue: "開通失敗,請重試" }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("reseller.onboardTitle", { defaultValue: "開通下游客戶" })}</DialogTitle>
          <DialogDescription>
            {t("reseller.onboardDesc", {
              defaultValue: "建立一個掛在你名下的下游租戶,並設定其首位管理員坐席。",
            })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          /* 開通結果 */
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="h-5 w-5" />
              <span className="text-sm font-medium">{t("reseller.onboardSuccess", { defaultValue: "下游客戶已開通" })}</span>
            </div>
            <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("reseller.nameLabel", { defaultValue: "下游名稱" })}</span>
                <span className="font-medium">{result.tenant.name}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("reseller.slugLabel", { defaultValue: "子網域 slug" })}</span>
                <span className="font-mono text-xs">{result.tenant.slug}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("reseller.adminEmail", { defaultValue: "管理員 email" })}</span>
                <span className="font-mono text-xs">{result.admin.email}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("reseller.credHint", {
                defaultValue: "請將上述帳號與你設定的初始密碼安全地交給客戶,並提醒其首次登入後立即修改密碼。",
              })}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t("reseller.done", { defaultValue: "完成" })}
              </Button>
              <Button onClick={reset}>
                <UserPlus className="h-4 w-4" /> {t("reseller.onboardAnother", { defaultValue: "再開通一個" })}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          /* 招募表單 */
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rs-name">{t("reseller.nameLabel", { defaultValue: "下游名稱" })}</Label>
              <Input
                id="rs-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                placeholder={t("reseller.namePlaceholder", { defaultValue: "例:Acme 客服" })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-email">{t("reseller.adminEmail", { defaultValue: "管理員 email" })}</Label>
              <Input
                id="rs-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                placeholder="admin@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-password">{t("reseller.adminPassword", { defaultValue: "初始密碼(至少 6 碼)" })}</Label>
              <Input
                id="rs-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-display">{t("reseller.displayName", { defaultValue: "顯示名稱(選填)" })}</Label>
              <Input
                id="rs-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-slug">{t("reseller.slugLabel", { defaultValue: "子網域 slug" })}</Label>
              <Input
                id="rs-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={submitting}
                placeholder="acme"
              />
              <p className="text-xs text-muted-foreground">{t("reseller.slugHint", { defaultValue: "不填則由名稱衍生" })}</p>
            </div>
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                {t("reseller.cancel", { defaultValue: "取消" })}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting
                  ? t("reseller.submitting", { defaultValue: "開通中…" })
                  : t("reseller.submit", { defaultValue: "開通" })}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 單租戶用量/帳單明細(下鑽;獨立 inline query,含載入/錯誤/空)。 */
function TenantDetail({
  tenantId,
  currency,
  kindLabel,
  onBack,
}: {
  tenantId: string;
  currency: string;
  kindLabel: (kind: string) => string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: rkeys.tenantUsage(tenantId),
    queryFn: () => resellerApi.tenantUsage(tenantId),
    retry: (count, err) => {
      if (err instanceof ApiError && (err.httpStatus === 401 || err.httpStatus === 403)) return false;
      return count < 1;
    },
  });

  const charges: ChargeEstimate | undefined = detail.data?.charges;
  const lineItems = charges?.line_items ?? [];
  const detailCurrency = charges?.currency ?? currency;

  return (
    <Card className="border-brand/40 bg-brand/5">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          {t("reseller.detailTitle")}
          <span className="font-mono text-xs text-muted-foreground">{shortId(tenantId)}</span>
          {detail.data?.subscription.byo_key && (
            <Badge variant="secondary">{t("reseller.byoKey")}</Badge>
          )}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> {t("reseller.back")}
        </Button>
      </CardHeader>
      <CardContent>
        {detail.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : detail.isError ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-muted-foreground">{t("reseller.loadError")}</p>
            <button
              type="button"
              onClick={() => detail.refetch()}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              {t("reseller.retry")}
            </button>
          </div>
        ) : lineItems.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("reseller.detailEmpty")}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2 font-medium">{t("reseller.colKind")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("reseller.colQuantity")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("reseller.colIncluded")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("reseller.colBillable")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("reseller.colUnitPrice")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("reseller.colAmount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => (
                    <tr key={li.kind} className="border-b border-border/60 last:border-0">
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1.5">
                          <span>{kindLabel(li.kind)}</span>
                          {li.self_funded && <Badge variant="info">{t("reseller.selfFunded")}</Badge>}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right">{formatNum(li.quantity)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{formatNum(li.included)}</td>
                      <td className="px-2 py-2 text-right">{formatNum(li.billable_quantity)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">
                        {formatMoney(li.unit_price, detailCurrency)}
                      </td>
                      <td className="px-2 py-2 text-right font-medium">
                        {formatMoney(li.amount, detailCurrency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* 帳單合計 */}
            <div className="mt-3 flex flex-col items-end gap-1 text-sm">
              <div className="flex w-full max-w-xs justify-between text-muted-foreground">
                <span>{t("reseller.baseFee")}</span>
                <span>{formatMoney(charges?.base_fee ?? 0, detailCurrency)}</span>
              </div>
              <div className="flex w-full max-w-xs justify-between text-muted-foreground">
                <span>{t("reseller.meteredTotal")}</span>
                <span>{formatMoney(charges?.metered_total ?? 0, detailCurrency)}</span>
              </div>
              <div className="flex w-full max-w-xs justify-between border-t border-border pt-1 font-semibold">
                <span>{t("reseller.total")}</span>
                <span>{formatMoney(charges?.total ?? 0, detailCurrency)}</span>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
