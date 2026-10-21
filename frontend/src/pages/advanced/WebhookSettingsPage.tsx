import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Webhook,
  Trash2,
  Send,
  Check,
  AlertCircle,
  Power,
} from "lucide-react";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, timeAgo } from "@/lib/utils";
import {
  useWebhookEndpoints,
  useWebhookEvents,
  useWebhookMutations,
} from "@/api/hooks";
import { webhookApi } from "@/api/endpoints";
import { CopyField } from "./shared";
import type { WebhookEndpoint } from "@/types";

/** 對外 Webhook 端點管理:列表 + 建立(勾訂閱事件、secret)、啟停用、刪除、測試發送。 */
export function WebhookSettingsPage() {
  const { t } = useTranslation();
  const { data: endpoints, isLoading } = useWebhookEndpoints();
  const { data: events } = useWebhookEvents();
  const { create, update, remove } = useWebhookMutations();

  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  // 各端點測試結果 / 進行中
  const [testResult, setTestResult] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<string | null>(null);

  function resetForm() {
    setUrl("");
    setSecret("");
    setDescription("");
    setSelected([]);
    setError(null);
  }

  function toggleEvent(ev: string) {
    setSelected((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));
  }

  async function submit() {
    setError(null);
    if (!url.trim()) {
      setError(t("advanced.webhook.errorUrlRequired"));
      return;
    }
    try {
      const created = await create.mutateAsync({
        url: url.trim(),
        events: selected,
        secret: secret.trim() || undefined,
        description: description.trim() || undefined,
        is_active: true,
      });
      setAddOpen(false);
      resetForm();
      // 建立回應含一次明文 secret,顯示供複製保存
      if (created.secret) setCreatedSecret(created.secret);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("advanced.webhook.errorCreateFailed"));
    }
  }

  async function runTest(id: string) {
    setTesting(id);
    try {
      const r = await webhookApi.test(id);
      setTestResult((prev) => ({ ...prev, [id]: r.delivered }));
    } catch {
      setTestResult((prev) => ({ ...prev, [id]: false }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <PageShell
      title={t("advanced.webhook.title")}
      description={t("advanced.webhook.description")}
      actions={
        <Button size="sm" onClick={() => { resetForm(); setAddOpen(true); }}>
          <Plus className="h-4 w-4" /> {t("advanced.webhook.addEndpoint")}
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : (endpoints ?? []).length === 0 ? (
        <Card className="max-w-3xl">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Webhook className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("advanced.webhook.emptyState")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-3">
          {(endpoints ?? []).map((e) => (
            <WebhookRow
              key={e.id}
              endpoint={e}
              tested={testResult[e.id]}
              testing={testing === e.id}
              onTest={() => runTest(e.id)}
              onToggle={(active) => update.mutate({ id: e.id, body: { is_active: active } })}
              onRemove={() => remove.mutate(e.id)}
              removing={remove.isPending}
            />
          ))}
        </div>
      )}

      {/* 建立端點 */}
      <Dialog open={addOpen} onOpenChange={(v) => !v && setAddOpen(false)}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("advanced.webhook.addDialogTitle")}</DialogTitle>
            <DialogDescription>{t("advanced.webhook.addDialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="w-url">{t("advanced.webhook.urlLabel")}</Label>
              <Input
                id="w-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-service.example.com/hooks/kefu"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("advanced.webhook.eventsLabel")}</Label>
              {(events ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("advanced.webhook.noEvents")}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(events ?? []).map((ev) => {
                    const on = selected.includes(ev);
                    return (
                      <button
                        key={ev}
                        type="button"
                        onClick={() => toggleEvent(ev)}
                        className={cn(
                          "rounded-md border px-2 py-1 font-mono text-xs transition-colors",
                          on
                            ? "border-transparent bg-brand text-brand-foreground"
                            : "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {ev}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">{t("advanced.webhook.noEventsHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-secret">{t("advanced.webhook.secretLabel")}</Label>
              <Input
                id="w-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={t("advanced.webhook.secretPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-desc">{t("advanced.webhook.descLabel")}</Label>
              <Input
                id="w-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("advanced.webhook.descPlaceholder")}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>{t("advanced.webhook.cancel")}</Button>
            <Button onClick={submit} disabled={create.isPending || !url.trim()}>
              {create.isPending ? t("advanced.webhook.creating") : t("advanced.webhook.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 建立後一次性顯示明文 secret */}
      <Dialog open={!!createdSecret} onOpenChange={(v) => !v && setCreatedSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("advanced.webhook.createdTitle")}</DialogTitle>
            <DialogDescription>
              {t("advanced.webhook.createdDesc")}
            </DialogDescription>
          </DialogHeader>
          {createdSecret && <CopyField value={createdSecret} />}
          <p className="text-xs text-muted-foreground">
            {t("advanced.webhook.createdHint")}
          </p>
          <DialogFooter>
            <Button onClick={() => setCreatedSecret(null)}>{t("advanced.webhook.saved")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function WebhookRow({
  endpoint,
  tested,
  testing,
  onTest,
  onToggle,
  onRemove,
  removing,
}: {
  endpoint: WebhookEndpoint;
  tested?: boolean;
  testing: boolean;
  onTest: () => void;
  onToggle: (active: boolean) => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const { t } = useTranslation();
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Webhook className="h-4 w-4 text-brand" />
              <span className="truncate text-sm font-medium">{endpoint.url}</span>
              {endpoint.is_active ? (
                <Badge variant="success">{t("advanced.webhook.statusActive")}</Badge>
              ) : (
                <Badge variant="secondary">{t("advanced.webhook.statusInactive")}</Badge>
              )}
            </div>
            {endpoint.description && (
              <p className="mt-1 text-xs text-muted-foreground">{endpoint.description}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {endpoint.events.length === 0 ? (
                <Badge variant="warning">{t("advanced.webhook.noSubscribedEvents")}</Badge>
              ) : (
                endpoint.events.map((ev) => (
                  <span key={ev} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {ev}
                  </span>
                ))
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Secret:<span className="font-mono">{endpoint.secret ?? "—"}</span>
              {endpoint.created_at && <> · {t("advanced.webhook.createdAt", { time: timeAgo(endpoint.created_at) })}</>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-1.5" title={t("advanced.webhook.toggleTitle")}>
              <Power className="h-3.5 w-3.5 text-muted-foreground" />
              <Switch checked={endpoint.is_active} onCheckedChange={onToggle} />
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-1.5">
          <Button variant="secondary" size="sm" disabled={testing} onClick={onTest}>
            <Send className="h-4 w-4" /> {testing ? t("advanced.webhook.testing") : t("advanced.webhook.test")}
          </Button>
          {tested !== undefined && (
            <span className={cn("flex items-center gap-1 text-xs", tested ? "text-success" : "text-destructive")}>
              {tested ? <Check className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
              {tested ? t("advanced.webhook.delivered") : t("advanced.webhook.deliverFailed")}
            </span>
          )}
          <div className="ml-auto">
            {confirmDel ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{t("advanced.webhook.confirmDelete")}</span>
                <Button variant="destructive" size="sm" disabled={removing} onClick={onRemove}>
                  {removing ? t("advanced.webhook.removing") : t("advanced.webhook.remove")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmDel(false)}>{t("advanced.webhook.cancel")}</Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmDel(true)}>
                <Trash2 className="h-4 w-4" /> {t("advanced.webhook.remove")}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
