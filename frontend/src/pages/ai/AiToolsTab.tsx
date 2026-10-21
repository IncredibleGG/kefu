import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, Wrench, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { aiToolsApi, type AiToolSpec } from "@/api/aiTools";

/**
 * AI 工具檢視分頁:列出後端內建的 function-calling 工具(名稱 / 說明 / 參數 / 分類)。
 *
 * 首版:內建工具皆為「唯讀、租戶隔離」,由 AI 在啟用工具時自動呼叫;此頁為唯讀檢視,
 * 不提供逐一開關(啟用與否於 Agent 設定 / 系統旗標決定)。文案走 t("aitools.*"),
 * 暫存於 locales/_pending/aitools.json,待併入 common.json;故一律帶 defaultValue。
 */

/** 分類 → Badge variant 對照(未列者用 secondary)。 */
const CATEGORY_VARIANT: Record<string, "brand" | "info" | "warning" | "secondary"> = {
  knowledge: "brand",
  ticket: "info",
  conversation: "info",
  settings: "warning",
};

function ToolCard({ tool }: { tool: AiToolSpec }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono text-sm">{tool.name}</CardTitle>
          <Badge variant={CATEGORY_VARIANT[tool.category] ?? "secondary"}>
            {t(`aitools.category.${tool.category}`, { defaultValue: tool.category })}
          </Badge>
          {tool.readonly && (
            <Badge variant="success">
              <ShieldCheck className="h-3 w-3" />
              {t("aitools.readonly", { defaultValue: "唯讀" })}
            </Badge>
          )}
        </div>
        <p className="pt-1 text-xs text-muted-foreground">{tool.description}</p>
      </CardHeader>
      <CardContent>
        {tool.parameters.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {t("aitools.noParams", { defaultValue: "無參數" })}
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">
                    {t("aitools.param", { defaultValue: "參數" })}
                  </th>
                  <th className="px-3 py-1.5 font-medium">
                    {t("aitools.type", { defaultValue: "型別" })}
                  </th>
                  <th className="px-3 py-1.5 font-medium">
                    {t("aitools.desc", { defaultValue: "說明" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tool.parameters.map((p) => (
                  <tr key={p.name} className="border-t border-border">
                    <td className="px-3 py-1.5">
                      <span className="font-mono">{p.name}</span>
                      {p.required && (
                        <span className="ml-1 text-destructive" title={t("aitools.required", { defaultValue: "必填" })}>
                          *
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">{p.type}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{p.description ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** AI 工具管理 / 檢視分頁(接 aiToolsApi.list;端點未掛載時回退靜態內建清單)。 */
export function AiToolsTab() {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["ai", "tools"], queryFn: () => aiToolsApi.list() });

  if (query.isLoading) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card className="max-w-2xl">
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {t("aitools.loadError", { defaultValue: "工具清單載入失敗" })}
          </p>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4" />
            {t("aitools.retry", { defaultValue: "重試" })}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const data = query.data;
  const tools = data?.tools ?? [];

  return (
    <div className="max-w-2xl space-y-4">
      {/* 說明:工具由 AI 在啟用時自動呼叫,此頁唯讀檢視 */}
      <div className="flex items-start gap-3 rounded-md border border-brand/30 bg-brand/5 px-4 py-3">
        <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("aitools.introTitle", { defaultValue: "AI 工具呼叫" })}</p>
          <p className="text-xs text-muted-foreground">
            {t("aitools.introDesc", {
              defaultValue:
                "以下內建工具皆為唯讀且以租戶隔離。啟用工具後,AI 會在需要時自動呼叫它們查詢資料,再據以作答。本頁為唯讀檢視。",
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[11px] text-muted-foreground">
              {t("aitools.featureStatus", { defaultValue: "工具功能" })}:
            </span>
            {data?.featureEnabled === true && (
              <Badge variant="success">{t("aitools.enabled", { defaultValue: "已啟用" })}</Badge>
            )}
            {data?.featureEnabled === false && (
              <Badge variant="secondary">{t("aitools.disabled", { defaultValue: "未啟用" })}</Badge>
            )}
            {(data?.featureEnabled === null || data?.featureEnabled === undefined) && (
              <Badge variant="secondary">{t("aitools.unknown", { defaultValue: "未知" })}</Badge>
            )}
            {data?.source === "static" && (
              <span className="text-[11px] text-muted-foreground">
                {t("aitools.staticNote", { defaultValue: "(展示內建清單,尚未連上後端)" })}
              </span>
            )}
          </div>
        </div>
      </div>

      {tools.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-xs text-muted-foreground">
            {t("aitools.empty", { defaultValue: "目前沒有可用的內建工具。" })}
          </CardContent>
        </Card>
      ) : (
        tools.map((tool) => <ToolCard key={tool.name} tool={tool} />)
      )}
    </div>
  );
}

export default AiToolsTab;
