/**
 * 伺服器設定頁(原生殼首次啟動 / 更換伺服器)。
 * 行為契約(ServerGate 依賴,請勿更動):
 *  - default export;props:initialUrl?(預填,例如 kefu://setup 佈建連結)、onCancel?(已有伺服器時可返回)。
 *  - 網址輸入預設 DEFAULT_SERVER;「繼續」→ probeServer() → 成功才 setServerBase();失敗顯示錯誤。
 *  - 本頁在 RouterProvider 之外渲染(由 ServerGate 控制),不可使用 react-router hooks。
 * 介面:
 *  - 「測試連線」只探測不儲存,成功時顯示伺服器名稱 / 版本 / 可用功能;「繼續」若剛測過同一網址就直接儲存。
 *  - 佈建連結(kefu://setup?server=…)只會預填或跳出確認,**絕不靜默切換**(docs/NATIVE-CLIENTS.md §2)。
 *  - 伺服器要求較新 App 版本時只提示(非阻擋),仍可繼續。
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Link2,
  Loader2,
  Server,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AuthShell } from "@/components/auth/AuthShell";
import { BrandMark } from "@/components/auth/BrandMark";
import { parseSetupLink } from "@/components/auth/links";
import { primeServerInfo } from "@/components/auth/serverInfo";
import { appVersion, isNative, onDeepLink } from "@/lib/platform";
import {
  DEFAULT_SERVER,
  ServerUrlError,
  isAppOutdated,
  normalizeServerUrl,
  probeServer,
  setServerBase,
  type ServerInfo,
} from "@/lib/server";

export interface ServerSetupPageProps {
  /** 預填網址(未提供時用 DEFAULT_SERVER) */
  initialUrl?: string | null;
  /** 提供時顯示「返回」(已設定過伺服器、只是想更換時) */
  onCancel?: () => void;
}

/** 探測錯誤碼(probeServer 的碼 + 本頁依情境細分的 offline / timeout)。 */
type ProbeErrorCode =
  | "empty"
  | "invalid_url"
  | "https_required"
  | "not_kefu"
  | "offline"
  | "timeout"
  | "unreachable";

type ProbeState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; url: string; info?: ServerInfo }
  | { status: "error"; code: ProbeErrorCode };

/** probeServer 單次請求逾時 8 秒;接近這個時間才失敗視為逾時,否則多半是 DNS / 連線被拒 / 憑證錯誤。 */
const TIMEOUT_HINT_MS = 7500;

