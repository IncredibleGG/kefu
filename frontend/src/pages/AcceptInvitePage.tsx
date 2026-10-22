import { useState, type FormEvent } from "react";
import { useNavigate, Navigate, Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Loader2, AlertCircle, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/stores/auth";
import { useBrand } from "@/stores/brand";
import { fileUrl } from "@/lib/server";
import { ApiError } from "@/api/client";
import { finalizeSession } from "@/api/authExtra";
import { acceptInvite } from "@/api/invite";

/** 接受坐席邀請:自 query string 讀 token,設定密碼後啟用帳號並自動登入進工作台。 */
export function AcceptInvitePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const loggedIn = useAuth((s) => s.token);
  const brand = useBrand();
  const branded = brand.ready && !brand.isDefault;
  const brandName = branded && brand.name ? brand.name : t("app.name", { defaultValue: "kefu" });

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loggedIn) return <Navigate to="/workspace" replace />;

  const canSubmit = token.length > 0 && password.length >= 6 && confirm.length > 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError(t("invite.errWeakPassword", { defaultValue: "密碼至少 6 碼" }));
      return;
    }
    if (password !== confirm) {
      setError(t("invite.errPasswordMismatch", { defaultValue: "兩次輸入的密碼不一致" }));
      return;
    }
    setSubmitting(true);
    try {
      const res = await acceptInvite({
        token,
        password,
        display_name: displayName.trim() || undefined,
      });
      // 成功回正式 token → 自動登入並進入工作台
      await finalizeSession(res);
      navigate("/workspace", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVITE_ALREADY_USED") {
        setError(t("invite.errAlreadyUsed", { defaultValue: "此邀請連結已被使用,請洽管理員重新邀請" }));
      } else if (err instanceof ApiError && err.code === "INVALID_TOKEN") {
        setError(t("invite.errInvalidToken", { defaultValue: "邀請連結無效或已過期,請洽管理員重新邀請" }));
      } else if (err instanceof ApiError && err.code === "WEAK_PASSWORD") {
        setError(t("invite.errWeakPassword", { defaultValue: "密碼至少 6 碼" }));
      } else {
        setError(err instanceof Error ? err.message : t("invite.errFailed", { defaultValue: "接受邀請失敗,請稍後再試" }));
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
            <h1 className="text-lg font-semibold">{t("invite.title", { defaultValue: "接受邀請" })}</h1>
            <p className="text-sm text-muted-foreground">
              {t("invite.subtitle", { defaultValue: "設定你的密碼以完成加入" })}
            </p>
          </div>
        </div>

        {!token ? (
          <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {t("invite.errMissingToken", { defaultValue: "缺少邀請權杖,請由邀請連結進入" })}
            </div>
            <Link to="/login" className="block text-center text-xs font-medium text-brand hover:underline">
              {t("auth.backToLoginLink", { defaultValue: "前往登入" })}
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="space-y-1.5">
              <Label htmlFor="inv-name">{t("invite.displayName", { defaultValue: "顯示名稱(選填)" })}</Label>
              <Input
                id="inv-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("invite.displayNamePlaceholder", { defaultValue: "例如:王小明" })}
                autoComplete="name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-password">{t("invite.password", { defaultValue: "設定密碼" })}</Label>
              <Input
                id="inv-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("invite.passwordHint", { defaultValue: "至少 6 碼" })}
                autoComplete="new-password"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-confirm">{t("invite.confirmPassword", { defaultValue: "確認密碼" })}</Label>
              <Input
                id="inv-confirm"
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
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              {submitting
                ? t("invite.submitting", { defaultValue: "處理中…" })
                : t("invite.submit", { defaultValue: "完成並進入工作台" })}
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
