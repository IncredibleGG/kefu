import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Search, MessagesSquare, MessageSquareText, UserRound, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { searchApi } from "@/api/endpoints";
import { cn } from "@/lib/utils";
import type { SearchResults } from "@/types";

interface GlobalSearchProps {
  /** 附加到根節點(例如頂欄在手機版面以 max-md:hidden 隱藏) */
  className?: string;
  /** 掛載即聚焦輸入框(手機全螢幕搜尋) */
  autoFocus?: boolean;
  /** 點選結果並導頁後呼叫(供外層關閉搜尋面板) */
  onNavigate?: () => void;
  /** 結果以一般排版直接列在輸入框下方(全螢幕搜尋面板用),而非浮動下拉 */
  inline?: boolean;
}

/** 頂欄全域搜尋:接 GET /search,結果依 會話 / 訊息 / 聯絡人 分組,點擊跳轉。 */
export function GlobalSearch({ className, autoFocus, onNavigate, inline = false }: GlobalSearchProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 去抖動
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const { data, isFetching } = useQuery({
    queryKey: ["globalSearch", debounced],
    queryFn: () => searchApi.query(debounced, "all", 1, 8),
    enabled: debounced.length >= 1,
  });

  // 點擊外部關閉(inline 模式結果常駐,不需要)
  useEffect(() => {
    if (inline) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [inline]);

  function go(path: string) {
    setOpen(false);
    setQ("");
    navigate(path);
    onNavigate?.();
  }

  const sessions = data?.sessions ?? [];
  const messages = data?.messages ?? [];
  const contacts = data?.contacts ?? [];
  const empty = !isFetching && debounced.length >= 1 && !sessions.length && !messages.length && !contacts.length;

  // 手機全螢幕搜尋:輸入框固定在上方,結果在下方自行捲動
  if (inline) {
    return (
      <div ref={boxRef} className={cn("flex min-h-0 flex-1 flex-col gap-2", className)}>
        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            enterKeyHint="search"
            autoFocus={autoFocus}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("topbar.search")}
            aria-label={t("common.search")}
            className="h-11 ps-9 pe-9"
          />
          {isFetching && (
            <Loader2 className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {debounced.length < 1 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("mobile.search.hint", "輸入關鍵字搜尋會話、訊息與聯絡人")}
            </p>
          ) : (
            <ResultGroups
              empty={empty}
              sessions={sessions}
              messages={messages}
              contacts={contacts}
              go={go}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={boxRef} className={cn("relative max-w-md flex-1", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={t("topbar.search")}
        autoFocus={autoFocus}
        className="h-8 pl-8"
      />
      {isFetching && (
        <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}

      {open && debounced.length >= 1 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
          <ResultGroups empty={empty} sessions={sessions} messages={messages} contacts={contacts} go={go} />
        </div>
      )}
    </div>
  );
}

/** 搜尋結果分組清單(浮動下拉與全螢幕面板共用) */
function ResultGroups({
  empty,
  sessions,
  messages,
  contacts,
  go,
}: {
  empty: boolean;
  sessions: SearchResults["sessions"];
  messages: SearchResults["messages"];
  contacts: SearchResults["contacts"];
  go: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {empty && <p className="px-3 py-4 text-center text-sm text-muted-foreground">{t("layout.searchNoResults")}</p>}

      {sessions.length > 0 && (
        <Group label={t("layout.searchGroupSessions")} icon={<MessagesSquare className="h-3 w-3" />}>
          {sessions.map((s) => (
            <ResultRow
              key={`s-${s.id}`}
              title={s.visitor_name || s.visitor_external_id || t("layout.searchVisitorFallback")}
              sub={t("layout.searchSessionSub", { status: s.status })}
              onClick={() => go(`/workspace/${s.id}`)}
            />
          ))}
        </Group>
      )}

      {messages.length > 0 && (
        <Group label={t("layout.searchGroupMessages")} icon={<MessageSquareText className="h-3 w-3" />}>
          {messages.map((m) => (
            <ResultRow
              key={`m-${m.id}`}
              title={<Snippet text={m.snippet} />}
              sub={m.sender_type}
              onClick={() => go(`/workspace/${m.session_id}`)}
            />
          ))}
        </Group>
      )}

      {contacts.length > 0 && (
        <Group label={t("layout.searchGroupContacts")} icon={<UserRound className="h-3 w-3" />}>
          {contacts.map((c) => (
            <ResultRow
              key={`c-${c.id}`}
              title={c.name || t("layout.searchUnnamedContact")}
              sub={[c.email, c.phone].filter(Boolean).join(" · ") || undefined}
              onClick={() => go(`/visitors?contact=${c.id}`)}
            />
          ))}
        </Group>
      )}
    </>
  );
}

/** 手機全螢幕搜尋面板(TopBar 搜尋圖示開啟;點選結果導頁後自動關閉) */
export function MobileSearchSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="end"
        description={t("topbar.search")}
        className="w-full max-w-none overflow-hidden border-s-0"
      >
        <SheetHeader>
          <SheetTitle>{t("common.search")}</SheetTitle>
        </SheetHeader>
        <GlobalSearch inline autoFocus onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

function Group({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function ResultRow({
  title,
  sub,
  onClick,
}: {
  title: React.ReactNode;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-accent pointer-coarse:py-2.5"
    >
      <span className="w-full truncate text-sm">{title}</span>
      {sub && <span className="truncate text-[11px] text-muted-foreground">{sub}</span>}
    </button>
  );
}

/** 後端 snippet 以 [[命中]] 標記,渲染為高亮。 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return (
    <span className="text-sm">
      {parts.map((p, i) =>
        p.startsWith("[[") && p.endsWith("]]") ? (
          <mark key={i} className={cn("rounded bg-warning/30 px-0.5 text-foreground")}>
            {p.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}
