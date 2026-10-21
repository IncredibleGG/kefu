import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  ClipboardList,
  XCircle,
  Bot,
  PanelRightOpen,
  Timer,
  Languages,
  Hand,
  MessagesSquare,
  AtSign,
  AlertTriangle,
  Ticket,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { MessageBubble } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import { SuggestionBar } from "./SuggestionBar";
import { ServiceSummaryDialog } from "./ServiceSummaryDialog";
import { TransferDialog } from "./TransferDialog";
import { SessionTags } from "./SessionTags";
import { SideConversationPanel, MentionInput } from "./SideConversationPanel";
import { useNavigate } from "react-router-dom";
import {
  useMessages,
  useSendMessage,
  useFlagMessage,
  useHandoff,
  useCloseSession,
  useServiceSummary,
  qk,
} from "@/api/hooks";
import { channelMeta } from "@/lib/channels";
import { cn, initials } from "@/lib/utils";
import type { Message, Session } from "@/types";
import { useUi } from "@/stores/ui";
import { useAuth } from "@/stores/auth";
import { useNotify } from "@/stores/notify";
import { conversationApi, ticketApi } from "@/api/endpoints";
import { collabApi, type MentionRef } from "@/api/collab";
import { agentSocket, type ConnState } from "@/api/realtime";
import { apiFetch } from "@/api/client";

