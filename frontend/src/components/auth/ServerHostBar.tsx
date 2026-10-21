/**
 * 原生登入頁:顯示目前連線的伺服器,並提供「更換伺服器」。
 * 按下後先確認,再以 requestServerSetup() 交回 ServerGate 顯示伺服器設定頁
 * (設定頁內按「繼續」才會真正 setServerBase;按「返回」維持原伺服器)。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { requestServerSetup, serverHost } from "@/lib/server";

export function ServerHostBar({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const host = serverHost();

  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-sm">
        <Server className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] leading-tight text-muted-foreground">
            {t("native.login.serverLabel", "伺服器")}
          </div>
          <div className="truncate font-medium leading-tight" title={host}>
            {host || t("native.login.serverUnknown", "未設定")}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirmOpen(true)}
          disabled={disabled}
        >
          {t("native.login.changeServer", "更換伺服器")}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("native.login.changeServerTitle", "更換伺服器?")}</DialogTitle>
            <DialogDescription>
              {t(
                "native.login.changeServerDesc",
                "將回到伺服器設定畫面。改連其他伺服器後,需要以該伺服器的帳號重新登入。",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t("native.server.cancel", "取消")}
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                requestServerSetup();
              }}
            >
              {t("native.login.changeServerConfirm", "更換")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
