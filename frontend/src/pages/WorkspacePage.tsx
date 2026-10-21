import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare, Wifi, WifiOff, Radio, Loader2 } from "lucide-react";
import { ConversationList } from "@/components/workspace/ConversationList";
import { ConversationView } from "@/components/workspace/ConversationView";
import { ContextPanel } from "@/components/workspace/ContextPanel";
import { useSessions, qk } from "@/api/hooks";
import { conversationApi } from "@/api/endpoints";
import { useUi } from "@/stores/ui";
import { agentSocket, type ConnState } from "@/api/realtime";

/** 三欄坐席工作台:左會話清單 + 中對話區 + 右情境面板 */
export function WorkspacePage() {
  const { t } = useTranslation();
  const { sessionId } = useParams();
  const { rightPanelCollapsed } = useUi();
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

  return (
    <div className="flex h-full">
      <ConversationList />
      {session ? (
        <>
          <ConversationView session={session} />
          {!rightPanelCollapsed && <ContextPanel session={session} />}
        </>
      ) : loadingDeepLink ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">{t("common.loading", { defaultValue: "載入中…" })}</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
            <MessagesSquare className="h-8 w-8" />
          </div>
          <p className="text-sm">{sessionId ? t("core.workspaceSessionNotFound") : t("workspace.empty")}</p>
          <ConnBadge state={connState} />
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
