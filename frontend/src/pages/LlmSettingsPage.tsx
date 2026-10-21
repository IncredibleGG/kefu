import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { tenancyApi } from "@/api/endpoints";
import i18n from "@/lib/i18n";
import { cn } from "@/lib/utils";

const providers = (): { value: string; label: string; base: string }[] => [
  { value: "openai", label: i18n.t("team.llm.providerOpenai"), base: "https://api.openai.com/v1" },
  { value: "anthropic", label: "Anthropic", base: "https://api.anthropic.com" },
  { value: "local", label: i18n.t("team.llm.providerLocal"), base: "http://localhost:11434/v1" },
];

/** 模型供應商(BYO Key):讀寫 tenant.llm_config。金鑰為 write-only(讀取時後端遮罩)。 */
export function LlmSettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: tenant, isLoading, isError, refetch } = useQuery({
    queryKey: ["tenant", "me"],
    queryFn: () => tenancyApi.me(),
  });

  const [provider, setProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const PROVIDERS = providers();
  const cfg = (tenant?.llm_config ?? {}) as Record<string, unknown>;
  const hasKey = typeof cfg.api_key === "string" && (cfg.api_key as string).length > 0;

  // 載入現有設定 → 帶入表單(金鑰不帶入,維持 write-only)
  useEffect(() => {
    if (!tenant) return;
    const c = (tenant.llm_config ?? {}) as Record<string, unknown>;
    if (typeof c.provider === "string") setProvider(c.provider);
    if (typeof c.base_url === "string") setBaseUrl(c.base_url);
    if (typeof c.model === "string") setModel(c.model);
  }, [tenant]);

  const save = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error(t("team.llm.tenantNotLoaded"));
      // read-merge:保留其他鍵;金鑰為 write-only,留空則清除(避免把遮罩值寫回)
      const merged: Record<string, unknown> = { ...cfg };
      merged.provider = provider;
      merged.base_url = baseUrl || undefined;
      merged.model = model || undefined;
      if (apiKey.trim()) merged.api_key = apiKey.trim();
      else delete merged.api_key;
      return tenancyApi.update(tenant.id, { llm_config: merged });
    },
    onSuccess: () => {
      setApiKey("");
      setSaved(true);
      setError(null);
      qc.invalidateQueries({ queryKey: ["tenant", "me"] });
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (e) => setError(e instanceof Error ? e.message : t("team.llm.saveError")),
  });

  function handleSave() {
    // 金鑰為 write-only:留空且已有金鑰 → 儲存將清除,先確認以免誤刪
    if (!apiKey.trim() && hasKey) {
      if (!confirm(t("team.llm.confirmClearKey"))) return;
    }
    save.mutate();
  }

  return (
    <PageShell
      title={t("team.llm.title")}
      description={t("team.llm.description")}
    >
      {isLoading ? (
        <Skeleton className="h-72 max-w-lg" />
      ) : isError ? (
        <Card className="max-w-lg">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <p className="text-sm text-muted-foreground">{t("reports.loadError")}</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              {t("reports.retry")}
            </button>
          </CardContent>
        </Card>
      ) : (
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle className="text-sm">{t("team.llm.cardTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("team.llm.provider")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => {
                      setProvider(p.value);
                      if (!baseUrl) setBaseUrl(p.base);
                    }}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                      provider === p.value
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="llm-base">{t("team.llm.baseUrl")}</Label>
              <Input
                id="llm-base"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="llm-model">{t("team.llm.model")}</Label>
              <Input
                id="llm-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o-mini / claude-3-5-sonnet …"
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="llm-key">{t("team.llm.apiKey")}</Label>
              <Input
                id="llm-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasKey ? t("team.llm.keyPlaceholderSet") : "sk-..."}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                {t("team.llm.keyHint")}
                {hasKey
                  ? t("team.llm.keyHintHasKey")
                  : t("team.llm.keyHintNoKey")}
              </p>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            {saved && <p className="text-xs text-success">{t("team.llm.saved")}</p>}

            <Button onClick={handleSave} disabled={save.isPending}>
              {save.isPending ? t("team.llm.saving") : t("team.llm.save")}
            </Button>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
