import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  MessageSquareText,
  Globe,
  Plus,
  Trash2,
  ChevronRight,
  BarChart3,
  Search,
  AlertCircle,
  Target,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { knowledgeContentApi, kkeys, type ManagedCollection } from "@/api/knowledgeContent";
import { call } from "@/api/client";
import { tenancyApi } from "@/api/endpoints";
import { timeAgo } from "@/lib/utils";
import { CreateCollectionDialog } from "./knowledge/CreateCollectionDialog";
import { CollectionDetail } from "./knowledge/CollectionDetail";

const typeMeta: Record<string, { labelKey: string; Icon: typeof FileText }> = {
  document: { labelKey: "modules.knowledge.typeDocument", Icon: FileText },
  qa: { labelKey: "modules.knowledge.typeQa", Icon: MessageSquareText },
  website: { labelKey: "modules.knowledge.typeWebsite", Icon: Globe },
};

/** 本頁分頁值。nav 二級欄以 ?tab= 帶入:預設「知識庫列表」,?tab=hits 為「命中分析」。
 *  其餘未知值(如 ?tab=import)一律回列表,維持既有行為(零回歸)。 */
type KnowledgeTab = "list" | "hits";
function normalizeTab(raw: string | null): KnowledgeTab {
  return raw === "hits" ? "hits" : "list";
}

export function KnowledgePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const tab = normalizeTab(params.get("tab"));

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: kkeys.collections,
    queryFn: () => knowledgeContentApi.listCollections(),
  });
  const tenant = useQuery({ queryKey: ["tenancy", "me"], queryFn: () => tenancyApi.me() });

  const remove = useMutation({
    mutationFn: (id: string) => knowledgeContentApi.deleteCollection(id),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: kkeys.collections });
      if (selectedId === id) setSelectedId(null);
    },
  });

  const collections = data ?? [];
  const selected = selectedId ? collections.find((c) => c.id === selectedId) ?? null : null;

  const onTab = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "list") next.delete("tab");
    else next.set("tab", value);
    setParams(next, { replace: true });
  };

  // 詳情視圖(master-detail;不新增路由,以本頁狀態切換)。詳情有自己的返回鍵,不顯示分頁列。
  if (selected) {
    return (
      <PageShell title={t("nav.knowledge")} description={t("modules.knowledge.pageDescription")}>
        <CollectionDetail
          collection={selected}
          tenantSlug={tenant.data?.slug ?? null}
          onBack={() => setSelectedId(null)}
        />
      </PageShell>
    );
  }

  const tabsBar = (
    <Tabs value={tab} onValueChange={onTab}>
      <TabsList>
        <TabsTrigger value="list">
          {t("knowledge.hits.tabList", { defaultValue: "知識庫列表" })}
        </TabsTrigger>
        <TabsTrigger value="hits">
          {t("knowledge.hits.tabHits", { defaultValue: "命中分析" })}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  // 命中分析分頁
  if (tab === "hits") {
    return (
      <PageShell title={t("nav.knowledge")} description={t("modules.knowledge.pageDescription")}>
        <div className="space-y-4">
          {tabsBar}
          <KnowledgeHitsTab />
        </div>
      </PageShell>
    );
  }

  // 知識庫列表分頁(既有行為)
  return (
    <PageShell
      title={t("nav.knowledge")}
      description={t("modules.knowledge.pageDescription")}
      actions={
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> {t("modules.knowledge.addCollection")}
        </Button>
      }
    >
      <div className="space-y-4">
        {tabsBar}
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
        ) : isError ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-destructive">
                {t("knowledge.manage.loadError", {
                  msg: error instanceof Error ? error.message : "",
                })}
              </p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                {t("knowledge.manage.retry")}
              </Button>
            </CardContent>
          </Card>
        ) : collections.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-muted-foreground">{t("knowledge.manage.empty")}</p>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> {t("modules.knowledge.addCollection")}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.map((c: ManagedCollection) => {
              const m = typeMeta[c.source_type] ?? typeMeta.document;
              return (
                <Card key={c.id} className="flex flex-col transition-shadow hover:shadow-md">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
                        <m.Icon className="h-4.5 w-4.5" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary">{t(m.labelKey)}</Badge>
                        <Badge variant={c.is_published ? "success" : "outline"}>
                          {c.is_published
                            ? t("knowledge.manage.published")
                            : t("knowledge.manage.private")}
                        </Badge>
                      </div>
                    </div>
                    <CardTitle className="mt-1 truncate text-sm">{c.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="mt-auto space-y-3">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{t("modules.knowledge.docCount", { n: c.doc_count })}</span>
                      <span>{t("modules.knowledge.updatedAt", { time: timeAgo(c.created_at) })}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => setSelectedId(c.id)}
                      >
                        {t("knowledge.manage.manageContent")}
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(t("knowledge.manage.confirmDeleteCollection", { name: c.name })))
                            remove.mutate(c.id);
                        }}
                        aria-label={t("knowledge.manage.deleteCollection")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <CreateCollectionDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageShell>
  );
}

