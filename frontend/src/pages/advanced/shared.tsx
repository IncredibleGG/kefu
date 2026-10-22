/** 進階平台管理 UI 共用小工具(Meta 渠道 / Webhook / API Key / Help Center 發布共用)。 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getServerOrigin } from "@/lib/server";
import { cn } from "@/lib/utils";

/** 對外可存取的後端來源(絕對網址):貼到 Meta 後台 / Telegram / 給第三方的 webhook URL 用。
 *  web 同源部署回瀏覽器來源;原生殼回使用者設定的伺服器(不可用 App 自己的 tauri:// / capacitor:// origin)。 */
export function apiOrigin(): string {
  return getServerOrigin();
}

/** 複製到剪貼簿的小按鈕;複製後短暫顯示打勾。 */
export function CopyButton({
  value,
  label,
  size = "icon",
  className,
}: {
  value: string;
  label?: string;
  size?: "icon" | "sm";
  className?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 某些情境無 clipboard 權限:退回選取提示
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <Button
      type="button"
      variant="outline"
      size={size === "icon" ? "icon" : "sm"}
      className={cn("shrink-0", className)}
      onClick={copy}
      title={t("advanced.shared.copy")}
    >
      {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      {size === "sm" && <span>{copied ? t("advanced.shared.copied") : label ?? t("advanced.shared.copy")}</span>}
    </Button>
  );
}

/** 只讀、可複製的網址/密鑰欄位(等寬字型、可捲動)。 */
export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <code
        className={cn(
          "min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs",
          mono && "font-mono",
        )}
      >
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}
