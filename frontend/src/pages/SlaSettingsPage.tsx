import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, X, Timer, AlertTriangle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSlaPolicies, useSlaBreaches, useSlaMutations } from "@/api/hooks";
import type { SlaPolicy } from "@/types";

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** 可作為 SLA 條件的會話情境鍵(對齊後端 _build_ctx)。 */
const COND_KEYS: { key: string; label: string }[] = [
  { key: "channel_type", label: "config.sla.condKey.channel_type" },
  { key: "status", label: "config.sla.condKey.status" },
  { key: "handler_type", label: "config.sla.condKey.handler_type" },
  { key: "tag", label: "config.sla.condKey.tag" },
];

type CondRow = { key: string; value: string };
type Draft = {
  id?: string;
  name: string;
  conditions: CondRow[];
  first_response_minutes: number;
  resolution_minutes: number;
  is_active: boolean;
  priority: number;
};

function policyToDraft(p: SlaPolicy): Draft {
  const conds = Object.entries(p.conditions ?? {}).map(([key, v]) => ({
    key,
    value: Array.isArray(v) ? v.join(", ") : String(v ?? ""),
  }));
  return {
    id: p.id,
    name: p.name,
    conditions: conds,
    first_response_minutes: p.first_response_minutes,
    resolution_minutes: p.resolution_minutes,
    is_active: p.is_active,
    priority: p.priority,
  };
}

