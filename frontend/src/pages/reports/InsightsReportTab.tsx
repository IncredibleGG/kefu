/** 聚合洞察分頁(對齊 LiveChat「Insights」):用 LLM 掃近 N 天訪客訊息,
 *  «30 秒讀完上千則對話»——熱門問題 / 主題(主題 + 佔比條 + 範例)、整體情緒趨勢、
 *  建議關注點。可切 7 / 30 天;載入 / 空 / 錯誤齊全;沿用 reports/_shared 元件風格。
 *
 *  資料層:後端 GET /api/v1/reporting/insights?days=N(report.view、租戶隔離、結果快取)。
 *  endpoints.ts / quality.ts 不在本次可改範圍,故就地以 @/api/client 的 call() 取用。 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb, Smile, Meh, Frown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call } from "@/api/client";
import { cn } from "@/lib/utils";
import { KpiCard, SectionCard, QueryState } from "./_shared";

type Sentiment = "positive" | "neutral" | "negative";

interface InsightTopic {
  topic: string;
  count: number;
  share: number;
  example: string | null;
}
interface InsightsData {
  days: number;
  sample_size: number;
  status: "ok" | "insufficient" | "unavailable";
  topics: InsightTopic[];
  sentiment: { overall: Sentiment; summary: string | null };
  recommendations: string[];
  generated_at: string;
}

/** 就地資料存取:GET /reporting/insights?days=N(租戶隔離由後端依 JWT 處理)。 */
function fetchInsights(days: number) {
  return call<InsightsData>({
    path: "/api/v1/reporting/insights",
    params: { days },
    real: true,
  });
}

