import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, Plug, Settings2 } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  integrationsApi,
  type IntegrationField,
  type IntegrationItem,
} from "@/api/integrations";

/** 分類代碼 → 顯示名(繁中回退;鍵暫存於 locales/_pending/integrations.json)。 */
function useCategoryLabel() {
  const { t } = useTranslation();
  return (category: string) => {
    const map: Record<string, string> = {
      ecommerce: t("integrations.category.ecommerce", { defaultValue: "電商" }),
      notification: t("integrations.category.notification", { defaultValue: "通知" }),
      developer: t("integrations.category.developer", { defaultValue: "開發者" }),
      analytics: t("integrations.category.analytics", { defaultValue: "分析" }),
      marketing: t("integrations.category.marketing", { defaultValue: "行銷" }),
    };
    return map[category] ?? category;
  };
}

/** 依欄位 type 建初始表單值:機敏欄位一律留空(遮罩值不回填),其餘帶入既有值。 */
function initialForm(integration: IntegrationItem): Record<string, string> {
  const form: Record<string, string> = {};
  for (const f of integration.config_schema) {
    if (f.secret) {
      form[f.key] = "";
    } else {
      const v = integration.config?.[f.key];
      form[f.key] = v == null ? "" : String(v);
    }
  }
  return form;
}

function FieldInput({
  field,
  value,
  configured,
  onChange,
}: {
  field: IntegrationField;
  value: string;
  configured: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const secretPlaceholder =
    field.secret && configured
      ? t("integrations.secretKeep", { defaultValue: "已設定,留空表示不變更" })
      : field.placeholder;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`field-${field.key}`}>
        {field.label}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      <Input
        id={`field-${field.key}`}
        type={field.type === "password" ? "password" : "text"}
        value={value}
        autoComplete={field.secret ? "off" : undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={secretPlaceholder}
      />
      {field.help && <p className="text-[11px] text-muted-foreground">{field.help}</p>}
    </div>
  );
}

function IntegrationCard({ integration }: { integration: IntegrationItem }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const categoryLabel = useCategoryLabel();

  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(() => initialForm(integration));

  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; config?: Record<string, string> }) =>
      integrationsApi.update(integration.key, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["integrations"] });
      // 機敏欄位已提交(或沿用),清空輸入使「留空=不變更」語意保持一致
      setForm((prev) => {
        const next = { ...prev };
        for (const f of integration.config_schema) if (f.secret) next[f.key] = "";
        return next;
      });
    },
  });

  function toggleEnabled(next: boolean) {
    save.mutate({ enabled: next });
  }

  function saveConfig() {
    save.mutate({ enabled: integration.enabled, config: form });
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <Plug className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{integration.name}</span>
              <Badge variant="outline" className="text-[10px]">
                {categoryLabel(integration.category)}
              </Badge>
              {integration.enabled ? (
                <Badge className="text-[10px]">
                  {t("integrations.enabled", { defaultValue: "已啟用" })}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">
                  {t("integrations.disabled", { defaultValue: "未啟用" })}
                </Badge>
              )}
              {integration.requires_config &&
                (integration.configured ? (
                  <Badge variant="outline" className="text-[10px] text-emerald-600">
                    {t("integrations.configured", { defaultValue: "已設定" })}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] text-amber-600">
                    {t("integrations.notConfigured", { defaultValue: "未設定" })}
                  </Badge>
                ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{integration.description}</p>
          </div>
          <Switch
            checked={integration.enabled}
            disabled={save.isPending}
            onCheckedChange={toggleEnabled}
            aria-label={
              integration.enabled
                ? t("integrations.disable", { defaultValue: "停用整合" })
                : t("integrations.enable", { defaultValue: "啟用整合" })
            }
          />
        </div>

        {integration.requires_config && (
          <div className="border-t border-border pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setExpanded((v) => !v)}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t("integrations.configure", { defaultValue: "設定" })}
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </Button>

            {expanded && (
              <div className="mt-3 space-y-3 rounded-md border border-border bg-muted/30 p-3">
                {integration.config_schema.map((field) => (
                  <FieldInput
                    key={field.key}
                    field={field}
                    value={form[field.key] ?? ""}
                    configured={integration.configured}
                    onChange={(v) => setForm((prev) => ({ ...prev, [field.key]: v }))}
                  />
                ))}

                {save.isError && (
                  <p className="text-xs text-destructive">
                    {save.error instanceof Error
                      ? save.error.message
                      : t("integrations.saveError", { defaultValue: "儲存整合設定失敗" })}
                  </p>
                )}

                <div className="flex justify-end">
                  <Button size="sm" onClick={saveConfig} disabled={save.isPending}>
                    {save.isPending ? (
                      t("integrations.saving", { defaultValue: "儲存中…" })
                    ) : (
                      <>
                        <Check className="h-4 w-4" />{" "}
                        {t("integrations.save", { defaultValue: "儲存" })}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsSettings() {
  const { t } = useTranslation();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => integrationsApi.catalog(),
  });

  const integrations = data?.integrations ?? [];

  return (
    <PageShell
      title={t("integrations.pageTitle", { defaultValue: "整合 / 插件" })}
      description={t("integrations.pageDescription", {
        defaultValue: "啟用第一方整合,並依需要填入金鑰;所有整合皆為自研,按租戶以開關控制。",
      })}
    >
      {isLoading ? (
        <div className="max-w-2xl space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError ? (
        <Card className="max-w-2xl">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">
              {t("integrations.loadError", { defaultValue: "載入整合目錄失敗" })}
            </p>
          </CardContent>
        </Card>
      ) : integrations.length === 0 ? (
        <Card className="max-w-2xl">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("integrations.empty", { defaultValue: "目前沒有可用的整合。" })}
          </CardContent>
        </Card>
      ) : (
        <div className="max-w-2xl space-y-2">
          {integrations.map((integration) => (
            <IntegrationCard key={integration.key} integration={integration} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