export function ConversationView({ session }: { session: Session }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: messages, isLoading } = useMessages(session.id);
  const send = useSendMessage(session.id);
  const flag = useFlagMessage(session.id);
  const handoff = useHandoff(session.id);
  const closeSession = useCloseSession(session.id);
  const serviceSummary = useServiceSummary(session.id);
  const { rightPanelCollapsed, setRightPanelCollapsed } = useUi();
  const myStaffId = useAuth((s) => s.staff?.staff_id);
  const qc = useQueryClient();
  const [summaryOpen, setSummaryOpen] = useState(false);
  // 服務小結對話框的兩種用途:close=送出後結束會話;summary=僅記小結不結束
  const [closeMode, setCloseMode] = useState<"close" | "summary">("close");
  const [transferOpen, setTransferOpen] = useState(false);
  // 操作錯誤提示(送訊 / 備註 / @提及 / 轉接失敗);以浮層顯示,確保於對話框之上仍可見
  const [actionError, setActionError] = useState<string | null>(null);
  // 操作成功提示(如建立工單);與 actionError 分開,正向綠色
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  // 坐席 WebSocket 連線狀態(僅訂閱,不管理連線生命週期;連線由 AppLayout 的 useAgentSocket 掌管)
  const [connState, setConnState] = useState<ConnState>("closed");
  // 引用訊息:把某則訊息內容帶入輸入框(帶 nonce 觸發注入)
  const [quote, setQuote] = useState<{ text: string; nonce: number }>();
  // 旁支協作面板開關 + 「帶 @提及的私密備註」輸入區開關
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [mentionNoteOpen, setMentionNoteOpen] = useState(false);
  const [inject, setInject] = useState<{ text: string; nonce: number }>();
  const [translateOn, setTranslateOn] = useState<boolean>(session.translate_enabled ?? false);
  const [translateBusy, setTranslateBusy] = useState(false);
  // 已讀浮水印:己方(human/ai)訊息被訪客讀到的最新時間;晚於此的己方訊息顯示「已送達」
  const [readWatermark, setReadWatermark] = useState<string | null>(null);
  // 對方(訪客)輸入中指示
  const [visitorTyping, setVisitorTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Message sneak-peek:訪客尚未送出的即時草稿內容(空字串 = 無草稿)
  const [visitorDraft, setVisitorDraft] = useState("");
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 送出私密內部備註:POST notes,成功後插入本會話訊息快取(以 id 去重)
  const sendNote = useMutation({
    mutationFn: (content: string) => conversationApi.addNote(session.id, content),
    onSuccess: (note: Message) => {
      qc.setQueryData<Message[]>(qk.messages(session.id), (old) => {
        if (!old) return [note];
        if (old.some((m) => m.id === note.id)) return old;
        return [...old, note];
      });
    },
  });

  // 送出「帶 @提及的私密備註」:走既有 notes 端點,mentions 併入 meta,純文字 @名字 存於內容。
  // 成功後同樣插入本會話訊息快取(以 id 去重),並收合輸入區。
  const sendMentionNote = useMutation({
    mutationFn: (input: { content: string; mentions: MentionRef[] }) =>
      collabApi.addNoteWithMentions(session.id, input.content, input.mentions),
    onMutate: () => setActionError(null),
    onSuccess: (note: Message) => {
      qc.setQueryData<Message[]>(qk.messages(session.id), (old) => {
        if (!old) return [note];
        if (old.some((m) => m.id === note.id)) return old;
        return [...old, note];
      });
      setMentionNoteOpen(false);
    },
    onError: () =>
      setActionError(t("collab.mentionNoteFailed", { defaultValue: "@提及備註送出失敗,請重試" })),
  });

  // 轉接:POST transfer,成功後即時更新列表與本會話
  const transfer = useMutation({
    mutationFn: (input: {
      target: { target_staff_id?: string; target_skill_group_id?: string };
      note?: string;
    }) => conversationApi.transfer(session.id, { ...input.target, note: input.note }),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setTransferOpen(false);
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: qk.messages(session.id) });
    },
    onError: () =>
      setActionError(t("workspace.transferFailed", { defaultValue: "轉接失敗,請重試" })),
  });

  // 從當前會話升級為工單:呼叫既有 from-session 端點(後端自動關聯訪客 / 聯絡人 / 指派人)。
  // 成功以正向浮層提示並提供前往工單入口;失敗走既有錯誤浮層。
  const createTicket = useMutation({
    mutationFn: () =>
      ticketApi.fromSession(session.id, {
        title: t("workspace.ticketFromSessionTitle", {
          name: session.visitor.display_name,
          defaultValue: "會話工單:{{name}}",
        }),
      }),
    onMutate: () => {
      setActionError(null);
      setActionNotice(null);
    },
    onSuccess: () => {
      setActionNotice(t("workspace.ticketCreated", { defaultValue: "已建立工單" }));
      qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: () =>
      setActionError(t("workspace.ticketCreateFailed", { defaultValue: "建立工單失敗,請重試" })),
  });

  // 訂閱共用坐席連線狀態(不 connect/disconnect,避免影響 AppLayout 管理的單例連線)
  useEffect(() => {
    const off = agentSocket.onState(setConnState);
    return () => {
      off();
    };
  }, []);

  // 新訊息自動捲到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages?.length]);

  // 切換會話時同步翻譯開關狀態
  useEffect(() => {
    setTranslateOn(session.translate_enabled ?? false);
  }, [session.id, session.translate_enabled]);

  // 開啟此會話時,讓坐席 WebSocket 額外訂閱該會話頻道,
  // 使「正在看的這個會話」的逐則新訊息(message.new)免刷新即時到達。
  useEffect(() => {
    agentSocket.setActiveSession(session.id);
    // 通知:標記為正在檢視的會話並清其未讀
    useNotify.getState().setActiveSession(session.id);
    return () => {
      agentSocket.setActiveSession(null);
      useNotify.getState().setActiveSession(null);
    };
  }, [session.id]);

  // 已讀回執:進入會話 / 收到新訊息時,標記訪客(對向)訊息為已讀,並取回
  // 「己方訊息被訪客讀到的浮水印」(peer_read_until)以在自己氣泡上顯示已讀/已送達。
  const msgCount = messages?.length ?? 0;
  useEffect(() => {
    if (!msgCount) return;
    let alive = true;
    (async () => {
      try {
        const r = await apiFetch<{ peer_read_until: string | null }>(
          `/api/v1/conversation/sessions/${session.id}/read`,
          { method: "POST", body: {} },
        );
        if (alive && r?.peer_read_until) setReadWatermark(r.peer_read_until);
      } catch {
        /* 標記已讀為加值,不阻斷 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [session.id, msgCount]);

  // 切換會話時重置本地即時狀態(避免殘留上一個會話的浮水印 / 輸入中)
  useEffect(() => {
    setReadWatermark(null);
    setVisitorTyping(false);
    setVisitorDraft("");
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (draftTimer.current) clearTimeout(draftTimer.current);
  }, [session.id]);

  // 訂閱即時事件:message.read(訪客已讀己方訊息)更新浮水印;typing(訪客輸入中)顯示指示。
  // 沿用既有 agentSocket(坐席已於上方 setActiveSession 訂閱本會話頻道)。
  useEffect(() => {
    const off = agentSocket.onEvent((ev) => {
      const p = (ev.payload ?? {}) as {
        session_id?: string;
        reader_type?: string;
        read_at?: string;
        sender_type?: string;
        text?: string;
      };
      if (p.session_id !== session.id) return;
      // message.read 不在 WsEvent 型別聯集中(相容保留),以字串比較避免型別窄化誤判
      if ((ev.type as string) === "message.read") {
        if (p.reader_type === "visitor" && p.read_at) setReadWatermark(p.read_at);
        return;
      }
      // Message sneak-peek:訪客即時草稿(visitor_draft,不在 WsEvent 型別聯集,以字串比較)。
      // 顯示目前草稿全文;空字串代表訪客已清空,直接收起。5 秒內無更新即自動清除(防殘留)。
      if ((ev.type as string) === "visitor_draft") {
        const text = typeof p.text === "string" ? p.text : "";
        setVisitorDraft(text);
        if (draftTimer.current) clearTimeout(draftTimer.current);
        if (text) draftTimer.current = setTimeout(() => setVisitorDraft(""), 5000);
        return;
      }
      if (ev.type === "typing" && p.sender_type !== "human") {
        setVisitorTyping(true);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setVisitorTyping(false), 4000);
      }
    });
    return () => {
      off();
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [session.id]);

  // 新訊息抵達即清除「輸入中」指示與草稿預覽(訪客送出後不再顯示)
  useEffect(() => {
    setVisitorTyping(false);
    setVisitorDraft("");
    if (draftTimer.current) clearTimeout(draftTimer.current);
  }, [msgCount]);

  const ch = channelMeta[session.channel];
  const isAi = session.handler_type !== "human";
  // 是否已指派給本坐席(否則顯示「接手」按鈕)
  const isMine = !!myStaffId && session.assignee_id === myStaffId;
  // 會話是否已結束:已結束時 header 顯示「已結束」而非「服務中」,輸入區禁用並提供「重新開啟」,
  // 避免送訊靜默重開(送訊會 auto-claim 使 status=open)造成的不一致。
  const isClosed = session.status === "closed";
  // 重新開啟:沿用既有 handoff takeover 端點(將 status 設回 open 並指派給本人),
  // 屬明確可見的操作,取代「送訊靜默重開」。
  const reopen = () => handoff.mutate({ action: "takeover" });

  // 翻譯開關:呼叫 PATCH 端點,樂觀更新;失敗回滾
  async function toggleTranslate() {
    const next = !translateOn;
    setTranslateBusy(true);
    setTranslateOn(next);
    try {
      await conversationApi.setTranslation(session.id, { enabled: next });
    } catch {
      setTranslateOn(!next);
    } finally {
      setTranslateBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      {/* 操作失敗浮層提示(送訊 / 備註 / @提及 / 轉接):高 z-index 以於對話框之上仍可見 */}
      {actionError && (
        <div className="fixed left-1/2 top-4 z-[100] flex max-w-[90vw] -translate-x-1/2 items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive shadow-md">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="shrink-0 text-destructive/70 hover:text-destructive"
            aria-label={t("workspace.cancel")}
          >
            ×
          </button>
        </div>
      )}
      {/* 操作成功浮層提示(如建立工單) */}
      {actionNotice && (
        <div className="fixed left-1/2 top-4 z-[100] flex max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs font-medium text-success shadow-md">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{actionNotice}</span>
          <button
            type="button"
            onClick={() => navigate("/tickets")}
            className="shrink-0 underline underline-offset-2 hover:opacity-80"
          >
            {t("workspace.viewTickets", { defaultValue: "查看工單" })}
          </button>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="shrink-0 opacity-70 hover:opacity-100"
            aria-label={t("workspace.cancel")}
          >
            ×
          </button>
        </div>
      )}
      {/* 標頭 */}
      <div className="flex h-13 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <Avatar className="h-9 w-9">
          <AvatarFallback>{initials(session.visitor.display_name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{session.visitor.display_name}</span>
            <Badge variant="outline" className="gap-1">
              <ch.Icon className={`h-3 w-3 ${ch.color}`} />
              {ch.label}
            </Badge>
            {isAi && (
              <Badge variant="brand" className="gap-1">
                <Bot className="h-3 w-3" />
                {t("workspace.aiHandled")}
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {session.visitor.location ?? session.visitor.external_id ?? "—"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {/* 連線狀態常駐指示:連線中 / 已連線 / 重新連線中,斷線重連時明顯提示 */}
          <ConnStatus state={connState} />
          {/* 已結束:顯示「已結束」徽章;進行中:顯示服務時長指示 */}
          {isClosed ? (
            <Badge variant="outline" className="gap-1 border-muted-foreground/30 text-muted-foreground">
              <CheckCircle2 className="h-3 w-3" />
              {t("conv.closedBadge", { defaultValue: "已結束" })}
            </Badge>
          ) : (
            <span className="mr-1 hidden items-center gap-1 text-xs text-muted-foreground lg:flex">
              <Timer className="h-3.5 w-3.5" /> {t("workspace.conversationView.serviceDuration")}
            </span>
          )}
          {/* 已結束:提供「重新開啟」明確操作(取代送訊靜默重開) */}
          {isClosed && (
            <Button
              size="sm"
              variant="default"
              className="gap-1"
              disabled={handoff.isPending}
              onClick={reopen}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("conv.reopen", { defaultValue: "重新開啟" })}
            </Button>
          )}
          {/* 接手/認領:未指派給本人且會話未結束時顯示(AI 接待或他人接手皆可接手) */}
          {!isMine && !isClosed && (
            <Button
              size="sm"
              variant="default"
              className="gap-1"
              disabled={handoff.isPending}
              onClick={() => handoff.mutate({ action: "takeover" })}
            >
              {isAi ? <Bot className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
              {t("workspace.takeover")}
            </Button>
          )}
          {/* 雙向翻譯開關 */}
          <SimpleTooltip label={translateOn ? t("workspace.conversationView.translateOff") : t("workspace.conversationView.translateOn")} side="bottom">
            <Button
              size="icon-sm"
              variant={translateOn ? "default" : "ghost"}
              disabled={translateBusy}
              onClick={toggleTranslate}
              aria-label={t("workspace.conversationView.translateLabel")}
              aria-pressed={translateOn}
            >
              <Languages className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          <HeaderAction
            icon={<ArrowRightLeft className="h-4 w-4" />}
            label={t("workspace.transfer")}
            onClick={() => setTransferOpen(true)}
          />
          {/* 旁支協作:開啟旁支討論串 / 協作者面板 */}
          <HeaderAction
            icon={<MessagesSquare className="h-4 w-4" />}
            label={t("collab.openPanel", { defaultValue: "旁支協作" })}
            onClick={() => setSidePanelOpen(true)}
          />
          {/* 帶 @提及的私密備註:切換輸入區 */}
          <SimpleTooltip label={t("collab.mentionNote", { defaultValue: "@提及備註" })} side="bottom">
            <Button
              size="icon-sm"
              variant={mentionNoteOpen ? "default" : "ghost"}
              aria-pressed={mentionNoteOpen}
              aria-label={t("collab.mentionNote", { defaultValue: "@提及備註" })}
              onClick={() => setMentionNoteOpen((v) => !v)}
            >
              <AtSign className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          {/* 從會話升級為工單:呼叫既有 from-session 端點 */}
          <HeaderAction
            icon={<Ticket className="h-4 w-4" />}
            label={t("workspace.createTicket", { defaultValue: "升級為工單" })}
            onClick={() => createTicket.mutate()}
            disabled={createTicket.isPending}
          />
          {/* 服務小結:僅記錄本次小結(含內部處理評級),不結束會話 */}
          <HeaderAction
            icon={<ClipboardList className="h-4 w-4" />}
            label={t("workspace.summary")}
            onClick={() => {
              setCloseMode("summary");
              setSummaryOpen(true);
            }}
          />
          <SessionTags sessionId={session.id} />
          {/* 結束會話:開結束對話框,送出後結束會話 */}
          <SimpleTooltip label={t("workspace.close")} side="bottom">
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                setCloseMode("close");
                setSummaryOpen(true);
              }}
            >
              <XCircle className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          {rightPanelCollapsed && (
            <SimpleTooltip label={t("panel.expand")} side="bottom">
              <Button size="icon-sm" variant="ghost" onClick={() => setRightPanelCollapsed(false)}>
                <PanelRightOpen className="h-4 w-4" />
              </Button>
            </SimpleTooltip>
          )}
        </div>
      </div>

      {/* 訊息流 */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-2/3" />
            ))}
          </div>
        ) : (
          messages?.map((m) => {
            // 己方(坐席 agent / ai)訊息:依浮水印判定已讀 / 已送達;訪客訊息不帶狀態
            const outbound = m.sender_type === "agent" || m.sender_type === "ai";
            const readState = outbound
              ? readWatermark && Date.parse(m.ts) <= Date.parse(readWatermark)
                ? ("read" as const)
                : ("delivered" as const)
              : undefined;
            return (
              <div key={m.id} className="animate-in-msg">
                <MessageBubble
                  message={m}
                  onFlag={(f) => flag.mutate({ messageId: m.id, flagged: f })}
                  onQuote={(content) => setQuote({ text: content, nonce: Date.now() })}
                  readState={readState}
                />
              </div>
            );
          })
        )}
        {/* 對方輸入中指示 + Message sneak-peek 即時草稿預覽。
            有草稿(visitorDraft)時顯示「訪客正在輸入:<即時文字>」;僅 typing 無草稿時顯示動畫點。 */}
        {(visitorTyping || visitorDraft) && (
          <div className="flex justify-start px-1">
            <div className="flex max-w-[80%] items-start gap-1.5 rounded-lg rounded-tl-sm bg-muted px-3 py-2 text-xs text-muted-foreground">
              <span className="mt-0.5 flex shrink-0 gap-0.5">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
              </span>
              {visitorDraft ? (
                <span className="min-w-0">
                  <span className="opacity-70">
                    {t("conv.visitorTypingPreview", { defaultValue: "訪客正在輸入:" })}
                  </span>
                  <span className="whitespace-pre-wrap break-words italic">{visitorDraft}</span>
                </span>
              ) : (
                <span>{t("conv.visitorTyping", { defaultValue: "訪客輸入中…" })}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 帶 @提及的私密備註輸入區(僅坐席可見,不送給訪客) */}
      {mentionNoteOpen && (
        <div className="border-t border-warning/40 bg-warning/5 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-warning">
            <AtSign className="h-3.5 w-3.5" />
            {t("collab.mentionNoteHint", {
              defaultValue: "內部備註:用 @ 提及同事,訪客看不到;送出即記入備註。",
            })}
          </div>
          <MentionInput
            tone="note"
            busy={sendMentionNote.isPending}
            submitLabel={t("collab.saveNote", { defaultValue: "儲存備註" })}
            placeholder={t("collab.mentionNotePlaceholder", { defaultValue: "輸入內部備註,用 @ 提及同事…" })}
            onSend={(content, mentions) => sendMentionNote.mutate({ content, mentions })}
          />
        </div>
      )}

      {/* AI 回覆建議條(輸入框上方) */}
      <SuggestionBar
        sessionId={session.id}
        onAdopt={(text) => setInject({ text, nonce: Date.now() })}
      />

      {/* 輸入區:送出回傳 Promise,成功才由 MessageComposer 清空輸入框;失敗保留內容並在此顯示提示。
          已結束會話禁用輸入(顯示提示 + 重新開啟入口),避免送訊靜默重開的不一致。 */}
      <MessageComposer
        disabled={isClosed}
        disabledHint={t("composer.closedHint", {
          defaultValue: "此會話已結束,請先「重新開啟」再回覆訪客",
        })}
        onReopen={reopen}
        onSend={async (text) => {
          setActionError(null);
          try {
            await send.mutateAsync({ content: text });
          } catch (e) {
            setActionError(t("workspace.sendFailed", { defaultValue: "訊息送出失敗,請重試" }));
            throw e; // 重新拋出,讓 MessageComposer 保留未送出的內容
          }
        }}
        onSendNote={async (text) => {
          setActionError(null);
          try {
            await sendNote.mutateAsync(text);
          } catch (e) {
            setActionError(t("workspace.noteSaveFailed", { defaultValue: "內部備註儲存失敗,請重試" }));
            throw e;
          }
        }}
        visitor={session.visitor}
        injectText={inject}
        injectQuote={quote}
      />

      <TransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        submitting={transfer.isPending}
        myStaffId={myStaffId}
        onSubmit={(target, note) => transfer.mutate({ target, note })}
      />

      {/* 旁支協作會話面板(旁支討論串 + 協作者管理) */}
      <SideConversationPanel
        open={sidePanelOpen}
        onOpenChange={setSidePanelOpen}
        sessionId={session.id}
      />

      <ServiceSummaryDialog
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
        closing={closeMode === "close"}
        onSubmit={async ({ category, note, csat }) => {
          // 失敗時不關閉對話框、不導頁(錯誤由對話框內就地顯示);拋出讓對話框得知失敗。
          if (closeMode === "close") {
            await closeSession.mutateAsync({ category, note, csat });
            setSummaryOpen(false);
            navigate("/workspace");
          } else {
            // 僅記服務小結,不結束會話;成功後關閉對話框、留在此會話。
            await serviceSummary.mutateAsync({ category, note, csat });
            setSummaryOpen(false);
          }
        }}
      />
    </div>
  );
}

function HeaderAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <SimpleTooltip label={label} side="bottom">
      <Button size="icon-sm" variant="ghost" onClick={onClick} disabled={disabled} aria-label={label}>
        {icon}
      </Button>
    </SimpleTooltip>
  );
}

/** 連線狀態常駐指示:連線中 / 已連線 / 重新連線中 / 模擬。
 *  連線中與重連中會明顯常駐顯示文字(不因螢幕小而收起),斷線重連時清楚可見。 */
function ConnStatus({ state }: { state: ConnState }) {
  const { t } = useTranslation();
  const meta: Record<
    ConnState,
    { dot: string; label: string; pulse: boolean; emphasize: boolean }
  > = {
    open: {
      dot: "bg-status-online",
      label: t("conn.connected", { defaultValue: "已連線" }),
      pulse: false,
      emphasize: false,
    },
    connecting: {
      dot: "bg-status-away",
      label: t("conn.connecting", { defaultValue: "連線中…" }),
      pulse: true,
      emphasize: true,
    },
    closed: {
      dot: "bg-status-busy",
      label: t("conn.reconnecting", { defaultValue: "重新連線中…" }),
      pulse: true,
      emphasize: true,
    },
    mock: {
      dot: "bg-status-offline",
      label: t("conn.mock", { defaultValue: "模擬即時" }),
      pulse: false,
      emphasize: false,
    },
  };
  const m = meta[state];
  return (
    <SimpleTooltip label={m.label} side="bottom">
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs",
          m.emphasize ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        <StatusDot className={m.dot} pulse={m.pulse} />
        {/* 已連線 / 模擬:小螢幕收起文字保持精簡;連線中 / 重連中:常駐明顯顯示 */}
        <span className={cn(m.emphasize ? "inline" : "hidden lg:inline")}>{m.label}</span>
      </span>
    </SimpleTooltip>
  );
}
