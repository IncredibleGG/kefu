import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, X, Zap } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useAutomationCatalog,
  useAutomationRules,
  useAutomationMutations,
  useSkillGroups,
  useStaffAdmin,
  useTags,
  useCanned,
} from "@/api/hooks";
import type { AutomationCatalog, AutomationRule } from "@/types";

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

type CondDraft = { field: string; op: string; value: string };
type ActionDraft = { type: string; params: Record<string, string> };
type Draft = {
  id?: string;
  name: string;
  trigger_event: string;
  conditions: CondDraft[];
  actions: ActionDraft[];
  is_active: boolean;
  priority: number;
};

/** 由既有規則(value 可能是陣列 / 數字)反推表單字串。 */
function condValueToStr(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v == null) return "";
  return String(v);
}

function ruleToDraft(r: AutomationRule): Draft {
  return {
    id: r.id,
    name: r.name,
    trigger_event: r.trigger_event,
    conditions: (r.conditions ?? []).map((c) => ({
      field: c.field,
      op: c.op,
      value: condValueToStr(c.value),
    })),
    actions: (r.actions ?? []).map((a) => ({
      type: a.type,
      params: Object.fromEntries(
        Object.entries(a.params ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)]),
      ),
    })),
    is_active: r.is_active,
    priority: r.priority,
  };
}

function emptyDraft(catalog?: AutomationCatalog): Draft {
  return {
    name: "",
    trigger_event: catalog?.events[0]?.event ?? "message.visitor",
    conditions: [],
    actions: [],
    is_active: true,
    priority: 100,
  };
}

