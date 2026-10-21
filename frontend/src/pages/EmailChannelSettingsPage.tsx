import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Mail, Settings2, Plug, Check, AlertCircle, Inbox, Send } from "lucide-react";
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
import { useEmailChannels, useEmailChannelMutations } from "@/api/hooks";
import { channelApi } from "@/api/endpoints";
import type { RawChannel } from "@/api/adapters";
import type { EmailChannelConfig, EmailTestResult } from "@/types";

type ImapForm = { host: string; port: string; ssl: boolean; user: string; pass: string; folder: string };
type SmtpForm = { host: string; port: string; tls: boolean; user: string; pass: string; from: string };

function readImap(cfg: Record<string, unknown> | null | undefined): ImapForm {
  const i = ((cfg?.imap ?? {}) as Record<string, unknown>) || {};
  return {
    host: String(i.host ?? ""),
    port: String(i.port ?? 993),
    ssl: i.ssl == null ? true : Boolean(i.ssl),
    user: String(i.user ?? ""),
    pass: "", // 不回填遮罩值;留空 = 沿用既有
    folder: String(i.folder ?? "INBOX"),
  };
}
function readSmtp(cfg: Record<string, unknown> | null | undefined): SmtpForm {
  const s = ((cfg?.smtp ?? {}) as Record<string, unknown>) || {};
  return {
    host: String(s.host ?? ""),
    port: String(s.port ?? 587),
    tls: s.tls == null ? true : Boolean(s.tls),
    user: String(s.user ?? ""),
    pass: "",
    from: String(s.from ?? ""),
  };
}

