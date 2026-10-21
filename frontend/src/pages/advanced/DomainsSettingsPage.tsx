import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Plus, Trash2, CheckCircle2, Clock, ShieldCheck, Loader2, Star } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { useCustomDomains, useDomainMutations } from "@/api/hooks";
import type { CustomDomain, DnsInstructions, DnsRecord, DomainVerifyResult } from "@/types";
import { CopyField } from "./shared";

/** 單筆 DNS 記錄:主機 / 類型 / 值(值可複製)。 */
function DnsRecordRow({ label, record }: { label: string; record: DnsRecord }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">
        {label} <span className="font-mono text-muted-foreground">({record.type})</span>
      </p>
      <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <p className="mb-0.5 text-[11px] text-muted-foreground">{t("domains.dnsHost")}</p>
          <CopyField value={record.host} />
        </div>
        <div>
          <p className="mb-0.5 text-[11px] text-muted-foreground">{t("domains.dnsValue")}</p>
          <CopyField value={record.value} />
        </div>
      </div>
    </div>
  );
}

/** DNS 設定指示區塊(TXT 驗證 + CNAME 指向平台入口)。 */
function DnsInstructionsBox({ dns }: { dns: DnsInstructions }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs font-medium text-foreground">{t("domains.dnsTitle")}</p>
      <DnsRecordRow label={t("domains.dnsTxtLabel")} record={dns.txt} />
      <DnsRecordRow label={t("domains.dnsCnameLabel")} record={dns.cname} />
      {dns.note && <p className="text-[11px] leading-relaxed text-muted-foreground">{dns.note}</p>}
    </div>
  );
}

/** 綁定新網域對話框。 */
function BindDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const { bind } = useDomainMutations();
  const [domain, setDomain] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setDomain("");
    setIsPrimary(false);
    setError(null);
  }

  async function submit() {
    setError(null);
    if (!domain.trim()) {
      setError(t("domains.errorRequired"));
      return;
    }
    try {
      await bind.mutateAsync({ domain: domain.trim(), is_primary: isPrimary });
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("domains.errorFailed"));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("domains.bindTitle")}</DialogTitle>
          <DialogDescription>{t("domains.bindDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="d-domain">{t("domains.domainLabel")}</Label>
            <Input
              id="d-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="support.example.com"
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <label className="flex cursor-pointer items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm">{t("domains.setPrimary")}</p>
              <p className="text-xs text-muted-foreground">{t("domains.setPrimaryHint")}</p>
            </div>
            <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
          </label>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={bind.isPending || !domain.trim()}>
            {bind.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {bind.isPending ? t("domains.binding") : t("domains.bind")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 單筆已綁網域:狀態 / DNS 指示 / 驗證 / 解除綁定。 */
function DomainCard({ domain }: { domain: CustomDomain }) {
  const { t } = useTranslation();
  const { unbind, verify } = useDomainMutations();
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [verifyResult, setVerifyResult] = useState<DomainVerifyResult | null>(null);

  async function onVerify() {
    setVerifyResult(null);
    try {
      const res = await verify.mutateAsync(domain.id);
      setVerifyResult(res);
    } catch {
      /* 錯誤忽略;list 失效後會反映最新狀態 */
    }
  }

  // 驗證後回傳的最新 DNS 指示優先(pending 時附回),否則用列表既有的
  const dns = verifyResult?.dns_instructions ?? domain.dns_instructions;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Globe className="h-4 w-4 text-brand" />
              <span className="break-all font-mono text-sm font-medium">{domain.domain}</span>
              {domain.is_primary && (
                <Badge variant="brand">
                  <Star className="h-3 w-3" /> {t("domains.primary")}
                </Badge>
              )}
              {domain.verified ? (
                <Badge variant="success">
                  <CheckCircle2 className="h-3 w-3" /> {t("domains.verified")}
                </Badge>
              ) : (
                <Badge variant="warning">
                  <Clock className="h-3 w-3" /> {t("domains.pending")}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {!domain.verified && (
              <Button variant="outline" size="sm" className="gap-1.5" disabled={verify.isPending} onClick={onVerify}>
                {verify.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {verify.isPending ? t("domains.verifying") : t("domains.verify")}
              </Button>
            )}
            {confirmUnbind ? (
              <>
                <Button variant="destructive" size="sm" disabled={unbind.isPending} onClick={() => unbind.mutate(domain.id)}>
                  {unbind.isPending ? t("domains.unbinding") : t("domains.confirmUnbind")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmUnbind(false)}>
                  {t("common.cancel")}
                </Button>
              </>
            ) : (
              <Button variant="outline" size="icon-sm" onClick={() => setConfirmUnbind(true)} aria-label={t("domains.unbind")}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* 驗證結果訊息(pending 時後端會附說明) */}
        {verifyResult && !verifyResult.verified && verifyResult.detail && (
          <p className="mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">{verifyResult.detail}</p>
        )}
        {verifyResult && verifyResult.verified && (
          <p className="mt-2 rounded-md bg-success/10 px-2.5 py-1.5 text-xs text-success">{t("domains.verifySuccess")}</p>
        )}

        {/* 未驗證:顯示 DNS 設定指示 */}
        {!domain.verified && dns && <DnsInstructionsBox dns={dns} />}
      </CardContent>
    </Card>
  );
}

/** 自訂網域綁定頁(/settings?tab=domains,admin):列已綁網域、綁新網域、驗證、解除綁定。 */
export function DomainsSettingsPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useCustomDomains();
  const [bindOpen, setBindOpen] = useState(false);
  const domains = data?.items ?? [];

  return (
    <PageShell
      title={t("domains.title")}
      description={t("domains.description")}
      actions={
        <Button size="sm" onClick={() => setBindOpen(true)}>
          <Plus className="h-4 w-4" /> {t("domains.bindButton")}
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : domains.length === 0 ? (
        <Card className="max-w-3xl">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Globe className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("domains.empty")}</p>
            <Button size="sm" variant="outline" onClick={() => setBindOpen(true)}>
              <Plus className="h-4 w-4" /> {t("domains.bindButton")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-3">
          {domains.map((d) => (
            <DomainCard key={d.id} domain={d} />
          ))}
        </div>
      )}

      <BindDialog open={bindOpen} onOpenChange={setBindOpen} />
    </PageShell>
  );
}
