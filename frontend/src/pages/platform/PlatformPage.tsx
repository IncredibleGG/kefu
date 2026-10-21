import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Users,
  MessagesSquare,
  Search,
  Plus,
  Power,
  PowerOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePlatformOverview, usePlatformTenants, usePlatformMutations } from "@/api/hooks";
import type { PlatformTenant } from "@/types";

/** 內建預設方案(對齊後端 seed_default_plans:free / pro / enterprise)。 */
const PLAN_OPTIONS = [
  { code: "free", name: "Free" },
  { code: "pro", name: "Pro" },
  { code: "enterprise", name: "Enterprise" },
];

const PAGE_SIZE = 20;

/** 平台總覽卡 */
function OverviewCards() {
  const { t } = useTranslation();
  const { data, isLoading } = usePlatformOverview();

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }
  if (!data) return null;

  const cards = [
    {
      icon: Building2,
      label: t("platform.overview.totalTenants"),
      value: data.tenants.total,
      hint: t("platform.overview.activeInactive", {
        active: data.tenants.active,
        inactive: data.tenants.inactive,
      }),
    },
    {
      icon: ShieldCheck,
      label: t("platform.overview.activeTenants"),
      value: data.tenants.active,
      hint: t("platform.overview.ofTotal", { total: data.tenants.total }),
    },
    { icon: Users, label: t("platform.overview.totalStaff"), value: data.staff_total },
    { icon: MessagesSquare, label: t("platform.overview.totalSessions"), value: data.session_total },
  ];

  const distribution = Object.entries(data.plan_distribution).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Icon className="h-4 w-4" />
                  <span className="text-xs font-medium">{c.label}</span>
                </div>
                <p className="mt-1.5 text-2xl font-semibold tabular-nums">{c.value}</p>
                {c.hint && <p className="mt-0.5 text-xs text-muted-foreground">{c.hint}</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>
      {distribution.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("platform.overview.planDistribution")}</span>
          {distribution.map(([code, count]) => (
            <Badge key={code} variant="secondary">
              {code === "none" ? t("platform.overview.noPlan") : code} · {count}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/** 開通新租戶對話框 */
function ProvisionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const { provision } = usePlatformMutations();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setSlug("");
    setAdminEmail("");
    setAdminPassword("");
    setAdminDisplayName("");
    setError(null);
  }

  const canSubmit =
    name.trim() && slug.trim() && adminEmail.trim() && adminPassword.length >= 6;

  async function submit() {
    setError(null);
    if (!canSubmit) {
      setError(t("platform.provision.errorRequired"));
      return;
    }
    try {
      await provision.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        admin_email: adminEmail.trim(),
        admin_password: adminPassword,
        admin_display_name: adminDisplayName.trim() || undefined,
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("platform.provision.errorFailed"));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("platform.provision.title")}</DialogTitle>
          <DialogDescription>{t("platform.provision.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="p-name">{t("platform.provision.name")}</Label>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("platform.provision.namePlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-slug">{t("platform.provision.slug")}</Label>
            <Input id="p-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme" className="font-mono" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="p-admin-name">{t("platform.provision.adminDisplayName")}</Label>
            <Input id="p-admin-name" value={adminDisplayName} onChange={(e) => setAdminDisplayName(e.target.value)} placeholder={t("platform.provision.adminDisplayNamePlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-email">{t("platform.provision.adminEmail")}</Label>
            <Input id="p-email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@acme.com" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-pass">{t("platform.provision.adminPassword")}</Label>
            <Input id="p-pass" type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder={t("platform.provision.adminPasswordPlaceholder")} autoComplete="new-password" />
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={provision.isPending || !canSubmit}>
            {provision.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {provision.isPending ? t("platform.provision.submitting") : t("platform.provision.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 單列租戶:方案指派 + 停用 / 啟用 */
function TenantRow({ tenant }: { tenant: PlatformTenant }) {
  const { t } = useTranslation();
  const { suspend, activate, setPlan } = usePlatformMutations();
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const busy = suspend.isPending || activate.isPending || setPlan.isPending;

  async function toggleActive() {
    if (tenant.is_active) {
      await suspend.mutateAsync(tenant.id);
      setConfirmSuspend(false);
    } else {
      await activate.mutateAsync(tenant.id);
    }
  }

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{tenant.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{tenant.slug}</div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={setPlan.isPending}>
              {tenant.plan ? tenant.plan.name : t("platform.tenants.noPlan")}
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("platform.tenants.assignPlan")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {PLAN_OPTIONS.map((p) => (
              <DropdownMenuItem
                key={p.code}
                onClick={() => setPlan.mutate({ id: tenant.id, body: { plan_code: p.code } })}
              >
                <span className="flex-1">{p.name}</span>
                {tenant.plan?.code === p.code && <Check className="h-4 w-4 text-brand" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
      <td className="px-3 py-2.5 text-center text-sm tabular-nums">{tenant.seat_count}</td>
      <td className="px-3 py-2.5 text-center text-sm tabular-nums">{tenant.session_count}</td>
      <td className="px-3 py-2.5 text-center">
        {tenant.is_active ? (
          <Badge variant="success">{t("platform.tenants.statusActive")}</Badge>
        ) : (
          <Badge variant="secondary">{t("platform.tenants.statusSuspended")}</Badge>
        )}
      </td>
      <td className="px-3 py-2.5 text-right">
        {tenant.is_active ? (
          confirmSuspend ? (
            <div className="flex items-center justify-end gap-1.5">
              <span className="text-xs text-muted-foreground">{t("platform.tenants.confirmSuspend")}</span>
              <Button variant="destructive" size="sm" disabled={busy} onClick={toggleActive}>
                {suspend.isPending ? t("platform.tenants.suspending") : t("platform.tenants.suspend")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmSuspend(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setConfirmSuspend(true)}>
              <PowerOff className="h-4 w-4" /> {t("platform.tenants.suspend")}
            </Button>
          )
        ) : (
          <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={toggleActive}>
            <Power className="h-4 w-4" /> {activate.isPending ? t("platform.tenants.activating") : t("platform.tenants.activate")}
          </Button>
        )}
      </td>
    </tr>
  );
}

/** 平台超級管理員後台:總覽 + 租戶列表 + 開通 / 停用啟用 / 指派方案。 */
export function PlatformPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const { data, isLoading } = usePlatformTenants({ q: q || undefined, page, size: PAGE_SIZE });

  const tenants = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <OverviewCards />

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t("platform.tenants.title")}</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                placeholder={t("platform.tenants.searchPlaceholder")}
                className="h-8 w-52 pl-8"
              />
            </div>
            <Button size="sm" onClick={() => setProvisionOpen(true)}>
              <Plus className="h-4 w-4" /> {t("platform.tenants.provisionButton")}
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : tenants.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Building2 className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t("platform.tenants.empty")}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">{t("platform.tenants.colTenant")}</th>
                      <th className="px-3 py-2 text-left font-medium">{t("platform.tenants.colPlan")}</th>
                      <th className="px-3 py-2 text-center font-medium">{t("platform.tenants.colSeats")}</th>
                      <th className="px-3 py-2 text-center font-medium">{t("platform.tenants.colSessions")}</th>
                      <th className="px-3 py-2 text-center font-medium">{t("platform.tenants.colStatus")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("platform.tenants.colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map((tn) => (
                      <TenantRow key={tn.id} tenant={tn} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("platform.tenants.pageInfo", { page, totalPages, total })}</span>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label={t("platform.tenants.prevPage")}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label={t("platform.tenants.nextPage")}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <ProvisionDialog open={provisionOpen} onOpenChange={setProvisionOpen} />
    </div>
  );
}
