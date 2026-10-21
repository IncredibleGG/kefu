/** 旁支協作會話面板(W6 自建):在主會話旁開/看對內或對第三方的討論串,並管理協作者。
 *  另匯出可重用的 MentionInput(支援 `@` 觸發坐席選單),供本面板發訊與 ConversationView
 *  的私密備註共用。所有資料走 collabApi(/api/v1/collab),i18n 一律 t(key,{defaultValue})。 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessagesSquare,
  Users,
  Plus,
  ArrowLeft,
  Send,
  StickyNote,
  X,
  Building2,
  UserPlus,
  Trash2,
  AtSign,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, initials } from "@/lib/utils";
import {
  collabApi,
  type MentionRef,
  type MentionableStaff,
  type ParticipantRole,
  type SideConversation,
  type SideKind,
} from "@/api/collab";

/* ============ 本地 query keys(不動共用 hooks.ts) ============ */
const ck = {
  side: (sid: string) => ["collab", "side", sid] as const,
  sideMessages: (id: string) => ["collab", "sideMessages", id] as const,
  participants: (sid: string) => ["collab", "participants", sid] as const,
};

/* ============ @提及輸入框(可重用) ============ */

/** 找出游標前正在輸入的 @token(前面須為字串開頭或空白),回其 query 與 `@` 索引。 */
function activeMentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(upto);
  if (!m) return null;
  const token = m[2];
  return { query: token, start: caret - token.length - 1 };
}

/**
 * 支援 `@` 提及的多行輸入框。輸入 `@` 觸發坐席下拉(mentionable 端點),選取後把
 * `@顯示名 ` 併入純文字並記下該坐席 id。Enter 送出(Shift+Enter 換行;下拉開啟時 Enter 選第一項)。
 * 送出時回傳 (內容文字, 仍被提及的坐席清單)。
 */
