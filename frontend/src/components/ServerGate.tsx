/**
 * 伺服器閘門:包住 RouterProvider。
 * - 原生殼且尚未設定伺服器 → 顯示 ServerSetupPage(web 恆直接渲染 children)。
 * - requestServerSetup()(如登入頁「更換伺服器」)→ 顯示設定頁並可取消。
 * - 佈建連結 kefu://setup?server=…:**一律要使用者確認**才套用(docs/NATIVE-CLIENTS.md §2),
 *   未設定伺服器時只預填設定頁;已設定時跳確認對話框。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ServerSetupPage from "@/pages/ServerSetupPage";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isNative, onDeepLink } from "@/lib/platform";
import { setBackOverride } from "@/lib/mobile/backButton";
import {
  getServerBase,
  hasServer,
  normalizeServerUrl,
  onServerChange,
  onServerSetupRequest,
} from "@/lib/server";

/** 解析 kefu://setup?server=…;非佈建連結或網址不合法回 null。 */
function parseSetupLink(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "kefu:") return null;
    // kefu://setup?… 在不同平台可能解析成 host=setup 或 pathname=//setup
    const target = (u.host || u.pathname.replace(/^\/+/, "")).toLowerCase();
    if (target !== "setup") return null;
    const server = u.searchParams.get("server");
    if (!server) return null;
    return normalizeServerUrl(server);
  } catch {
    return null;
  }
}

export function ServerGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(() => hasServer());
  const [setupOpen, setSetupOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  // 設定頁(可取消模式)開著時,佈建連結交給 ServerSetupPage 自己的確認卡處理
  const setupOpenRef = useRef(setupOpen);
  useEffect(() => {
    setupOpenRef.current = setupOpen;
  }, [setupOpen]);

  useEffect(
    () =>
      onServerChange(() => {
        setReady(hasServer());
        setSetupOpen(false);
        setPrefill(null);
        setPendingSwitch(null);
      }),
    [],
  );

  useEffect(() => onServerSetupRequest(() => setSetupOpen(true)), []);

  useEffect(() => {
    if (!isNative) return;
    return onDeepLink((url) => {
      const server = parseSetupLink(url);
      if (!server) return;
      if (!hasServer()) {
        // 尚未設定:只預填,使用者按「連線」才套用
        setPrefill(server);
        return;
      }
      if (setupOpenRef.current) return;
      if (server === getServerBase()) return;
      setPendingSwitch(server);
    });
  }, []);

  const showSetup = isNative && (!ready || setupOpen);

  // 設定頁蓋住 RouterProvider 時,Android 返回鍵不可移動隱藏中的 router(畫面不會變):
  // 可取消(已有伺服器)→ 關閉設定頁回到原畫面;否則縮小 App。
  useEffect(() => {
    if (!showSetup) return;
    return setBackOverride(() => {
      if (!ready) return false;
      setSetupOpen(false);
      return true;
    });
  }, [showSetup, ready]);

  if (showSetup) {
    return (
      <ServerSetupPage
        key={prefill ?? "default"}
        initialUrl={prefill}
        onCancel={ready ? () => setSetupOpen(false) : undefined}
      />
    );
  }

  return (
    <>
      {children}
      <Dialog open={pendingSwitch != null} onOpenChange={(o) => !o && setPendingSwitch(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("native.server.switchTitle", "切換伺服器?")}</DialogTitle>
            <DialogDescription>
              {t("native.server.switchDesc", "連結要求改連到 {{server}}。切換後需要重新登入。", {
                server: pendingSwitch ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingSwitch(null)}>
              {t("native.server.cancel", "取消")}
            </Button>
            <Button
              onClick={() => {
                // 先經設定頁探測伺服器,通過後才真正切換
                setPrefill(pendingSwitch);
                setPendingSwitch(null);
                setSetupOpen(true);
              }}
            >
              {t("native.server.switchConfirm", "前往設定")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
