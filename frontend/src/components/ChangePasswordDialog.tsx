import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useChangePassword } from "@/api/hooks";
import { ApiError } from "@/api/client";

/**
 * 坐席自助修改密碼對話框:舊密碼 / 新密碼 / 確認新密碼。
 * 前端先驗證(新密碼長度 + 兩次一致),再呼叫 /auth/change-password;
 * 成功顯示提示並自動關閉,失敗依後端錯誤碼(INVALID_OLD_PASSWORD / WEAK_PASSWORD)顯示訊息。
 */
export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const changePw = useChangePassword();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function reset() {
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
    setError(null);
    setSuccess(false);
  }

  const canSubmit = oldPw.length > 0 && newPw.length >= 6 && confirmPw.length > 0;

  async function submit() {
    setError(null);
    if (newPw.length < 6) {
      setError(t("account.errorTooShort"));
      return;
    }
    if (newPw !== confirmPw) {
      setError(t("account.errorMismatch"));
      return;
    }
    try {
      await changePw.mutateAsync({ old_password: oldPw, new_password: newPw });
      setSuccess(true);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      // 成功後短暫顯示提示再自動關閉
      window.setTimeout(() => onOpenChange(false), 1200);
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_OLD_PASSWORD") {
        setError(t("account.errorOldPassword"));
      } else if (e instanceof ApiError && e.code === "WEAK_PASSWORD") {
        setError(t("account.errorTooShort"));
      } else {
        setError(e instanceof Error ? e.message : t("account.errorFailed"));
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("account.changePassword")}</DialogTitle>
          <DialogDescription>{t("account.changePasswordDesc")}</DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2.5 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" /> {t("account.changeSuccess")}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cp-old">{t("account.oldPassword")}</Label>
              <Input
                id="cp-old"
                type="password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
                autoComplete="current-password"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp-new">{t("account.newPassword")}</Label>
              <Input
                id="cp-new"
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder={t("account.newPasswordPlaceholder")}
                autoComplete="new-password"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp-confirm">{t("account.confirmPassword")}</Label>
              <Input
                id="cp-confirm"
                type="password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                autoComplete="new-password"
                className="font-mono"
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {!success && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submit} disabled={changePw.isPending || !canSubmit}>
              {changePw.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {changePw.isPending ? t("account.submitting") : t("account.submit")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
