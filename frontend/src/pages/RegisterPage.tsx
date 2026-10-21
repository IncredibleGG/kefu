import { useState, type FormEvent } from "react";
import { useNavigate, Navigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/stores/auth";
import { useBrand } from "@/stores/brand";
import { fileUrl } from "@/lib/server";
import { ApiError } from "@/api/client";
import { registerRequest, finalizeSession } from "@/api/authExtra";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 自助註冊:建立新租戶 + 第一個 admin 坐席。成功後自動登入並進入工作台。 */
export function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const token = useAuth((s) => s.token);
  const brand = useBrand();
  const branded = brand.ready && !brand.isDefault;
  const brandName = branded && brand.name ? brand.name : t("app.name", { defaultValue: "kefu" });

  const [tenantName, setTenantName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token) return <Navigate to="/workspace" replace />;

  const canSubmit =
    tenantName.trim().length > 0 && EMAIL_RE.test(email) && password.length >= 6 && confirm.length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!EMAIL_RE.test(email)) {
      setError(t("auth.errEmailFormat", { defaultValue: "電子郵件格式不正確" }));
      return;
    }
    if (password.length < 6) {
      setError(t("auth.errWeakPassword", { defaultValue: "密碼至少 6 碼" }));
      return;
    }
    if (password !== confirm) {
      setError(t("auth.errPasswordMismatch", { defaultValue: "兩次輸入的密碼不一致" }));
      return;
    }
    setSubmitting(true);
    try {
      const res = await registerRequest({
        email: email.trim(),
        password,
        tenant_name: tenantName.trim(),
        display_name: displayName.trim() || undefined,
      });
      // 成功即回正式 token → 自動登入
      await finalizeSession(res);
      navigate("/workspace", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_EMAIL") {
        setError(t("auth.errEmailFormat", { defaultValue: "電子郵件格式不正確" }));
      } else if (err instanceof ApiError && err.code === "WEAK_PASSWORD") {
        setError(t("auth.errWeakPassword", { defaultValue: "密碼至少 6 碼" }));
      } else {
        setError(err instanceof Error ? err.message : t("auth.errRegisterFailed", { defaultValue: "註冊失敗" }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand/10 blur-3xl" />
        <div className="absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-info/10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {branded && brand.logoUrl ? (
            <img src={fileUrl(brand.logoUrl) ?? undefined} alt={brandName} className="h-12 w-12 rounded-xl object-contain shadow-lg" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-lg">
              <MessagesSquare className="h-6 w-6" />
            </div>
          )}
          <div>
            <h1 className="text-lg font-semibold">{t("auth.registerTitle", { defaultValue: "建立你的客服工作台" })}</h1>
            <p className="text-sm text-muted-foreground">
              {t("auth.registerSubtitle", { defaultValue: "註冊即建立專屬租戶,你將成為管理員" })}
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="space-y-1.5">
            <Label htmlFor="tenant-name">{t("auth.tenantName", { defaultValue: "團隊 / 公司名稱" })}</Label>
            <Input
              id="tenant-name"
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              placeholder={t("auth.tenantNamePlaceholder", { defaultValue: "例如:ACME 客服中心" })}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reg-name">{t("auth.displayName", { defaultValue: "你的姓名(選填)" })}</Label>
            <Input
              id="reg-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("auth.displayNamePlaceholder", { defaultValue: "例如:王小明" })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reg-email">{t("login.email")}</Label>
            <Input
              id="reg-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reg-password">{t("login.password")}</Label>
            <Input
              id="reg-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.passwordHint", { defaultValue: "至少 6 碼" })}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reg-confirm">{t("auth.confirmPassword", { defaultValue: "確認密碼" })}</Label>
            <Input
              id="reg-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={submitting || !canSubmit}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? t("auth.registering", { defaultValue: "建立中…" }) : t("auth.registerSubmit", { defaultValue: "建立工作台" })}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            {t("auth.haveAccount", { defaultValue: "已經有帳號?" })}{" "}
            <Link to="/login" className="font-medium text-brand hover:underline">
              {t("auth.backToLoginLink", { defaultValue: "前往登入" })}
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
