import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Tag as TagIcon, AlertCircle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useTags } from "@/api/hooks";
import { visitorApi } from "@/api/endpoints";

const PRESET_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b"];

export function TagsSettingsPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useTags();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[5]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await visitorApi.createTag(name.trim(), color);
      await qc.invalidateQueries({ queryKey: ["tags"] });
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("team.tags.createError"));
    } finally {
      setSaving(false);
    }
  }

  const tags = data ?? [];

  return (
    <PageShell title={t("team.tags.title")} description={t("team.tags.description")}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* 建立 */}
        <Card className="lg:col-span-1">
          <CardHeader className="flex-row items-center gap-2">
            <Plus className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">{t("team.tags.addTag")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tag-name">{t("team.tags.name")}</Label>
              <Input
                id="tag-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
                placeholder={t("team.tags.namePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("team.tags.color")}</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110"
                    style={{ backgroundColor: c, borderColor: color === c ? "var(--foreground, #000)" : "transparent" }}
                    aria-label={t("team.tags.colorAria", { color: c })}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-7 w-9 cursor-pointer rounded-md border border-input bg-transparent"
                  aria-label={t("team.tags.customColor")}
                />
              </div>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button onClick={create} disabled={saving || !name.trim()} className="w-full">
              {saving ? t("team.tags.creating") : t("team.tags.createTag")}
            </Button>
          </CardContent>
        </Card>

        {/* 清單 */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center gap-2">
            <TagIcon className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">{t("team.tags.allTags", { total: tags.length })}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : isError ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <AlertCircle className="h-6 w-6 text-destructive" />
                <p className="text-sm text-muted-foreground">{t("reports.loadError")}</p>
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="text-xs text-primary underline-offset-2 hover:underline"
                >
                  {t("reports.retry")}
                </button>
              </div>
            ) : tags.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground">{t("team.tags.empty")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm"
                    style={{
                      borderColor: (t.color ?? "#64748b") + "66",
                      backgroundColor: (t.color ?? "#64748b") + "18",
                      color: t.color ?? undefined,
                    }}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color ?? "#64748b" }} />
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
