import { useState, type FormEvent } from "react";
import { Navigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Loader2, AlertCircle, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/stores/auth";
import { forgotPasswordRequest, type ForgotPasswordResult } from "@/api/authExtra";

/** 忘記密碼:輸入 email 申請重設。無論帳號是否存在皆回相同通用訊息(避免枚舉)。
 *  dev 環境後端會回傳測試用 token,此頁直接顯示重設連結,方便無 SMTP 時測試。 */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const token = useAuth((s) => s.token);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ForgotPasswordResult | null>(null);

  if (token) return <Navigate to="/workspace" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await forgotPasswordRequest(email.trim());
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.errRequestFailed", { defaultValue: "申請失敗,請稍後再試" }));
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
            <h1 className="text-lg font-semibold">{t("auth.forgotTitle", { defaultValue: "重設密碼" })}</h1>
            <p className="text-sm text-muted-foreground">
              {t("auth.forgotSubtitle", { defaultValue: "輸入註冊用的電子郵件,我們將寄出重設連結" })}
            </p>
          </div>
        </div>

        {result ? (
          <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-start gap-2 rounded-md bg-success/10 px-3 py-2.5 text-sm text-success">
              <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{result.message}</span>
            </div>

            {/* dev 環境:後端回傳測試 token,直接給出重設連結 */}
            {result.debug_tokens && result.debug_tokens.length > 0 && (
              <div className="space-y-2 rounded-md border border-dashed border-border bg-muted/40 p-3">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {t("auth.devTokenNote", { defaultValue: "開發模式:以下為測試用重設連結(正式環境改由信件寄出)" })}
                </p>
                {result.debug_tokens.map((d) => (
                  <Link
                    key={d.token}
                    to={`/reset-password?token=${encodeURIComponent(d.token)}`}
                    className="block break-all text-xs font-medium text-brand hover:underline"
                  >
                    {t("auth.devResetLink", { defaultValue: "前往重設密碼" })} →
                  </Link>
                ))}
              </div>
            )}

            <Link
              to="/login"
              className="block text-center text-xs font-medium text-brand hover:underline"
            >
              {t("auth.backToLoginLink", { defaultValue: "前往登入" })}
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="space-y-1.5">
              <Label htmlFor="fp-email">{t("login.email")}</Label>
              <Input
                id="fp-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                autoFocus
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting || email.trim().length === 0}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? t("auth.sending", { defaultValue: "送出中…" }) : t("auth.forgotSubmit", { defaultValue: "寄出重設連結" })}
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
