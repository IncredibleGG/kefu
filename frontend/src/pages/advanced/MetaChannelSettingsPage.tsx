import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  MessageCircle,
  Facebook,
  Settings2,
  Check,
  Sparkles,
  Link2,
  ShieldCheck,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useMetaChannels, useMetaChannelMutations } from "@/api/hooks";
import type { RawChannel } from "@/api/adapters";
import type { WhatsAppConfigInput, FacebookConfigInput } from "@/types";
import { apiOrigin, CopyField } from "./shared";

type MetaType = "whatsapp" | "facebook";

const META = {
  whatsapp: { label: "WhatsApp", Icon: MessageCircle },
  facebook: { label: "Facebook Messenger", Icon: Facebook },
} as const;

/** 由渠道 config.public_key 組出貼到 Meta 後台的 webhook 回呼網址。 */
function webhookUrl(type: MetaType, publicKey: string | undefined | null): string | null {
  if (!publicKey) return null;
  return `${apiOrigin()}/api/v1/channel/${type}/webhook/${publicKey}`;
}

/** WhatsApp / Facebook 渠道設定:建立渠道、填 Meta 設定、顯示 webhook URL 與 verify_token。 */
export function MetaChannelSettingsPage() {
  const { t } = useTranslation();
  const { data: channels, isLoading } = useMetaChannels();
  const { create } = useMetaChannelMutations();

  const [addOpen, setAddOpen] = useState(false);
  const [newType, setNewType] = useState<MetaType>("whatsapp");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  const editing = (channels ?? []).find((c) => c.id === editId) ?? null;

  async function addChannel() {
    setError(null);
    setCreating(true);
    try {
      const created = await create.mutateAsync({ type: newType, name: newName.trim() });
      setNewName("");
      setAddOpen(false);
      // 建立後直接開設定對話框填 Meta 設定
      setEditId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("advanced.meta.errorCreateFailed"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <PageShell
      title={t("advanced.meta.title")}
      description={t("advanced.meta.description")}
      actions={
        <Button size="sm" onClick={() => { setError(null); setNewName(""); setAddOpen(true); }}>
          <Plus className="h-4 w-4" /> {t("advanced.meta.addChannel")}
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : (channels ?? []).length === 0 ? (
        <Card className="max-w-3xl">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <MessageCircle className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t("advanced.meta.emptyState")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-3">
          {(channels ?? []).map((c) => {
            const type = c.type as MetaType;
            const meta = META[type] ?? META.whatsapp;
            const Icon = meta.Icon;
            const cfg = (c.config ?? {}) as Record<string, unknown>;
            const publicKey = cfg.public_key as string | undefined;
            const url = webhookUrl(type, publicKey);
            const configured =
              type === "whatsapp"
                ? Boolean(cfg.phone_number_id && cfg.access_token)
                : Boolean(cfg.page_id && cfg.page_access_token);
            const verifySet = Boolean(cfg.verify_token);
            return (
              <Card key={c.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Icon className="h-4 w-4 text-brand" />
                        <span className="text-sm font-medium">{c.name}</span>
                        <Badge variant="brand">{meta.label}</Badge>
                        {c.is_active ? (
                          <Badge variant="success">{t("advanced.meta.statusActive")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("advanced.meta.statusInactive")}</Badge>
                        )}
                        {configured ? (
                          <Badge variant="success">{t("advanced.meta.statusConfigured")}</Badge>
                        ) : (
                          <Badge variant="warning">{t("advanced.meta.statusUnconfigured")}</Badge>
                        )}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {type === "whatsapp"
                          ? `Phone Number ID:${cfg.phone_number_id || t("advanced.meta.notFilled")}`
                          : `Page ID:${cfg.page_id || t("advanced.meta.notFilled")}`}
                        {verifySet ? t("advanced.meta.verifyTokenSet") : t("advanced.meta.verifyTokenUnset")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => { setError(null); setEditId(c.id); }}
                    >
                      <Settings2 className="h-4 w-4" /> {t("advanced.meta.configureButton")}
                    </Button>
                  </div>

                  {/* 貼到 Meta 後台的 webhook 回呼位址 */}
                  <div className="mt-3 space-y-1.5 rounded-md border border-border bg-muted/30 p-2.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <Link2 className="h-3.5 w-3.5 text-brand" /> {t("advanced.meta.webhookCallbackUrl")}
                    </p>
                    {url ? (
                      <CopyField value={url} />
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("advanced.meta.noPublicKey")}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {t("advanced.meta.verifyHint")}
                    </p>
                  </div>
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
            <DialogTitle>{t("advanced.meta.addDialogTitle")}</DialogTitle>
            <DialogDescription>{t("advanced.meta.addDialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("advanced.meta.typeLabel")}</Label>
              <div className="flex gap-2">
                {(Object.keys(META) as MetaType[]).map((t) => {
                  const Icon = META[t].Icon;
                  const active = newType === t;
                  return (
                    <Button
                      key={t}
                      type="button"
                      variant={active ? "default" : "outline"}
                      size="sm"
                      onClick={() => setNewType(t)}
                    >
                      <Icon className="h-4 w-4" /> {META[t].label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-name">{t("advanced.meta.channelNameLabel")}</Label>
              <Input
                id="m-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={newType === "whatsapp" ? t("advanced.meta.namePlaceholderWhatsapp") : t("advanced.meta.namePlaceholderFacebook")}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>{t("advanced.meta.cancel")}</Button>
            <Button onClick={addChannel} disabled={creating || !newName.trim()}>
              {creating ? t("advanced.meta.creating") : t("advanced.meta.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 設定 Meta config */}
      <MetaConfigDialog channel={editing} onClose={() => setEditId(null)} />
    </PageShell>
  );
}

/** 隨機產生一組 verify_token(供 Meta 訂閱驗證握手)。 */
function randomToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** WhatsApp / Facebook 設定對話框。敏感欄位留空 = 沿用既有。 */
function MetaConfigDialog({ channel, onClose }: { channel: RawChannel | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { setWhatsapp, setFacebook } = useMetaChannelMutations();
  const [lastId, setLastId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // 表單欄位(以字串保存;敏感欄位留空表示不變更)
  const [ident, setIdent] = useState(""); // phone_number_id / page_id
  const [token, setToken] = useState(""); // access_token / page_access_token
  const [verify, setVerify] = useState("");
  const [appSecret, setAppSecret] = useState("");

  const type = (channel?.type ?? "whatsapp") as MetaType;
  const cfg = (channel?.config ?? {}) as Record<string, unknown>;

  // channel 變更即以其(非機敏)config 初始化表單
  if (channel && channel.id !== lastId) {
    setLastId(channel.id);
    const c = (channel.config ?? {}) as Record<string, unknown>;
    setIdent(String((type === "whatsapp" ? c.phone_number_id : c.page_id) ?? ""));
    setToken("");
    // verify_token 遮罩後不可還原,預填空;若已設定則提示;未設定時自動生成一組便於填 Meta
    setVerify(c.verify_token ? "" : randomToken());
    setAppSecret("");
    setError(null);
    setSaved(false);
  }

  const url = webhookUrl(type, cfg.public_key as string | undefined);
  const verifyAlreadySet = Boolean(cfg.verify_token);

  async function save() {
    if (!channel) return;
    setError(null);
    setSaved(false);
    try {
      if (type === "whatsapp") {
        const body: WhatsAppConfigInput = {
          phone_number_id: ident.trim(),
          access_token: token.trim() || undefined,
          verify_token: verify.trim() || undefined,
          app_secret: appSecret.trim() || undefined,
        };
        await setWhatsapp.mutateAsync({ id: channel.id, body });
      } else {
        const body: FacebookConfigInput = {
          page_id: ident.trim(),
          page_access_token: token.trim() || undefined,
          verify_token: verify.trim() || undefined,
          app_secret: appSecret.trim() || undefined,
        };
        await setFacebook.mutateAsync({ id: channel.id, body });
      }
      setSaved(true);
      setTimeout(() => onClose(), 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("advanced.meta.errorSaveFailed"));
    }
  }

  const pending = setWhatsapp.isPending || setFacebook.isPending;
  const identLabel = type === "whatsapp" ? "Phone Number ID" : "Page ID";
  const tokenLabel = type === "whatsapp" ? "Access Token" : "Page Access Token";

  return (
    <Dialog open={!!channel} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("advanced.meta.configTitle", { label: META[type]?.label, name: channel?.name })}</DialogTitle>
          <DialogDescription>
            {t("advanced.meta.configDialogDesc")}
          </DialogDescription>
        </DialogHeader>

        {channel && (
          <div className="space-y-4">
            {/* 貼到 Meta 的資訊 */}
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Link2 className="h-4 w-4 text-brand" /> {t("advanced.meta.pasteToMeta")}
              </p>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{t("advanced.meta.webhookUrlLabel")}</Label>
                {url ? <CopyField value={url} /> : <p className="text-xs text-muted-foreground">{t("advanced.meta.noPublicKeyShort")}</p>}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("advanced.meta.metaAppHint")}
              </p>
            </div>

            {/* 設定表單 */}
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="space-y-1.5">
                <Label>{identLabel}</Label>
                <Input
                  value={ident}
                  onChange={(e) => setIdent(e.target.value)}
                  placeholder={type === "whatsapp" ? t("advanced.meta.identPlaceholderWhatsapp") : t("advanced.meta.identPlaceholderFacebook")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{tokenLabel}</Label>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={cfg[type === "whatsapp" ? "access_token" : "page_access_token"] ? t("advanced.meta.placeholderKeepExisting") : t("advanced.meta.tokenPlaceholderNew")}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" /> Verify Token
                </Label>
                <div className="flex gap-1.5">
                  <Input
                    value={verify}
                    onChange={(e) => setVerify(e.target.value)}
                    placeholder={verifyAlreadySet ? t("advanced.meta.verifyPlaceholderKeep") : t("advanced.meta.verifyPlaceholderNew")}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => setVerify(randomToken())}>
                    <Sparkles className="h-4 w-4" /> {t("advanced.meta.generate")}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {verifyAlreadySet
                    ? t("advanced.meta.verifyNoteSet")
                    : t("advanced.meta.verifyNoteUnset")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>App Secret</Label>
                <Input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder={cfg.app_secret ? t("advanced.meta.placeholderKeepExisting") : t("advanced.meta.appSecretPlaceholderNew")}
                />
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {saved && (
            <span className="mr-auto flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> {t("advanced.meta.saved")}
            </span>
          )}
          <Button variant="outline" onClick={onClose}>{t("advanced.meta.cancel")}</Button>
          <Button onClick={save} disabled={pending || !ident.trim()}>
            {pending ? t("advanced.meta.saving") : t("advanced.meta.saveConfig")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
