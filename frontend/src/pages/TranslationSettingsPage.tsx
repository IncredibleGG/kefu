import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Languages, Sparkles, Server, Check, Lock, AlertCircle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { UpgradeNotice } from "@/components/settings/UpgradeNotice";
import { useFeatures } from "@/api/hooks";
import { tenancyApi } from "@/api/endpoints";
import { cn } from "@/lib/utils";
import type { TranslationConfig, TranslationProvider } from "@/types";

const OURS_FEATURE = "translate.ours";
const CUSTOM_FEATURE = "translate.custom";

function readTranslation(llm: Record<string, unknown> | null | undefined): TranslationConfig {
  const t = (llm?.translation ?? {}) as Partial<TranslationConfig>;
  return {
    provider: (t.provider as TranslationProvider) || "google",
    endpoint: t.endpoint || "",
    api_key: t.api_key || "",
  };
}

export function TranslationSettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const features = useFeatures();
  const tenant = useQuery({ queryKey: ["tenancy", "me"], queryFn: () => tenancyApi.me() });

  const OPTIONS: {
    value: TranslationProvider;
    name: string;
    desc: string;
    icon: typeof Languages;
    feature?: string;
  }[] = [
    { value: "google", name: t("config.translation.google.name"), desc: t("config.translation.google.desc"), icon: Languages },
    { value: "ours", name: t("config.translation.ours.name"), desc: t("config.translation.ours.desc"), icon: Sparkles, feature: OURS_FEATURE },
    { value: "custom", name: t("config.translation.custom.name"), desc: t("config.translation.custom.desc"), icon: Server, feature: CUSTOM_FEATURE },
  ];

  const [provider, setProvider] = useState<TranslationProvider>("google");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenant.data) return;
    const cfg = readTranslation(tenant.data.llm_config);
    setProvider(cfg.provider);
    setEndpoint(cfg.endpoint ?? "");
    setApiKey(cfg.api_key ?? "");
  }, [tenant.data]);

  const feat = features.data?.features ?? {};
  const canOurs = feat[OURS_FEATURE] === true;
  const canCustom = feat[CUSTOM_FEATURE] === true;
  const locked = (p: TranslationProvider) => (p === "ours" && !canOurs) || (p === "custom" && !canCustom);

  async function save() {
    if (locked(provider)) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const id = tenant.data!.id;
      // read-merge-write:保留 llm_config 既有頂層鍵,只覆寫 translation 子鍵
      const existing = (tenant.data!.llm_config ?? {}) as Record<string, unknown>;
      const translation: TranslationConfig = { provider };
      if (provider === "custom") {
        translation.endpoint = endpoint;
        if (apiKey) translation.api_key = apiKey; // 空值不覆寫既有金鑰
        else {
          const prev = readTranslation(existing).api_key;
          if (prev) translation.api_key = prev;
        }
      }
      await tenancyApi.update(id, { llm_config: { ...existing, translation } });
      await qc.invalidateQueries({ queryKey: ["tenancy", "me"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("config.common.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const loading = features.isLoading || tenant.isLoading;
  const loadError = features.isError || tenant.isError;

  return (
    <PageShell
      title={t("config.translation.title")}
      description={t("config.translation.description")}
      actions={
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> {t("config.common.saved")}
            </span>
          )}
          <Button size="sm" onClick={save} disabled={saving || loading || locked(provider)}>
            {saving ? t("config.common.saving") : t("config.common.save")}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-3 max-w-2xl rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <Skeleton className="h-72 w-full max-w-2xl" />
      ) : loadError ? (
        <div className="flex max-w-2xl flex-col items-center justify-center gap-2 py-16 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="text-sm text-muted-foreground">{t("reports.loadError")}</p>
          <button
            type="button"
            onClick={() => {
              features.refetch();
              tenant.refetch();
            }}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            {t("reports.retry")}
          </button>
        </div>
      ) : (
        <div className="max-w-2xl space-y-3">
          {OPTIONS.map((opt) => {
            const isLocked = locked(opt.value);
            const active = provider === opt.value;
            const Icon = opt.icon;
            return (
              <Card
                key={opt.value}
                className={cn(
                  "cursor-pointer transition-colors",
                  active && !isLocked ? "border-brand ring-1 ring-brand" : "hover:border-muted-foreground/30",
                  isLocked && "opacity-70",
                )}
                onClick={() => !isLocked && setProvider(opt.value)}
              >
                <CardContent className="flex items-start gap-3 p-4">
                  <div
                    className={cn(
                      "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                      active && !isLocked ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{opt.name}</span>
                      {opt.value === "google" && <Badge variant="success">{t("config.translation.free")}</Badge>}
                      {isLocked && (
                        <Badge variant="warning" className="gap-1">
                          <Lock className="h-3 w-3" /> {t("config.translation.locked")}
                        </Badge>
                      )}
                      {active && !isLocked && <Check className="h-4 w-4 text-brand" />}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{opt.desc}</p>

                    {isLocked && <UpgradeNotice feature={opt.name} className="mt-2" />}

                    {opt.value === "custom" && active && !isLocked && (
                      <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                        <div className="space-y-1.5">
                          <Label htmlFor="ep">{t("config.translation.endpoint")}</Label>
                          <Input
                            id="ep"
                            value={endpoint}
                            onChange={(e) => setEndpoint(e.target.value)}
                            placeholder="https://api.example.com/translate"
                            className="font-mono text-xs"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="key">API Key</Label>
                          <Input
                            id="key"
                            type="password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder={t("config.translation.apiKeyPlaceholder")}
                            className="font-mono text-xs"
                          />
                          <p className="text-[11px] text-muted-foreground">{t("config.translation.apiKeyHint")}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
          <p className="text-[11px] text-muted-foreground">{t("config.translation.defaultHint")}</p>
        </div>
      )}
    </PageShell>
  );
}
