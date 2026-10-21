import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, CheckCircle2, XCircle, Send, Check, Code2 } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useChannels, qk } from "@/api/hooks";
import { channelApi } from "@/api/endpoints";
import { channelMeta } from "@/lib/channels";
import { apiOrigin, CopyField } from "./advanced/shared";
import type { ChannelType } from "@/types";

// 本頁可直接建立的渠道型別(email 於「Email 渠道」頁、WhatsApp/Facebook 於 Meta 頁另有專屬流程)
const CREATABLE: ChannelType[] = ["telegram", "web"];

export function ChannelsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { data, isLoading } = useChannels();

  // 支援 ?type= 篩選(僅影響左側列表呈現;Telegram 設定卡仍取全部 telegram 渠道)
  const typeFilter = params.get("type");
  const list = (data ?? []).filter((c) => !typeFilter || c.type === typeFilter);
  const tgChannels = (data ?? []).filter((c) => c.type === "telegram");
  const webChannels = (data ?? []).filter((c) => c.type === "web");

  // 新增渠道
  const [addOpen, setAddOpen] = useState(false);
  const [newType, setNewType] = useState<ChannelType>("telegram");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // 啟用切換(進行中鎖住該列)
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Telegram bot_token / webhook
  const [tgChannelId, setTgChannelId] = useState<string | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgSaving, setTgSaving] = useState(false);
  const [tgSaved, setTgSaved] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);
  // 目前操作的 telegram 渠道:優先使用者選擇,否則落在第一個
  const selectedTgId =
    tgChannelId && tgChannels.some((c) => c.id === tgChannelId)
      ? tgChannelId
      : tgChannels[0]?.id ?? null;

  // 嵌入碼卡:選定的 web 渠道(多個時可切換,否則落第一個)
  const [webChannelId, setWebChannelId] = useState<string | null>(null);
  const selectedWebId =
    webChannelId && webChannels.some((c) => c.id === webChannelId)
      ? webChannelId
      : webChannels[0]?.id ?? null;
  const selectedWeb = webChannels.find((c) => c.id === selectedWebId);
  // web 渠道的 public_key(adapters.mapChannel 對 web 型別不遮罩,提供完整值);即 channelKey。
  const channelKey = selectedWeb?.meta?.public_key ?? "";
  // widget 前端資源(embed.js)預設同源於目前管理台網域;專案目前無專屬 widget host 設定
  // (config.ts 僅有 apiBase)。若 widget 由獨立 CDN / 子網域提供,把下方 host 換成該來源即可。
  const widgetHost = typeof window !== "undefined" ? window.location.origin : "";
  const embedSnippet = channelKey
    ? `<script src="${widgetHost}/embed.js" data-channel-key="${channelKey}"></script>`
    : "";

  function openAdd(type: ChannelType) {
    setAddError(null);
    setNewName("");
    setNewType(type);
    setAddOpen(true);
  }

  async function createChannel() {
    setAddError(null);
    setCreating(true);
    try {
      await channelApi.create(newType, newName.trim());
      setNewName("");
      setAddOpen(false);
      await qc.invalidateQueries({ queryKey: qk.channels() });
    } catch (e) {
      setAddError(e instanceof Error ? e.message : t("advanced.meta.errorCreateFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(id: string, next: boolean) {
    setTogglingId(id);
    try {
      await channelApi.update(id, { is_active: next });
    } finally {
      // 成功或失敗都重新拉取,讓開關回到後端真實狀態
      await qc.invalidateQueries({ queryKey: qk.channels() });
      setTogglingId(null);
    }
  }

  async function saveTelegram() {
    if (!selectedTgId) return;
    setTgError(null);
    setTgSaving(true);
    setTgSaved(false);
    try {
      // 1) 存 bot_token(後端會呼叫 getMe 驗證,失敗則丟錯)
      await channelApi.setTelegramToken(selectedTgId, tgToken.trim());
      // 2) 以對外來源註冊 webhook(後端組出 {base_url}/api/v1/channel/telegram/webhook/{key})
      await channelApi.setTelegramWebhook(selectedTgId, apiOrigin());
      setTgToken("");
      setTgSaved(true);
      setTimeout(() => setTgSaved(false), 2500);
      await qc.invalidateQueries({ queryKey: qk.channels() });
    } catch (e) {
      setTgError(e instanceof Error ? e.message : t("config.common.saveFailed"));
    } finally {
      setTgSaving(false);
    }
  }

  return (
    <PageShell
      title={t("nav.channels")}
      description={t("modules.channels.pageDescription")}
      actions={
        <Button size="sm" onClick={() => openAdd("telegram")}>
          <Plus className="h-4 w-4" /> {t("modules.channels.addChannel")}
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)
          ) : list.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
              </CardContent>
            </Card>
          ) : (
            list.map((c) => {
              const m = channelMeta[c.type];
              return (
                <Card key={c.id}>
                  <CardContent className="flex items-center gap-3 p-3.5">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      <m.Icon className={`h-5 w-5 ${m.color}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{c.name}</span>
                        {c.status === "connected" ? (
                          <Badge variant="success" className="gap-1">
                            <CheckCircle2 className="h-3 w-3" /> {t("common.connected")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <XCircle className="h-3 w-3" /> {t("common.disconnected")}
                          </Badge>
                        )}
                      </div>
                      {c.meta && (
                        <p className="truncate text-xs text-muted-foreground">
                          {Object.entries(c.meta).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                        </p>
                      )}
                    </div>
                    <Switch
                      checked={c.enabled}
                      disabled={togglingId === c.id}
                      onCheckedChange={(v) => toggleActive(c.id, v)}
                    />
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        <div className="space-y-4">
        {/* 網站嵌入碼卡:對選定的 web 渠道顯示完整 channelKey 與一行嵌入碼(皆可複製) */}
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                <Code2 className="h-5 w-5 text-info" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">
                  {t("channels.embed.title", { defaultValue: "網站嵌入碼" })}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t("channels.embed.desc", {
                    defaultValue: "把以下程式碼貼進你的網站,即可在頁面顯示線上客服元件。",
                  })}
                </p>
              </div>
            </div>
            <Separator />

            {webChannels.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
                <Button size="sm" variant="outline" onClick={() => openAdd("web")}>
                  <Plus className="h-4 w-4" /> {t("modules.channels.addChannel")}
                </Button>
              </div>
            ) : (
              <>
                {/* 多個 web 渠道時,選擇要取用嵌入碼的目標 */}
                {webChannels.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {webChannels.map((c) => (
                      <Button
                        key={c.id}
                        type="button"
                        size="sm"
                        variant={c.id === selectedWebId ? "default" : "outline"}
                        onClick={() => setWebChannelId(c.id)}
                      >
                        {c.name}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>
                    {t("channels.embed.channelKeyLabel", { defaultValue: "渠道金鑰(Channel Key)" })}
                  </Label>
                  {channelKey ? (
                    <CopyField value={channelKey} />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("channels.embed.noKey", {
                        defaultValue: "此渠道尚未產生金鑰,啟用後重新整理即可取得。",
                      })}
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {t("channels.embed.keyPublicNote", {
                      defaultValue: "此為公開嵌入金鑰,會出現在你的網站原始碼,可安全公開。",
                    })}
                  </p>
                </div>
                {channelKey && (
                  <div className="space-y-1.5">
                    <Label>{t("channels.embed.snippetLabel", { defaultValue: "一行嵌入碼" })}</Label>
                    <CopyField value={embedSnippet} />
                    <p className="text-[11px] text-muted-foreground">
                      {t("channels.embed.hostNote", {
                        host: widgetHost,
                        defaultValue:
                          "widget 主機預設為目前網域({{host}});若你的 widget 由獨立 CDN 提供,請自行替換 src。",
                      })}
                    </p>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Telegram 設定卡:對選定的 telegram 渠道設定 bot_token 並註冊 webhook */}
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                <Send className="h-5 w-5 text-[hsl(200_80%_50%)]" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">{t("modules.channels.telegramTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("modules.channels.telegramHint")}</p>
              </div>
            </div>
            <Separator />

            {tgChannels.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
                <Button size="sm" variant="outline" onClick={() => openAdd("telegram")}>
                  <Plus className="h-4 w-4" /> {t("modules.channels.addChannel")}
                </Button>
              </div>
            ) : (
              <>
                {/* 多個 telegram 渠道時,選擇要設定的目標 */}
                {tgChannels.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {tgChannels.map((c) => (
                      <Button
                        key={c.id}
                        type="button"
                        size="sm"
                        variant={c.id === selectedTgId ? "default" : "outline"}
                        onClick={() => setTgChannelId(c.id)}
                      >
                        {c.name}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="tg">Bot Token</Label>
                  <Input
                    id="tg"
                    value={tgToken}
                    onChange={(e) => setTgToken(e.target.value)}
                    placeholder="123456:ABC-DEF..."
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t("modules.channels.tokenSecurityNote")}
                  </p>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border p-2.5">
                  <div>
                    <p className="text-sm">{t("modules.channels.receiveMode")}</p>
                    <p className="text-xs text-muted-foreground">{t("modules.channels.receiveModeHint")}</p>
                  </div>
                  <div className="flex gap-1">
                    <Badge variant="brand">Webhook</Badge>
                    <Badge variant="outline">Polling</Badge>
                  </div>
                </div>
                {tgError && <p className="text-xs text-destructive">{tgError}</p>}
                <div className="flex items-center gap-2">
                  <Button
                    className="flex-1"
                    disabled={!tgToken.trim() || !selectedTgId || tgSaving}
                    onClick={saveTelegram}
                  >
                    {tgSaving ? t("config.common.saving") : t("modules.channels.saveAndConnect")}
                  </Button>
                  {tgSaved && (
                    <span className="flex items-center gap-1 text-xs text-success">
                      <Check className="h-3.5 w-3.5" /> {t("config.common.saved")}
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
        </div>
      </div>

      {/* 新增渠道 */}
      <Dialog open={addOpen} onOpenChange={(v) => !v && setAddOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("modules.channels.addChannel")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("advanced.meta.typeLabel")}</Label>
              <div className="flex gap-2">
                {CREATABLE.map((type) => {
                  const m = channelMeta[type];
                  return (
                    <Button
                      key={type}
                      type="button"
                      variant={newType === type ? "default" : "outline"}
                      size="sm"
                      onClick={() => setNewType(type)}
                    >
                      <m.Icon className="h-4 w-4" /> {m.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-name">{t("advanced.meta.channelNameLabel")}</Label>
              <Input
                id="c-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={channelMeta[newType].label}
              />
            </div>
            {addError && <p className="text-xs text-destructive">{addError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t("config.common.cancel")}
            </Button>
            <Button onClick={createChannel} disabled={creating || !newName.trim()}>
              {creating ? t("advanced.meta.creating") : t("advanced.meta.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