export function MentionInput({
  onSend,
  placeholder,
  submitLabel,
  disabled,
  busy,
  tone = "default",
}: {
  onSend: (content: string, mentions: MentionRef[]) => void | Promise<void>;
  placeholder?: string;
  submitLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  tone?: "default" | "note";
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<MentionRef[]>([]);
  const [menuStart, setMenuStart] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<MentionableStaff[]>([]);
  const caretRef = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 下拉開啟時,依 query 去抖動查可提及坐席
  useEffect(() => {
    if (menuStart === null) {
      setSuggestions([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      collabApi
        .mentionable(query || undefined)
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [menuStart, query]);

  function syncMenu(value: string, caret: number) {
    const active = activeMentionQuery(value, caret);
    if (active) {
      setMenuStart(active.start);
      setQuery(active.query);
    } else {
      setMenuStart(null);
      setQuery("");
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    const caret = e.target.selectionStart ?? value.length;
    caretRef.current = caret;
    setText(value);
    syncMenu(value, caret);
  }

  function trackCaret(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    const caret = e.currentTarget.selectionStart ?? 0;
    caretRef.current = caret;
    syncMenu(e.currentTarget.value, caret);
  }

  function pick(s: MentionableStaff) {
    if (menuStart === null) return;
    const caret = caretRef.current;
    const before = text.slice(0, menuStart);
    const after = text.slice(caret);
    const insert = `@${s.display_name} `;
    const next = before + insert + after;
    setText(next);
    setMentions((prev) =>
      prev.some((m) => m.staff_id === s.id)
        ? prev
        : [...prev, { staff_id: s.id, display_name: s.display_name }],
    );
    setMenuStart(null);
    setQuery("");
    setSuggestions([]);
    const pos = (before + insert).length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
        caretRef.current = pos;
      }
    });
  }

  function submit() {
    const content = text.trim();
    if (!content) return;
    // 只保留內容中仍存在 @名字 的提及,避免使用者刪字後殘留
    const used = mentions.filter((m) => content.includes(`@${m.display_name}`));
    void onSend(content, used);
    setText("");
    setMentions([]);
    setMenuStart(null);
    setQuery("");
    setSuggestions([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && menuStart !== null) {
      e.preventDefault();
      setMenuStart(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (menuStart !== null && suggestions.length > 0) {
        e.preventDefault();
        pick(suggestions[0]);
        return;
      }
      e.preventDefault();
      submit();
    }
  }

  const menuOpen = menuStart !== null && suggestions.length > 0;

  return (
    <div className="relative">
      {/* @提及下拉(顯示於輸入框上方) */}
      {menuOpen && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <AtSign className="mr-1 inline h-3 w-3" />
            {t("collab.mention.hint", { defaultValue: "選擇要提及的同事" })}
          </div>
          <div className="max-h-52 overflow-y-auto">
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
              >
                <Avatar className="h-6 w-6">
                  <AvatarFallback>{initials(s.display_name)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{s.display_name}</span>
                  {s.email && (
                    <span className="block truncate text-[10px] text-muted-foreground">{s.email}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={cn(
          "rounded-md border focus-within:ring-2 focus-within:ring-ring",
          tone === "note" ? "border-warning/50 bg-warning/10" : "border-input",
        )}
      >
        <Textarea
          ref={taRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          disabled={disabled}
          placeholder={placeholder ?? t("collab.mention.placeholder", { defaultValue: "輸入訊息,用 @ 提及同事…" })}
          className="min-h-[52px] resize-none border-0 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center gap-2 border-t border-border px-2 py-1">
          <span className="text-[10px] text-muted-foreground">
            {t("collab.mention.sendHint", { defaultValue: "Enter 送出 · Shift+Enter 換行 · @ 提及" })}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={submit}
            disabled={disabled || busy || !text.trim()}
            className={cn(tone === "note" && "bg-warning text-warning-foreground hover:bg-warning/90")}
          >
            {tone === "note" ? <StickyNote className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
            {submitLabel ?? t("collab.send", { defaultValue: "送出" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ============ 旁支協作會話面板 ============ */

export function SideConversationPanel({
  open,
  onOpenChange,
  sessionId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<SideConversation | null>(null);

  // 關閉面板時重置選取
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("collab.panel.title", { defaultValue: "旁支協作" })}</DialogTitle>
          <DialogDescription>
            {t("collab.panel.description", {
              defaultValue: "在主對話旁與團隊或第三方討論,並管理協作者;訪客看不到這裡的內容。",
            })}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="threads">
          <TabsList className="w-full">
            <TabsTrigger value="threads" className="flex-1 gap-1.5">
              <MessagesSquare className="h-3.5 w-3.5" />
              {t("collab.tab.threads", { defaultValue: "旁支討論" })}
            </TabsTrigger>
            <TabsTrigger value="participants" className="flex-1 gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {t("collab.tab.participants", { defaultValue: "協作者" })}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="threads">
            {selected ? (
              <SideThreadView
                side={selected}
                onBack={() => setSelected(null)}
                onClosed={() => {
                  qc.invalidateQueries({ queryKey: ck.side(sessionId) });
                }}
              />
            ) : (
              <SideThreadList
                sessionId={sessionId}
                onOpen={(s) => setSelected(s)}
              />
            )}
          </TabsContent>

          <TabsContent value="participants">
            <ParticipantsView sessionId={sessionId} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ 旁支列表 + 建立 ------------------------------ */

function SideThreadList({
  sessionId,
  onOpen,
}: {
  sessionId: string;
  onOpen: (s: SideConversation) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<SideKind>("internal");

  const sides = useQuery({
    queryKey: ck.side(sessionId),
    queryFn: () => collabApi.listSide(sessionId),
    enabled: !!sessionId,
  });

  const create = useMutation({
    mutationFn: () => collabApi.createSide(sessionId, { topic: topic.trim() || undefined, kind }),
    onSuccess: (s) => {
      setTopic("");
      qc.invalidateQueries({ queryKey: ck.side(sessionId) });
      onOpen(s);
    },
  });

  return (
    <div className="space-y-3">
      {/* 建立新旁支 */}
      <div className="space-y-2 rounded-md border border-border p-2.5">
        <div className="flex gap-1.5">
          <KindBtn active={kind === "internal"} onClick={() => setKind("internal")} icon={<Users className="h-3.5 w-3.5" />}>
            {t("collab.kind.internal", { defaultValue: "對內團隊" })}
          </KindBtn>
          <KindBtn active={kind === "external"} onClick={() => setKind("external")} icon={<Building2 className="h-3.5 w-3.5" />}>
            {t("collab.kind.external", { defaultValue: "對第三方" })}
          </KindBtn>
        </div>
        <div className="flex gap-1.5">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t("collab.topicPlaceholder", { defaultValue: "主題(選填),例:向物流確認到貨" })}
            className="h-8"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !create.isPending) create.mutate();
            }}
          />
          <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending} className="gap-1">
            <Plus className="h-3.5 w-3.5" />
            {t("collab.create", { defaultValue: "開新討論" })}
          </Button>
        </div>
      </div>

      {/* 旁支清單 */}
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {sides.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (sides.data ?? []).length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t("collab.empty", { defaultValue: "尚無旁支討論,於上方開一條新的。" })}
          </p>
        ) : (
          (sides.data ?? []).map((s) => (
            <button
              key={s.id}
              onClick={() => onOpen(s)}
              className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-2 text-left hover:bg-accent"
            >
              {s.kind === "external" ? (
                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {s.topic || t("collab.untitled", { defaultValue: "未命名討論" })}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {s.kind === "external"
                    ? t("collab.kind.external", { defaultValue: "對第三方" })
                    : t("collab.kind.internal", { defaultValue: "對內團隊" })}
                </span>
              </span>
              <Badge variant={s.status === "open" ? "default" : "outline"}>
                {s.status === "open"
                  ? t("collab.status.open", { defaultValue: "進行中" })
                  : t("collab.status.closed", { defaultValue: "已結束" })}
              </Badge>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------ 單一旁支討論串 ------------------------------ */

function SideThreadView({
  side,
  onBack,
  onClosed,
}: {
  side: SideConversation;
  onBack: () => void;
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const messages = useQuery({
    queryKey: ck.sideMessages(side.id),
    queryFn: () => collabApi.listSideMessages(side.id),
    enabled: !!side.id,
  });

  const send = useMutation({
    mutationFn: (input: { content: string; mentions: MentionRef[] }) =>
      collabApi.sendSideMessage(
        side.id,
        input.content,
        input.mentions.map((m) => m.staff_id),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ck.sideMessages(side.id) });
    },
  });

  const close = useMutation({
    mutationFn: () => collabApi.closeSide(side.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ck.sideMessages(side.id) });
      onClosed();
      onBack();
    },
  });

  const isOpen = side.status === "open";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label={t("collab.back", { defaultValue: "返回" })}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {side.topic || t("collab.untitled", { defaultValue: "未命名討論" })}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {side.kind === "external"
              ? t("collab.kind.external", { defaultValue: "對第三方" })
              : t("collab.kind.internal", { defaultValue: "對內團隊" })}
          </p>
        </div>
        {isOpen && (
          <Button size="sm" variant="outline" onClick={() => close.mutate()} disabled={close.isPending} className="gap-1">
            <X className="h-3.5 w-3.5" />
            {t("collab.closeThread", { defaultValue: "結束討論" })}
          </Button>
        )}
      </div>

      {/* 訊息流 */}
      <div className="h-56 space-y-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-2.5">
        {messages.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (messages.data ?? []).length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {t("collab.noMessages", { defaultValue: "還沒有訊息,發第一則吧。" })}
          </p>
        ) : (
          (messages.data ?? []).map((m) => (
            <div key={m.id} className="rounded-md bg-card px-2.5 py-1.5 shadow-sm">
              <p className="whitespace-pre-wrap break-words text-sm">{m.content}</p>
              {m.created_at && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {new Date(m.created_at).toLocaleString()}
                </p>
              )}
            </div>
          ))
        )}
      </div>

      {/* 發訊(支援 @提及);已結束則停用 */}
      {isOpen ? (
        <MentionInput
          onSend={(content, mentions) => send.mutate({ content, mentions })}
          busy={send.isPending}
          placeholder={t("collab.threadPlaceholder", { defaultValue: "回覆討論,用 @ 提及同事…" })}
        />
      ) : (
        <p className="rounded-md bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
          {t("collab.threadClosed", { defaultValue: "此討論已結束,無法再發訊。" })}
        </p>
      )}
    </div>
  );
}

/* ------------------------------ 協作者管理 ------------------------------ */

function ParticipantsView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [role, setRole] = useState<ParticipantRole>("collaborator");
  const [candidates, setCandidates] = useState<MentionableStaff[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const participants = useQuery({
    queryKey: ck.participants(sessionId),
    queryFn: () => collabApi.listParticipants(sessionId),
    enabled: !!sessionId,
  });

  // 搜尋可加入的坐席(去抖動)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      collabApi
        .mentionable(q.trim() || undefined)
        .then(setCandidates)
        .catch(() => setCandidates([]));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  const add = useMutation({
    mutationFn: (staffId: string) => collabApi.addParticipant(sessionId, staffId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ck.participants(sessionId) }),
  });
  const remove = useMutation({
    mutationFn: (staffId: string) => collabApi.removeParticipant(sessionId, staffId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ck.participants(sessionId) }),
  });

  const existingIds = new Set((participants.data ?? []).map((p) => p.staff_id));

  return (
    <div className="space-y-3">
      {/* 目前協作者 */}
      <div className="max-h-40 space-y-1 overflow-y-auto">
        {participants.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (participants.data ?? []).length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            {t("collab.noParticipants", { defaultValue: "尚無協作者" })}
          </p>
        ) : (
          (participants.data ?? []).map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
              <Avatar className="h-7 w-7">
                <AvatarFallback>{initials(p.display_name || "?")}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.display_name || p.staff_id}</p>
                {p.email && <p className="truncate text-[11px] text-muted-foreground">{p.email}</p>}
              </div>
              <Badge variant="outline">
                {p.role === "watcher"
                  ? t("collab.role.watcher", { defaultValue: "關注者" })
                  : t("collab.role.collaborator", { defaultValue: "協作者" })}
              </Badge>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(p.staff_id)}
                aria-label={t("collab.removeParticipant", { defaultValue: "移除" })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* 加入協作者 */}
      <div className="space-y-2 rounded-md border border-border p-2.5">
        <div className="flex gap-1.5">
          <KindBtn active={role === "collaborator"} onClick={() => setRole("collaborator")} icon={<UserPlus className="h-3.5 w-3.5" />}>
            {t("collab.role.collaborator", { defaultValue: "協作者" })}
          </KindBtn>
          <KindBtn active={role === "watcher"} onClick={() => setRole("watcher")} icon={<Users className="h-3.5 w-3.5" />}>
            {t("collab.role.watcher", { defaultValue: "關注者" })}
          </KindBtn>
        </div>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("collab.searchStaff", { defaultValue: "搜尋坐席以加入…" })}
          className="h-8"
        />
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {candidates
            .filter((c) => !existingIds.has(c.id))
            .map((c) => (
              <button
                key={c.id}
                onClick={() => add.mutate(c.id)}
                disabled={add.isPending}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-accent disabled:opacity-50"
              >
                <Avatar className="h-7 w-7">
                  <AvatarFallback>{initials(c.display_name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.display_name}</p>
                  {c.email && <p className="truncate text-[11px] text-muted-foreground">{c.email}</p>}
                </div>
                <Plus className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 小元件 ------------------------------ */

function KindBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
        active ? "border-brand bg-brand/10 text-brand" : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
