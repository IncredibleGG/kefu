import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useLocation, Navigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  AlertCircle,
  Sun,
  Moon,
  ShieldCheck,
  ArrowLeft,
  QrCode,
  KeyRound,
  Copy,
  Check,
  ChevronRight,
  Building2,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/stores/auth";
import { useUi } from "@/stores/ui";
import { useBrand } from "@/stores/brand";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";
import { isMobileApp, isNative, onDeepLink, onResume } from "@/lib/platform";
import { ApiError, isNetworkError } from "@/api/client";
import { finalizeSession, enrollVerify2fa } from "@/api/authExtra";
import { AuthShell } from "@/components/auth/AuthShell";
import { BrandMark } from "@/components/auth/BrandMark";
import { GoogleIcon } from "@/components/auth/GoogleIcon";
import { ServerHostBar } from "@/components/auth/ServerHostBar";
import { TenantPicker } from "@/components/auth/TenantPicker";
import { AppUpdateBanner } from "@/components/auth/AppUpdateBanner";
import { useServerInfo } from "@/components/auth/serverInfo";
import { openOtpauth, parseAuthCallback, type AuthCallback } from "@/components/auth/links";
import {
  loginWithTenant,
  normalizeTenantSlug,
  tenantChoicesOf,
  type TenantChoice,
} from "@/components/auth/loginApi";
import {
  beginNativeSso,
  clearPendingSso,
  nativeSsoErrorText,
  resolveNativeSsoCallback,
  type SsoProvider,
} from "@/components/auth/nativeSso";

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // token 供已登入導向;login 為 mock 模式(後端未起)時的降級登入
  const { login: mockLogin, token } = useAuth();
  const { theme, toggleTheme } = useUi();
  const brand = useBrand();
  // 白牌:命中租戶網域時,登入頁改用該租戶 logo 與名稱
  const branded = brand.ready && !brand.isDefault;
  const brandName = branded && brand.name ? brand.name : t("login.title");
  // 只在純前端展示(VITE_MOCK=on)預填 demo 帳號:mock 登入不驗密碼,其餘模式一律留空。
  // repo 是公開的,不要在這裡放真的 demo 密碼
  const demoPrefill = config.mockMode === "on";
  const [email, setEmail] = useState(demoPrefill ? "admin@demo.local" : "");
  const [password, setPassword] = useState(demoPrefill ? "demo" : "");
  // 多租戶:選填工作區 slug(進階,預設收合);同一帳密對到多個工作區時後端回清單讓使用者選
  const [tenant, setTenant] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [tenantChoices, setTenantChoices] = useState<TenantChoice[] | null>(null);
  const [pickingSlug, setPickingSlug] = useState<string | null>(null);
  // 2FA:密碼通過後若需 OTP,顯示驗證碼輸入;challenge 免重送密碼
  const [otp, setOtp] = useState("");
  const [need2fa, setNeed2fa] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  // 組織強制 2FA(enrollment):租戶開啟 require_2fa 但坐席尚未啟用 → 進入設定步驟。
  //  enroll 保存後端回的密鑰 / otpauth / 短時效 challenge;enrollCode 為驗證器動態碼。
  const [enroll, setEnroll] = useState<{
    challenge: string;
    secret: string;
    otpauthUri: string;
    digits: number;
    period: number;
  } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  // 驗證成功後:先顯示一次性備援碼並要求確認保存,pendingSession 暫存 token 待確認後再登入。
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pendingSession, setPendingSession] = useState<{
    access_token: string;
    is_platform_admin?: boolean;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // SSO(Google):按鈕忙碌狀態 + 導回時處理 hash 的 token / query 的錯誤碼
  const [ssoBusy, setSsoBusy] = useState(false);
  // 原生 SSO:正在等系統瀏覽器完成哪一種登入;ssoCompleting = 已收到回呼、正在兌換 token
  const [nativeSso, setNativeSso] = useState<SsoProvider | null>(null);
  const [ssoCompleting, setSsoCompleting] = useState(false);
  // 原生殼:伺服器資訊(決定 SSO 按鈕、提示更新);web 不請求
  const serverInfo = useServerInfo(isNative);

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || "/workspace";
  const tenantSlug = normalizeTenantSlug(tenant);

  // Google 回呼導回登入頁:成功以 fragment 帶 token(#sso_token=…),失敗以 query 帶 sso_error。
  // 於掛載時處理一次;token 讀畢立即清掉 hash,避免殘留在網址列 / 歷史紀錄。(web 流程,原生走 deep link)
  useEffect(() => {
    if (isNative) return;
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const ssoToken = new URLSearchParams(hash).get("sso_token");
    if (ssoToken) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      (async () => {
        try {
          await finalizeSession({ access_token: ssoToken });
          navigate(from, { replace: true });
        } catch {
          setError(t("auth.ssoFailed", { defaultValue: "Google 登入失敗,請重試" }));
        }
      })();
      return;
    }
    const ssoErr = new URLSearchParams(window.location.search).get("sso_error");
    if (ssoErr) {
      window.history.replaceState(null, "", window.location.pathname);
      if (ssoErr === "SSO_DISABLED") {
        setError(t("auth.ssoDisabled", { defaultValue: "尚未設定 Google 單一登入,請聯絡管理員" }));
      } else if (ssoErr === "SSO_NOT_INVITED") {
        setError(t("auth.ssoNotInvited", { defaultValue: "此 Google 帳號未被邀請,請聯絡管理員" }));
      } else {
        setError(t("auth.ssoFailed", { defaultValue: "Google 登入失敗,請重試" }));
      }
    }
    // 僅於掛載時處理一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 原生 SSO 回呼:kefu://auth/callback?code&state(或 sso_error)。
  // 以 ref 取最新的處理函式,訂閱只建立一次(平台層會把冷啟動前抵達的連結重播給訂閱者)。
  async function handleNativeCallback(url: string, cb: AuthCallback) {
    const out = await resolveNativeSsoCallback(url, cb);
    if (out.kind === "ignored") return;
    setNativeSso(null);
    if (out.kind === "error") {
      setError(nativeSsoErrorText(t, out.code, out.provider));
      return;
    }
    setError(null);
    setSsoCompleting(true);
    try {
      await finalizeSession(out.result);
      navigate(from, { replace: true });
    } catch {
      setError(nativeSsoErrorText(t, "OAUTH_FAILED", out.provider));
    } finally {
      setSsoCompleting(false);
    }
  }
  const callbackRef = useRef(handleNativeCallback);
  callbackRef.current = handleNativeCallback;

  useEffect(() => {
    if (!isNative) return;
    return onDeepLink((url) => {
      const cb = parseAuthCallback(url);
      if (cb) void callbackRef.current(url, cb);
    });
  }, []);

  // 使用者從瀏覽器返回卻沒有完成登入(關掉瀏覽器):回到前景幾秒後仍無回呼 → 解除等待狀態。
  // 暫存的 PKCE 狀態保留到逾時,稍晚抵達的回呼仍可完成登入。
  useEffect(() => {
    if (!nativeSso) return;
    let timer: number | undefined;
    const off = onResume(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setNativeSso(null), 4000);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [nativeSso]);

  if (token) return <Navigate to={from} replace />;

  /** 原生:以系統瀏覽器開始 Google / SAML 單一登入(PKCE,docs/NATIVE-CLIENTS.md §4.1)。 */
  async function startNativeSso(provider: SsoProvider) {
    setError(null);
    setNativeSso(provider);
    try {
      await beginNativeSso(provider, provider === "saml" ? tenantSlug : undefined);
    } catch {
      setNativeSso(null);
      setError(t("native.login.sso.errOpenBrowser", "無法開啟系統瀏覽器,請重試"));
    }
  }

  function cancelNativeSso() {
    clearPendingSso();
    setNativeSso(null);
  }

  /**
   * 「使用 Google 登入」:先以 redirect:"manual" 探測 start 端點——
   * - 302(opaqueredirect)→ SSO 已設定,直接整頁導向 start 端點交由後端轉往 Google;
   * - 200 且 code=SSO_DISABLED → 未設定,原地顯示提示(不離開頁面)。
   * 後端連不上等例外一律保底直接導向,交由後端決定。
   * 原生殼改走系統瀏覽器 + PKCE(WebView 內的 Google 登入會被 Google 拒絕)。
   */
  async function onGoogleLogin() {
    if (isNative) {
      await startNativeSso("google");
      return;
    }
    setError(null);
    setSsoBusy(true);
    const startUrl = `${config.apiBase.replace(/\/$/, "")}/api/v1/auth/oauth/google/start`;
    try {
      const res = await fetch(startUrl, { redirect: "manual" });
      if (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400)) {
        window.location.href = startUrl;
        return;
      }
      const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (json?.error?.code === "SSO_DISABLED") {
        setError(t("auth.ssoDisabled", { defaultValue: "尚未設定 Google 單一登入,請聯絡管理員" }));
      } else {
        window.location.href = startUrl;
      }
    } catch {
      window.location.href = startUrl;
    } finally {
      setSsoBusy(false);
    }
  }

  function resetTwoFa() {
    setNeed2fa(false);
    setChallenge(null);
    setOtp("");
    setError(null);
  }

  function resetTenantPick() {
    setTenantChoices(null);
    setPickingSlug(null);
    setError(null);
  }

  // 放棄設定流程,回到帳密登入(challenge 為短時效,失效時亦由此重來)
  function resetEnroll() {
    setEnroll(null);
    setEnrollCode("");
    setRecoveryCodes(null);
    setRecoverySaved(false);
    setCopied(false);
    setPendingSession(null);
    setError(null);
  }

  // 設定 2FA 第二步:以動態碼向後端驗證 → 啟用並取得正式 token + 一次性備援碼
  async function onVerifyEnroll(e: FormEvent) {
    e.preventDefault();
    if (!enroll) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await enrollVerify2fa({ challenge: enroll.challenge, code: enrollCode.trim() });
      const session = { access_token: res.access_token, is_platform_admin: res.is_platform_admin };
      if (res.recovery_codes && res.recovery_codes.length > 0) {
        // 先顯示一次性備援碼,要求確認已保存後再進入系統
        setPendingSession(session);
        setRecoveryCodes(res.recovery_codes);
        return;
      }
      // 保底:後端未回備援碼時直接完成登入
      await finalizeSession(session);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_OTP") {
        setError(
          t("login.enroll2fa.errInvalidCode", {
            defaultValue: "驗證碼不正確,請確認驗證器 App 時間同步後重試",
          }),
        );
      } else if (
        err instanceof ApiError &&
        (err.code === "INVALID_TOKEN" || err.code === "TWOFA_NOT_SETUP")
      ) {
        setError(
          t("login.enroll2fa.errChallengeExpired", {
            defaultValue: "設定連結已失效,請返回重新登入以重新開始設定",
          }),
        );
      } else if (err instanceof ApiError && err.httpStatus === 429) {
        setError(
          t("login.enroll2fa.errTooMany", { defaultValue: "嘗試次數過多,請稍後再試" }),
        );
      } else {
        setError(
          err instanceof Error
            ? err.message
            : t("login.enroll2fa.error", { defaultValue: "設定失敗,請重試" }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  // 複製備援碼(以換行分隔,方便貼進密碼管理器)
  async function onCopyRecovery() {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪貼簿不可用時忽略,使用者仍可手動選取 */
    }
  }

  // 確認已保存備援碼 → 正式寫入 session 並進入系統
  async function onFinishEnroll() {
    if (!pendingSession) return;
    setSubmitting(true);
    setError(null);
    try {
      await finalizeSession(pendingSession);
      navigate(from, { replace: true });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("login.enroll2fa.error", { defaultValue: "設定失敗,請重試" }),
      );
      setSubmitting(false);
    }
  }

  /** 送出登入(帳密 / 2FA 第二步 / 選定工作區後重送共用)。 */
  async function attemptLogin(tenantOverride?: string) {
    const useTenant = tenantOverride ?? tenantSlug;
    setSubmitting(true);
    setError(null);
    try {
      const res = await loginWithTenant({
        email,
        password,
        otp: need2fa ? otp.trim() : undefined,
        challenge: need2fa ? challenge ?? undefined : undefined,
        tenant: useTenant || undefined,
      });
      if (res.requires_tenant_selection) {
        // 密碼正確但對到多個工作區:顯示清單讓使用者選擇,再帶 tenant 重送
        const choices = tenantChoicesOf(res);
        if (choices.length > 0) {
          setTenantChoices(choices);
        } else {
          setError(t("native.login.tenantRequired", "這個帳號屬於多個工作區,請在「工作區(進階)」填寫工作區代號"));
          setShowAdvanced(true);
        }
        return;
      }
      // 已確定工作區(含從清單選定):收起清單並記住,後續 2FA 步驟沿用
      if (tenantOverride !== undefined) setTenant(tenantOverride);
      setTenantChoices(null);
      if (res.requires_2fa_enrollment) {
        // 組織強制 2FA 但此坐席尚未啟用:進入「設定 2FA」步驟(顯示密鑰 / otpauth,待掃碼驗證)
        setEnroll({
          challenge: res.enroll_challenge ?? "",
          secret: res.secret ?? "",
          otpauthUri: res.otpauth_uri ?? "",
          digits: res.digits ?? 6,
          period: res.period ?? 30,
        });
        return;
      }
      if (res.requires_2fa) {
        // 密碼已通過,進入 2FA 步驟:顯示 OTP 輸入,記住 challenge(免重送密碼)
        setNeed2fa(true);
        setChallenge(res.challenge ?? null);
        return;
      }
      await finalizeSession(res);
      navigate(from, { replace: true });
    } catch (err) {
      // 後端連不上且非 off 模式 → 以 mock 登入,讓無後端 demo 可進入
      if (isNetworkError(err) && config.mockMode !== "off") {
        try {
          await mockLogin(email, password);
          navigate(from, { replace: true });
          return;
        } catch {
          /* 落到下方錯誤處理 */
        }
      }
      if (err instanceof ApiError && err.code === "INVALID_OTP") {
        setError(t("auth.invalidOtp", { defaultValue: "驗證碼不正確或已過期" }));
      } else if (err instanceof ApiError && err.httpStatus === 401) {
        setError(
          useTenant
            ? t("native.login.invalidWithTenant", "電子郵件、密碼或工作區代號不正確")
            : t("auth.invalidCredentials", { defaultValue: "電子郵件或密碼不正確" }),
        );
      } else if (isNative && isNetworkError(err)) {
        setError(t("native.login.sso.errNetwork", "無法連線到伺服器,請檢查網路後再試"));
      } else {
        setError(err instanceof Error ? err.message : t("auth.loginFailed", { defaultValue: "登入失敗" }));
      }
    } finally {
      setSubmitting(false);
      setPickingSlug(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await attemptLogin();
  }

  async function onPickTenant(slug: string) {
    setPickingSlug(slug);
    await attemptLogin(slug);
  }

  // SSO 按鈕:web 照舊永遠顯示 Google;原生依伺服器 features 決定(SAML 另需填工作區)
  const showGoogle = isNative ? Boolean(serverInfo?.features.google_sso) : true;
  const showSaml = isNative && Boolean(serverInfo?.features.saml) && tenantSlug !== "";
  const ssoLocked = ssoBusy || nativeSso != null || ssoCompleting;

  const errorBox = error && (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertCircle className="h-4 w-4 shrink-0" />
      {error}
    </div>
  );

  return (
    <AuthShell
      topRight={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          aria-label={t("topbar.theme")}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      }
    >
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark logoUrl={branded ? brand.logoUrl : null} alt={brandName} />
          <div>
            <h1 className="text-lg font-semibold">{brandName}</h1>
            <p className="text-sm text-muted-foreground">{t("login.subtitle")}</p>
          </div>
        </div>

        {isNative && (
          <div className="mb-4 space-y-2">
            <AppUpdateBanner info={serverInfo} />
            <ServerHostBar disabled={submitting || ssoCompleting} />
          </div>
        )}

        {enroll ? (
          recoveryCodes ? (
            /* 綁定成功:顯示一次性備援碼,要求確認保存後再進入系統 */
            <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="flex items-center gap-2 text-base font-semibold">
                <ShieldCheck className="h-5 w-5 text-brand" />
                {t("login.enroll2fa.recoveryTitle", { defaultValue: "請保存備援碼" })}
              </div>
              <p className="text-sm text-muted-foreground">
                {t("login.enroll2fa.recoveryHint", {
                  defaultValue:
                    "這組備援碼僅顯示這一次。當你無法使用驗證器 App 時,可用其中一組登入。請妥善保存於安全之處。",
                })}
              </p>
              <div className="relative rounded-md border border-border bg-muted/40 p-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-sm">
                  {recoveryCodes.map((code) => (
                    <span key={code} className="select-all tracking-wider">
                      {code}
                    </span>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onCopyRecovery}
                  className="absolute right-1.5 top-1.5"
                  aria-label={t("login.enroll2fa.copy", { defaultValue: "複製" })}
                >
                  {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>

              {errorBox}

              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={recoverySaved}
                  onChange={(e) => setRecoverySaved(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-brand"
                />
                <span>
                  {t("login.enroll2fa.recoverySaved", {
                    defaultValue: "我已將備援碼保存於安全之處",
                  })}
                </span>
              </label>

              <Button
                type="button"
                className="w-full"
                onClick={onFinishEnroll}
                disabled={!recoverySaved || submitting}
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("login.enroll2fa.continue", { defaultValue: "完成並進入系統" })}
              </Button>
            </div>
          ) : (
            /* 設定 2FA:顯示密鑰 / otpauth 供加入驗證器 App,輸入動態碼驗證 */
            <form
              onSubmit={onVerifyEnroll}
              className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
            >
              <div className="flex items-center gap-2 text-base font-semibold">
                <ShieldCheck className="h-5 w-5 text-brand" />
                {t("login.enroll2fa.title", { defaultValue: "設定兩步驗證(2FA)" })}
              </div>
              <p className="text-sm text-muted-foreground">
                {t("login.enroll2fa.hint", {
                  defaultValue:
                    "貴組織已要求所有坐席啟用兩步驗證。請以驗證器 App(如 Google Authenticator、1Password)加入下方密鑰,再輸入其顯示的動態碼完成設定。",
                })}
              </p>

              {/* 手機 App:直接把 otpauth:// 交給裝置上的驗證器 App */}
              {isMobileApp && enroll.otpauthUri && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void openOtpauth(enroll.otpauthUri)}
                >
                  <ExternalLink className="h-4 w-4" />
                  {t("native.login.openAuthenticator", "在驗證器 App 中開啟")}
                </Button>
              )}

              <div className="space-y-1.5">
                <Label>{t("login.enroll2fa.secretLabel", { defaultValue: "手動輸入密鑰" })}</Label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <code className="select-all break-all font-mono text-sm tracking-wider">
                    {enroll.secret}
                  </code>
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <QrCode className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 space-y-1">
                  <p>
                    {t("login.enroll2fa.scanHint", {
                      defaultValue: "或以下列 otpauth 連結加入驗證器(支援掃碼的 App 可掃描此內容):",
                    })}
                  </p>
                  <code className="block select-all break-all font-mono">{enroll.otpauthUri}</code>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="enrollCode">
                  {t("login.enroll2fa.codeLabel", { defaultValue: "驗證器動態碼" })}
                </Label>
                <Input
                  id="enrollCode"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={enrollCode}
                  onChange={(e) =>
                    setEnrollCode(e.target.value.replace(/\D/g, "").slice(0, enroll.digits))
                  }
                  placeholder={"0".repeat(enroll.digits)}
                  className="text-center font-mono text-lg tracking-[0.4em]"
                  autoFocus
                  required
                />
              </div>

              {errorBox}

              <Button
                type="submit"
                className="w-full"
                disabled={submitting || enrollCode.length < enroll.digits}
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting
                  ? t("login.submitting")
                  : t("login.enroll2fa.verify", { defaultValue: "驗證並啟用" })}
              </Button>

              <button
                type="button"
                onClick={resetEnroll}
                className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" />
                {t("auth.backToLogin", { defaultValue: "返回重新登入" })}
              </button>
            </form>
          )
        ) : tenantChoices ? (
          /* 多租戶:選擇工作區後帶 tenant 重送登入 */
          <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
            <TenantPicker
              tenants={tenantChoices}
              busySlug={pickingSlug}
              onPick={(slug) => void onPickTenant(slug)}
              onBack={resetTenantPick}
            />
            {errorBox}
          </div>
        ) : (
        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
        >
          {need2fa ? (
            /* 2FA 步驟:輸入驗證器 App 產生的 6 碼 */
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md bg-brand/10 px-3 py-2 text-sm text-brand">
                <ShieldCheck className="h-4 w-4 shrink-0" />
                {t("auth.twoFaPrompt", { defaultValue: "請輸入驗證器 App 顯示的 6 位數驗證碼" })}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="otp">{t("auth.otpLabel", { defaultValue: "驗證碼" })}</Label>
                <Input
                  id="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  className="text-center font-mono text-lg tracking-[0.4em]"
                  autoFocus
                  required
                />
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="email">{t("login.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">{t("login.password")}</Label>
                  <Link
                    to="/forgot-password"
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {t("auth.forgotPasswordLink", { defaultValue: "忘記密碼?" })}
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>

              {/* 工作區(進階,預設收合):同一帳號屬於多個工作區、或使用 SAML 時填寫 */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  aria-controls="login-advanced"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform rtl:rotate-180", showAdvanced && "rotate-90 rtl:rotate-90")}
                  />
                  {t("native.login.workspaceToggle", "工作區(進階)")}
                  {!showAdvanced && tenantSlug && (
                    <span className="max-w-[10rem] truncate font-mono text-foreground">· {tenantSlug}</span>
                  )}
                </button>
                {showAdvanced && (
                  <div id="login-advanced" className="mt-2 space-y-1.5">
                    <Label htmlFor="tenant">{t("native.login.workspaceLabel", "工作區代號")}</Label>
                    <Input
                      id="tenant"
                      value={tenant}
                      onChange={(e) => setTenant(e.target.value)}
                      placeholder={t("native.login.workspacePlaceholder", "例如 acme")}
                      autoComplete="organization"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={100}
                    />
                    <p className="text-xs text-muted-foreground">
                      {isNative && serverInfo?.features.saml
                        ? t(
                            "native.login.workspaceHintSaml",
                            "同一帳號屬於多個工作區,或要使用 SAML 單一登入時填寫;其餘情況可留空。",
                          )
                        : t("native.login.workspaceHint", "同一帳號屬於多個工作區時填寫;其餘情況可留空。")}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {errorBox}

          <Button type="submit" className="w-full" disabled={submitting || ssoCompleting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting
              ? t("login.submitting")
              : need2fa
                ? t("auth.verifyAndLogin", { defaultValue: "驗證並登入" })
                : t("login.submit")}
          </Button>

          {!need2fa && (showGoogle || showSaml) && (
            <>
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">
                  {t("auth.orDivider", { defaultValue: "或" })}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              {showGoogle && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={onGoogleLogin}
                  disabled={ssoLocked}
                >
                  {ssoBusy || nativeSso === "google" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GoogleIcon />
                  )}
                  {t("auth.googleLogin", { defaultValue: "使用 Google 登入" })}
                </Button>
              )}
              {showSaml && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void startNativeSso("saml")}
                  disabled={ssoLocked}
                >
                  {nativeSso === "saml" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Building2 className="h-4 w-4" />
                  )}
                  <span className="truncate">
                    {t("native.login.samlLogin", "以 SAML 單一登入 {{slug}}", { slug: tenantSlug })}
                  </span>
                </Button>
              )}
              {nativeSso && (
                <p className="text-center text-xs text-muted-foreground" aria-live="polite">
                  {t("native.login.sso.waiting", "已在瀏覽器開啟登入頁面,完成後會自動回到 App。")}{" "}
                  <button
                    type="button"
                    onClick={cancelNativeSso}
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {t("native.server.cancel", "取消")}
                  </button>
                </p>
              )}
              {ssoCompleting && (
                <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("native.login.sso.completing", "正在完成登入…")}
                </p>
              )}
            </>
          )}

          {need2fa ? (
            <button
              type="button"
              onClick={resetTwoFa}
              className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" />
              {t("auth.backToLogin", { defaultValue: "返回重新登入" })}
            </button>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              {t("auth.noAccount", { defaultValue: "還沒有帳號?" })}{" "}
              <Link to="/register" className="font-medium text-brand hover:underline">
                {t("auth.registerLink", { defaultValue: "免費註冊" })}
              </Link>
            </p>
          )}

          {config.mockMode !== "off" && !need2fa && (
            <p className="text-center text-xs text-muted-foreground">{t("login.demoHint")}</p>
          )}
        </form>
        )}

        {!isNative && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            {t("core.loginApiMode", { api: config.apiBase, mode: config.mockMode })}
          </p>
        )}
      </div>
    </AuthShell>
  );
}
