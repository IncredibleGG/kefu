import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, MessageSquarePlus } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
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
import { useProactiveRules, useProactiveMutations, useChannels } from "@/api/hooks";
import i18n from "@/lib/i18n";
import type {
  ProactiveFrequency,
  ProactiveMode,
  ProactiveRule,
  ProactiveTriggerType,
} from "@/types";

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const TRIGGER_TYPES: ProactiveTriggerType[] = [
  "url_match",
  "time_on_page",
  "scroll_depth",
  "visit_count",
  "exit_intent",
];

type Draft = {
  id?: string;
  name: string;
  triggerType: ProactiveTriggerType;
  params: Record<string, string>;
  message: string;
  mode: ProactiveMode;
  frequency: ProactiveFrequency;
  priority: number;
  channel_id: string;
  is_active: boolean;
};

function ruleToDraft(r: ProactiveRule): Draft {
  const p = (r.trigger?.params ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    name: r.name,
    triggerType: r.trigger?.type ?? "url_match",
    params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v == null ? "" : String(v)])),
    message: r.message,
    mode: r.mode,
    frequency: r.frequency,
    priority: r.priority,
    channel_id: r.channel_id ?? "",
    is_active: r.is_active,
  };
}

function emptyDraft(): Draft {
  return {
    name: "",
    triggerType: "url_match",
    params: { match: "contains" },
    message: "",
    mode: "show_bubble",
    frequency: "once_per_session",
    priority: 0,
    channel_id: "",
    is_active: true,
  };
}

/** 依 trigger 型別把表單字串參數轉成後端形狀(數字轉數字)。 */
function buildTriggerParams(d: Draft): Record<string, unknown> {
  const p = d.params;
  switch (d.triggerType) {
    case "url_match":
      return { pattern: p.pattern ?? "", match: p.match || "contains" };
    case "time_on_page":
      return { seconds: Number(p.seconds) || 0 };
    case "scroll_depth":
      return { percent: Number(p.percent) || 0 };
    case "visit_count":
      return { count: Number(p.count) || 0, op: p.op || "gte" };
    case "exit_intent":
      return {};
  }
}

/** 觸發條件摘要(供列表顯示)。 */
function triggerSummary(r: ProactiveRule): string {
  const p = (r.trigger?.params ?? {}) as Record<string, unknown>;
  switch (r.trigger?.type) {
    case "url_match":
      return i18n.t("config.proactive.summary.url_match", {
        match: p.match ?? "contains",
        pattern: p.pattern ?? "",
      });
    case "time_on_page":
      return i18n.t("config.proactive.summary.time_on_page", { seconds: p.seconds ?? 0 });
    case "scroll_depth":
      return i18n.t("config.proactive.summary.scroll_depth", { percent: p.percent ?? 0 });
    case "visit_count":
      return i18n.t("config.proactive.summary.visit_count", { op: p.op ?? "gte", visits: p.count ?? 0 });
    case "exit_intent":
      return i18n.t("config.proactive.summary.exit_intent");
    default:
      return r.trigger?.type ?? "";
  }
}