/* ============================ 命中分析分頁 ============================ */

/** Recharts tooltip 統一外觀(就地定義,避免耦合 reports/ 私有共用件)。 */
const HIT_TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
} as const;

/** 後端 GET /api/v1/knowledge/analytics 回傳形狀(對齊 knowledge.py knowledge_analytics)。 */
interface KbAnalytics {
  days: number;
  total_retrievals: number;
  hit_retrievals: number;
  miss_retrievals: number;
  hit_rate: number | null;
  top_queries: { query: string; count: number }[];
  top_documents: { document_id: string; title: string | null; collection_id: string | null; count: number }[];
  top_collections: { collection_id: string; name: string | null; count: number }[];
  trend: { date: string; total: number; hits: number }[];
}

/** 就地資料存取:GET /knowledge/analytics?days=N(租戶隔離由後端依 JWT 處理;
 *  endpoints.ts 不在本次可改範圍,故沿用 InsightsReportTab 的 @/api/client call() 慣例)。 */
function fetchKbAnalytics(days: number) {
  return call<KbAnalytics>({
    path: "/api/v1/knowledge/analytics",
    params: { days },
    real: true,
  });
}

/** 命中率格式化為百分比字串;null(尚無資料)顯示「—」。 */
function fmtRate(r: number | null | undefined): string {
  if (r === null || r === undefined) return "—";
  return `${(r * 100).toFixed(1)}%`;
}

/** 命中分析分頁:命中率 KPI、熱門搜尋詞、常命中文件 / 集合、逐日趨勢圖。
 *  載入 / 空 / 錯誤狀態齊全;沿用全域圖表色票(--chart-*)與卡片風格。 */