const SENTIMENT_ICON: Record<Sentiment, typeof Smile> = {
  positive: Smile,
  neutral: Meh,
  negative: Frown,
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function InsightsReportTab() {
  const { t } = useTranslation();
  const [days, setDays] = useState<7 | 30>(7);

  const q = useQuery({
    queryKey: ["reports", "insights", days],
    queryFn: () => fetchInsights(days),
    // 與後端 1 小時快取對齊,避免頻繁重打 LLM。
    staleTime: 60 * 60_000,
  });

  const data = q.data;
  const topics = data?.topics ?? [];
  const maxShare = topics.reduce((m, x) => Math.max(m, x.share), 0) || 1;
  const degraded = !!data && data.status !== "ok";
  const overall = data?.sentiment.overall ?? "neutral";
  const SentimentIcon = SENTIMENT_ICON[overall];
  const sentimentLabel = t(`insights.sentiment_${overall}`, {
    defaultValue:
      overall === "positive" ? "正面" : overall === "negative" ? "負面" : "中性",
  });

  // 熱門主題 / 建議的空與降級狀態文案(status 決定資料不足 vs. LLM 暫時無法產生)。
  const emptyText =
    data?.status === "unavailable"
      ? t("insights.unavailable", { defaultValue: "洞察暫時無法產生,請稍後重試" })
      : t("insights.insufficient", {
          defaultValue: "近期資料不足,暫無足夠對話可供分析",
        });

  const DayButton = ({ value, label }: { value: 7 | 30; label: string }) => (
    <Button
      variant={days === value ? "default" : "outline"}
      size="sm"
      onClick={() => setDays(value)}
      aria-pressed={days === value}
    >
      {label}
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* 標題列 + 天數切換 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Lightbulb className="h-4 w-4 text-primary" />
            {t("insights.title", { defaultValue: "聚合洞察" })}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("insights.subtitle", {
              defaultValue:
                "30 秒讀完上千則對話:熱門問題、情緒趨勢與建議關注點",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DayButton value={7} label={t("insights.days7", { defaultValue: "近 7 天" })} />
          <DayButton value={30} label={t("insights.days30", { defaultValue: "近 30 天" })} />
        </div>
      </div>

      {/* KPI 列 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard
          label={t("insights.kpiSampleSize", { defaultValue: "分析樣本" })}
          value={q.isLoading ? "…" : String(data?.sample_size ?? 0)}
          hint={t("insights.kpiSampleHint", {
            days,
            defaultValue: `近 ${days} 天訪客訊息`,
          })}
        />
        <KpiCard
          label={t("insights.kpiTopTopic", { defaultValue: "最熱門主題" })}
          value={q.isLoading ? "…" : topics[0]?.topic ?? "—"}
          hint={
            topics[0]
              ? t("insights.topicShareHint", {
                  share: topics[0].share,
                  defaultValue: `約佔 ${topics[0].share}%`,
                })
              : undefined
          }
        />
        <KpiCard
          label={t("insights.kpiSentiment", { defaultValue: "整體情緒" })}
          value={q.isLoading ? "…" : sentimentLabel}
        />
      </div>

      {/* 熱門問題 / 主題 */}
      <SectionCard title={t("insights.topicsTitle", { defaultValue: "熱門問題 / 主題" })}>
        <QueryState
          isLoading={q.isLoading}
          isError={q.isError}
          isEmpty={degraded || topics.length === 0}
          onRetry={() => q.refetch()}
          emptyText={topics.length === 0 && !degraded ? t("insights.emptyTopics", { defaultValue: "尚未辨識出明顯的熱門主題" }) : emptyText}
          skeletonHeight={220}
        >
          <ol className="space-y-3">
            {topics.map((tp, i) => (
              <li key={`${tp.topic}-${i}`} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                    <span className="truncate font-medium">{tp.topic}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge variant="secondary" className="tabular-nums">
                      {t("insights.topicShare", { share: tp.share, defaultValue: `${tp.share}%` })}
                    </Badge>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t("insights.topicCount", { count: tp.count, defaultValue: `約 ${tp.count} 則` })}
                    </span>
                  </span>
                </div>
                {/* 佔比條(相對最高佔比縮放,確保視覺可辨) */}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(4, (tp.share / maxShare) * 100)}%` }}
                  />
                </div>
                {tp.example && (
                  <p className="truncate text-xs text-muted-foreground">
                    {t("insights.exampleLabel", { defaultValue: "範例" })}:{tp.example}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </QueryState>
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 情緒趨勢 */}
        <SectionCard title={t("insights.sentimentTitle", { defaultValue: "情緒趨勢" })}>
          <QueryState
            isLoading={q.isLoading}
            isError={q.isError}
            isEmpty={degraded || !data?.sentiment.summary}
            onRetry={() => q.refetch()}
            emptyText={emptyText}
            skeletonHeight={120}
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-full p-2",
                  overall === "positive"
                    ? "bg-success/15 text-success"
                    : overall === "negative"
                      ? "bg-destructive/15 text-destructive"
                      : "bg-muted text-muted-foreground",
                )}
              >
                <SentimentIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{sentimentLabel}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{data?.sentiment.summary}</p>
              </div>
            </div>
          </QueryState>
        </SectionCard>

        {/* 建議關注點 */}
        <SectionCard title={t("insights.recommendationsTitle", { defaultValue: "建議關注點" })}>
          <QueryState
            isLoading={q.isLoading}
            isError={q.isError}
            isEmpty={degraded || (data?.recommendations.length ?? 0) === 0}
            onRetry={() => q.refetch()}
            emptyText={emptyText}
            skeletonHeight={120}
          >
            <ul className="space-y-2">
              {(data?.recommendations ?? []).map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>
      </div>

      {/* 產生時間(僅正常結果顯示) */}
      {data?.status === "ok" && (
        <p className="text-right text-xs text-muted-foreground">
          {t("insights.generatedAt", {
            time: fmtTime(data.generated_at),
            defaultValue: `產生於 ${fmtTime(data.generated_at)}`,
          })}
        </p>
      )}
    </div>
  );
}
