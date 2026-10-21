import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  ScrollText,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { auditApi, type AuditQuery, type AuditLogEntry } from "@/api/audit";

const PAGE_SIZE = 20;

/** 把 <input type="datetime-local"> 的值轉為 ISO8601;空值回 undefined。 */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** 稽核 / 操作日誌:表格顯示時間 / 操作者 / 動作 / 目標 / IP,支援篩選 + 分頁。全接真 API。 */
export function AuditPage() {
  const { t } = useTranslation();

  // 篩選草稿(輸入中)與已套用的查詢(送出後才觸發請求)
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [applied, setApplied] = useState<Omit<AuditQuery, "page" | "size">>({});
  const [page, setPage] = useState(1);

  const query: AuditQuery = useMemo(
    () => ({ ...applied, page, size: PAGE_SIZE }),
    [applied, page],
  );

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["audit", query],
    queryFn: () => auditApi.list(query),
    placeholderData: keepPreviousData,
  });

  const items: AuditLogEntry[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function applyFilters() {
    setApplied({
      action: action.trim() || undefined,
      target_type: targetType.trim() || undefined,
      start: toIso(start),
      end: toIso(end),
    });
    setPage(1);
  }

  function clearFilters() {
    setAction("");
    setTargetType("");
    setStart("");
    setEnd("");
    setApplied({});
    setPage(1);
  }

  const hasFilters =
    !!applied.action || !!applied.target_type || !!applied.start || !!applied.end;

  function fmtTime(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  return (
    <PageShell
      title={t("audit.title", { defaultValue: "稽核日誌" })}
      description={t("audit.description", {
        defaultValue: "追溯管理與敏感操作:誰在何時對什麼做了什麼。",
      })}
      actions={
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className="h-4 w-4" /> {t("audit.refresh", { defaultValue: "重新整理" })}
        </Button>
      }
    >
      {/* 篩選列 */}
      <Card className="mb-3">
        <CardContent className="p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="f-action" className="text-xs">
                {t("audit.filterAction", { defaultValue: "動作" })}
              </Label>
              <Input
                id="f-action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                placeholder={t("audit.filterActionPlaceholder", { defaultValue: "如 POST /api/v1/iam/staff" })}
                className="h-8 w-64 max-w-full"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-target" className="text-xs">
                {t("audit.filterTargetType", { defaultValue: "目標型別" })}
              </Label>
              <Input
                id="f-target"
                value={targetType}
                onChange={(e) => setTargetType(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                placeholder={t("audit.filterTargetPlaceholder", { defaultValue: "如 staff / roles" })}
                className="h-8 w-40 max-w-full"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-start" className="text-xs">
                {t("audit.filterStart", { defaultValue: "起始時間" })}
              </Label>
              <Input
                id="f-start"
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-8 w-52 max-w-full"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-end" className="text-xs">
                {t("audit.filterEnd", { defaultValue: "結束時間" })}
              </Label>
              <Input
                id="f-end"
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="h-8 w-52 max-w-full"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" onClick={applyFilters}>
                <Search className="h-4 w-4" /> {t("audit.apply", { defaultValue: "篩選" })}
              </Button>
              {hasFilters && (
                <Button size="sm" variant="ghost" onClick={clearFilters}>
                  <X className="h-4 w-4" /> {t("audit.clear", { defaultValue: "清除" })}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 表格 */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-medium">
                    {t("audit.colTime", { defaultValue: "時間" })}
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    {t("audit.colActor", { defaultValue: "操作者" })}
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    {t("audit.colAction", { defaultValue: "動作" })}
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    {t("audit.colTarget", { defaultValue: "目標" })}
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    {t("audit.colIp", { defaultValue: "IP" })}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="p-3">
                      <Skeleton className="h-32 w-full" />
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-xs text-muted-foreground">
                      {t("audit.empty", { defaultValue: "沒有符合條件的稽核記錄" })}
                    </td>
                  </tr>
                ) : (
                  items.map((a) => (
                    <tr key={a.id} className="hover:bg-accent/40 align-top">
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
                        {fmtTime(a.created_at)}
                      </td>
                      <td className="px-3 py-2.5">
                        {a.actor_name || a.actor_staff_id ? (
                          <span className="font-medium">
                            {a.actor_name ?? a.actor_staff_id}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t("audit.system", { defaultValue: "系統" })}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.action}</code>
                      </td>
                      <td className="px-3 py-2.5">
                        {a.target_type ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="secondary">{a.target_type}</Badge>
                            {a.target_id && (
                              <span className="truncate font-mono text-xs text-muted-foreground">
                                {a.target_id}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-muted-foreground">
                        {a.ip ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 分頁 */}
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <ScrollText className="h-3.5 w-3.5" />
          {t("audit.total", { defaultValue: "共 {{count}} 筆", count: total })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || isFetching}
            aria-label={t("audit.prevPage", { defaultValue: "上一頁" })}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>
            {t("audit.pageOf", { defaultValue: "第 {{page}} / {{total}} 頁", page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || isFetching}
            aria-label={t("audit.nextPage", { defaultValue: "下一頁" })}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
