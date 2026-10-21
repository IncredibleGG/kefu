/**
 * 「請更新 App」提示(非阻擋):伺服器 server-info 的 min_app_version 高於目前 App 版本時顯示。
 * 只提示、不擋登入;使用者可暫時關閉(本次開啟期間不再顯示)。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert, X } from "lucide-react";
import { appVersion } from "@/lib/platform";
import { isAppOutdated, type ServerInfo } from "@/lib/server";
import { cn } from "@/lib/utils";

let dismissedFor: string | null = null;

export function AppUpdateBanner({ info, className }: { info: ServerInfo | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const min = info?.min_app_version ?? "";
  const [dismissed, setDismissed] = useState(() => dismissedFor === min);
  if (!info || !isAppOutdated(info) || dismissed) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm",
        className,
      )}
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("native.update.title", "請更新 App")}</div>
        <p className="text-xs text-muted-foreground">
          {t(
            "native.update.desc",
            "此伺服器建議使用 {{min}} 以上版本(目前為 {{current}}),部分功能可能無法正常運作。",
            { min, current: appVersion },
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          dismissedFor = min;
          setDismissed(true);
        }}
        className="-me-1 -mt-0.5 rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        aria-label={t("native.update.dismiss", "先不要")}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
