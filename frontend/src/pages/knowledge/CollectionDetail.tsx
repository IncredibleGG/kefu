import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Globe, Copy, Check, FileText, MessageSquareText, Play, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { apiFetch } from "@/api/client";
import { publicUrl as serverPublicUrl } from "@/lib/server";
import { knowledgeContentApi, kkeys, type ManagedCollection } from "@/api/knowledgeContent";
import { DocumentManager } from "./DocumentManager";
import { QaManager } from "./QaManager";

const TYPE_LABEL: Record<string, string> = {
  document: "modules.knowledge.typeDocument",
  qa: "modules.knowledge.typeQa",
  website: "modules.knowledge.typeWebsite",
};

export function CollectionDetail({
  collection,
  tenantSlug,
  onBack,
}: {
  collection: ManagedCollection;
  tenantSlug: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [pubError, setPubError] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: kkeys.collections });
  const publish = useMutation({
    mutationFn: () => knowledgeContentApi.publish(collection.id),
    onSuccess: invalidate,
    onError: (e) => setPubError(e instanceof Error ? e.message : t("knowledge.manage.saveError")),
  });
  const unpublish = useMutation({
    mutationFn: () => knowledgeContentApi.unpublish(collection.id),
    onSuccess: invalidate,
    onError: (e) => setPubError(e instanceof Error ? e.message : t("knowledge.manage.saveError")),
  });

  const busy = publish.isPending || unpublish.isPending;
  const publicUrl =
    collection.is_published && collection.public_slug && tenantSlug
      ? serverPublicUrl(
          `/help/${encodeURIComponent(tenantSlug)}?c=${encodeURIComponent(collection.public_slug)}`,
        )
      : null;

  async function copyLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪貼簿不可用時忽略 */
    }
  }

  const defaultTab = collection.source_type === "qa" ? "qa" : "documents";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={t("knowledge.manage.back")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{collection.name}</h2>
              <Badge variant="secondary">{t(TYPE_LABEL[collection.source_type] ?? TYPE_LABEL.document)}</Badge>
              <Badge variant={collection.is_published ? "success" : "outline"}>
                {collection.is_published
                  ? t("knowledge.manage.published")
                  : t("knowledge.manage.private")}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("modules.knowledge.docCount", { n: collection.doc_count })}
            </p>
          </div>
        </div>
      </div>

      {/* 公開狀態 / Help Center 發布 */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4 text-muted-foreground" />
              {t("knowledge.manage.publicStatus")}
            </div>
            <p className="text-xs text-muted-foreground">
              {collection.is_published
                ? t("knowledge.manage.publishedHint")
                : t("knowledge.manage.privateHint")}
            </p>
            {publicUrl && (
              <div className="flex items-center gap-2 pt-1">
                <code className="max-w-[22rem] truncate rounded bg-muted px-2 py-1 text-xs">{publicUrl}</code>
                <Button variant="ghost" size="icon-sm" onClick={copyLink} aria-label={t("knowledge.manage.copyLink")}>
                  {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            )}
            {pubError && <p className="text-xs text-destructive">{pubError}</p>}
          </div>
          <div className="shrink-0">
            {collection.is_published ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setPubError(null);
                  unpublish.mutate();
                }}
              >
                {busy ? t("knowledge.manage.publishing") : t("knowledge.manage.unpublish")}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setPubError(null);
                  publish.mutate();
                }}
              >
                {busy ? t("knowledge.manage.publishing") : t("knowledge.manage.publish")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* website 型集合:提供「開始爬取」入口與任務狀態(爬到的正文入庫後見 Documents 分頁) */}
      {collection.source_type === "website" && <CrawlPanel collectionId={collection.id} />}

      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="documents">
            <FileText className="h-3.5 w-3.5" /> {t("knowledge.manage.tabDocuments")}
          </TabsTrigger>
          <TabsTrigger value="qa">
            <MessageSquareText className="h-3.5 w-3.5" /> {t("knowledge.manage.tabQa")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="documents" className="mt-4">
          <DocumentManager collectionId={collection.id} />
        </TabsContent>
        <TabsContent value="qa" className="mt-4">
          <QaManager collectionId={collection.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** 爬取任務狀態(對齊後端 knowledge.py 的 _crawl_task_dict)。 */
interface CrawlTask {
  task_id: string;
  url: string | null;
  status: string | null; // pending|running|done|failed
  max_pages: number | null;
  max_depth: number | null;
  pages_ingested: number;
  chunks: number;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
}

const CRAWL_STATUS: Record<
  string,
  { label: string; variant: "secondary" | "warning" | "success" | "destructive" }
> = {
  pending: { label: "排隊中", variant: "secondary" },
  running: { label: "爬取中", variant: "warning" },
  done: { label: "完成", variant: "success" },
  failed: { label: "失敗", variant: "destructive" },
};

/** website 型集合的爬取面板:填 URL 開始爬取 + 顯示任務狀態(pending/running 時自動輪詢)。
 *  直接呼叫 apiFetch(不改 endpoints.ts / knowledgeContent.ts):
 *   - POST /api/v1/knowledge/collections/{id}/crawl  排入爬取任務
 *   - GET  /api/v1/knowledge/collections/{id}/crawl  查任務狀態 */
function CrawlPanel({ collectionId }: { collectionId: string }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const key = ["knowledge", "manage", "crawl", collectionId] as const;

  const tasks = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<CrawlTask[]>(`/api/v1/knowledge/collections/${collectionId}/crawl`),
    // 有任務 pending/running 時每 4s 輪詢,否則停止(不空轉)
    refetchInterval: (query) => {
      const d = query.state.data as CrawlTask[] | undefined;
      return d?.some((t) => t.status === "pending" || t.status === "running") ? 4000 : false;
    },
  });

  const start = useMutation({
    mutationFn: (u: string) =>
      apiFetch<CrawlTask>(`/api/v1/knowledge/collections/${collectionId}/crawl`, {
        method: "POST",
        body: { url: u },
      }),
    onSuccess: () => {
      setUrl("");
      setErr(null);
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "爬取排程失敗"),
  });

  const canSubmit = /^https?:\/\/.+/i.test(url.trim()) && !start.isPending;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Globe className="h-4 w-4 text-muted-foreground" />
          網站爬取入庫
        </div>
        <p className="text-xs text-muted-foreground">
          輸入網址後開始爬取;系統會遵守 robots.txt、限制頁數與深度,於背景抽取正文、切塊嵌入入庫。
          爬到的內容會出現在下方「文件」分頁。
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="url"
            inputMode="url"
            placeholder="https://example.com/help"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) start.mutate(url.trim());
            }}
          />
          <Button className="shrink-0" disabled={!canSubmit} onClick={() => start.mutate(url.trim())}>
            {start.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            開始爬取
          </Button>
        </div>
        {err && <p className="text-xs text-destructive">{err}</p>}

        {tasks.data && tasks.data.length > 0 && (
          <div className="divide-y rounded-md border">
            {tasks.data.map((task) => {
              const s =
                CRAWL_STATUS[task.status ?? ""] ??
                ({ label: task.status ?? "未知", variant: "secondary" } as const);
              return (
                <div
                  key={task.task_id}
                  className="flex flex-wrap items-center gap-2 p-2 text-xs"
                >
                  <Badge variant={s.variant}>{s.label}</Badge>
                  <span
                    className="min-w-0 flex-1 truncate text-muted-foreground"
                    title={task.url ?? ""}
                  >
                    {task.url}
                  </span>
                  {task.status === "done" && (
                    <span className="shrink-0 text-muted-foreground">
                      {task.pages_ingested} 頁 / {task.chunks} 切塊
                    </span>
                  )}
                  {task.status === "failed" && task.error && (
                    <span
                      className="max-w-[16rem] shrink-0 truncate text-destructive"
                      title={task.error}
                    >
                      {task.error}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