function KnowledgeHitsTab() {
  const { t } = useTranslation();
  const [days, setDays] = useState<7 | 30 | 90>(30);

  const q = useQuery({
    queryKey: ["knowledge", "analytics", days],
    queryFn: () => fetchKbAnalytics(days),
    staleTime: 5 * 60_000,
  });
  const data = q.data;

  const DayButton = ({ value, label }: { value: 7 | 30 | 90; label: string }) => (
    <Button
      variant={days === value ? "default" : "outline"}
      size="sm"
      onClick={() => setDays(value)}
      aria-pressed={days === value}
    >
      {label}
    </Button>
  );

  // 錯誤狀態
  if (q.isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-muted-foreground">
          {t("knowledge.hits.loadError", { defaultValue: "載入命中分析失敗" })}
        </p>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>
          {t("knowledge.hits.retry", { defaultValue: "重試" })}
        </Button>
      </div>
    );
  }

  const kpis: { key: string; label: string; value: string }[] = [
    {
      key: "hit_rate",
      label: t("knowledge.hits.kpiHitRate", { defaultValue: "命中率" }),
      value: q.isLoading ? "…" : fmtRate(data?.hit_rate),
    },
    {
      key: "total",
      label: t("knowledge.hits.kpiTotal", { defaultValue: "總檢索次數" }),
      value: q.isLoading ? "…" : String(data?.total_retrievals ?? 0),
    },
    {
      key: "hits",
      label: t("knowledge.hits.kpiHits", { defaultValue: "命中次數" }),
      value: q.isLoading ? "…" : String(data?.hit_retrievals ?? 0),
    },
    {
      key: "miss",
      label: t("knowledge.hits.kpiMiss", { defaultValue: "未命中次數" }),
      value: q.isLoading ? "…" : String(data?.miss_retrievals ?? 0),
    },
  ];

  const noData = !q.isLoading && (data?.total_retrievals ?? 0) === 0;

  return (
    <div className="space-y-4">
      {/* 標題列 + 天數切換 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <BarChart3 className="h-4 w-4 text-primary" />
            {t("knowledge.hits.title", { defaultValue: "知識庫命中分析" })}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("knowledge.hits.subtitle", {
              defaultValue: "AI 檢索知識庫的命中率、熱門搜尋詞與最常命中內容",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DayButton value={7} label={t("knowledge.hits.days7", { defaultValue: "近 7 天" })} />
          <DayButton value={30} label={t("knowledge.hits.days30", { defaultValue: "近 30 天" })} />
          <DayButton value={90} label={t("knowledge.hits.days90", { defaultValue: "近 90 天" })} />
        </div>
      </div>

      {/* KPI 列 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.key}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : noData ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Target className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t("knowledge.hits.empty", {
                defaultValue: "所選期間內尚無檢索記錄;AI 檢索知識庫後即會累積命中資料",
              })}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 逐日趨勢 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {t("knowledge.hits.trendTitle", { defaultValue: "逐日檢索 / 命中趨勢" })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={data?.trend ?? []} margin={{ left: -20, right: 8 }}>
                  <defs>
                    <linearGradient id="kbTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="kbHits" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--chart-2))" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
                  <Tooltip contentStyle={HIT_TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area
                    type="monotone"
                    dataKey="total"
                    name={t("knowledge.hits.seriesTotal", { defaultValue: "檢索次數" })}
                    stroke="hsl(var(--chart-1))"
                    fill="url(#kbTotal)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="hits"
                    name={t("knowledge.hits.seriesHits", { defaultValue: "命中次數" })}
                    stroke="hsl(var(--chart-2))"
                    fill="url(#kbHits)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* 熱門搜尋詞 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  {t("knowledge.hits.topQueries", { defaultValue: "熱門搜尋詞" })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RankList
                  items={(data?.top_queries ?? []).map((x) => ({
                    key: x.query,
                    label: x.query,
                    count: x.count,
                  }))}
                  emptyText={t("knowledge.hits.emptyQueries", { defaultValue: "尚無搜尋詞" })}
                />
              </CardContent>
            </Card>

            {/* 最常命中文件 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  {t("knowledge.hits.topDocuments", { defaultValue: "最常命中文件" })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RankList
                  items={(data?.top_documents ?? []).map((x) => ({
                    key: x.document_id,
                    label:
                      x.title ||
                      t("knowledge.hits.untitledDoc", { defaultValue: "(未命名文件)" }),
                    count: x.count,
                  }))}
                  emptyText={t("knowledge.hits.emptyDocuments", { defaultValue: "尚無命中文件" })}
                />
              </CardContent>
            </Card>

            {/* 最常命中集合 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                  {t("knowledge.hits.topCollections", { defaultValue: "最常命中集合" })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RankList
                  items={(data?.top_collections ?? []).map((x) => ({
                    key: x.collection_id,
                    label:
                      x.name ||
                      t("knowledge.hits.unknownCollection", { defaultValue: "(未知集合)" }),
                    count: x.count,
                  }))}
                  emptyText={t("knowledge.hits.emptyCollections", { defaultValue: "尚無命中集合" })}
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/** 排行清單:名次 + 名稱(截斷) + 次數;空時顯示 emptyText。 */
function RankList({
  items,
  emptyText,
}: {
  items: { key: string; label: string; count: number }[];
  emptyText: string;
}) {
  if (items.length === 0) {
    return <p className="py-6 text-center text-xs text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ol className="space-y-2.5">
      {items.map((it, i) => (
        <li key={`${it.key}-${i}`} className="flex items-center justify-between gap-2 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
            <span className="truncate">{it.label}</span>
          </span>
          <Badge variant="secondary" className="shrink-0 tabular-nums">
            {it.count}
          </Badge>
        </li>
      ))}
    </ol>
  );
}
