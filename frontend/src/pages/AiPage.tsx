import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, Wrench, Workflow, FlaskConical, type LucideIcon } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { cn } from "@/lib/utils";
import { AgentConfigForm } from "./ai/AgentConfigForm";
import { AiToolsTab } from "./ai/AiToolsTab";
import { AiWorkflowsTab } from "./ai/AiWorkflowsTab";
import { AiPlaygroundTab } from "./ai/AiPlaygroundTab";

interface TabDef {
  key: string;
  icon: LucideIcon;
  labelKey: string;
}

const TABS: TabDef[] = [
  { key: "agents", icon: Bot, labelKey: "ai.tab.agents" },
  { key: "tools", icon: Wrench, labelKey: "ai.tab.tools" },
  { key: "workflows", icon: Workflow, labelKey: "ai.tab.workflows" },
  { key: "playground", icon: FlaskConical, labelKey: "ai.tab.playground" },
];

/** 尚無後端能力的分頁:誠實的「即將推出」佔位,不用假資料 / 假 badge 冒充。 */
/** AI 區:代理設定接真 API(/ai/config、/ai/models、知識庫集合);其餘分頁為誠實佔位。 */
export function AiPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const active = TABS.some((tb) => tb.key === params.get("tab")) ? params.get("tab")! : "agents";

  return (
    <PageShell title={t("nav.ai")} description={t("ai.pageDescription")}>
      <div className="mb-5 flex flex-wrap gap-1.5 border-b border-border pb-3">
        {TABS.map((tb) => (
          <Link
            key={tb.key}
            to={`/ai?tab=${tb.key}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
              active === tb.key
                ? "border-brand bg-brand/10 text-brand"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            <tb.icon className="h-4 w-4" />
            {t(tb.labelKey)}
          </Link>
        ))}
      </div>

      {active === "agents" && <AgentConfigForm />}
      {active === "tools" && <AiToolsTab />}
      {active === "workflows" && <AiWorkflowsTab />}
      {active === "playground" && <AiPlaygroundTab />}
    </PageShell>
  );
}
