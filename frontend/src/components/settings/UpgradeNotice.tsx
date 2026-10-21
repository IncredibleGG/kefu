import { Link } from "react-router-dom";
import { Lock, ArrowUpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 功能未解鎖時的升級引導條。點擊導向套餐頁。 */
export function UpgradeNotice({
  feature,
  className,
  compact,
}: {
  /** 顯示的功能名稱(例:我方 LLM 翻譯) */
  feature: string;
  className?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning",
        compact ? "text-[11px]" : "text-xs",
        className,
      )}
    >
      <Lock className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {t("misc.upgradeNoticeText", { feature })}
      </span>
      <Button asChild size="sm" variant="outline" className="h-7 shrink-0 gap-1 border-warning/50 text-warning hover:bg-warning/15">
        <Link to="/billing">
          <ArrowUpCircle className="h-3.5 w-3.5" /> {t("misc.upgradePlan")}
        </Link>
      </Button>
    </div>
  );
}
