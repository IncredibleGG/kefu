import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  ArrowRightLeft,
  AtSign,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Languages,
  MessagesSquare,
  MoreVertical,
  Tag as TagIcon,
  Ticket,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { conversationApi, visitorApi } from "@/api/endpoints";
import { cn, hhmm } from "@/lib/utils";
import { routerCanGoBack } from "@/lib/mobile/backButton";
import type { Tag } from "@/types";
import { sessionTagsKey } from "./SessionTags";
import { SNOOZE_DURATIONS, findInboxSnoozedUntil, snoozeSession, unsnoozeSession } from "./ConversationList";

/**
 * 手機對話頁的「← 返回」:App 內有上一頁時 navigate(-1)(與 Android 返回鍵一致),
 * 沒有上一頁(冷啟動 / 新分頁直接進對話、登入後 replace 回深連結)→ replace 回會話清單,不留下已離開的會話。
 * 以 react-router 的 history.state.idx 判斷(location.key 在 replace 後也不是 "default",不可靠)。
 */
export function useBackToInbox(): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    if (routerCanGoBack()) navigate(-1);
    else navigate("/workspace", { replace: true });
  }, [navigate]);
}

export interface MobileConversationActionsProps {
  sessionId: string;
  isClosed: boolean;
  translateOn: boolean;
  translateBusy: boolean;
  onToggleTranslate: () => void;
  onTransfer: () => void;
  onSideConversation: () => void;
  mentionNoteOpen: boolean;
  onToggleMentionNote: () => void;
  onCreateTicket: () => void;
  creatingTicket: boolean;
  onSummary: () => void;
  onCloseSession: () => void;
  /** 操作成功的提示文字(例如已延後) */
  onNotice?: (text: string) => void;
  /** 操作失敗的提示文字 */
  onError?: (text: string) => void;
}

type View = "main" | "snooze" | "tags";

/**
 * 手機對話標頭的「⋯ 更多」:以底部 sheet 呈現(每列 ≥ 48px,觸控友善),
 * 收納桌面標頭的動作鈕:翻譯、轉接、旁支協作、@提及備註、升級工單、服務小結、標籤、延後、結束會話。
 * 會開啟對話框的動作,等 sheet 完全關閉(onCloseAutoFocus)後才執行,避免兩層 Radix Dialog 搶焦點。
 */
export function MobileConversationActions(props: MobileConversationActionsProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("main");
  const pending = useRef<(() => void) | null>(null);

  const appliedTags = useQuery({
    queryKey: sessionTagsKey(props.sessionId),
    queryFn: () => conversationApi.listSessionTags(props.sessionId),
  });
  const appliedCount = appliedTags.data?.length ?? 0;

  /** 先關閉 sheet,關閉完成後再執行動作 */
  function run(action: () => void) {
    pending.current = action;
    setOpen(false);
  }

  const snoozedUntil = open ? findInboxSnoozedUntil(qc, props.sessionId) : null;

  async function doSnooze(minutes: number, label: string) {
    setOpen(false);
    try {
      await snoozeSession(qc, props.sessionId, minutes);
      props.onNotice?.(t("mobile.conv.snoozedNotice", { defaultValue: "已延後 {{duration}}", duration: label }));
    } catch {
      props.onError?.(t("mobile.conv.snoozeFailed", "延後失敗,請重試"));
    }
  }

  async function doUnsnooze() {
    setOpen(false);
    try {
      await unsnoozeSession(qc, props.sessionId);
      props.onNotice?.(t("mobile.conv.unsnoozedNotice", "已取消延後"));
    } catch {
      props.onError?.(t("mobile.conv.snoozeFailed", "延後失敗,請重試"));
    }
  }

  const title =
    view === "snooze"
      ? t("conv.durationTitle", { defaultValue: "延後多久" })
      : view === "tags"
        ? t("workspace.sessionTags.label")
        : t("mobile.conv.moreActions", "更多操作");

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setView("main");
      }}
    >
      <SheetTrigger asChild>
        <Button size="icon" variant="ghost" className="size-10" aria-label={t("mobile.conv.moreActions", "更多操作")}>
          <MoreVertical className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          const action = pending.current;
          pending.current = null;
          if (action) {
            e.preventDefault();
            action();
          }
        }}
      >
        <SheetHeader className="flex-row items-center gap-1">
          {view !== "main" && (
            <Button
              size="icon"
              variant="ghost"
              className="-ms-2 size-10"
              onClick={() => setView("main")}
              aria-label={t("mobile.conv.backToActions", "返回")}
            >
              <ChevronLeft className="h-5 w-5 rtl:rotate-180" />
            </Button>
          )}
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>

        {view === "main" && (
          <div className="flex flex-col">
            <ActionRow
              icon={<Languages />}
              label={
                props.translateOn
                  ? t("workspace.conversationView.translateOff")
                  : t("workspace.conversationView.translateOn")
              }
              trailing={props.translateOn ? <Check className="h-4 w-4 text-brand" /> : undefined}
              disabled={props.translateBusy}
              onClick={() => run(props.onToggleTranslate)}
            />
            <ActionRow icon={<ArrowRightLeft />} label={t("workspace.transfer")} onClick={() => run(props.onTransfer)} />
            <ActionRow
              icon={<MessagesSquare />}
              label={t("collab.openPanel", { defaultValue: "旁支協作" })}
              onClick={() => run(props.onSideConversation)}
            />
            <ActionRow
              icon={<AtSign />}
              label={t("collab.mentionNote", { defaultValue: "@提及備註" })}
              trailing={props.mentionNoteOpen ? <Check className="h-4 w-4 text-brand" /> : undefined}
              onClick={() => run(props.onToggleMentionNote)}
            />
            <ActionRow
              icon={<Ticket />}
              label={t("workspace.createTicket", { defaultValue: "升級為工單" })}
              disabled={props.creatingTicket}
              onClick={() => run(props.onCreateTicket)}
            />
            <ActionRow icon={<ClipboardList />} label={t("workspace.summary")} onClick={() => run(props.onSummary)} />
            <ActionRow
              icon={<TagIcon />}
              label={t("workspace.sessionTags.label")}
              trailing={
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {appliedCount > 0 && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-[11px] font-semibold text-brand-foreground">
                      {appliedCount}
                    </span>
                  )}
                  <ChevronRight className="h-4 w-4 rtl:rotate-180" />
                </span>
              }
              onClick={() => setView("tags")}
            />
            <ActionRow
              icon={<AlarmClock />}
              label={t("conv.snoozeTooltip", { defaultValue: "稍後處理(延後)" })}
              trailing={
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {snoozedUntil &&
                    t("conv.snoozedUntil", { defaultValue: "已延後至 {{time}}", time: hhmm(snoozedUntil) })}
                  <ChevronRight className="h-4 w-4 rtl:rotate-180" />
                </span>
              }
              disabled={props.isClosed}
              onClick={() => setView("snooze")}
            />
            <div className="my-1 h-px bg-border" />
            <ActionRow
              icon={<XCircle />}
              label={t("workspace.close")}
              destructive
              onClick={() => run(props.onCloseSession)}
            />
          </div>
        )}

        {view === "snooze" && (
          <div className="flex flex-col">
            {SNOOZE_DURATIONS.map((d) => {
              const label = t(d.key, { defaultValue: d.fallback });
              return (
                <ActionRow
                  key={d.minutes}
                  icon={<AlarmClock />}
                  label={label}
                  onClick={() => void doSnooze(d.minutes, label)}
                />
              );
            })}
            {snoozedUntil && (
              <>
                <div className="my-1 h-px bg-border" />
                <ActionRow
                  icon={<X />}
                  label={t("conv.unsnooze", { defaultValue: "取消延後" })}
                  destructive
                  onClick={() => void doUnsnooze()}
                />
              </>
            )}
          </div>
        )}

        {view === "tags" && <SessionTagsList sessionId={props.sessionId} />}
      </SheetContent>
    </Sheet>
  );
}

