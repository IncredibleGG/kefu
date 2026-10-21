import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare, Wifi, WifiOff, Radio, Loader2, ArrowLeft } from "lucide-react";
import { ConversationList } from "@/components/workspace/ConversationList";
import { ConversationView } from "@/components/workspace/ConversationView";
import { ContextPanel } from "@/components/workspace/ContextPanel";
import { ContextSheet, useContextPanelMode } from "@/components/workspace/ContextSheet";
import { useBackToInbox } from "@/components/workspace/MobileConversationActions";
import { Button } from "@/components/ui/button";
import { useSessions, qk } from "@/api/hooks";
import { conversationApi } from "@/api/endpoints";
import { useUi } from "@/stores/ui";
import { agentSocket, type ConnState } from "@/api/realtime";
import { cn } from "@/lib/utils";

/**
 * 三欄坐席工作台:左會話清單 + 中對話區 + 右情境面板。
 * - 手機(< md):由路由驅動。/workspace 只顯示全寬清單;/workspace/:id 時對話區以
 *   absolute inset-0 疊在清單上(清單保持掛載,返回時捲動位置 / 分頁不重置;點會話為 push,
 *   Android 返回鍵自然回到清單)。情境面板改為 ?panel= 驅動的底部 sheet。
 * - 平板(md–lg):右欄改為 ?panel= 驅動的右側抽屜(浮層,不佔欄寬)。
 * - 桌面(≥ lg):維持原三欄。
 */
export function WorkspacePage() {
  const { t } = useTranslation();
  const { sessionId } = useParams();
  const { rightPanelCollapsed } = useUi();
  const contextMode = useContextPanelMode();
  const goBack = useBackToInbox();
  // 找出當前選中的會話(從各 tab 快取,簡化:抓 mine + online 合集)
  const mine = useSessions("mine");
  const online = useSessions("online");
  const all = [...(mine.data?.items ?? []), ...(online.data?.items ?? [])];
  const cached = all.find((s) => s.id === sessionId);
  // 深連結 /workspace/:sessionId 命中的會話可能不在 mine/online 兩個 tab 快取內
  //(例如 unassigned/queue、或他人負責中的會話);快取找不到時直接依 id 載入該會話,
  // 避免存在的會話被誤報「找不到」。
  const detailQuery = useQuery({
    queryKey: qk.session(sessionId ?? "none"),
    queryFn: () => conversationApi.getSession(sessionId!),
    enabled: !!sessionId && !cached,
  });
  const session = cached ?? detailQuery.data ?? undefined;
  // 深連結載入中(尚無快取命中且仍在抓取):避免在確定不存在前先閃現「找不到」
  const loadingDeepLink = !!sessionId && !cached && detailQuery.isLoading;

  const [connState, setConnState] = useState<ConnState>("closed");
  useEffect(() => {
    const off = agentSocket.onState(setConnState);
    return () => {
      off();
    };
  }, []);

  // 手機上有 sessionId 但還沒有會話內容(載入中 / 找不到)時,同樣疊在清單上方並提供返回
  const phoneOverlay = "max-md:absolute max-md:inset-0 max-md:z-10 max-md:pt-safe";
  const backButton = (
    <Button variant="outline" className="gap-1.5 md:hidden pointer-coarse:h-10" onClick={goBack}>
      <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
      {t("mobile.workspace.backToList", "返回會話清單")}
    </Button>
  );

  return (
    <div className="flex h-full max-md:relative">
      <ConversationList covered={contextMode === "sheet" && !!sessionId} />
      {session ? (
        <>
          <ConversationView session={session} />
          {contextMode === "aside" ? (
            !rightPanelCollapsed && <ContextPanel session={session} />
          ) : (
            <ContextSheet session={session} side={contextMode === "sheet" ? "bottom" : "end"} />
          )}
        </>
      ) : loadingDeepLink ? (
        <div
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-3 bg-background text-muted-foreground",
            phoneOverlay,
          )}
        >
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">{t("common.loading", { defaultValue: "載入中…" })}</p>
          {/* 沉浸模式下頂欄 / 分頁列都隱藏:載入卡住時仍要能離開(按鈕 md:hidden,桌面不變) */}
          {backButton}
        </div>
      ) : (
        // 未選會話的佔位畫面:手機上清單即主畫面,不顯示佔位
        <div
          className={cn(
            "flex-1 flex-col items-center justify-center gap-3 bg-background text-muted-foreground",
            sessionId ? cn("flex", phoneOverlay) : "hidden md:flex",
          )}
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
            <MessagesSquare className="h-8 w-8" />
          </div>
          <p className="text-sm">{sessionId ? t("core.workspaceSessionNotFound") : t("workspace.empty")}</p>
          <ConnBadge state={connState} />
          {sessionId && backButton}
        </div>
      )}
    </div>
  );
}

function ConnBadge({ state }: { state: string }) {
  const { t } = useTranslation();
  const map: Record<string, { icon: React.ReactNode; cls: string }> = {
    open: { icon: <Wifi className="h-3.5 w-3.5" />, cls: "text-success" },
    mock: { icon: <Radio className="h-3.5 w-3.5" />, cls: "text-warning" },
    connecting: { icon: <Wifi className="h-3.5 w-3.5 animate-pulse" />, cls: "text-muted-foreground" },
    closed: { icon: <WifiOff className="h-3.5 w-3.5" />, cls: "text-destructive" },
  };
  const m = map[state] ?? map.closed;
  const key = (["open", "connecting", "closed", "mock"].includes(state) ? state : "closed") as
    | "open"
    | "connecting"
    | "closed"
    | "mock";
  return (
    <span className={`flex items-center gap-1 text-xs ${m.cls}`}>
      {m.icon}
      {t(`workspace.connState.${key}`)}
    </span>
  );
}