/** Email 渠道:列出/建立 email 渠道,設定 IMAP/SMTP + 測試連線。 */
export function EmailChannelSettingsPage() {
  const { t } = useTranslation();
  const { data: channels, isLoading } = useEmailChannels();
  const { create } = useEmailChannelMutations();

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 各渠道的測試結果 / 進行中
  const [testResult, setTestResult] = useState<Record<string, EmailTestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const editing = (channels ?? []).find((c) => c.id === editId) ?? null;

  async function addChannel() {
    setError(null);
    setCreating(true);
    try {
      await create.mutateAsync(newName.trim());
      setNewName("");
      setAddOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("config.email.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function runTest(id: string) {
    setTesting(id);
    try {
      const r = await channelApi.testEmail(id);
      setTestResult((prev) => ({ ...prev, [id]: r }));
    } catch (e) {
      setTestResult((prev) => ({
        ...prev,
        [id]: {
          channel_id: id,
          ok: false,
          imap: { ok: false, error: e instanceof Error ? e.message : t("config.email.testFailed") },
          smtp: { ok: false, error: e instanceof Error ? e.message : t("config.email.testFailed") },
        },
      }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <PageShell
      title={t("config.email.title")}
      description={t("config.email.description")}
      actions={
        <Button size="sm" onClick={() => { setError(null); setAddOpen(true); }}>
          <Plus className="h-4 w-4" /> {t("config.email.addChannel")}
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : (channels ?? []).length === 0 ? (
        <Card className="max-w-3xl">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Mail className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("config.email.empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-3">
          {(channels ?? []).map((c) => {
            const cfg = (c.config ?? {}) as Record<string, unknown>;
            const imap = (cfg.imap ?? {}) as Record<string, unknown>;
            const smtp = (cfg.smtp ?? {}) as Record<string, unknown>;
            const configured = Boolean(imap.host && smtp.host);
            const res = testResult[c.id];
            return (
              <Card key={c.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-brand" />
                        <span className="text-sm font-medium">{c.name}</span>
                        {c.is_active ? (
                          <Badge variant="success">{t("config.email.badgeActive")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("config.email.badgeInactive")}</Badge>
                        )}
                        {configured ? (
                          <Badge variant="brand">{t("config.email.badgeConfigured")}</Badge>
                        ) : (
                          <Badge variant="warning">{t("config.email.badgeNotConfigured")}</Badge>
                        )}
                      </div>
                      <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <Inbox className="h-3 w-3" /> IMAP:{" "}
                          {imap.host ? `${imap.host}:${imap.port ?? 993}` : t("config.email.badgeNotConfigured")}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Send className="h-3 w-3" /> SMTP:{" "}
                          {smtp.host ? `${smtp.host}:${smtp.port ?? 587}` : t("config.email.badgeNotConfigured")}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => { setError(null); setEditId(c.id); }}>
                        <Settings2 className="h-4 w-4" /> {t("config.email.configure")}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!configured || testing === c.id}
                        onClick={() => runTest(c.id)}
                      >
                        <Plug className="h-4 w-4" /> {testing === c.id ? t("config.email.testing") : t("config.email.testConnection")}
                      </Button>
                    </div>
                  </div>

                  {res && (
                    <div className="mt-3 grid gap-1.5 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
                      <TestLine label={t("config.email.imapReceive")} ok={res.imap?.ok} error={res.imap?.error} />
                      <TestLine label={t("config.email.smtpSend")} ok={res.smtp?.ok} error={res.smtp?.error} />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 新增渠道 */}
      <Dialog open={addOpen} onOpenChange={(v) => !v && setAddOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("config.email.addChannel")}</DialogTitle>
            <DialogDescription>{t("config.email.addDialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="e-name">{t("config.email.channelName")}</Label>
            <Input
              id="e-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("config.email.channelNamePlaceholder")}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>{t("config.common.cancel")}</Button>
            <Button onClick={addChannel} disabled={creating || !newName.trim()}>
              {creating ? t("config.email.creating") : t("config.email.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 設定 IMAP / SMTP */}
      <EmailConfigDialog channel={editing} onClose={() => setEditId(null)} />
    </PageShell>
  );
}

function TestLine({ label, ok, error }: { label: string; ok?: boolean; error?: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <AlertCircle className="h-3.5 w-3.5 text-destructive" />
      )}
      <span className="font-medium">{label}</span>
      <span className={ok ? "text-success" : "text-destructive"}>
        {ok ? t("config.email.connOk") : error || t("config.email.connFail")}
      </span>
    </div>
  );
}

/** IMAP / SMTP 設定對話框。 */
function EmailConfigDialog({ channel, onClose }: { channel: RawChannel | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { setConfig } = useEmailChannelMutations();
  const [imap, setImap] = useState<ImapForm | null>(null);
  const [smtp, setSmtp] = useState<SmtpForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 開啟時以渠道 config 初始化(channel 變更即重置)
  const [lastId, setLastId] = useState<string | null>(null);
  if (channel && channel.id !== lastId) {
    setLastId(channel.id);
    setImap(readImap(channel.config));
    setSmtp(readSmtp(channel.config));
    setError(null);
    setSaved(false);
  }

  async function save() {
    if (!channel || !imap || !smtp) return;
    setError(null);
    setSaved(false);
    try {
      const body: EmailChannelConfig = {
        imap: {
          host: imap.host.trim(),
          port: parseInt(imap.port, 10) || 993,
          ssl: imap.ssl,
          user: imap.user.trim(),
          pass: imap.pass, // 留空 = 沿用既有
          folder: imap.folder.trim() || "INBOX",
        },
        smtp: {
          host: smtp.host.trim(),
          port: parseInt(smtp.port, 10) || 587,
          tls: smtp.tls,
          user: smtp.user.trim(),
          pass: smtp.pass,
          from: smtp.from.trim() || undefined,
        },
      };
      await setConfig.mutateAsync({ id: channel.id, body });
      setSaved(true);
      setTimeout(() => onClose(), 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("config.common.saveFailed"));
    }
  }

  return (
    <Dialog open={!!channel} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("config.email.configDialogTitle", { name: channel?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("config.email.configDialogDesc")}</DialogDescription>
        </DialogHeader>

        {imap && smtp && (
          <div className="space-y-4">
            {/* IMAP */}
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Inbox className="h-4 w-4 text-brand" /> {t("config.email.imapReceive")}
              </p>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <Label>{t("config.email.server")}</Label>
                  <Input value={imap.host} onChange={(e) => setImap({ ...imap, host: e.target.value })} placeholder="imap.gmail.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>Port</Label>
                  <Input value={imap.port} onChange={(e) => setImap({ ...imap, port: e.target.value })} placeholder="993" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("config.email.account")}</Label>
                  <Input value={imap.user} onChange={(e) => setImap({ ...imap, user: e.target.value })} placeholder="support@example.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("config.email.password")}</Label>
                  <Input type="password" value={imap.pass} onChange={(e) => setImap({ ...imap, pass: e.target.value })} placeholder={t("config.email.passwordPlaceholder")} />
                </div>
              </div>
              <div className="grid grid-cols-2 items-center gap-3">
                <div className="space-y-1.5">
                  <Label>{t("config.email.folder")}</Label>
                  <Input value={imap.folder} onChange={(e) => setImap({ ...imap, folder: e.target.value })} placeholder="INBOX" />
                </div>
                <label className="mt-5 flex items-center gap-2 text-sm">
                  <Switch checked={imap.ssl} onCheckedChange={(v) => setImap({ ...imap, ssl: v })} />
                  {t("config.email.useSsl")}
                </label>
              </div>
            </div>

            {/* SMTP */}
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Send className="h-4 w-4 text-brand" /> {t("config.email.smtpSend")}
              </p>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <Label>{t("config.email.server")}</Label>
                  <Input value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.gmail.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>Port</Label>
                  <Input value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} placeholder="587" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("config.email.account")}</Label>
                  <Input value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} placeholder="support@example.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("config.email.password")}</Label>
                  <Input type="password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} placeholder={t("config.email.passwordPlaceholder")} />
                </div>
              </div>
              <div className="grid grid-cols-2 items-center gap-3">
                <div className="space-y-1.5">
                  <Label>{t("config.email.fromLabel")}</Label>
                  <Input value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} placeholder={t("config.email.fromPlaceholder")} />
                </div>
                <label className="mt-5 flex items-center gap-2 text-sm">
                  <Switch checked={smtp.tls} onCheckedChange={(v) => setSmtp({ ...smtp, tls: v })} />
                  {t("config.email.useTls")}
                </label>
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {saved && (
            <span className="mr-auto flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> {t("config.common.saved")}
            </span>
          )}
          <Button variant="outline" onClick={onClose}>{t("config.common.cancel")}</Button>
          <Button
            onClick={save}
            disabled={setConfig.isPending || !imap?.host.trim() || !smtp?.host.trim()}
          >
            {setConfig.isPending ? t("config.common.saving") : t("config.email.saveConfig")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
