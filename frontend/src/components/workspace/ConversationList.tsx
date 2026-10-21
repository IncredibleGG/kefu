import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { Search, Bot, Tag as TagIcon, X, Check, AlarmClock, Clock, Eye, EyeOff, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { visitorApi } from "@/api/endpoints";
import { apiFetch } from "@/api/client";
import { agentSocket } from "@/api/realtime";
import { fetchChannelMap, mapSession, type RawPaged, type RawSession } from "@/api/adapters";
import { useNotify } from "@/stores/notify";
import { channelMeta } from "@/lib/channels";
import { cn, hhmm, initials, fmtDuration } from "@/lib/utils";
import type { Session, SessionTab, Tag } from "@/types";

/** 後端會話列摘要:含分流體驗欄位(mapSession 不保留,故直接由原始回應取用並疊加)。 */
type RawSessionFull = RawSession & {
  last_message_preview?: string | null;
  unread_count?: number;
  tags?: string[];
  snoozed_until?: string | null;
};

/** 會話列項目:前端 Session + 原始 status / snoozed_until(供延後標示與過濾)。 */
type InboxSession = Session & { rawStatus: string; snoozedUntil: string | null };

/** 延後時長選項(分鐘);手機對話頁的「⋯ 更多 → 延後」共用。 */
export const SNOOZE_DURATIONS: { minutes: number; key: string; fallback: string }[] = [
  { minutes: 30, key: "conv.duration30m", fallback: "30 分鐘" },
  { minutes: 60, key: "conv.duration1h", fallback: "1 小時" },
  { minutes: 180, key: "conv.duration3h", fallback: "3 小時" },
  { minutes: 1440, key: "conv.duration1d", fallback: "1 天" },
];

function invalidateSessionLists(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["sessions-inbox"] });
  qc.invalidateQueries({ queryKey: ["sessions"] });
}

/** 延後會話(稍後處理);無論成敗都刷新會話列。 */
export async function snoozeSession(qc: QueryClient, id: string, minutes: number): Promise<void> {
  try {
    await apiFetch(`/api/v1/conversation/sessions/${id}/snooze`, {
      method: "POST",
      body: { duration_minutes: minutes },
    });
  } finally {
    invalidateSessionLists(qc);
  }
}

