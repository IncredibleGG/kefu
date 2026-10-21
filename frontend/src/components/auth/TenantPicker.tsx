/**
 * 多租戶登入:同一 email + 密碼對到多個工作區時(後端回 requires_tenant_selection),
 * 列出工作區讓使用者選擇,選定後由呼叫端帶 tenant 重送登入。
 */
import { useTranslation } from "react-i18next";
import { ArrowLeft, Building2, ChevronRight, Loader2 } from "lucide-react";
import type { TenantChoice } from "./loginApi";

export function TenantPicker({
  tenants,
  busySlug,
  onPick,
  onBack,
}: {
  tenants: TenantChoice[];
  /** 正在以哪個工作區登入(顯示轉圈並鎖住其他選項) */
  busySlug: string | null;
  onPick: (slug: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-base font-semibold">
          <Building2 className="h-5 w-5 text-brand" />
          {t("native.login.tenantTitle", "選擇工作區")}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("native.login.tenantHint", "這個帳號屬於多個工作區,請選擇要登入的工作區。")}
        </p>
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {tenants.map((tn) => {
          const busy = busySlug === tn.slug;
          return (
            <li key={tn.slug}>
              <button
                type="button"
                onClick={() => onPick(tn.slug)}
                disabled={busySlug != null}
                className="flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-start transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold uppercase text-muted-foreground">
                  {(tn.name || tn.slug).slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{tn.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{tn.slug}</span>
                </span>
                {busy ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={onBack}
        disabled={busySlug != null}
        className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
      >
        <ArrowLeft className="h-3 w-3 rtl:rotate-180" />
        {t("auth.backToLogin", { defaultValue: "返回重新登入" })}
      </button>
    </div>
  );
}