/** 自動化規則:catalog 驅動的觸發/條件/動作建構器 + CRUD + 啟停用。 */
export function AutomationSettingsPage() {
  const { t } = useTranslation();
  const { data: rules, isLoading } = useAutomationRules();
  const { data: catalog } = useAutomationCatalog();
  const { create, update, remove } = useAutomationMutations();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;

  const eventLabel = useMemo(() => {
    const m = new Map<string, string>();
    (catalog?.events ?? []).forEach((e) => m.set(e.event, e.label));
    return m;
  }, [catalog]);
  const actionLabel = useMemo(() => {
    const m = new Map<string, string>();
    (catalog?.action_types ?? []).forEach((a) => m.set(a.type, a.label));
    return m;
  }, [catalog]);

  async function submit() {
    if (!draft) return;
    setError(null);
    try {
      const conditions = draft.conditions
        .filter((c) => c.field && c.op)
        .map((c) => ({
          field: c.field,
          op: c.op,
          value: c.op === "in" ? c.value.split(",").map((s) => s.trim()).filter(Boolean) : c.value,
        }));
      const actions = draft.actions
        .filter((a) => a.type)
        .map((a) => ({
          type: a.type,
          params: Object.fromEntries(
            Object.entries(a.params).filter(([, v]) => v !== "" && v != null),
          ),
        }));
      const body = {
        name: draft.name.trim(),
        trigger_event: draft.trigger_event,
        conditions,
        actions,
        is_active: draft.is_active,
        priority: Number.isFinite(draft.priority) ? draft.priority : 100,
      };
      if (draft.id) await update.mutateAsync({ id: draft.id, body });
      else await create.mutateAsync(body);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("config.common.saveFailed"));
    }
  }

  async function toggleActive(r: AutomationRule) {
    try {
      await update.mutateAsync({ id: r.id, body: { is_active: !r.is_active } });
    } catch {
      /* 交由清單重取回復狀態 */
    }
  }

  return (
    <PageShell
      title={t("config.automation.title")}
      description={t("config.automation.description")}
      actions={
        <Button
          size="sm"
          disabled={!catalog}
          onClick={() => {
            setError(null);
            setDraft(emptyDraft(catalog));
          }}
        >
          <Plus className="h-4 w-4" /> {t("config.common.addRule")}
        </Button>
      }
    >
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-medium">{t("config.automation.colRule")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("config.automation.colTriggerEvent")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("config.automation.colCondAction")}</th>
                  <th className="px-3 py-2.5 text-center font-medium">{t("config.automation.colPriority")}</th>
                  <th className="px-3 py-2.5 text-center font-medium">{t("config.common.colActive")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("config.common.colActions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="p-3">
                      <Skeleton className="h-24 w-full" />
                    </td>
                  </tr>
                ) : (rules ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                      {t("config.automation.empty")}
                    </td>
                  </tr>
                ) : (
                  (rules ?? []).map((r) => (
                    <tr key={r.id} className="hover:bg-accent/40">
                      <td className="px-3 py-2.5 font-medium">
                        <div className="flex items-center gap-2">
                          <Zap className="h-3.5 w-3.5 text-brand" />
                          {r.name}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {eventLabel.get(r.trigger_event) ?? r.trigger_event}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="secondary">{t("config.automation.conditionCount", { count: r.conditions.length })}</Badge>
                          {r.actions.map((a, i) => (
                            <Badge key={i} variant="brand">
                              {actionLabel.get(a.type) ?? a.type}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-muted-foreground">
                        {r.priority}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-center">
                          <Switch checked={r.is_active} onCheckedChange={() => toggleActive(r)} />
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
                              setDraft(ruleToDraft(r));
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
                              if (confirm(t("config.common.confirmDeleteRule", { name: r.name }))) remove.mutate(r.id);
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

      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("config.automation.editRule") : t("config.automation.newRule")}</DialogTitle>
          </DialogHeader>
          {draft && catalog && (
            <RuleBuilder draft={draft} setDraft={setDraft} catalog={catalog} />
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("config.common.cancel")}
            </Button>
            <Button onClick={submit} disabled={saving || !draft?.name.trim() || (draft?.actions.length ?? 0) === 0}>
              {saving ? t("config.common.saving") : t("config.common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

/** 規則建構器主體:觸發事件 + 條件列 + 動作列(全由 catalog 驅動)。 */
function RuleBuilder({
  draft,
  setDraft,
  catalog,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  catalog: AutomationCatalog;
}) {
  const { t } = useTranslation();
  // 供 uuid 類參數渲染下拉的資源清單
  const { data: skillGroups } = useSkillGroups();
  const { data: staff } = useStaffAdmin();
  const { data: tags } = useTags();
  const { data: canned } = useCanned();

  const fieldByName = new Map(catalog.condition_fields.map((f) => [f.field, f]));

  function setCond(i: number, patch: Partial<CondDraft>) {
    const conditions = draft.conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    setDraft({ ...draft, conditions });
  }
  function setActionType(i: number, type: string) {
    const actions = draft.actions.map((a, idx) => (idx === i ? { type, params: {} } : a));
    setDraft({ ...draft, actions });
  }
  function setActionParam(i: number, name: string, value: string) {
    const actions = draft.actions.map((a, idx) =>
      idx === i ? { ...a, params: { ...a.params, [name]: value } } : a,
    );
    setDraft({ ...draft, actions });
  }

  function renderParamControl(actionIdx: number, action: ActionDraft, param: { name: string; type: string; required: boolean }) {
    const val = action.params[param.name] ?? "";
    const common = {
      value: val,
      onChange: (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
        setActionParam(actionIdx, param.name, e.target.value),
    };
    // 已知 uuid 參數 → 對應資源下拉,較文字輸入好用
    if (param.name === "skill_group_id") {
      return (
        <select className={SELECT_CLS} {...common}>
          <option value="">{t("config.automation.selectSkillGroup")}</option>
          {(skillGroups ?? []).map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      );
    }
    if (param.name === "staff_id") {
      return (
        <select className={SELECT_CLS} {...common}>
          <option value="">{t("config.automation.selectStaff")}</option>
          {(staff ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.display_name}</option>
          ))}
        </select>
      );
    }
    if (param.name === "tag_id") {
      return (
        <select className={SELECT_CLS} {...common}>
          <option value="">{t("config.automation.selectTag")}</option>
          {(tags ?? []).map((tg) => (
            <option key={tg.id} value={tg.id}>{tg.name}</option>
          ))}
        </select>
      );
    }
    if (param.name === "canned_id") {
      return (
        <select className={SELECT_CLS} {...common}>
          <option value="">{t("config.automation.selectCanned")}</option>
          {(canned ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.title}</option>
          ))}
        </select>
      );
    }
    return (
      <Input
        {...common}
        placeholder={param.name + (param.required ? t("config.automation.requiredSuffix") : t("config.automation.optionalSuffix"))}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="r-name">{t("config.automation.ruleName")}</Label>
          <Input
            id="r-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={t("config.automation.ruleNamePlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="r-prio">{t("config.automation.priorityLabel")}</Label>
          <Input
            id="r-prio"
            type="number"
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: parseInt(e.target.value, 10) || 0 })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="r-event">{t("config.automation.triggerEvent")}</Label>
        <select
          id="r-event"
          className={SELECT_CLS}
          value={draft.trigger_event}
          onChange={(e) => setDraft({ ...draft, trigger_event: e.target.value })}
        >
          {catalog.events.map((ev) => (
            <option key={ev.event} value={ev.event}>{ev.label}</option>
          ))}
        </select>
      </div>

      {/* 條件(AND;全部成立才命中) */}
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">{t("config.automation.conditionsLabel")}</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft({
                ...draft,
                conditions: [
                  ...draft.conditions,
                  {
                    field: catalog.condition_fields[0]?.field ?? "",
                    op: catalog.condition_ops[0]?.op ?? "eq",
                    value: "",
                  },
                ],
              })
            }
          >
            <Plus className="h-4 w-4" /> {t("config.common.condition")}
          </Button>
        </div>
        {draft.conditions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("config.automation.noConditionHint")}</p>
        ) : (
          draft.conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                className={SELECT_CLS}
                value={c.field}
                onChange={(e) => setCond(i, { field: e.target.value })}
              >
                {catalog.condition_fields.map((f) => (
                  <option key={f.field} value={f.field}>{f.label}</option>
                ))}
              </select>
              <select
                className={SELECT_CLS + " max-w-[120px]"}
                value={c.op}
                onChange={(e) => setCond(i, { op: e.target.value })}
              >
                {catalog.condition_ops.map((o) => (
                  <option key={o.op} value={o.op}>{o.label}</option>
                ))}
              </select>
              <Input
                value={c.value}
                onChange={(e) => setCond(i, { value: e.target.value })}
                placeholder={
                  c.op === "in"
                    ? t("config.automation.condValueInPlaceholder")
                    : fieldByName.get(c.field)?.type === "uuid"
                      ? t("config.automation.condValueIdPlaceholder")
                      : t("config.automation.condValuePlaceholder")
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("config.common.removeCondition")}
                onClick={() =>
                  setDraft({ ...draft, conditions: draft.conditions.filter((_, idx) => idx !== i) })
                }
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* 動作(依序執行) */}
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">{t("config.automation.actionsLabel")}</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft({
                ...draft,
                actions: [
                  ...draft.actions,
                  { type: catalog.action_types[0]?.type ?? "", params: {} },
                ],
              })
            }
          >
            <Plus className="h-4 w-4" /> {t("config.automation.action")}
          </Button>
        </div>
        {draft.actions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("config.automation.noActionHint")}</p>
        ) : (
          draft.actions.map((a, i) => {
            const spec = catalog.action_types.find((t) => t.type === a.type);
            return (
              <div key={i} className="space-y-2 rounded-md bg-muted/40 p-2.5">
                <div className="flex items-center gap-2">
                  <select
                    className={SELECT_CLS}
                    value={a.type}
                    onChange={(e) => setActionType(i, e.target.value)}
                  >
                    {catalog.action_types.map((t) => (
                      <option key={t.type} value={t.type}>{t.label}</option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("config.automation.removeAction")}
                    onClick={() =>
                      setDraft({ ...draft, actions: draft.actions.filter((_, idx) => idx !== i) })
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {(spec?.params ?? []).length > 0 && (
                  <div className="grid gap-2 pl-1">
                    {spec!.params.map((p) => (
                      <div key={p.name} className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">
                          {p.name}
                          {p.required && <span className="text-destructive"> *</span>}
                        </Label>
                        {renderParamControl(i, a, p)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between rounded-md border border-border p-3">
        <div>
          <p className="text-sm">{t("config.common.enableRule")}</p>
          <p className="text-xs text-muted-foreground">{t("config.automation.enableRuleHint")}</p>
        </div>
        <Switch
          checked={draft.is_active}
          onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
        />
      </div>
    </div>
  );
}
