import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Tag as TagIcon, Plus, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { conversationApi, visitorApi } from "@/api/endpoints";
import { cn } from "@/lib/utils";
import i18n from "@/lib/i18n";
import type { Tag } from "@/types";

export const sessionTagsKey = (id: string) => ["sessionTags", id] as const;

/** 標籤色點:tag.color 為 hex/hsl 字串時用行內色,否則用品牌色。 */
function dot(color?: string | null) {
  return color ? { backgroundColor: color } : undefined;
}

/** 會話頭部標籤控制:顯示已套用標籤 + 彈出主檔清單勾選加/移除。 */
export function SessionTags({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const applied = useQuery({
    queryKey: sessionTagsKey(sessionId),
    queryFn: () => conversationApi.listSessionTags(sessionId),
  });
  const master = useQuery({
    queryKey: ["tags", "session"],
    queryFn: () => visitorApi.listTags() as Promise<Tag[]>,
  });

  const appliedIds = new Set((applied.data ?? []).map((t) => t.id));

  const toggle = useMutation({
    mutationFn: async (tag: Tag) => {
      if (appliedIds.has(tag.id)) await conversationApi.removeSessionTag(sessionId, tag.id);
      else await conversationApi.applySessionTag(sessionId, tag.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sessionTagsKey(sessionId) });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const remove = useMutation({
    mutationFn: (tagId: string) => conversationApi.removeSessionTag(sessionId, tagId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sessionTagsKey(sessionId) });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  return (
    <Popover>
      <SimpleTooltip label={t("workspace.sessionTags.label")} side="bottom">
        <PopoverTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t("workspace.sessionTags.label")} className="relative">
            <TagIcon className="h-4 w-4" />
            {appliedIds.size > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand px-0.5 text-[9px] font-semibold text-brand-foreground">
                {appliedIds.size}
              </span>
            )}
          </Button>
        </PopoverTrigger>
      </SimpleTooltip>
      <PopoverContent align="end" className="w-64 p-0">
        {/* 已套用 */}
        <div className="border-b border-border p-2.5">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("workspace.sessionTags.appliedTitle")}
          </div>
          {applied.data && applied.data.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {applied.data.map((t) => (
                <Badge key={t.id} variant="secondary" className="gap-1 pr-1">
                  <span className="h-2 w-2 rounded-full bg-brand" style={dot(t.color)} />
                  {t.name}
                  <button
                    onClick={() => remove.mutate(t.id)}
                    className="rounded-sm hover:bg-background/50"
                    aria-label={i18n.t("workspace.sessionTags.remove", { name: t.name })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("workspace.sessionTags.noneApplied")}</p>
          )}
        </div>
        {/* 主檔清單勾選 */}
        <div className="max-h-56 overflow-y-auto p-1">
          <div className="px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("workspace.sessionTags.selectTitle")}
          </div>
          {master.isLoading ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t("workspace.loading")}</p>
          ) : (master.data ?? []).length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t("workspace.sessionTags.noMaster")}</p>
          ) : (
            (master.data ?? []).map((t) => {
              const on = appliedIds.has(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => toggle.mutate(t)}
                  disabled={toggle.isPending}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    on && "font-medium",
                  )}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand" style={dot(t.color)} />
                  <span className="flex-1 truncate">{t.name}</span>
                  {on && <Check className="h-3.5 w-3.5 text-brand" />}
                </button>
              );
            })
          )}
          <div className="mt-1 border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
            <Plus className="mr-1 inline h-3 w-3" />
            {t("workspace.sessionTags.manageHint")}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
