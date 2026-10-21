import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck,
  ShieldOff,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  KeyRound,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/api/client";
import { twoFaApi, type TwoFaSetupResult } from "@/api/authExtra";

/** 把 base32 密鑰每 4 碼空一格,方便手動輸入驗證器 App。 */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(" ");
}

/**
 * 兩步驗證(TOTP)設定頁。狀態機:
 *   未啟用 → [開始設定] → 顯示密鑰 / otpauth,輸入驗證碼 → [啟用]
 *   已啟用 → 輸入驗證碼或密碼 → [停用]
 * 無 QR 相依:顯示密鑰(手動輸入)與 otpauth URI(可複製貼入支援的 App)。
 * 本頁自帶 PageShell,可由 SettingsPage 以 ?tab=2fa 分派掛載。
 */
export function TwoFactorSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ["2fa", "status"],
    queryFn: () => twoFaApi.status(),
  });

  const [setup, setSetup] = useState<TwoFaSetupResult | null>(null);
  const [enableCode, setEnableCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = statusQuery.data?.totp_enabled ?? false;

  const setupMut = useMutation({
    mutationFn: () => twoFaApi.setup(),
    onSuccess: (data) => {
      setSetup(data);
      setError(null);
    },
    onError: (e) => setError(errMsg(e)),
  });

  const enableMut = useMutation({
    mutationFn: () => twoFaApi.enable(enableCode.trim()),
    onSuccess: () => {
      setSetup(null);
      setEnableCode("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["2fa", "status"] });
    },
    onError: (e) => setError(errMsg(e)),
  });

  const disableMut = useMutation({
    mutationFn: () => twoFaApi.disable({ code: disableCode.trim() || undefined }),
    onSuccess: () => {
      setDisableCode("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["2fa", "status"] });
    },
    onError: (e) => setError(errMsg(e)),
  });

  function errMsg(e: unknown): string {
    if (e instanceof ApiError && e.code === "INVALID_OTP") {
      return t("auth.invalidOtp", { defaultValue: "驗證碼不正確或已過期" });
    }
    if (e instanceof ApiError && e.code === "TWOFA_VERIFY_REQUIRED") {
      return t("auth.twoFaVerifyRequired", { defaultValue: "請提供有效的驗證碼以停用" });
    }
    if (e instanceof ApiError && e.code === "TWOFA_ALREADY_ENABLED") {
      return t("auth.twoFaAlreadyEnabled", { defaultValue: "兩步驗證已啟用" });
    }
    return e instanceof Error ? e.message : t("auth.twoFaGenericError", { defaultValue: "操作失敗" });
  }

  async function copyUri() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.otpauth_uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 剪貼簿不可用時忽略;使用者仍可手動選取 */
    }
  }

  return (
    <PageShell
      title={t("auth.twoFaTitle", { defaultValue: "兩步驗證(2FA)" })}
      description={t("auth.twoFaDescription", {
        defaultValue: "以驗證器 App 產生的動態驗證碼,為登入加上第二道防線。",
      })}
    >
      {statusQuery.isLoading ? (
        <Skeleton className="h-64 max-w-lg" />
      ) : statusQuery.isError ? (
        <Card className="max-w-lg">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">
              {t("auth.twoFaLoadError", { defaultValue: "無法載入兩步驗證狀態" })}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              {enabled ? (
                <ShieldCheck className="h-4 w-4 text-success" />
              ) : (
                <ShieldOff className="h-4 w-4 text-muted-foreground" />
              )}
              {enabled
                ? t("auth.twoFaOnTitle", { defaultValue: "兩步驗證已啟用" })
                : t("auth.twoFaOffTitle", { defaultValue: "兩步驗證未啟用" })}
            </CardTitle>
          </CardHeader>

          <CardContent className="space-y-4">
            {enabled ? (
              /* 已啟用:輸入驗證碼以停用 */
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t("auth.twoFaOnHint", {
                    defaultValue: "登入時需額外輸入驗證器動態碼。若要停用,請輸入目前的驗證碼。",
                  })}
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="disable-code">{t("auth.otpLabel", { defaultValue: "驗證碼" })}</Label>
                  <Input
                    id="disable-code"
                    inputMode="numeric"
                    value={disableCode}
                    onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    className="max-w-[160px] text-center font-mono tracking-[0.3em]"
                  />
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button
                  variant="destructive"
                  onClick={() => disableMut.mutate()}
                  disabled={disableMut.isPending || disableCode.trim().length < 6}
                >
                  {disableMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("auth.twoFaDisable", { defaultValue: "停用兩步驗證" })}
                </Button>
              </div>
            ) : setup ? (
              /* 設定中:顯示密鑰 / otpauth,輸入驗證碼啟用 */
              <div className="space-y-4">
                <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  <li>{t("auth.twoFaStep1", { defaultValue: "在驗證器 App(如 Google Authenticator)新增帳號。" })}</li>
                  <li>{t("auth.twoFaStep2", { defaultValue: "掃描 QR,或以「手動輸入金鑰」貼入下方密鑰。" })}</li>
                  <li>{t("auth.twoFaStep3", { defaultValue: "輸入 App 顯示的 6 位數驗證碼並啟用。" })}</li>
                </ol>

                <div className="space-y-1.5">
                  <Label>{t("auth.twoFaSecret", { defaultValue: "設定金鑰(手動輸入)" })}</Label>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2.5">
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <code className="flex-1 break-all font-mono text-sm">{groupSecret(setup.secret)}</code>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>{t("auth.twoFaUri", { defaultValue: "otpauth 連結" })}</Label>
                  <div className="flex items-center gap-2">
                    <Input value={setup.otpauth_uri} readOnly className="font-mono text-[11px]" />
                    <Button type="button" variant="outline" size="icon-sm" onClick={copyUri} aria-label={t("common.copy", { defaultValue: "複製" })}>
                      {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="enable-code">{t("auth.otpLabel", { defaultValue: "驗證碼" })}</Label>
                  <Input
                    id="enable-code"
                    inputMode="numeric"
                    value={enableCode}
                    onChange={(e) => setEnableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    className="max-w-[160px] text-center font-mono tracking-[0.3em]"
                  />
                </div>

                {error && <p className="text-xs text-destructive">{error}</p>}

                <div className="flex items-center gap-2">
                  <Button onClick={() => enableMut.mutate()} disabled={enableMut.isPending || enableCode.trim().length < 6}>
                    {enableMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("auth.twoFaEnable", { defaultValue: "啟用兩步驗證" })}
                  </Button>
                  <Button variant="ghost" onClick={() => { setSetup(null); setError(null); }}>
                    {t("common.cancel", { defaultValue: "取消" })}
                  </Button>
                </div>
              </div>
            ) : (
              /* 未啟用:開始設定 */
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {t("auth.twoFaOffHint", {
                      defaultValue: "啟用後,登入時除了密碼,還需輸入驗證器 App 產生的動態驗證碼。",
                    })}
                  </span>
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button onClick={() => setupMut.mutate()} disabled={setupMut.isPending}>
                  {setupMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("auth.twoFaSetupStart", { defaultValue: "開始設定" })}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