/** 主動式訊息:規則列表 + 觸發型別/參數/訊息/呈現/頻率 表單。 */
export function ProactiveSettingsPage() {
  const { t } = useTranslation();
  const { data: rules, isLoading } = useProactiveRules();
  const { data: channels } = useChannels();
  const { create, update, remove } = useProactiveMutations();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;

  const TRIGGER_LABEL: Record<ProactiveTriggerType, string> = {
    url_match: t("config.proactive.trigger.url_match"),
    time_on_page: t("config.proactive.trigger.time_on_page"),
    scroll_depth: t("config.proactive.trigger.scroll_depth"),
    visit_count: t("config.proactive.trigger.visit_count"),
    exit_intent: t("config.proactive.trigger.exit_intent"),
  };
  const MODE_LABEL: Record<ProactiveMode, string> = {
    show_bubble: t("config.proactive.mode.show_bubble"),
    auto_open: t("config.proactive.mode.auto_open"),
  };
  const FREQ_LABEL: Record<ProactiveFrequency, string> = {
    once_per_session: t("config.proactive.freq.once_per_session"),
    once_per_visitor: t("config.proactive.freq.once_per_visitor"),
    always: t("config.proactive.freq.always"),
  };

  const channelName = (id?: string | null) =>
    id ? (channels ?? []).find((c) => c.id === id)?.name ?? t("config.proactive.channelSpecified") : t("config.proactive.channelAll");

  async function submit() {
    if (!draft) return;
    setError(null);
    try {
      const body = {
        name: draft.name.trim(),
        trigger: { type: draft.triggerType, params: buildTriggerParams(draft) },
        message: draft.message.trim(),
        mode: draft.mode,
        frequency: draft.frequency,
        priority: Number.isFinite(draft.priority) ? draft.priority : 0,
        is_active: draft.is_active,
        channel_id: draft.channel_id || null,
      };
      if (draft.id) await update.mutateAsync({ id: draft.id, body });
      else await create.mutateAsync(body);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("config.common.saveFailed"));
    }
  }

  async function toggleActive(r: ProactiveRule) {
    try {
      await update.mutateAsync({ id: r.id, body: { is_active: !r.is_active } });
    } catch {
      /* 清單重取回復 */
    }
  }

  return (
    <PageShell
      title={t("config.proactive.title")}
      description={t("config.proactive.description")}
      actions={
        <Button
          size="sm"
          onClick={() => {
            setError(null);
            setDraft(emptyDraft());
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
                  <th className="px-3 py-2.5 text-left font-medium">{t("config.proactive.colRule")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("config.proactive.colTrigger")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("config.proactive.colModeFreq")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("config.proactive.colChannel")}</th>
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
                      {t("config.proactive.empty")}
                    </td>
                  </tr>
                ) : (
                  (rules ?? []).map((r) => (
                    <tr key={r.id} className="hover:bg-accent/40">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2 font-medium">
                          <MessageSquarePlus className="h-3.5 w-3.5 text-brand" />
                          {r.name}
                        </div>
                        <p className="mt-0.5 max-w-[220px] truncate text-xs text-muted-foreground">
                          {r.message}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{triggerSummary(r)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="secondary">{MODE_LABEL[r.mode]}</Badge>
                          <Badge variant="outline">{FREQ_LABEL[r.frequency]}</Badge>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {channelName(r.channel_id)}
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
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("config.proactive.editRule") : t("config.proactive.newRule")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="p-name">{t("config.proactive.ruleName")}</Label>
                <Input
                  id="p-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("config.proactive.ruleNamePlaceholder")}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="p-trigger">{t("config.proactive.triggerType")}</Label>
                  <select
                    id="p-trigger"
                    className={SELECT_CLS}
                    value={draft.triggerType}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        triggerType: e.target.value as ProactiveTriggerType,
                        params: e.target.value === "url_match" ? { match: "contains" } : {},
                      })
                    }
                  >
                    {TRIGGER_TYPES.map((t) => (
                      <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-prio">{t("config.proactive.priorityLabel")}</Label>
                  <Input
                    id="p-prio"
                    type="number"
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: parseInt(e.target.value, 10) || 0 })}
                  />
                </div>
              </div>

              {/* 觸發參數(依型別動態) */}
              <TriggerParams draft={draft} setDraft={setDraft} />

              <div className="space-y-1.5">
                <Label htmlFor="p-msg">{t("config.proactive.messageLabel")}</Label>
                <Textarea
                  id="p-msg"
                  value={draft.message}
                  onChange={(e) => setDraft({ ...draft, message: e.target.value })}
                  placeholder={t("config.proactive.messagePlaceholder")}
                  className="min-h-[72px]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="p-mode">{t("config.proactive.modeLabel")}</Label>
                  <select
                    id="p-mode"
                    className={SELECT_CLS}
                    value={draft.mode}
                    onChange={(e) => setDraft({ ...draft, mode: e.target.value as ProactiveMode })}
                  >
                    {(Object.keys(MODE_LABEL) as ProactiveMode[]).map((m) => (
                      <option key={m} value={m}>{MODE_LABEL[m]}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-freq">{t("config.proactive.freqLabel")}</Label>
                  <select
                    id="p-freq"
                    className={SELECT_CLS}
                    value={draft.frequency}
                    onChange={(e) =>
                      setDraft({ ...draft, frequency: e.target.value as ProactiveFrequency })
                    }
                  >
                    {(Object.keys(FREQ_LABEL) as ProactiveFrequency[]).map((f) => (
                      <option key={f} value={f}>{FREQ_LABEL[f]}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="p-channel">{t("config.proactive.channelLabel")}</Label>
                <select
                  id="p-channel"
                  className={SELECT_CLS}
                  value={draft.channel_id}
                  onChange={(e) => setDraft({ ...draft, channel_id: e.target.value })}
                >
                  <option value="">{t("config.proactive.channelAll")}</option>
                  {(channels ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <p className="text-sm">{t("config.common.enableRule")}</p>
                  <p className="text-xs text-muted-foreground">{t("config.proactive.enableRuleHint")}</p>
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
            <Button onClick={submit} disabled={saving || !draft?.name.trim() || !draft?.message.trim()}>
              {saving ? t("config.common.saving") : t("config.common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

/** 觸發參數:依 triggerType 呈現對應輸入。 */
function TriggerParams({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const { t } = useTranslation();
  const set = (name: string, value: string) =>
    setDraft({ ...draft, params: { ...draft.params, [name]: value } });

  if (draft.triggerType === "exit_intent") {
    return (
      <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t("config.proactive.triggerParams.exitIntentHint")}
      </p>
    );
  }

  if (draft.triggerType === "url_match") {
    return (
      <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/40 p-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("config.proactive.triggerParams.urlPattern")}</Label>
          <Input
            value={draft.params.pattern ?? ""}
            onChange={(e) => set("pattern", e.target.value)}
            placeholder="/pricing"
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("config.proactive.triggerParams.matchMethod")}</Label>
          <select
            className={SELECT_CLS}
            value={draft.params.match ?? "contains"}
            onChange={(e) => set("match", e.target.value)}
          >
            <option value="contains">{t("config.proactive.match.contains")}</option>
            <option value="prefix">{t("config.proactive.match.prefix")}</option>
            <option value="exact">{t("config.proactive.match.exact")}</option>
            <option value="regex">{t("config.proactive.match.regex")}</option>
          </select>
        </div>
      </div>
    );
  }

  if (draft.triggerType === "time_on_page") {
    return (
      <div className="space-y-1.5 rounded-md bg-muted/40 p-3">
        <Label className="text-xs">{t("config.proactive.triggerParams.seconds")}</Label>
        <Input
          type="number"
          value={draft.params.seconds ?? ""}
          onChange={(e) => set("seconds", e.target.value)}
          placeholder="20"
        />
      </div>
    );
  }

  if (draft.triggerType === "scroll_depth") {
    return (
      <div className="space-y-1.5 rounded-md bg-muted/40 p-3">
        <Label className="text-xs">{t("config.proactive.triggerParams.percent")}</Label>
        <Input
          type="number"
          value={draft.params.percent ?? ""}
          onChange={(e) => set("percent", e.target.value)}
          placeholder="50"
        />
      </div>
    );
  }

  // visit_count
  return (
    <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/40 p-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{t("config.proactive.triggerParams.count")}</Label>
        <Input
          type="number"
          value={draft.params.count ?? ""}
          onChange={(e) => set("count", e.target.value)}
          placeholder="2"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t("config.proactive.triggerParams.compare")}</Label>
        <select
          className={SELECT_CLS}
          value={draft.params.op ?? "gte"}
          onChange={(e) => set("op", e.target.value)}
        >
          <option value="gte">{t("config.proactive.compareOp.gte")}</option>
          <option value="eq">{t("config.proactive.compareOp.eq")}</option>
          <option value="lte">{t("config.proactive.compareOp.lte")}</option>
        </select>
      </div>
    </div>
  );
}