function tryNormalize(input: string): string | null {
  try {
    return normalizeServerUrl(input);
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function ServerSetupPage({ initialUrl, onCancel }: ServerSetupPageProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(initialUrl || DEFAULT_SERVER);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 網址是否來自佈建連結(提醒使用者確認是信任的伺服器)
  const [fromLink, setFromLink] = useState(() => Boolean(initialUrl));
  // 本頁開著時收到的佈建連結:先顯示確認,使用者同意才套用到輸入框
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;
  const probeSeq = useRef(0);

  // 佈建連結:與目前輸入相同 → 只標記來源;不同 → 跳確認(不靜默切換)
  useEffect(() => {
    if (!isNative) return;
    return onDeepLink((link) => {
      const server = parseSetupLink(link);
      if (!server) return;
      if (server === tryNormalize(urlRef.current)) {
        setFromLink(true);
        return;
      }
      setPendingLink(server);
    });
  }, []);

  function errorTitle(code: ProbeErrorCode): string {
    switch (code) {
      case "empty":
        return t("native.server.errorEmpty", "請輸入伺服器網址");
      case "invalid_url":
        return t("native.server.errorInvalid", "網址格式不正確");
      case "https_required":
        return t("native.server.errorHttpsTitle", "需要 https 連線");
      case "not_kefu":
        return t("native.server.errorNotKefu", "這個網址不是 kefu 伺服器");
      case "offline":
        return t("native.server.errorOfflineTitle", "裝置目前離線");
      case "timeout":
        return t("native.server.errorTimeoutTitle", "連線逾時");
      default:
        return t("native.server.errorDnsTitle", "找不到伺服器");
    }
  }

  function errorDesc(code: ProbeErrorCode): string {
    switch (code) {
      case "empty":
        return t("native.server.errorEmptyDesc", "請填入貴公司 kefu 伺服器的網址。");
      case "invalid_url":
        return t("native.server.errorInvalidDesc", "請輸入像 https://kf.example.com 這樣的網址。");
      case "https_required":
        return t("native.server.errorHttps", "App 只能連線 https:// 伺服器");
      case "not_kefu":
        return t(
          "native.server.errorNotKefuDesc",
          "這個網址有回應,但不是 kefu 服務。請確認網址是否正確,或詢問系統管理員。",
        );
      case "offline":
        return t("native.server.errorOfflineDesc", "請檢查 Wi-Fi 或行動網路後再試一次。");
      case "timeout":
        return t(
          "native.server.errorTimeoutDesc",
          "伺服器沒有在時間內回應,可能是網路不穩或伺服器忙碌,請稍後再試。",
        );
      default:
        return t(
          "native.server.errorDnsDesc",
          "無法解析或連上這個網址。請確認拼寫與網路連線,並確認伺服器的 HTTPS 憑證有效。",
        );
    }
  }

  /** 探測伺服器;回傳成功時的正規化網址與資訊。 */
  async function runProbe(input: string): Promise<{ url: string; info?: ServerInfo } | null> {
    const seq = ++probeSeq.current;
    setSaveError(null);
    let normalized: string;
    try {
      normalized = normalizeServerUrl(input);
    } catch (e) {
      setProbe({ status: "error", code: e instanceof ServerUrlError ? e.code : "invalid_url" });
      return null;
    }
    setProbe({ status: "testing" });
    const started = Date.now();
    const res = await probeServer(normalized);
    if (seq !== probeSeq.current) return null; // 期間網址已改,丟棄過期結果
    if (!res.ok) {
      let code = (res.error ?? "unreachable") as ProbeErrorCode;
      if (code === "unreachable") {
        if (typeof navigator !== "undefined" && navigator.onLine === false) code = "offline";
        else if (Date.now() - started >= TIMEOUT_HINT_MS) code = "timeout";
      }
      setProbe({ status: "error", code });
      return null;
    }
    setProbe({ status: "ok", url: normalized, info: res.info });
    primeServerInfo(normalized, res.info ?? null);
    return { url: normalized, info: res.info };
  }

  async function onTest() {
    if (saving || probe.status === "testing") return;
    await runProbe(url);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving || probe.status === "testing") return;
    const normalized = tryNormalize(url);
    let target: string | null = null;
    if (probe.status === "ok" && normalized && probe.url === normalized) {
      target = probe.url;
    } else {
      const res = await runProbe(url);
      target = res?.url ?? null;
    }
    if (!target) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setServerBase(target);
      // 成功後 ServerGate 會卸載本頁(onServerChange)
    } catch (err) {
      const code = err instanceof ServerUrlError ? err.code : null;
      setSaveError(code ? errorTitle(code) : t("native.server.saveFailed", "無法儲存伺服器設定,請重試"));
      setSaving(false);
    }
  }

  function onUrlChange(v: string) {
    setUrl(v);
    setFromLink(false);
    setSaveError(null);
    if (probe.status !== "idle") {
      probeSeq.current++;
      setProbe({ status: "idle" });
    }
  }

  function acceptLink() {
    if (!pendingLink) return;
    const next = pendingLink;
    setPendingLink(null);
    setUrl(next);
    setFromLink(true);
    probeSeq.current++;
    setProbe({ status: "idle" });
    void runProbe(next);
  }

  const testing = probe.status === "testing";
  const busy = testing || saving;
  const outdated = probe.status === "ok" && isAppOutdated(probe.info);

  return (
    <AuthShell>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">{t("native.server.title", "連線到伺服器")}</h1>
            <p className="text-sm text-muted-foreground">
              {t(
                "native.server.intro",
                "輸入貴公司 kefu 伺服器的網址。不確定網址時,請詢問系統管理員。",
              )}
            </p>
          </div>
        </div>

        {pendingLink && (
          <div
            role="alertdialog"
            aria-labelledby="setup-link-title"
            className="mb-4 space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm"
          >
            <div className="flex items-start gap-2">
              <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
              <div className="min-w-0 space-y-0.5">
                <div id="setup-link-title" className="text-sm font-medium">
                  {t("native.server.linkTitle", "收到伺服器設定連結")}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("native.server.linkDesc", "連結要求改用以下伺服器。請確認是你信任的網址再套用。")}
                </p>
                <p className="break-all font-mono text-xs">{pendingLink}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setPendingLink(null)}>
                {t("native.server.linkIgnore", "忽略")}
              </Button>
              <Button type="button" size="sm" onClick={acceptLink}>
                {t("native.server.linkApply", "使用此網址")}
              </Button>
            </div>
          </div>
        )}

        <form
          onSubmit={onSubmit}
          noValidate
          className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
        >
          <div className="space-y-1.5">
            <Label htmlFor="server-url">{t("native.server.urlLabel", "伺服器網址")}</Label>
            <div className="relative">
              <Server
                className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="server-url"
                type="url"
                inputMode="url"
                enterKeyHint="go"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="url"
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
                placeholder={DEFAULT_SERVER}
                className="h-10 ps-9"
                disabled={saving}
                aria-invalid={probe.status === "error" ? true : undefined}
                aria-describedby="server-url-hint"
              />
            </div>
            <p id="server-url-hint" className="text-xs text-muted-foreground">
              {fromLink
                ? t("native.server.fromLinkHint", "此網址來自設定連結,請確認後再繼續。")
                : t("native.server.urlHint", "只需填網域,例如 kf.example.com(會自動使用 https)。")}
            </p>
          </div>

          {/* 探測結果 */}
          <div aria-live="polite">
            {probe.status === "ok" && (
              <div className="space-y-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  {t("native.server.okTitle", "連線成功")}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">{t("native.server.okHost", "伺服器")}</dt>
                  <dd className="min-w-0 truncate font-medium">{hostOf(probe.url)}</dd>
                  {probe.info?.server_version && (
                    <>
                      <dt className="text-muted-foreground">{t("native.server.okVersion", "版本")}</dt>
                      <dd className="font-mono">{probe.info.server_version}</dd>
                    </>
                  )}
                  {probe.info && (
                    <>
                      <dt className="text-muted-foreground">{t("native.server.okFeatures", "功能")}</dt>
                      <dd className="flex flex-wrap gap-1">
                        <Badge variant="outline" className="bg-card">
                          {t("native.server.featurePassword", "帳號密碼登入")}
                        </Badge>
                        {probe.info.features.google_sso && (
                          <Badge variant="outline" className="bg-card">
                            {t("native.server.featureGoogle", "Google 登入")}
                          </Badge>
                        )}
                        {probe.info.features.saml && (
                          <Badge variant="outline" className="bg-card">
                            {t("native.server.featureSaml", "SAML 單一登入")}
                          </Badge>
                        )}
                        {probe.info.features.push && (
                          <Badge variant="outline" className="bg-card">
                            {t("native.server.featurePush", "推播通知")}
                          </Badge>
                        )}
                      </dd>
                    </>
                  )}
                </dl>
                {!probe.info && (
                  <p className="text-xs text-muted-foreground">
                    {t("native.server.okLegacy", "伺服器可用,但未提供版本資訊(可能是較舊的版本)。")}
                  </p>
                )}
                {outdated && (
                  <div className="flex items-start gap-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                    <span>
                      {t(
                        "native.update.desc",
                        "此伺服器建議使用 {{min}} 以上版本(目前為 {{current}}),部分功能可能無法正常運作。",
                        { min: probe.info?.min_app_version ?? "", current: appVersion },
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}

            {probe.status === "error" && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-destructive"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0 space-y-0.5">
                  <div className="text-sm font-medium">{errorTitle(probe.code)}</div>
                  <p className="text-xs opacity-90">{errorDesc(probe.code)}</p>
                </div>
              </div>
            )}

            {saveError && (
              <div
                role="alert"
                className="mt-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {saveError}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={onTest} disabled={busy} className="h-10">
              {testing && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("native.server.test", "測試連線")}
            </Button>
            <Button type="submit" disabled={busy} className="h-10">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? t("native.server.connecting", "連線中…") : t("native.server.continue", "繼續")}
            </Button>
          </div>

          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              <ArrowLeft className="h-3 w-3 rtl:rotate-180" />
              {t("native.server.back", "返回,不更換")}
            </button>
          )}
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t("native.server.appVersion", "App 版本 {{version}}", { version: appVersion })}
        </p>
      </div>
    </AuthShell>
  );
}
