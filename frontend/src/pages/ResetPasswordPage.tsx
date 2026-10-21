import { useState, type FormEvent } from "react";
import { Navigate, Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/stores/auth";
import { ApiError } from "@/api/client";
import { resetPasswordRequest } from "@/api/authExtra";

/** 重設密碼:自 query string 讀取 token,輸入新密碼後送後端驗證並更新。 */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const loggedIn = useAuth((s) => s.token);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (loggedIn) return <Navigate to="/workspace" replace />;

  const canSubmit = token.length > 0 && password.length >= 6 && confirm.length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
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
      await resetPasswordRequest(token, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_TOKEN") {
        setError(t("auth.errInvalidToken", { defaultValue: "重設連結無效或已過期,請重新申請" }));
      } else if (err instanceof ApiError && err.code === "WEAK_PASSWORD") {
        setError(t("auth.errWeakPassword", { defaultValue: "密碼至少 6 碼" }));
      } else {
        setError(err instanceof Error ? err.message : t("auth.errResetFailed", { defaultValue: "重設失敗,請稍後再試" }));
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
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-lg">
            <MessagesSquare className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">{t("auth.resetTitle", { defaultValue: "設定新密碼" })}</h1>
            <p className="text-sm text-muted-foreground">
              {t("auth.resetSubtitle", { defaultValue: "輸入新密碼以完成重設" })}
            </p>
          </div>
        </div>

        {done ? (
          <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2.5 text-sm text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {t("auth.resetSuccess", { defaultValue: "密碼已重設,請以新密碼登入" })}
            </div>
            <Link
              to="/login"
              className="block text-center text-xs font-medium text-brand hover:underline"
            >
              {t("auth.backToLoginLink", { defaultValue: "前往登入" })}
            </Link>
          </div>
        ) : !token ? (
          <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {t("auth.errMissingToken", { defaultValue: "缺少重設權杖,請由信件連結進入或重新申請" })}
            </div>
            <Link
              to="/forgot-password"
              className="block text-center text-xs font-medium text-brand hover:underline"
            >
              {t("auth.reRequestLink", { defaultValue: "重新申請重設密碼" })}
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="space-y-1.5">
              <Label htmlFor="rp-password">{t("auth.newPassword", { defaultValue: "新密碼" })}</Label>
              <Input
                id="rp-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("auth.passwordHint", { defaultValue: "至少 6 碼" })}
                autoComplete="new-password"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rp-confirm">{t("auth.confirmPassword", { defaultValue: "確認密碼" })}</Label>
              <Input
                id="rp-confirm"
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
              {submitting ? t("auth.resetting", { defaultValue: "重設中…" }) : t("auth.resetSubmit", { defaultValue: "重設密碼" })}
            </Button>

            <Link to="/login" className="block text-center text-xs text-muted-foreground hover:text-foreground">
              {t("auth.backToLoginLink", { defaultValue: "前往登入" })}
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
