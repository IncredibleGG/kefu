import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, KeyRound, Trash2, Check } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { timeAgo } from "@/lib/utils";
import { useApiKeys, useApiKeyMutations } from "@/api/hooks";
import { CopyField } from "./shared";

/** 開放 API 金鑰管理:建立(明文只顯示一次)、列表(遮罩 + last_used)、撤銷。 */
export function ApiKeySettingsPage() {
  const { t } = useTranslation();
  const { data: keys, isLoading } = useApiKeys();
  const { create, revoke } = useApiKeyMutations();

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [plainKey, setPlainKey] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError(t("advanced.apiKey.errorNameRequired"));
      return;
    }
    try {
      const created = await create.mutateAsync(name.trim());
      setAddOpen(false);
      setName("");
      if (created.key) setPlainKey(created.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("advanced.apiKey.errorCreateFailed"));
    }
  }

  return (
    <PageShell
      title={t("advanced.apiKey.title")}
      description={t("advanced.apiKey.description")}
      actions={
        <Button size="sm" onClick={() => { setError(null); setName(""); setAddOpen(true); }}>
          <Plus className="h-4 w-4" /> {t("advanced.apiKey.createButton")}
        </Button>
      }
    >
      {/* 用法簡要 */}
      <Card className="mb-3 max-w-3xl">
        <CardContent className="space-y-2 p-4">
          <p className="text-sm font-medium">{t("advanced.apiKey.usageTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("advanced.apiKey.usageIntro")} <code className="rounded bg-muted px-1 py-0.5 font-mono">X-Api-Key: &lt;{t("advanced.apiKey.yourKeyPlaceholder")}&gt;</code>
            {t("advanced.apiKey.usageCall")} <code className="rounded bg-muted px-1 py-0.5 font-mono">/api/ext/v1/...</code> {t("advanced.apiKey.usageEndpoint")}
          </p>
          <CopyField value={t("advanced.apiKey.curlExample")} mono />
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : (keys ?? []).length === 0 ? (
        <Card className="max-w-3xl">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <KeyRound className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("advanced.apiKey.emptyState")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-3">
          {(keys ?? []).map((k) => (
            <Card key={k.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-brand" />
                      <span className="text-sm font-medium">{k.name}</span>
                      {k.is_active ? (
                        <Badge variant="success">{t("advanced.apiKey.statusActive")}</Badge>
                      ) : (
                        <Badge variant="secondary">{t("advanced.apiKey.statusRevoked")}</Badge>
                      )}
                    </div>
                    <p className="mt-1.5 font-mono text-xs text-muted-foreground">{k.key_masked}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {k.last_used_at ? t("advanced.apiKey.lastUsed", { time: timeAgo(k.last_used_at) }) : t("advanced.apiKey.neverUsed")}
                      {k.created_at && <> · {t("advanced.apiKey.createdAt", { time: timeAgo(k.created_at) })}</>}
                    </p>
                  </div>
                  {k.is_active && (
                    <div className="shrink-0">
                      {revokingId === k.id ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">{t("advanced.apiKey.confirmRevoke")}</span>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={revoke.isPending}
                            onClick={async () => {
                              await revoke.mutateAsync(k.id);
                              setRevokingId(null);
                            }}
                          >
                            {revoke.isPending ? t("advanced.apiKey.revoking") : t("advanced.apiKey.revoke")}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setRevokingId(null)}>{t("advanced.apiKey.cancel")}</Button>
                        </div>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => setRevokingId(k.id)}>
                          <Trash2 className="h-4 w-4" /> {t("advanced.apiKey.revoke")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 建立金鑰 */}
      <Dialog open={addOpen} onOpenChange={(v) => !v && setAddOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("advanced.apiKey.createDialogTitle")}</DialogTitle>
            <DialogDescription>{t("advanced.apiKey.createDialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="k-name">{t("advanced.apiKey.nameLabel")}</Label>
            <Input
              id="k-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("advanced.apiKey.namePlaceholder")}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>{t("advanced.apiKey.cancel")}</Button>
            <Button onClick={submit} disabled={create.isPending || !name.trim()}>
              {create.isPending ? t("advanced.apiKey.creating") : t("advanced.apiKey.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 建立後一次性顯示明文金鑰 */}
      <Dialog open={!!plainKey} onOpenChange={(v) => !v && setPlainKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <span className="flex items-center gap-1.5">
                <Check className="h-4 w-4 text-success" /> {t("advanced.apiKey.createdTitle")}
              </span>
            </DialogTitle>
            <DialogDescription>
              {t("advanced.apiKey.createdDesc")}
            </DialogDescription>
          </DialogHeader>
          {plainKey && <CopyField value={plainKey} />}
          <p className="text-xs text-muted-foreground">
            {t("advanced.apiKey.headerHintBefore")} <code className="rounded bg-muted px-1 py-0.5 font-mono">X-Api-Key</code> {t("advanced.apiKey.headerHintAfter")}
          </p>
          <DialogFooter>
            <Button onClick={() => setPlainKey(null)}>{t("advanced.apiKey.saved")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