function emptyDraft(): Draft {
  return {
    name: "",
    conditions: [],
    first_response_minutes: 15,
    resolution_minutes: 240,
    is_active: true,
    priority: 0,
  };
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** SLA 政策:政策 CRUD(條件、首回應/解決分鐘、啟用)+ 違約清單。 */
export function SlaSettingsPage() {
  const { t } = useTranslation();
  const { data: policies, isLoading } = useSlaPolicies();
  const { create, update, remove } = useSlaMutations();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;

  async function submit() {
    if (!draft) return;
    setError(null);
    try {
      const condEntries = draft.conditions
        .filter((c) => c.key && c.value.trim())
        .map((c) => {
          const parts = c.value.split(",").map((s) => s.trim()).filter(Boolean);
          return [c.key, parts.length > 1 ? parts : parts[0]] as const;
        });
      const conditions = condEntries.length ? Object.fromEntries(condEntries) : null;
      const body = {
        name: draft.name.trim(),
        conditions,
        first_response_minutes: Math.max(0, draft.first_response_minutes || 0),
        resolution_minutes: Math.max(0, draft.resolution_minutes || 0),
        is_active: draft.is_active,
        priority: Number.isFinite(draft.priority) ? draft.priority : 0,
      };
      if (draft.id) await update.mutateAsync({ id: draft.id, body });
      else await create.mutateAsync(body);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("config.common.saveFailed"));
    }
  }

  async function toggleActive(p: SlaPolicy) {
    try {
      await update.mutateAsync({ id: p.id, body: { is_active: !p.is_active } });
    } catch {
      /* 清單重取回復 */
    }
  }

  return (
    <PageShell
      title={t("config.sla.title")}
      description={t("config.sla.description")}
    >
      <Tabs defaultValue="policies">
        <div className="mb-4 flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="policies">
              <Timer className="h-3.5 w-3.5" /> {t("config.sla.tabPolicies")}
            </TabsTrigger>
            <TabsTrigger value="breaches">
              <AlertTriangle className="h-3.5 w-3.5" /> {t("config.sla.tabBreaches")}
            </TabsTrigger>
          </TabsList>
          <Button
            size="sm"
            onClick={() => {
              setError(null);
              setDraft(emptyDraft());
            }}
          >
            <Plus className="h-4 w-4" /> {t("config.sla.addPolicy")}
          </Button>
        </div>

        <TabsContent value="policies">
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="px-3 py-2.5 text-left font-medium">{t("config.sla.colPolicy")}</th>
                      <th className="px-3 py-2.5 text-left font-medium">{t("config.sla.colConditions")}</th>
                      <th className="px-3 py-2.5 text-center font-medium">{t("config.sla.colFirstResponse")}</th>
                      <th className="px-3 py-2.5 text-center font-medium">{t("config.sla.colResolution")}</th>
                      <th className="px-3 py-2.5 text-center font-medium">{t("config.sla.colPriority")}</th>
                      <th className="px-3 py-2.5 text-center font-medium">{t("config.common.colActive")}</th>
                      <th className="px-3 py-2.5 text-right font-medium">{t("config.common.colActions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {isLoading ? (
                      <tr>
                        <td colSpan={7} className="p-3">
                          <Skeleton className="h-24 w-full" />
                        </td>
                      </tr>
                    ) : (policies ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">
                          {t("config.sla.empty")}
                        </td>
                      </tr>
                    ) : (
                      (policies ?? []).map((p) => (
                        <tr key={p.id} className="hover:bg-accent/40">
                          <td className="px-3 py-2.5 font-medium">{p.name}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {Object.keys(p.conditions ?? {}).length === 0 ? (
                                <span className="text-xs text-muted-foreground">{t("config.sla.allSessions")}</span>
                              ) : (
                                Object.entries(p.conditions ?? {}).map(([k, v]) => (
                                  <Badge key={k} variant="secondary">
                                    {k}={Array.isArray(v) ? v.join("/") : String(v)}
                                  </Badge>
                                ))
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-center tabular-nums">
                            {t("config.sla.minutes", { minutes: p.first_response_minutes })}
                          </td>
                          <td className="px-3 py-2.5 text-center tabular-nums">
                            {t("config.sla.minutes", { minutes: p.resolution_minutes })}
                          </td>
                          <td className="px-3 py-2.5 text-center tabular-nums text-muted-foreground">
                            {p.priority}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex justify-center">
                              <Switch checked={p.is_active} onCheckedChange={() => toggleActive(p)} />
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("config.common.edit")}
                                onClick={() => {
                                  setError(null);
                                  setDraft(policyToDraft(p));
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("config.common.delete")}
                                className="text-destructive hover:text-destructive"
                                onClick={() => {
                                  if (confirm(t("config.sla.confirmDelete", { name: p.name }))) remove.mutate(p.id);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="breaches">
          <BreachList />
        </TabsContent>
      </Tabs>

      {/* 政策表單 */}
      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("config.sla.editPolicy") : t("config.sla.newPolicy")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="s-name">{t("config.sla.policyName")}</Label>
                <Input
                  id="s-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("config.sla.policyNamePlaceholder")}
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="s-first">{t("config.sla.firstResponseMinutes")}</Label>
                  <Input
                    id="s-first"
                    type="number"
                    value={draft.first_response_minutes}
                    onChange={(e) =>
                      setDraft({ ...draft, first_response_minutes: parseInt(e.target.value, 10) || 0 })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s-res">{t("config.sla.resolutionMinutes")}</Label>
                  <Input
                    id="s-res"
                    type="number"
                    value={draft.resolution_minutes}
                    onChange={(e) =>
                      setDraft({ ...draft, resolution_minutes: parseInt(e.target.value, 10) || 0 })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s-prio">{t("config.sla.priority")}</Label>
                  <Input
                    id="s-prio"
                    type="number"
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: parseInt(e.target.value, 10) || 0 })}
                  />
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">
                    {t("config.sla.conditionsLabel")}
                  </Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        conditions: [...draft.conditions, { key: COND_KEYS[0].key, value: "" }],
                      })
                    }
                  >
                    <Plus className="h-4 w-4" /> {t("config.common.condition")}
                  </Button>
                </div>
                {draft.conditions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("config.sla.noConditionHint")}</p>
                ) : (
                  draft.conditions.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        className={SELECT_CLS + " max-w-[160px]"}
                        value={c.key}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            conditions: draft.conditions.map((x, idx) =>
                              idx === i ? { ...x, key: e.target.value } : x,
                            ),
                          })
                        }
                      >
                        {COND_KEYS.map((k) => (
                          <option key={k.key} value={k.key}>{t(k.label)}</option>
                        ))}
                      </select>
                      <Input
                        value={c.value}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            conditions: draft.conditions.map((x, idx) =>
                              idx === i ? { ...x, value: e.target.value } : x,
                            ),
                          })
                        }
                        placeholder={t("config.sla.condValuePlaceholder")}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("config.common.removeCondition")}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            conditions: draft.conditions.filter((_, idx) => idx !== i),
                          })
                        }
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))
                )}
              </div>

              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <p className="text-sm">{t("config.sla.enablePolicy")}</p>
                  <p className="text-xs text-muted-foreground">{t("config.sla.enablePolicyHint")}</p>
                </div>
                <Switch
                  checked={draft.is_active}
                  onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
                />
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("config.common.cancel")}
            </Button>
            <Button onClick={submit} disabled={saving || !draft?.name.trim()}>
              {saving ? t("config.common.saving") : t("config.common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

/** 違約清單:讀 /sla/breaches。 */
function BreachList() {
  const { t } = useTranslation();
  const { data, isLoading } = useSlaBreaches(1, 50);
  const items = data?.items ?? [];

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-medium">{t("config.sla.breach.colSession")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("config.sla.breach.colStatus")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("config.sla.breach.colType")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("config.sla.breach.colFirstDue")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("config.sla.breach.colResolutionDue")}</th>
                <th className="px-3 py-2.5 text-left font-medium">{t("config.sla.breach.colUpdated")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="p-3">
                    <Skeleton className="h-24 w-full" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    {t("config.sla.breach.empty")}
                  </td>
                </tr>
              ) : (
                items.map((b) => (
                  <tr key={b.id} className="hover:bg-accent/40">
                    <td className="px-3 py-2.5 font-mono text-xs">{b.session_id.slice(0, 8)}…</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{b.status}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {b.breached_first && <Badge variant="destructive">{t("config.sla.breach.firstBreached")}</Badge>}
                        {b.breached_resolution && <Badge variant="destructive">{t("config.sla.breach.resolutionBreached")}</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {fmtDate(b.first_response_due)}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {fmtDate(b.resolution_due)}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{fmtDate(b.updated_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
