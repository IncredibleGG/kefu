import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck,
  Network,
  KeyRound,
  Loader2,
  AlertCircle,
  Check,
  Copy,
  Download,
  Plus,
  RefreshCw,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import { saveFile } from "@/lib/platform";
import { securityApi } from "@/api/security";

/** 把多行 / 逗號分隔的文字解析為白名單條目(去空白、去空行)。 */
function parseAllowlist(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 企業安全設定頁(對標 LiveChat 企業版):
 *   1. 組織強制 2FA 開關
 *   2. 登入 IP 白名單(顯示當前 IP;自鎖護欄)
 *   3. 2FA 備援碼管理(重新產生 / 顯示明文一次)
 * 本頁自帶 PageShell,由 SettingsPage 以 ?tab=security 分派掛載。政策端點需 settings.manage。
 */
export function SecuritySettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const policyQuery = useQuery({
    queryKey: ["security", "policy"],
    queryFn: () => securityApi.getPolicy(),
  });
  const twoFaQuery = useQuery({
    queryKey: ["security", "2fa-status"],
    queryFn: () => securityApi.twoFaStatus(),
  });

  // 本地編輯狀態(從載入的政策初始化)
  const [require2fa, setRequire2fa] = useState(false);
  const [allowlistText, setAllowlistText] = useState("");
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  // 備援碼:重新產生後於此暫存明文(僅前端記憶體,重整即失)
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const policy = policyQuery.data;
  const currentIp = policy?.current_ip ?? "";

  useEffect(() => {
    if (policy) {
      setRequire2fa(policy.require_2fa);
      setAllowlistText((policy.login_ip_allowlist ?? []).join("\n"));
    }
  }, [policy]);

  function flash(msg: string) {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), 2200);
  }

  function policyErrMsg(e: unknown): string {
    if (e instanceof ApiError && e.code === "IP_SELF_LOCKOUT") {
      return e.message || t("security.ipSelfLockout", {
        defaultValue: "白名單未包含您目前的 IP,為避免自鎖已拒絕儲存,請先把此 IP 加入。",
      });
    }
    if (e instanceof ApiError && e.code === "INVALID_IP") {
      return e.message || t("security.ipInvalid", { defaultValue: "有 IP 或 CIDR 格式不正確" });
    }
    if (e instanceof ApiError && e.code === "UNAUTHORIZED") {
      return t("security.noPermission", { defaultValue: "您沒有管理安全設定的權限" });
    }
    return e instanceof Error ? e.message : t("security.saveError", { defaultValue: "儲存失敗" });
  }

  const require2faMut = useMutation({
    mutationFn: () => securityApi.updatePolicy({ require_2fa: require2fa }),
    onSuccess: (data) => {
      setPolicyError(null);
      qc.setQueryData(["security", "policy"], data);
      flash(t("security.saved", { defaultValue: "已儲存" }));
    },
    onError: (e) => setPolicyError(policyErrMsg(e)),
  });

  const allowlistMut = useMutation({
    mutationFn: () =>
      securityApi.updatePolicy({ login_ip_allowlist: parseAllowlist(allowlistText) }),
    onSuccess: (data) => {
      setPolicyError(null);
      qc.setQueryData(["security", "policy"], data);
      setAllowlistText((data.login_ip_allowlist ?? []).join("\n"));
      flash(t("security.saved", { defaultValue: "已儲存" }));
    },
    onError: (e) => setPolicyError(policyErrMsg(e)),
  });

  const regenMut = useMutation({
    mutationFn: () => securityApi.regenerateRecoveryCodes(),
    onSuccess: (data) => {
      setFreshCodes(data.recovery_codes);
      setCopiedAll(false);
      qc.invalidateQueries({ queryKey: ["security", "2fa-status"] });
    },
  });

  const twoFaEnabled = twoFaQuery.data?.totp_enabled ?? false;
  const remaining = twoFaQuery.data?.recovery_codes_remaining ?? 0;
  const generated = twoFaQuery.data?.recovery_codes_generated ?? false;

  const allowlistEntries = useMemo(() => parseAllowlist(allowlistText), [allowlistText]);

  async function copyAll() {
    if (!freshCodes) return;
    try {
      await navigator.clipboard.writeText(freshCodes.join("\n"));
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1800);
    } catch {
      /* 剪貼簿不可用時忽略;使用者仍可手動選取 */
    }
  }

  function downloadCodes() {
    if (!freshCodes) return;
    try {
      const blob = new Blob(
        [
          `${t("security.recoveryFileHeader", { defaultValue: "kefu 兩步驗證備援碼(請妥善保存,每組僅能使用一次)" })}\n\n`,
          freshCodes.join("\n"),
          "\n",
        ],
        { type: "text/plain;charset=utf-8" },
      );
      // 交給平台層存檔(web:<a download>;桌面:存檔對話框;手機:分享面板)
      void saveFile(blob, "kefu-recovery-codes.txt").catch(() => undefined);
    } catch {
      /* 下載不可用時忽略 */
    }
  }

  return (
    <PageShell
      title={t("security.title", { defaultValue: "安全" })}
      description={t("security.description", {
        defaultValue: "組織層級的登入安全政策:強制兩步驗證、登入 IP 白名單、備援碼。",
      })}
    >
      {policyQuery.isLoading ? (
        <Skeleton className="h-64 max-w-2xl" />
      ) : policyQuery.isError ? (
        <Card className="max-w-2xl">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">
              {policyErrMsg(policyQuery.error)}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="max-w-2xl space-y-6">
          {savedFlash && (
            <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
              <Check className="h-4 w-4" />
              {savedFlash}
            </div>
          )}

          {/* 1. 組織強制 2FA */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-brand" />
                {t("security.require2faTitle", { defaultValue: "強制兩步驗證" })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="require-2fa">
                    {t("security.require2faLabel", { defaultValue: "要求所有坐席啟用 2FA" })}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t("security.require2faHint", {
                      defaultValue:
                        "開啟後,尚未啟用 2FA 的坐席下次登入時會被強制先完成 2FA 設定才能進入(平台管理員不受限)。",
                    })}
                  </p>
                </div>
                <Switch
                  id="require-2fa"
                  checked={require2fa}
                  onCheckedChange={setRequire2fa}
                />
              </div>
              <div className="flex items-center gap-3">
                <Button
                  onClick={() => require2faMut.mutate()}
                  disabled={require2faMut.isPending || require2fa === policy?.require_2fa}
                >
                  {require2faMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("security.save", { defaultValue: "儲存" })}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* 2. 登入 IP 白名單 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Network className="h-4 w-4 text-brand" />
                {t("security.ipTitle", { defaultValue: "登入 IP 白名單" })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t("security.ipDesc", {
                  defaultValue:
                    "非空時,僅允許來自名單內 IP / 網段的登入。留空 = 不限制(避免把所有人鎖在門外)。平台管理員不受限制。",
                })}
              </p>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t("security.ipCurrentIp", { defaultValue: "您目前的 IP" })}
                </span>
                <Badge variant="secondary" className="font-mono">
                  {currentIp || "—"}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!currentIp) return;
                    if (!allowlistEntries.includes(currentIp)) {
                      setAllowlistText((prev) => (prev.trim() ? `${prev.trim()}\n${currentIp}` : currentIp));
                    }
                  }}
                  disabled={!currentIp || allowlistEntries.includes(currentIp)}
                >
                  <Plus className="h-4 w-4" />
                  {t("security.ipAddMyIp", { defaultValue: "加入我的 IP" })}
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="allowlist">
                  {t("security.ipLabel", { defaultValue: "允許的 IP / CIDR(每行一個)" })}
                </Label>
                <textarea
                  id="allowlist"
                  value={allowlistText}
                  onChange={(e) => setAllowlistText(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  placeholder={"203.0.113.4\n198.51.100.0/24\n2001:db8::/32"}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {!allowlistEntries.length && (
                  <p className="text-xs text-muted-foreground">
                    {t("security.ipEmptyHint", { defaultValue: "目前未設定任何項目 = 不限制登入來源。" })}
                  </p>
                )}
              </div>

              <Button
                onClick={() => allowlistMut.mutate()}
                disabled={allowlistMut.isPending}
              >
                {allowlistMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("security.save", { defaultValue: "儲存" })}
              </Button>
            </CardContent>
          </Card>

          {policyError && (
            <p className="text-sm text-destructive">{policyError}</p>
          )}

          {/* 3. 2FA 備援碼 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <KeyRound className="h-4 w-4 text-brand" />
                {t("security.recoveryTitle", { defaultValue: "兩步驗證備援碼" })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t("security.recoveryDesc", {
                  defaultValue: "當你無法使用驗證器 App 時,可用備援碼登入。每組僅能使用一次。",
                })}
              </p>

              {twoFaQuery.isLoading ? (
                <Skeleton className="h-16" />
              ) : !twoFaEnabled ? (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {t("security.recoveryNeed2fa", {
                      defaultValue: "請先在「兩步驗證」分頁啟用 2FA,才能產生備援碼。",
                    })}{" "}
                    <Link to="?tab=2fa" className="text-brand underline-offset-4 hover:underline">
                      {t("security.recoverySetupLink", { defaultValue: "前往設定 2FA" })}
                    </Link>
                  </span>
                </div>
              ) : (
                <>
                  <p className="text-sm">
                    {generated
                      ? t("security.recoveryRemaining", {
                          defaultValue: "剩餘可用備援碼:{{count}} 組",
                          count: remaining,
                        })
                      : t("security.recoveryNone", { defaultValue: "尚未產生備援碼。" })}
                  </p>

                  {freshCodes && (
                    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
                      <div className="flex items-start gap-2 text-sm text-warning">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          {t("security.recoveryWarn", {
                            defaultValue: "請立即保存這些備援碼,離開此頁後將無法再次顯示。",
                          })}
                        </span>
                      </div>
                      <ul className="grid grid-cols-2 gap-1.5 font-mono text-sm">
                        {freshCodes.map((c) => (
                          <li key={c} className="rounded bg-card px-2 py-1 tracking-wider">
                            {c}
                          </li>
                        ))}
                      </ul>
                      <div className="flex items-center gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={copyAll}>
                          {copiedAll ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                          {t("security.recoveryCopyAll", { defaultValue: "全部複製" })}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={downloadCodes}>
                          <Download className="h-4 w-4" />
                          {t("security.recoveryDownload", { defaultValue: "下載 .txt" })}
                        </Button>
                      </div>
                    </div>
                  )}

                  <Button
                    variant={generated ? "outline" : "default"}
                    onClick={() => regenMut.mutate()}
                    disabled={regenMut.isPending}
                  >
                    {regenMut.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    {generated
                      ? t("security.recoveryRegenerate", { defaultValue: "重新產生備援碼" })
                      : t("security.recoveryGenerate", { defaultValue: "產生備援碼" })}
                  </Button>
                  {generated && (
                    <p className="text-xs text-muted-foreground">
                      {t("security.recoveryRegenHint", {
                        defaultValue: "重新產生會使先前所有備援碼立即失效。",
                      })}
                    </p>
                  )}
                  {regenMut.isError && (
                    <p className="text-xs text-destructive">
                      {regenMut.error instanceof Error
                        ? regenMut.error.message
                        : t("security.saveError", { defaultValue: "操作失敗" })}
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </PageShell>
  );
}
