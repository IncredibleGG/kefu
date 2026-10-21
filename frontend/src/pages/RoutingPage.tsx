import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Hand,
  ListOrdered,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChannels, useSkillGroups, useStaffAdmin } from "@/api/hooks";
import {
  routing,
  ROUTING_STRATEGIES,
  type RoutingAgentLoad,
  type RoutingPolicyDto,
  type RoutingStrategy,
} from "@/api/routing";

/** 佇列/坐席即時輪詢間隔(毫秒)。 */
const POLL_MS = 8000;

const SELECT_CLS =
  "flex h-8 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** uuid 取前段供表格辨識用。 */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** 秒數格式化為 m:ss 或 h:mm:ss。 */
function fmtDur(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 依等待時長推導緊急度(後端佇列回應未帶 priority,故以等待時長近似)。 */
function urgencyKey(sec: number): "urgent" | "high" | "normal" {
  if (sec >= 180) return "urgent";
  if (sec >= 60) return "high";
  return "normal";
}
const URGENCY_VARIANT: Record<string, "destructive" | "warning" | "secondary"> = {
  urgent: "destructive",
  high: "warning",
  normal: "secondary",
};

/** 路由 / 佇列分派管理頁。 */
export function RoutingPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [selectedGroup, setSelectedGroup] = useState<string>(""); // "" = 全部 / 租戶預設
  const [live, setLive] = useState(true);
  const [opError, setOpError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const sgParam = selectedGroup || undefined;

  // 輔助查詢(既有 hooks;唯讀,供名稱映射)
  const { data: staff } = useStaffAdmin();
  const { data: groups } = useSkillGroups();
  const { data: channels } = useChannels();

  // 佇列 / 負載 / 策略(inline useQuery)
  const queueQ = useQuery({
    queryKey: ["routing", "queue", selectedGroup],
    queryFn: () => routing.queue(sgParam),
    refetchInterval: live ? POLL_MS : false,
  });
  const loadsQ = useQuery({
    queryKey: ["routing", "loads", selectedGroup],
    queryFn: () => routing.agentLoads(sgParam),
    refetchInterval: live ? POLL_MS : false,
  });
  const policiesQ = useQuery({
    queryKey: ["routing", "policies"],
    queryFn: () => routing.listPolicies(),
  });

  // 名稱映射
  const staffById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of staff ?? []) m.set(s.id, s.display_name);
    return m;
  }, [staff]);
  const groupName = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups ?? []) m.set(g.id, g.name);
    return (id: string | null) => (id ? m.get(id) ?? shortId(id) : t("routing.defaultScope"));
  }, [groups, t]);
  const channelName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of channels ?? []) m.set(c.id, c.name);
    return (id: string) => m.get(id) ?? shortId(id);
  }, [channels]);
  const staffName = (id: string) => staffById.get(id) ?? shortId(id);

  // 每秒推進 now,讓等待時長「即時」跳動
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 指派 / 認領 / 自動 mutation
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["routing"] });
    void qc.invalidateQueries({ queryKey: ["sessions"] }); // 讓工作台會話列表同步
  };
  const onErr = (e: unknown) =>
    setOpError(e instanceof Error ? e.message : t("routing.op.error"));
  const onOk = () => {
    setOpError(null);
    invalidate();
  };

  const autoMut = useMutation({
    mutationFn: (sessionId: string) => routing.autoAssign(sessionId),
    onSuccess: onOk,
    onError: onErr,
  });
  const claimMut = useMutation({
    mutationFn: (sessionId: string) => routing.claim(sessionId),
    onSuccess: onOk,
    onError: onErr,
  });
  const assignMut = useMutation({
    mutationFn: (v: { sessionId: string; staffId: string }) =>
      routing.assignTo(v.sessionId, v.staffId),
    onSuccess: onOk,
    onError: onErr,
  });
  const policyMut = useMutation({
    mutationFn: (body: { skill_group_id: string | null; strategy: RoutingStrategy; max_load: number }) =>
      routing.upsertPolicy(body),
    onSuccess: () => {
      setOpError(null);
      void qc.invalidateQueries({ queryKey: ["routing"] });
    },
    onError: onErr,
  });

  const rowBusy = (id: string) =>
    (autoMut.isPending && autoMut.variables === id) ||
    (claimMut.isPending && claimMut.variables === id) ||
    (assignMut.isPending && assignMut.variables?.sessionId === id);

  const sessions = queueQ.data?.sessions ?? [];
  const agents = loadsQ.data ?? [];

  return (
    <PageShell
      title={t("routing.title")}
      description={t("routing.description")}
      actions={
        <div className="flex items-center gap-3">
          <select
            className={SELECT_CLS}
            value={selectedGroup}
            onChange={(e) => setSelectedGroup(e.target.value)}
            aria-label={t("routing.filterGroup")}
          >
            <option value="">{t("routing.allGroups")}</option>
            {(groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={live} onCheckedChange={setLive} />
            {t("routing.live")}
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void queueQ.refetch();
              void loadsQ.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4" /> {t("routing.refresh")}
          </Button>
        </div>
      }
    >
      {opError && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{opError}</span>
        </div>
      )}

      <PolicyCard
        scopeLabel={selectedGroup ? groupName(selectedGroup) : t("routing.defaultScope")}
        policies={policiesQ.data}
        loading={policiesQ.isLoading}
        selectedGroup={selectedGroup}
        groupName={groupName}
        saving={policyMut.isPending}
        onSave={(strategy, maxLoad) =>
          policyMut.mutate({ skill_group_id: selectedGroup || null, strategy, max_load: maxLoad })
        }
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.7fr_1fr]">
        {/* 佇列視圖 */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ListOrdered className="h-4 w-4" /> {t("routing.queue.title")}
              <Badge variant="secondary">{queueQ.data?.count ?? 0}</Badge>
            </CardTitle>
            {queueQ.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-3 py-2.5 text-left font-medium">{t("routing.queue.colSession")}</th>
                    <th className="px-3 py-2.5 text-left font-medium">{t("routing.queue.colGroup")}</th>
                    <th className="px-3 py-2.5 text-left font-medium">{t("routing.queue.colChannel")}</th>
                    <th className="px-3 py-2.5 text-left font-medium">{t("routing.queue.colWait")}</th>
                    <th className="px-3 py-2.5 text-left font-medium">{t("routing.queue.colPriority")}</th>
                    <th className="px-3 py-2.5 text-right font-medium">{t("routing.queue.colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {queueQ.isLoading ? (
                    <tr>
                      <td colSpan={6} className="p-3">
                        <Skeleton className="h-24 w-full" />
                      </td>
                    </tr>
                  ) : queueQ.isError ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-xs text-destructive">
                        {t("routing.queue.loadError")}
                      </td>
                    </tr>
                  ) : sessions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                        {t("routing.queue.empty")}
                      </td>
                    </tr>
                  ) : (
                    sessions.map((s) => {
                      const waitSec = s.created_at
                        ? (now - Date.parse(s.created_at)) / 1000
                        : 0;
                      const uk = urgencyKey(waitSec);
                      const busy = rowBusy(s.session_id);
                      return (
                        <tr key={s.session_id} className="hover:bg-accent/40">
                          <td className="px-3 py-2.5 font-mono text-xs">{shortId(s.session_id)}</td>
                          <td className="px-3 py-2.5">{groupName(s.skill_group_id)}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">
                            {channelName(s.channel_id)}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums">
                            {s.created_at ? t("routing.queue.waited", { time: fmtDur(waitSec) }) : "—"}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge variant={URGENCY_VARIANT[uk]}>{t(`routing.priority.${uk}`)}</Badge>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => autoMut.mutate(s.session_id)}
                              >
                                {busy ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Zap className="h-4 w-4" />
                                )}
                                {t("routing.action.auto")}
                              </Button>
                              <AssignMenu
                                agents={agents}
                                staffName={staffName}
                                disabled={busy}
                                onPick={(staffId) =>
                                  assignMut.mutate({ sessionId: s.session_id, staffId })
                                }
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => claimMut.mutate(s.session_id)}
                              >
                                <Hand className="h-4 w-4" /> {t("routing.action.claim")}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* 坐席即時負載 */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4" /> {t("routing.loads.title")}
              <Badge variant="secondary">{agents.length}</Badge>
            </CardTitle>
            {loadsQ.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </CardHeader>
          <CardContent className="space-y-2.5">
            {loadsQ.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : loadsQ.isError ? (
              <p className="py-8 text-center text-xs text-destructive">{t("routing.loads.loadError")}</p>
            ) : agents.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">{t("routing.loads.empty")}</p>
            ) : (
              agents.map((a) => <AgentLoadRow key={a.staff_id} load={a} name={staffName(a.staff_id)} />)
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

/** 分派策略設定卡:選範圍(隨頂部技能組)→ 設策略 + 接待上限。 */
function PolicyCard({
  scopeLabel,
  policies,
  loading,
  selectedGroup,
  groupName,
  saving,
  onSave,
}: {
  scopeLabel: string;
  policies: RoutingPolicyDto[] | undefined;
  loading: boolean;
  selectedGroup: string;
  groupName: (id: string | null) => string;
  saving: boolean;
  onSave: (strategy: RoutingStrategy, maxLoad: number) => void;
}) {
  const { t } = useTranslation();
  const [strategy, setStrategy] = useState<RoutingStrategy>("least_load");
  const [maxLoad, setMaxLoad] = useState(5);

  // 範圍或策略資料變動 → 同步表單為該範圍現況
  useEffect(() => {
    const p = (policies ?? []).find((x) => (x.skill_group_id ?? "") === selectedGroup);
    setStrategy((p?.strategy as RoutingStrategy) ?? "least_load");
    setMaxLoad(p?.max_load ?? 5);
  }, [policies, selectedGroup]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <SlidersHorizontal className="h-4 w-4" /> {t("routing.policy.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t("routing.policy.scope")}</label>
            <div className="flex h-8 items-center rounded-md bg-muted px-3 text-sm font-medium">
              {scopeLabel}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t("routing.policy.strategy")}</label>
            <select
              className={SELECT_CLS}
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as RoutingStrategy)}
            >
              {ROUTING_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {t(`routing.strategy.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t("routing.policy.maxLoad")}</label>
            <input
              type="number"
              min={1}
              className={SELECT_CLS + " w-20"}
              value={maxLoad}
              onChange={(e) => setMaxLoad(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <Button size="sm" disabled={saving} onClick={() => onSave(strategy, maxLoad)}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("routing.policy.save")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t(`routing.strategy.${strategy}Hint`)}</p>

        {/* 已設定策略一覽 */}
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("routing.policy.configured")}
          </div>
          {loading ? (
            <div className="p-3">
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (policies ?? []).length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t("routing.policy.none")}
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {(policies ?? []).map((p) => (
                <li key={p.id} className="flex items-center justify-between px-3 py-2">
                  <span>{groupName(p.skill_group_id)}</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Badge variant="outline">{t(`routing.strategy.${p.strategy}`)}</Badge>
                    <span className="text-xs">{t("routing.policy.maxLoadShort", { n: p.max_load })}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** 單一坐席負載列:狀態點 + 負載進度條 + 忙/閒。 */
function AgentLoadRow({ load, name }: { load: RoutingAgentLoad; name: string }) {
  const { t } = useTranslation();
  const pct = load.max_load > 0 ? Math.min(100, (load.current_load / load.max_load) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 truncate">
          <StatusDot className="bg-success" />
          <span className="truncate">{name}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums text-xs text-muted-foreground">
            {load.current_load} / {load.max_load}
          </span>
          <Badge variant={load.available ? "success" : "warning"}>
            {load.available ? t("routing.loads.free") : t("routing.loads.full")}
          </Badge>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={load.available ? "h-full bg-success" : "h-full bg-destructive"}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** 手動指派選單:列出在線坐席(帶負載),點選即指派。 */
function AssignMenu({
  agents,
  staffName,
  disabled,
  onPick,
}: {
  agents: RoutingAgentLoad[];
  staffName: (id: string) => string;
  disabled: boolean;
  onPick: (staffId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <UserPlus className="h-4 w-4" /> {t("routing.action.assign")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-0">
        <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("routing.action.assignTo")}
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {agents.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("routing.loads.empty")}
            </p>
          ) : (
            agents.map((a) => (
              <button
                key={a.staff_id}
                type="button"
                onClick={() => {
                  onPick(a.staff_id);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <span className="flex items-center gap-2 truncate">
                  <StatusDot className="bg-success" />
                  <span className="truncate">{staffName(a.staff_id)}</span>
                </span>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {a.current_load}/{a.max_load}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
