import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  goalsApi,
  type Goal,
  type GoalInput,
  type GoalKind,
  type GoalSummaryItem,
} from "@/api/goals";

const GOAL_KINDS: GoalKind[] = ["url", "event", "manual"];
const DAYS_OPTIONS = [7, 30, 90];
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** 分 → 顯示金額(保留兩位小數)+ 幣別。 */
function formatMoney(cents: number, currency: string): string {
  const amount = (cents || 0) / 100;
  return `${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export function GoalsSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [days, setDays] = useState(30);

  const { data: goals, isLoading, isError } = useQuery({
    queryKey: ["goals"],
    queryFn: () => goalsApi.list(),
  });
  const { data: summary } = useQuery({
    queryKey: ["goals", "summary", days],
    queryFn: () => goalsApi.summary(days),
  });

  // 以目標 id 對映近 N 天達成聚合,供卡片顯示次數 / 總價值
  const summaryById = useMemo(() => {
    const m = new Map<string, GoalSummaryItem>();
    for (const s of summary?.goals ?? []) m.set(s.id, s);
    return m;
  }, [summary]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GoalKind>("url");
  const [urlContains, setUrlContains] = useState("");
  const [eventName, setEventName] = useState("");
  const [valueMajor, setValueMajor] = useState("0");
  const [currency, setCurrency] = useState("USD");
  const [isActive, setIsActive] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const kindLabels = useMemo(
    () => ({
      url: t("goals.kind.url", { defaultValue: "到達網址" }),
      event: t("goals.kind.event", { defaultValue: "自訂事件" }),
      manual: t("goals.kind.manual", { defaultValue: "手動標記" }),
    }),
    [t],
  );

  function openCreate() {
    setEditing(null);
    setName("");
    setKind("url");
    setUrlContains("");
    setEventName("");
    setValueMajor("0");
    setCurrency("USD");
    setIsActive(true);
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(g: Goal) {
    setEditing(g);
    setName(g.name);
    setKind(g.kind);
    setUrlContains((g.config?.url_contains as string) ?? "");
    setEventName((g.config?.event_name as string) ?? "");
    setValueMajor(((g.value_cents || 0) / 100).toString());
    setCurrency(g.currency || "USD");
    setIsActive(g.is_active);
    setFormError(null);
    setDialogOpen(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      const cents = Math.round((parseFloat(valueMajor) || 0) * 100);
      const config: Record<string, string> = {};
      if (kind === "url") config.url_contains = urlContains.trim();
      if (kind === "event") config.event_name = eventName.trim();
      const body: GoalInput = {
        name: name.trim(),
        kind,
        config,
        value_cents: cents,
        currency: currency.trim() || "USD",
        is_active: isActive,
      };
      return editing ? goalsApi.update(editing.id, body) : goalsApi.create(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goals"] });
      setDialogOpen(false);
    },
    onError: (e) =>
      setFormError(
        e instanceof Error ? e.message : t("goals.saveError", { defaultValue: "儲存目標失敗" }),
      ),
  });

  const remove = useMutation({
    mutationFn: (id: string) => goalsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["goals"] }),
  });

  function submit() {
    setFormError(null);
    if (!name.trim()) {
      setFormError(t("goals.nameRequired", { defaultValue: "請輸入目標名稱" }));
      return;
    }
    if (kind === "url" && !urlContains.trim()) {
      setFormError(t("goals.urlRequired", { defaultValue: "url 型目標需填寫「網址包含」條件" }));
      return;
    }
    if (kind === "event" && !eventName.trim()) {
      setFormError(t("goals.eventRequired", { defaultValue: "event 型目標需填寫事件名稱" }));
      return;
    }
    save.mutate();
  }

  return (
    <PageShell
      title={t("goals.pageTitle", { defaultValue: "目標 / 銷售追蹤" })}
      description={t("goals.pageDescription", {
        defaultValue: "設定要衡量的轉換(到達網址 / 自訂事件 / 手動標記),追蹤達成次數與銷售價值。",
      })}
      actions={
        <div className="flex items-center gap-2">
          <select
            className={SELECT_CLASS + " w-auto"}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label={t("goals.rangeLabel", { defaultValue: "統計區間" })}
          >
            {DAYS_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {t("goals.lastNDays", { defaultValue: "近 {{days}} 天", days: d })}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" /> {t("goals.create", { defaultValue: "新增目標" })}
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <Skeleton className="h-64 max-w-2xl" />
      ) : isError ? (
        <Card className="max-w-2xl">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">
              {t("goals.loadError", { defaultValue: "載入目標失敗" })}
            </p>
          </CardContent>
        </Card>
      ) : !goals || goals.length === 0 ? (
        <Card className="max-w-2xl">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("goals.empty", { defaultValue: "尚無目標,點右上「新增目標」開始追蹤。" })}
          </CardContent>
        </Card>
      ) : (
        <div className="max-w-2xl space-y-2">
          {goals.map((g) => {
            const s = summaryById.get(g.id);
            const conversions = s?.conversions ?? 0;
            const totalValue = s?.total_value_cents ?? 0;
            return (
              <Card key={g.id}>
                <CardContent className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{g.name}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {kindLabels[g.kind]}
                      </Badge>
                      {!g.is_active && (
                        <Badge variant="secondary" className="text-[10px]">
                          {t("goals.inactive", { defaultValue: "停用" })}
                        </Badge>
                      )}
                    </div>
                    {g.kind === "url" && g.config?.url_contains && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t("goals.urlContainsLabel", { defaultValue: "網址包含" })}:{" "}
                        <code className="text-[11px]">{g.config.url_contains}</code>
                      </p>
                    )}
                    {g.kind === "event" && g.config?.event_name && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t("goals.eventNameLabel", { defaultValue: "事件名稱" })}:{" "}
                        <code className="text-[11px]">{g.config.event_name}</code>
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>
                        {t("goals.perValue", { defaultValue: "每次價值" })}:{" "}
                        {formatMoney(g.value_cents, g.currency)}
                      </span>
                      <span className="text-foreground">
                        {t("goals.conversionsN", {
                          defaultValue: "達成 {{count}} 次",
                          count: conversions,
                        })}
                      </span>
                      <span className="text-foreground">
                        {t("goals.totalValue", { defaultValue: "總價值" })}:{" "}
                        {formatMoney(totalValue, g.currency)}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("goals.edit", { defaultValue: "編輯目標" })}
                    onClick={() => openEdit(g)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("goals.delete", { defaultValue: "刪除" })}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("goals.confirmDelete", {
                            defaultValue: "確定刪除此目標?已記錄的達成歷史會保留,但不再追蹤。",
                          }),
                        )
                      )
                        remove.mutate(g.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("goals.edit", { defaultValue: "編輯目標" })
                : t("goals.create", { defaultValue: "新增目標" })}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="goal-name">{t("goals.name", { defaultValue: "名稱" })}</Label>
              <Input
                id="goal-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("goals.namePlaceholder", { defaultValue: "例如:完成結帳" })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="goal-kind">{t("goals.kindLabel", { defaultValue: "型別" })}</Label>
              <select
                id="goal-kind"
                className={SELECT_CLASS}
                value={kind}
                onChange={(e) => setKind(e.target.value as GoalKind)}
              >
                {GOAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindLabels[k]}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                {kind === "url" &&
                  t("goals.kindHintUrl", { defaultValue: "訪客瀏覽的網址包含指定字串時自動達成。" })}
                {kind === "event" &&
                  t("goals.kindHintEvent", { defaultValue: "由前端 / 整合上報指定事件時達成。" })}
                {kind === "manual" &&
                  t("goals.kindHintManual", { defaultValue: "由坐席在會話中手動標記達成。" })}
              </p>
            </div>

            {kind === "url" && (
              <div className="space-y-1.5">
                <Label htmlFor="goal-url">
                  {t("goals.urlContainsLabel", { defaultValue: "網址包含" })}
                </Label>
                <Input
                  id="goal-url"
                  value={urlContains}
                  onChange={(e) => setUrlContains(e.target.value)}
                  placeholder={t("goals.urlPlaceholder", { defaultValue: "例如:/checkout/success" })}
                />
              </div>
            )}

            {kind === "event" && (
              <div className="space-y-1.5">
                <Label htmlFor="goal-event">
                  {t("goals.eventNameLabel", { defaultValue: "事件名稱" })}
                </Label>
                <Input
                  id="goal-event"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  placeholder={t("goals.eventPlaceholder", { defaultValue: "例如:purchase" })}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="goal-value">{t("goals.value", { defaultValue: "每次價值" })}</Label>
                <Input
                  id="goal-value"
                  type="number"
                  min={0}
                  step="0.01"
                  value={valueMajor}
                  onChange={(e) => setValueMajor(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="goal-currency">{t("goals.currency", { defaultValue: "幣別" })}</Label>
                <Input
                  id="goal-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  maxLength={10}
                  placeholder="USD"
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <span className="text-sm">{t("goals.active", { defaultValue: "啟用" })}</span>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>

            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("goals.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={submit} disabled={save.isPending || !name.trim()}>
              {save.isPending ? (
                t("goals.saving", { defaultValue: "儲存中…" })
              ) : (
                <>
                  <Check className="h-4 w-4" /> {t("goals.save", { defaultValue: "儲存" })}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