/** 取消延後;無論成敗都刷新會話列。 */
export async function unsnoozeSession(qc: QueryClient, id: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/conversation/sessions/${id}/unsnooze`, {
      method: "POST",
      body: {},
    });
  } finally {
    invalidateSessionLists(qc);
  }
}

/** 從會話列快取(["sessions-inbox", …])找出某會話的延後到期時間;不在快取內回 null。 */
export function findInboxSnoozedUntil(qc: QueryClient, id: string): string | null {
  for (const [, data] of qc.getQueriesData<InfiniteData<{ items: InboxSession[] }>>({
    queryKey: ["sessions-inbox"],
  })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((s) => s.id === id);
      if (hit) return hit.snoozedUntil;
    }
  }
  return null;
}

const TABS: SessionTab[] = ["mine", "unassigned", "queue", "online"];
const PAGE_SIZE = 30;

/**
 * @param covered 手機上對話區疊在清單上方時為 true:清單保持掛載(保留捲動 / 分頁),
 *                但設為 inert,避免螢幕閱讀器與鍵盤焦點進入被蓋住的清單。
 */
export function ConversationList({ covered = false }: { covered?: boolean } = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const [tab, setTab] = useState<SessionTab>("mine");
  const [q, setQ] = useState("");
  // 去抖動後真正送給後端的關鍵字(避免逐字打 API)
  const [debouncedQ, setDebouncedQ] = useState("");
  const [tagFilter, setTagFilter] = useState<Tag>();
  const [showSnoozed, setShowSnoozed] = useState(true);
  const qc = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);

  // 搜尋去抖動:輸入停 300ms 才更新 debouncedQ → 觸發後端查詢
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const tags = useQuery({
    queryKey: ["tags", "session"],
    queryFn: () => visitorApi.listTags() as Promise<Tag[]>,
  });

  // 會話列主資料源:直接打 /sessions(帶 q / 分頁),取回含分流欄位的原始會話,
  // 以 mapSession 充實渠道/訪客後,疊加後端提供的 last_message_preview / unread / tags。
  // 走無限捲動(useInfiniteQuery),移除舊有「硬上限 30 不可達」。
  const sessionsQuery = useInfiniteQuery({
    queryKey: ["sessions-inbox", tab, debouncedQ, tagFilter?.id ?? ""],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const [raw, channelMap] = await Promise.all([
        apiFetch<RawPaged<RawSessionFull>>("/api/v1/conversation/sessions", {
          params: {
            tab,
            q: debouncedQ || undefined,
            page: pageParam,
            page_size: PAGE_SIZE,
            tag_id: tagFilter?.id,
          },
        }),
        fetchChannelMap().catch(() => new Map()),
      ]);
      const emptyVisitorMap = new Map();
      const items: InboxSession[] = (raw.items ?? []).map((s) => {
        const mapped = mapSession(s, { channelMap, visitorMap: emptyVisitorMap, tab });
        return {
          ...mapped,
          // 後端分流欄位疊加(mapSession 以空值佔位,不含真實內容)
          last_message_preview: s.last_message_preview ?? "",
          unread: s.unread_count ?? 0,
          tags: s.tags ?? [],
          rawStatus: s.status,
          // 已結束會話不視為延後(避免殘留舊的 snoozed_until 標示)
          snoozedUntil: s.status === "closed" ? null : s.snoozed_until ?? null,
        };
      });
      return {
        items,
        total: raw.total ?? items.length,
        page: raw.page ?? (pageParam as number),
      };
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? lastPage.page + 1 : undefined;
    },
    refetchInterval: 15_000,
  });

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = sessionsQuery;

  // 到期喚醒 / 接管 / 結束 / 新訊息等會影響列表的即時事件 → 刷新會話列(與 useSessions 快取)
  useEffect(() => {
    const off = agentSocket.onEvent((ev) => {
      if (
        [
          "session.opened",
          "session.snoozed",
          "handoff",
          "session.closed",
          "session.activity",
          "message.new",
          "session.new",
          "session.assigned",
          "session.handoff",
        ].includes(ev.type)
      ) {
        qc.invalidateQueries({ queryKey: ["sessions-inbox"] });
        qc.invalidateQueries({ queryKey: ["sessions"] });
      }
    });
    return () => {
      off();
    };
  }, [qc]);

  // 攤平所有已載入分頁,再依「顯示/隱藏已延後」過濾
  const allItems = sessionsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const items = allItems.filter((s) => showSnoozed || s.rawStatus !== "snoozed");

  // 捲到接近底部時自動載入更多(保留下方「載入更多」按鈕作為備援)
  function onListScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
    }
  }

  return (
    // 手機(< md)全寬;桌面維持 w-80。手機點會話後由 ConversationView 疊在上方(清單保持掛載)
    <div
      inert={covered || undefined}
      className="flex w-full shrink-0 flex-col border-r border-border bg-card md:w-80 max-md:border-r-0"
    >
      {/* Tabs */}
      <div className="p-2.5">
        <Tabs value={tab} onValueChange={(v) => setTab(v as SessionTab)}>
          <TabsList className="grid w-full grid-cols-4 pointer-coarse:h-12">
            {TABS.map((tb) => (
              <TabsTrigger key={tb} value={tb} className="max-md:min-w-0 pointer-coarse:h-10">
                {/* 手機上過長的語系(如德文)省略號截斷,不撐破四欄 */}
                <span className="max-md:min-w-0 max-md:truncate">{t(`workspace.tabs.${tb}`)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {/* 搜尋 + 標籤過濾 */}
      <div className="flex items-center gap-1.5 px-2.5 pb-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("workspace.searchPlaceholder")}
            className="h-8 pl-8 pr-7 pointer-coarse:h-10 pointer-coarse:pr-10"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label={t("conv.clearSearch", { defaultValue: "清除搜尋" })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground pointer-coarse:right-0 pointer-coarse:flex pointer-coarse:size-10 pointer-coarse:items-center pointer-coarse:justify-center"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="icon-sm"
              variant={tagFilter ? "default" : "outline"}
              aria-label={t("workspace.conversationList.filterByTag")}
              className="shrink-0 pointer-coarse:size-10"
            >
              <TagIcon className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-1">
            <div className="px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("workspace.conversationList.filterByTag")}
            </div>
            {tags.isLoading ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">{t("workspace.loading")}</p>
            ) : (tags.data ?? []).length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">{t("workspace.conversationList.noTags")}</p>
            ) : (
              <div className="max-h-56 overflow-y-auto">
                {(tags.data ?? []).map((tg) => (
                  <button
                    key={tg.id}
                    onClick={() => setTagFilter(tagFilter?.id === tg.id ? undefined : tg)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent pointer-coarse:py-2.5"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand"
                      style={tg.color ? { backgroundColor: tg.color } : undefined}
                    />
                    <span className="flex-1 truncate">{tg.name}</span>
                    {tagFilter?.id === tg.id && <Check className="h-3.5 w-3.5 text-brand" />}
                  </button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
        <SimpleTooltip
          label={
            showSnoozed
              ? t("conv.hideSnoozed", { defaultValue: "隱藏已延後" })
              : t("conv.showSnoozed", { defaultValue: "顯示已延後" })
          }
          side="bottom"
        >
          <Button
            size="icon-sm"
            variant={showSnoozed ? "outline" : "default"}
            className="shrink-0 pointer-coarse:size-10"
            aria-pressed={!showSnoozed}
            aria-label={
              showSnoozed
                ? t("conv.hideSnoozed", { defaultValue: "隱藏已延後" })
                : t("conv.showSnoozed", { defaultValue: "顯示已延後" })
            }
            onClick={() => setShowSnoozed((v) => !v)}
          >
            {showSnoozed ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        </SimpleTooltip>
      </div>
      {/* 已選標籤過濾條 */}
      {tagFilter && (
        <div className="flex items-center gap-1.5 px-2.5 pb-2">
          <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand pointer-coarse:py-0 pointer-coarse:pe-0 pointer-coarse:text-xs">
            <TagIcon className="h-3 w-3" />
            {tagFilter.name}
            {/* 觸控:清除鈕放大到 40px 點擊區(原 12px 難以點中) */}
            <button
              onClick={() => setTagFilter(undefined)}
              aria-label={t("workspace.conversationList.clearFilter")}
              className="pointer-coarse:flex pointer-coarse:size-10 pointer-coarse:items-center pointer-coarse:justify-center"
            >
              <X className="h-3 w-3 pointer-coarse:h-3.5 pointer-coarse:w-3.5" />
            </button>
          </span>
        </div>
      )}
      {/* 列表 */}
      <div ref={listRef} onScroll={onListScroll} className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-2 p-2.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : items.length > 0 ? (
          <>
            {items.map((s) => (
              <div key={s.id} className="group/row relative">
                <SessionRow
                  session={s}
                  active={s.id === sessionId}
                  onClick={() => navigate(`/workspace/${s.id}`)}
                  snoozedUntil={s.snoozedUntil}
                />
                {/* snooze 控制:overlay 為 row 按鈕的同層兄弟(避免巢狀 button)。
                    觸控裝置沒有懸停:改為常駐、垂直置中於列尾(列本身預留右側空間,不蓋住時間)。 */}
                <div className="absolute right-2 top-2 pointer-coarse:right-1 pointer-coarse:top-1/2 pointer-coarse:-translate-y-1/2">
                  <SnoozeControl
                    snoozed={!!s.snoozedUntil}
                    onSnooze={(m) => void snoozeSession(qc, s.id, m)}
                    onUnsnooze={() => void unsnoozeSession(qc, s.id)}
                  />
                </div>
              </div>
            ))}
            {/* 載入更多:自動捲動載入的備援按鈕 */}
            {hasNextPage && (
              <div className="p-2.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-1.5 pointer-coarse:h-10"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {isFetchingNextPage
                    ? t("conv.loadingMore", { defaultValue: "載入中…" })
                    : t("conv.loadMore", { defaultValue: "載入更多" })}
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
        )}
      </div>
    </div>
  );
}

/** 會話狀態徽章樣式(進行中 / 排隊中 / 已結束)。 */
function statusBadgeMeta(status: Session["status"]): { dot: string; cls: string; key: string; fallback: string } | null {
  switch (status) {
    case "open":
      return { dot: "bg-status-online", cls: "bg-status-online/12 text-status-online", key: "conv.statusOpen", fallback: "進行中" };
    case "waiting":
      return { dot: "bg-warning", cls: "bg-warning/15 text-warning", key: "conv.statusQueued", fallback: "排隊中" };
    case "closed":
      return { dot: "bg-muted-foreground", cls: "bg-muted text-muted-foreground", key: "conv.statusClosed", fallback: "已結束" };
    default:
      return null;
  }
}

function SessionRow({
  session,
  active,
  onClick,
  snoozedUntil,
}: {
  session: Session;
  active: boolean;
  onClick: () => void;
  snoozedUntil?: string | null;
}) {
  const { t } = useTranslation();
  const ch = channelMeta[session.channel];
  const ChIcon = ch.Icon;
  // 未讀數:優先取前端即時通知計數;為 0 時回退後端會話摘要的未讀數(重整後仍準)。
  // 正在檢視中的會話(active)視為已讀,不顯示徽章。
  const liveUnread = useNotify((s) => s.unread[session.id] ?? 0);
  const unread = active ? 0 : liveUnread || session.unread;
  const status = statusBadgeMeta(session.status);
  return (
    <button
      onClick={onClick}
      className={cn(
        // pointer-coarse:pr-12:為常駐的延後鈕(40px)預留列尾空間
        "flex w-full items-start gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors pointer-coarse:pr-12",
        active ? "border-brand bg-brand/8" : "border-transparent hover:bg-accent",
      )}
    >
      <div className="relative">
        <Avatar className="h-9 w-9">
          <AvatarFallback>{initials(session.visitor.display_name)}</AvatarFallback>
        </Avatar>
        {/* 渠道角標 */}
        <span
          className={cn(
            "absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-card bg-card",
            ch.color,
          )}
        >
          <ChIcon className="h-2.5 w-2.5" />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium">{session.visitor.display_name}</span>
          {session.handler_type !== "human" && (
            <Bot className="h-3.5 w-3.5 shrink-0 text-brand" aria-label={t("workspace.conversationList.aiTakeover")} />
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {hhmm(session.last_message_at)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <p className="truncate text-xs text-muted-foreground">
            {session.last_message_preview || (
              <span className="italic opacity-70">{t("conv.noMessages", { defaultValue: "尚無訊息" })}</span>
            )}
          </p>
          {unread > 0 && (
            <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {/* 會話狀態徽章:進行中 / 排隊中 / 已結束 */}
          {status && (
            <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium", status.cls)}>
              <StatusDot className={status.dot} />
              {session.status === "waiting" && session.waiting_seconds != null
                ? t("workspace.conversationList.waiting", { duration: fmtDuration(session.waiting_seconds) })
                : t(status.key, { defaultValue: status.fallback })}
            </span>
          )}
          {snoozedUntil && (
            <span className="inline-flex items-center gap-1 rounded bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info">
              <Clock className="h-3 w-3" />
              {t("conv.snoozedUntil", {
                defaultValue: "已延後至 {{time}}",
                time: hhmm(snoozedUntil),
              })}
            </span>
          )}
          {session.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

/** 會話列 snooze 控制:延後時長選單 + 取消延後。作為 row 按鈕的同層兄弟以避免巢狀 button。 */
function SnoozeControl({
  snoozed,
  onSnooze,
  onUnsnooze,
}: {
  snoozed: boolean;
  onSnooze: (minutes: number) => void;
  onUnsnooze: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon-sm"
          variant={snoozed ? "default" : "secondary"}
          className={cn(
            "h-6 w-6 shadow-sm transition-opacity pointer-coarse:size-10 pointer-coarse:opacity-100",
            snoozed || open ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
            // 觸控常駐顯示時,未延後的鈕用淡色無底,避免每列都是一顆實心按鈕
            !snoozed && "pointer-coarse:bg-transparent pointer-coarse:text-muted-foreground pointer-coarse:shadow-none",
          )}
          aria-label={t("conv.snoozeTooltip", { defaultValue: "稍後處理(延後)" })}
          onClick={(e) => e.stopPropagation()}
        >
          <AlarmClock className="h-3.5 w-3.5 pointer-coarse:h-4 pointer-coarse:w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1" onClick={(e) => e.stopPropagation()}>
        <div className="px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("conv.durationTitle", { defaultValue: "延後多久" })}
        </div>
        {SNOOZE_DURATIONS.map((d) => (
          <button
            key={d.minutes}
            onClick={(e) => {
              e.stopPropagation();
              onSnooze(d.minutes);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent pointer-coarse:py-2.5"
          >
            <AlarmClock className="h-3.5 w-3.5 text-muted-foreground" />
            {t(d.key, { defaultValue: d.fallback })}
          </button>
        ))}
        {snoozed && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUnsnooze();
              setOpen(false);
            }}
            className="mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-border px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent pointer-coarse:py-2.5"
          >
            <X className="h-3.5 w-3.5" />
            {t("conv.unsnooze", { defaultValue: "取消延後" })}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
