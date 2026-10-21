import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BookOpen, Globe, ExternalLink, AlertCircle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useHelpCenterCollections, useHelpCenterMutations } from "@/api/hooks";
import { tenancyApi } from "@/api/endpoints";
import { apiOrigin, CopyField } from "./shared";
import i18n from "@/lib/i18n";

/** 內容來源型別標籤(以函式回傳,確保語言切換後即時更新)。 */
function sourceLabel(sourceType: string): string {
  const labels: Record<string, string> = {
    document: i18n.t("advanced.helpCenter.sourceDocument"),
    website: i18n.t("advanced.helpCenter.sourceWebsite"),
    qa: i18n.t("advanced.helpCenter.sourceQa"),
  };
  return labels[sourceType] ?? sourceType;
}

/** 依租戶 slug + 集合 public_slug 組出公開 Help Center 內容連結(對齊後端 _publish_payload)。 */
function publicUrl(tenantSlug: string | undefined, publicSlug: string | null): string | null {
  if (!tenantSlug || !publicSlug) return null;
  return `${apiOrigin()}/api/v1/helpcenter/${tenantSlug}/articles?collection=${publicSlug}`;
}

/** Help Center 發布管理:列知識庫集合,發布 / 取消發布,顯示公開網址。 */
export function HelpCenterSettingsPage() {
  const { t } = useTranslation();
  const { data: collections, isLoading, isError, refetch } = useHelpCenterCollections();
  const { publish, unpublish } = useHelpCenterMutations();
  // 取租戶 slug 以組公開連結(集合清單不含 tenant_slug)
  const { data: tenant } = useQuery({ queryKey: ["tenancy", "me"], queryFn: () => tenancyApi.me() });
  const tenantSlug = tenant?.slug;

  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(id: string, next: boolean) {
    setBusyId(id);
    try {
      if (next) await publish.mutateAsync(id);
      else await unpublish.mutateAsync(id);
    } finally {
      setBusyId(null);
    }
  }

  const publishedCount = (collections ?? []).filter((c) => c.is_published).length;

  return (
    <PageShell
      title={t("advanced.helpCenter.title")}
      description={t("advanced.helpCenter.description")}
    >
      {isLoading ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : isError ? (
        <Card className="max-w-3xl">
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
      ) : (collections ?? []).length === 0 ? (
        <Card className="max-w-3xl">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <BookOpen className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t("advanced.helpCenter.emptyState")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-3">
          <p className="text-xs text-muted-foreground">
            {t("advanced.helpCenter.summary", { total: collections?.length, published: publishedCount })}
          </p>
          {(collections ?? []).map((c) => {
            const url = publicUrl(tenantSlug, c.public_slug);
            return (
              <Card key={c.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <BookOpen className="h-4 w-4 text-brand" />
                        <span className="text-sm font-medium">{c.name}</span>
                        <Badge variant="secondary">{sourceLabel(c.source_type)}</Badge>
                        {c.is_published ? (
                          <Badge variant="success">{t("advanced.helpCenter.badgePublished")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("advanced.helpCenter.badgeUnpublished")}</Badge>
                        )}
                      </div>
                      {c.public_slug && (
                        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                          slug:{c.public_slug}
                        </p>
                      )}
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <Globe className="h-3.5 w-3.5" />
                      <Switch
                        checked={c.is_published}
                        disabled={busyId === c.id}
                        onCheckedChange={(v) => toggle(c.id, v)}
                      />
                    </label>
                  </div>

                  {c.is_published && (
                    <div className="mt-3 space-y-1.5 rounded-md border border-border bg-muted/30 p-2.5">
                      <p className="flex items-center gap-1.5 text-xs font-medium">
                        <ExternalLink className="h-3.5 w-3.5 text-brand" /> {t("advanced.helpCenter.publicUrlLabel")}
                      </p>
                      {url ? (
                        <CopyField value={url} />
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {tenantSlug ? t("advanced.helpCenter.noPublicSlug") : t("advanced.helpCenter.loadingTenant")}
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
