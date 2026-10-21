import { useTranslation } from "react-i18next";
import { Sparkles, BookOpen, ArrowRight } from "lucide-react";
import { useSuggestions } from "@/api/hooks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 輸入框上方的 AI 回覆建議條(合併 AI 生成 + 知識庫聯想) */
export function SuggestionBar({
  sessionId,
  onAdopt,
}: {
  sessionId: string;
  onAdopt: (text: string) => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useSuggestions(sessionId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 border-t border-border bg-brand/5 px-3 py-2 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 animate-pulse text-brand" /> {t("workspace.suggestionBar.generating")}
      </div>
    );
  }
  if (!data || data.length === 0) return null;

  return (
    <div className="border-t border-border bg-brand/5 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-brand">
        <Sparkles className="h-3.5 w-3.5" />
        {t("workspace.suggestions")}
      </div>
      <div className="flex flex-wrap gap-2">
        {data.map((s) => (
          <div
            key={s.id}
            className={cn(
              "group flex max-w-md items-start gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs",
              s.kind === "ai" ? "border-brand/30" : "border-border",
            )}
          >
            <Badge variant={s.kind === "ai" ? "brand" : "secondary"} className="mt-0.5 shrink-0">
              {s.kind === "ai" ? (
                <>
                  <Sparkles className="h-3 w-3" /> AI
                </>
              ) : (
                <>
                  <BookOpen className="h-3 w-3" /> {t("workspace.suggestionBar.kb")}
                </>
              )}
            </Badge>
            <div className="min-w-0">
              <p className="text-foreground">{s.text}</p>
              {s.source && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t("workspace.suggestionBar.source", { source: s.source })}
                </p>
              )}
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0 opacity-60 group-hover:opacity-100"
              onClick={() => onAdopt(s.text)}
              aria-label={t("workspace.adopt")}
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