function ActionRow({
  icon,
  label,
  trailing,
  onClick,
  disabled,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex min-h-12 w-full select-none items-center gap-3 rounded-md px-2 text-start text-[15px] transition-colors hover:bg-accent active:bg-accent disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-5 [&>svg]:shrink-0",
        destructive ? "text-destructive" : "text-foreground [&>svg]:text-muted-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

/** sheet 版的會話標籤勾選(與桌面 SessionTags 共用查詢鍵,任一處變更即同步)。 */
function SessionTagsList({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const applied = useQuery({
    queryKey: sessionTagsKey(sessionId),
    queryFn: () => conversationApi.listSessionTags(sessionId),
  });
  const master = useQuery({
    queryKey: ["tags", "session"],
    queryFn: () => visitorApi.listTags() as Promise<Tag[]>,
  });
  const appliedIds = new Set((applied.data ?? []).map((tg) => tg.id));

  const toggle = useMutation({
    mutationFn: async (tag: Tag) => {
      if (appliedIds.has(tag.id)) await conversationApi.removeSessionTag(sessionId, tag.id);
      else await conversationApi.applySessionTag(sessionId, tag.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sessionTagsKey(sessionId) });
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["sessions-inbox"] });
    },
  });

  if (master.isLoading) {
    return <p className="px-2 py-3 text-sm text-muted-foreground">{t("workspace.loading")}</p>;
  }
  if ((master.data ?? []).length === 0) {
    return (
      <div className="px-2 py-3 text-sm text-muted-foreground">
        <p>{t("workspace.sessionTags.noMaster")}</p>
        <p className="mt-1 text-xs">{t("workspace.sessionTags.manageHint")}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {(master.data ?? []).map((tg) => {
        const on = appliedIds.has(tg.id);
        return (
          <button
            key={tg.id}
            type="button"
            onClick={() => toggle.mutate(tg)}
            disabled={toggle.isPending}
            aria-pressed={on}
            className={cn(
              "flex min-h-12 w-full items-center gap-3 rounded-md px-2 text-start text-[15px] hover:bg-accent active:bg-accent disabled:opacity-60",
              on && "font-medium",
            )}
          >
            <span
              className="h-3 w-3 shrink-0 rounded-full bg-brand"
              style={tg.color ? { backgroundColor: tg.color } : undefined}
            />
            <span className="min-w-0 flex-1 truncate">{tg.name}</span>
            {on && <Check className="h-5 w-5 shrink-0 text-brand" />}
          </button>
        );
      })}
    </div>
  );
}
