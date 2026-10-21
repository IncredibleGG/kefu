import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { downloadFile } from "@/lib/download";
import { OverviewReportTab } from "./reports/OverviewReportTab";
import { AgentsReportTab } from "./reports/AgentsReportTab";
import { SatisfactionReportTab } from "./reports/SatisfactionReportTab";
import { MonitorReportTab } from "./reports/MonitorReportTab";
import { InsightsReportTab } from "./reports/InsightsReportTab";
import { SalesReportTab } from "./reports/SalesReportTab";
import { AgentActivityTab } from "./reports/AgentActivityTab";

/** 有效分頁值。nav 二級欄以 ?tab= 帶入不同分頁;預設 overview。 */
type ReportTab =
  | "overview"
  | "agents"
  | "satisfaction"
  | "monitor"
  | "insights"
  | "sales"
  | "activity";

/** 正規化 ?tab= 值:未知 → overview;相容舊 nav 的 `quality` 別名 → satisfaction。 */
function normalizeTab(raw: string | null): ReportTab {
  switch (raw) {
    case "agents":
      return "agents";
    case "satisfaction":
    case "quality": // 現行 nav.ts 「滿意度 / 質檢」仍指向 ?tab=quality,保留相容
      return "satisfaction";
    case "monitor":
      return "monitor";
    case "insights":
      return "insights";
    case "sales":
      return "sales";
    case "activity":
      return "activity";
    default:
      return "overview";
  }
}

export function ReportsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = normalizeTab(params.get("tab"));

  const onTab = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "overview") next.delete("tab");
    else next.set("tab", value);
    setParams(next, { replace: true });
  };

  return (
    <PageShell
      title={t("nav.reports")}
      description={t("core.reportsDescription")}
      actions={
        // 手機(< md):只留圖示,文字改為螢幕閱讀器可讀
        <Button
          variant="outline"
          className="max-md:aspect-square max-md:px-0"
          onClick={() => downloadFile("/api/v1/exports/reports/overview.csv", "overview.csv").catch(() => {})}
        >
          <Download className="h-4 w-4" />
          <span className="max-md:sr-only">{t("common.exportCsv", { defaultValue: "匯出 CSV" })}</span>
        </Button>
      }
    >
      <div className="space-y-4">
        <Tabs value={tab} onValueChange={onTab}>
          <TabsList>
            <TabsTrigger value="overview">{t("reports.tabOverview")}</TabsTrigger>
            <TabsTrigger value="agents">{t("reports.tabAgents")}</TabsTrigger>
            <TabsTrigger value="satisfaction">{t("reports.tabSatisfaction")}</TabsTrigger>
            <TabsTrigger value="monitor">{t("reports.tabMonitor")}</TabsTrigger>
            <TabsTrigger value="insights">
              {t("reports.tabInsights", { defaultValue: "洞察" })}
            </TabsTrigger>
            <TabsTrigger value="sales">
              {t("reports.tabSales", { defaultValue: "銷售" })}
            </TabsTrigger>
            <TabsTrigger value="activity">
              {t("reports.tabActivity", { defaultValue: "工時 / 活動" })}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "agents" ? (
          <AgentsReportTab />
        ) : tab === "satisfaction" ? (
          <SatisfactionReportTab />
        ) : tab === "monitor" ? (
          <MonitorReportTab />
        ) : tab === "insights" ? (
          <InsightsReportTab />
        ) : tab === "sales" ? (
          <SalesReportTab />
        ) : tab === "activity" ? (
          <AgentActivityTab />
        ) : (
          <OverviewReportTab />
        )}
      </div>
    </PageShell>
  );
}
