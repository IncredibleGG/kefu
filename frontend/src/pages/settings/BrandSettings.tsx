import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { tenancyApi } from "@/api/endpoints";
import { hexToHslComponents } from "@/lib/brand";

/**
 * 品牌 / 外觀設定:讀寫 tenant.branding。
 * 欄位對齊 lib/brand.bootstrapBranding 與後端 branding._brand_from_tenant 實際套用者:
 *   - name          品牌名稱(登入頁 + 分頁標題)
 *   - logo_url       Logo 圖片網址(登入頁)
 *   - primary_color  主題色 hex(套用到 CSS --brand)
 * read-merge-write:保留 branding 內其餘既有 token,只覆寫本頁三欄。
 */
export function BrandSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const {
    data: tenant,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["tenant", "me"],
    queryFn: () => tenancyApi.me(),
  });

  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("");
  const [logoBroken, setLogoBroken] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 載入現有 branding → 帶入表單
  useEffect(() => {
    if (!tenant) return;
    const b = (tenant.branding ?? {}) as Record<string, unknown>;
    setName(typeof b.name === "string" ? b.name : "");
    setLogoUrl(typeof b.logo_url === "string" ? b.logo_url : "");
    setPrimaryColor(typeof b.primary_color === "string" ? b.primary_color : "");
    setLogoBroken(false);
  }, [tenant]);

  const trimmedColor = primaryColor.trim();
  const colorValid = trimmedColor === "" || hexToHslComponents(trimmedColor) !== null;
  // 供原生色票用的 #RRGGBB 值(非合法 6 碼時退回預設藍,不影響實際輸入)
  const colorSwatch = /^#[0-9a-fA-F]{6}$/.test(trimmedColor) ? trimmedColor : "#2563eb";
  const trimmedLogo = logoUrl.trim();

  const save = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error(t("brand.tenantNotLoaded"));
      // read-merge:保留其他品牌 token,只覆寫本頁三欄;留空即移除該鍵
      const merged: Record<string, unknown> = { ...((tenant.branding ?? {}) as Record<string, unknown>) };
      const nm = name.trim();
      if (nm) merged.name = nm;
      else delete merged.name;
      if (trimmedLogo) merged.logo_url = trimmedLogo;
      else delete merged.logo_url;
      if (trimmedColor) merged.primary_color = trimmedColor;
      else delete merged.primary_color;
      return tenancyApi.update(tenant.id, { branding: merged });
    },
    onSuccess: () => {
      setSaved(true);
      setError(null);
      qc.invalidateQueries({ queryKey: ["tenant", "me"] });
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (e) => setError(e instanceof Error ? e.message : t("brand.saveError")),
  });

  return (
    <PageShell title={t("brand.title")} description={t("brand.description")}>
      {isLoading ? (
        <Skeleton className="h-96 max-w-lg" />
      ) : isError ? (
        <Card className="max-w-lg">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">{t("brand.loadError")}</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle className="text-sm">{t("brand.cardTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* 品牌名稱 */}
            <div className="space-y-1.5">
              <Label htmlFor="brand-name">{t("brand.name")}</Label>
              <Input
                id="brand-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("brand.namePlaceholder")}
              />
              <p className="text-[11px] text-muted-foreground">{t("brand.nameHint")}</p>
            </div>

            {/* Logo 網址 */}
            <div className="space-y-1.5">
              <Label htmlFor="brand-logo">{t("brand.logoUrl")}</Label>
              <Input
                id="brand-logo"
                value={logoUrl}
                onChange={(e) => {
                  setLogoUrl(e.target.value);
                  setLogoBroken(false);
                }}
                placeholder="https://…/logo.png"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">{t("brand.logoUrlHint")}</p>
              {trimmedLogo && (
                <div className="mt-1 flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
                  {logoBroken ? (
                    <span className="text-[11px] text-destructive">{t("brand.logoInvalid")}</span>
                  ) : (
                    <img
                      src={trimmedLogo}
                      alt={t("brand.logoPreview")}
                      className="h-8 max-w-[140px] object-contain"
                      onError={() => setLogoBroken(true)}
                    />
                  )}
                </div>
              )}
            </div>

            {/* 主題色 */}
            <div className="space-y-1.5">
              <Label htmlFor="brand-color">{t("brand.primaryColor")}</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={t("brand.primaryColor")}
                  value={colorSwatch}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
                />
                <Input
                  id="brand-color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  placeholder="#2563eb"
                  className="font-mono text-xs"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">{t("brand.primaryColorHint")}</p>
              {!colorValid && (
                <p className="text-[11px] text-destructive">{t("brand.colorInvalid")}</p>
              )}
            </div>

            {/* 即時預覽(局部;實際全站套用需重新整理) */}
            <div className="space-y-1.5">
              <Label>{t("brand.preview")}</Label>
              <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
                {trimmedLogo && !logoBroken ? (
                  <img
                    src={trimmedLogo}
                    alt={t("brand.logoPreview")}
                    className="h-7 max-w-[120px] object-contain"
                    onError={() => setLogoBroken(true)}
                  />
                ) : (
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold text-white"
                    style={{ backgroundColor: colorValid && trimmedColor ? trimmedColor : "#2563eb" }}
                  >
                    {(name.trim()[0] ?? "K").toUpperCase()}
                  </span>
                )}
                <span className="text-sm font-medium">{name.trim() || t("brand.cardTitle")}</span>
                <span
                  className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium text-white"
                  style={{ backgroundColor: colorValid && trimmedColor ? trimmedColor : "#2563eb" }}
                >
                  {t("brand.previewButton")}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("brand.previewHint")}</p>
            </div>

            {/* 套用提示 */}
            <p className="rounded-md border border-border bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
              {t("brand.applyNote")}
            </p>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex items-center gap-2">
              <Button onClick={() => save.mutate()} disabled={save.isPending || !colorValid}>
                {save.isPending ? t("brand.saving") : t("brand.save")}
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-xs text-success">
                  <Check className="h-3.5 w-3.5" /> {t("brand.saved")}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
