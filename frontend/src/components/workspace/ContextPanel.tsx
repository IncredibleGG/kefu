import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  User,
  Sparkles,
  BookOpen,
  History,
  Search,
  PanelRightClose,
  Ban,
  Smile,
  Meh,
  Frown,
  AlertTriangle,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Check,
  Footprints,
  ExternalLink,
  Loader2,
  Target,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useInsight, useKbHits, useCrmMutations, useTags, useVisitorTimeline } from "@/api/hooks";
import { searchApi, visitorApi } from "@/api/endpoints";
import { apiFetch } from "@/api/client";
import { fetchVisitorPageViews } from "@/api/pagetrail";
import { goalsApi, type Goal } from "@/api/goals";
import type { VisitorAiProfile, VisitorWithProfile } from "@/api/adapters";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import type { KbHit, Session, Visitor } from "@/types";

/** 情境面板分頁(手機 / 平板抽屜以網址 ?panel= 指定,見 ContextSheet)。 */
export const CONTEXT_TABS = ["info", "insight", "kb", "history", "trail", "search"] as const;
export type ContextTab = (typeof CONTEXT_TABS)[number];
export function isContextTab(v: unknown): v is ContextTab {
  return typeof v === "string" && (CONTEXT_TABS as readonly string[]).includes(v);
}

/** 桌面(≥ lg)右欄:可拖曳調寬的 aside,內容為共用的 ContextPanelBody。 */
export function ContextPanel({ session }: { session: Session }) {
  const { t } = useTranslation();
  const { rightPanelWidth, setRightPanelWidth, setRightPanelCollapsed } = useUi();

  // 拖曳調寬(左緣):改用 pointer 事件(滑鼠 / 觸控筆皆可);觸控為主的裝置隱藏把手
  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = rightPanelWidth;
      const onMove = (ev: PointerEvent) => setRightPanelWidth(startW + (startX - ev.clientX));
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [rightPanelWidth, setRightPanelWidth],
  );

  return (
    <aside
      className="relative flex w-(--rpw) shrink-0 flex-col border-l border-border bg-card"
      // 寬度走 CSS 變數(而非 inline width),讓抽屜 / 響應式樣式可沿用同一個值
      style={{ "--rpw": `${rightPanelWidth}px` } as React.CSSProperties}
    >
      {/* 拖曳把手 */}
      <div
        onPointerDown={onDragStart}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-brand/20 pointer-coarse:hidden"
        title={t("workspace.contextPanel.resizeTooltip")}
      />
      <ContextPanelBody
        session={session}
        onClose={() => setRightPanelCollapsed(true)}
        closeLabel={t("panel.collapse")}
        closeIcon={<PanelRightClose className="h-4 w-4" />}
      />
    </aside>
  );
}

/**
 * 情境面板本體(分頁列 + 內容),由桌面 aside、平板抽屜、手機底部 sheet 共用。
 * - 未傳 tab 時為非受控(預設 info,與桌面原行為相同);傳 tab 時由外部(網址)控制。
 * - layout="sheet":分頁常駐顯示文字且可橫向捲動(手機);"panel":標籤僅 xl 顯示(桌面原樣)。
 */
export function ContextPanelBody({
  session,
  tab,
  onTabChange,
  onClose,
  closeLabel,
  closeIcon,
  layout = "panel",
  className,
}: {
  session: Session;
  tab?: ContextTab;
  onTabChange?: (tab: ContextTab) => void;
  onClose?: () => void;
  closeLabel?: string;
  closeIcon?: React.ReactNode;
  layout?: "panel" | "sheet";
  className?: string;
}) {
  const { t } = useTranslation();
  const sheet = layout === "sheet";
  const tabsState =
    tab !== undefined
      ? { value: tab, onValueChange: (v: string) => isContextTab(v) && onTabChange?.(v) }
      : { defaultValue: "info" };

  return (
    <Tabs {...tabsState} className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center gap-1 border-b border-border p-2">
        <TabsList
          className={cn(
            "h-8 flex-1 justify-start gap-0.5 bg-transparent p-0 pointer-coarse:h-10",
            sheet && "min-w-0 overflow-x-auto scrollbar-none",
          )}
        >
          <PanelTab value="info" icon={<User className="h-3.5 w-3.5" />} label={t("panel.info")} sheet={sheet} />
          <PanelTab value="insight" icon={<Sparkles className="h-3.5 w-3.5" />} label={t("panel.insight")} sheet={sheet} />
          <PanelTab value="kb" icon={<BookOpen className="h-3.5 w-3.5" />} label={t("panel.kb")} sheet={sheet} />
          <PanelTab value="history" icon={<History className="h-3.5 w-3.5" />} label={t("panel.history")} sheet={sheet} />
          <PanelTab
            value="trail"
            icon={<Footprints className="h-3.5 w-3.5" />}
            label={t("pagetrail.tab", { defaultValue: "瀏覽軌跡" })}
            sheet={sheet}
          />
          {/* 桌面只顯示圖示;手機 sheet 補上文字標籤 */}
          <PanelTab
            value="search"
            icon={<Search className="h-3.5 w-3.5" />}
            label={sheet ? t("panel.search") : ""}
            sheet={sheet}
          />
        </TabsList>
        {onClose && (
          <SimpleTooltip label={closeLabel} side="left">
            <Button
              size="icon-sm"
              variant="ghost"
              className="pointer-coarse:size-10"
              onClick={onClose}
              aria-label={closeLabel}
            >
              {closeIcon}
            </Button>
          </SimpleTooltip>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <TabsContent value="info">
          <InfoTab session={session} />
        </TabsContent>
        <TabsContent value="insight">
          <InsightTab sessionId={session.id} />
        </TabsContent>
        <TabsContent value="kb">
          <KbTab sessionId={session.id} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab visitorId={session.visitor.id} />
        </TabsContent>
        <TabsContent value="trail">
          <PageTrailTab visitorId={session.visitor.id} />
        </TabsContent>
        <TabsContent value="search">
          <SearchTab />
        </TabsContent>
      </div>
    </Tabs>
  );
}

function PanelTab({
  value,
  icon,
  label,
  sheet,
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
  sheet?: boolean;
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn("gap-1 px-2 pointer-coarse:h-10 pointer-coarse:min-w-10", sheet && "shrink-0 px-3")}
    >
      {icon}
      {label && <span className={sheet ? undefined : "hidden xl:inline"}>{label}</span>}
    </TabsTrigger>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function InfoTab({ session }: { session: Session }) {
  const { t } = useTranslation();
  // session.visitor 已由 adapters 帶上 ai_profile / is_blocked(擴充欄位皆可選,可直接窄化)
  const v: VisitorWithProfile = session.visitor;
  return (
    <div>
      <Section title={t("panel.info")}>
        <dl className="space-y-1 text-sm">
          <Row k={t("workspace.contextPanel.fieldName")} val={v.display_name} />
          <Row k={t("workspace.contextPanel.fieldChannelId")} val={v.external_id ?? "—"} mono />
          <Row k={t("workspace.contextPanel.fieldRegion")} val={v.location ?? "—"} />
          <Row k={t("workspace.contextPanel.fieldDevice")} val={[v.os, v.browser].filter(Boolean).join(" · ") || "—"} />
        </dl>
      </Section>

      {v.contact && (
        <Section title={t("panel.crm")}>
          <div className="rounded-md border border-border p-2.5 text-sm">
            <div className="font-medium">{v.contact.name}</div>
            <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              <Row k="Email" val={v.contact.email ?? "—"} sm />
              <Row k={t("workspace.contextPanel.fieldPhone")} val={v.contact.phone ?? "—"} sm />
              <Row k={t("workspace.contextPanel.fieldCompany")} val={v.contact.company ?? "—"} sm />
              {v.contact.lifetime_value != null && (
                <Row k={t("workspace.contextPanel.fieldLifetimeValue")} val={`NT$ ${v.contact.lifetime_value.toLocaleString()}`} sm />
              )}
            </dl>
            {v.contact.note && <p className="mt-1.5 text-xs italic text-muted-foreground">{v.contact.note}</p>}
          </div>
        </Section>
      )}

      <AiProfileSection profile={v.ai_profile} />

      <CustomAttributes visitor={v} />

      <TagEditor visitorId={v.id} sessionId={session.id} initialTagIds={v.tags} />

      <GoalAchieveSection session={session} />

      <Separator className="my-3" />
      <BlacklistButton visitorId={v.id} initialBlocked={v.is_blocked ?? false} />
    </div>
  );
}

/**
 * 標記目標達成:列出本租戶「手動型 + 啟用中」的目標,坐席點選即以當前會話 / 訪客
 * 呼叫 goalsApi.achieve(goalId, {session_id, visitor_id})(後端歸因當前坐席),
 * 成功以行內即時回饋(勾號 + 短暫「已標記達成」)取代 toast(專案無 toast 基建)。
 * 無手動型目標則不顯示此入口(避免空區塊)。goals 查詢與設定頁共用快取鍵 ["goals"]。
 */
function GoalAchieveSection({ session }: { session: Session }) {
  const { t } = useTranslation();
  const { data: goals, isLoading } = useQuery({
    queryKey: ["goals"],
    queryFn: () => goalsApi.list(),
  });

  const [achievingId, setAchievingId] = useState<string | null>(null);
  const [achievedId, setAchievedId] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const manualGoals = (goals ?? []).filter((g) => g.kind === "manual" && g.is_active);

  if (isLoading) {
    return (
      <Section title={t("goals.achieve.sectionTitle", { defaultValue: "標記目標達成" })}>
        <Skeleton className="h-7 w-full" />
      </Section>
    );
  }
  // 無手動型目標:不顯示入口(url/event 型自動追蹤,不需坐席手動標記)
  if (manualGoals.length === 0) return null;

  async function achieve(g: Goal) {
    if (achievingId) return;
    setError(false);
    setAchievingId(g.id);
    try {
      await goalsApi.achieve(g.id, {
        session_id: session.id,
        visitor_id: session.visitor.id,
      });
      setAchievedId(g.id);
      // 2 秒後自動收起成功狀態(僅收起本次;避免蓋掉後續其他目標的回饋)
      setTimeout(() => setAchievedId((cur) => (cur === g.id ? null : cur)), 2000);
    } catch {
      setError(true);
    } finally {
      setAchievingId(null);
    }
  }

  return (
    <Section title={t("goals.achieve.sectionTitle", { defaultValue: "標記目標達成" })}>
      <div className="flex flex-wrap gap-1.5">
        {manualGoals.map((g) => (
          <Button
            key={g.id}
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            disabled={achievingId !== null}
            onClick={() => achieve(g)}
            title={t("goals.achieve.buttonTitle", { defaultValue: "為當前會話標記此目標達成" })}
          >
            {achievedId === g.id ? (
              <Check className="h-3 w-3 text-success" />
            ) : achievingId === g.id ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Target className="h-3 w-3 text-brand" />
            )}
            {g.name}
          </Button>
        ))}
      </div>
      {achievedId && (
        <p className="mt-1 flex items-center gap-1 text-xs text-success">
          <Check className="h-3 w-3" />
          {t("goals.achieve.success", { defaultValue: "已標記達成" })}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{t("common.error")}</p>}
    </Section>
  );
}

/** 情緒詞 → 圖示(容忍中/英與自由文字)。 */
function sentimentIcon(s: string) {
  const v = s.toLowerCase();
  if (s.includes("正") || v.includes("positive") || v.includes("happy"))
    return <Smile className="h-4 w-4 text-success" />;
  if (s.includes("負") || v.includes("negative") || v.includes("angry"))
    return <Frown className="h-4 w-4 text-destructive" />;
  return <Meh className="h-4 w-4 text-muted-foreground" />;
}

/**
 * AI 畫像:顯示 visitor.ai_profile(意圖/情緒/標籤/摘要)。
 * 資料由會話端點內嵌帶出,無獨立請求,故只需空狀態(尚未產生時)。
 */
function AiProfileSection({ profile }: { profile?: VisitorAiProfile }) {
  const { t } = useTranslation();
  return (
    <Section title={t("workspace.contextPanel.aiProfile", { defaultValue: "AI 畫像" })}>
      {!profile ? (
        <p className="text-xs text-muted-foreground">
          {t("workspace.contextPanel.aiProfileEmpty", { defaultValue: "尚未產生 AI 畫像" })}
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          {profile.intent && (
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">{t("panel.intent")}</span>
              <Badge variant="brand" className="truncate">
                {profile.intent}
              </Badge>
            </div>
          )}
          {profile.sentiment && (
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">{t("panel.sentiment")}</span>
              <span className="flex items-center gap-1 text-xs">
                {sentimentIcon(profile.sentiment)}
                {profile.sentiment}
              </span>
            </div>
          )}
          {profile.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {profile.tags.map((tg) => (
                <Badge key={tg} variant="secondary">
                  {tg}
                </Badge>
              ))}
            </div>
          )}
          {profile.summary && <p className="text-xs text-muted-foreground">{profile.summary}</p>}
        </div>
      )}
    </Section>
  );
}

/** AI 自動打標建議形狀(對齊後端 /ai/sessions/{id}/suggest-tags)。 */
type TagSuggestion = { name: string; tag_id: string | null };

/**
 * 標籤區:顯示已套用標籤(id→名稱由標籤主檔解析),並可從既有標籤挑選套用。
 * 套用走 visitorApi.applyTag(target_type='visitor'),成功後本地即時追加並失效 sessions 快取。
 *
 * AI 建議標籤:對本會話呼叫 /ai/sessions/{id}/suggest-tags,顯示建議。點一下即套用——
 * 對上既有 tag(帶 tag_id)直接走 applyTag;無 tag_id 者先以 visitorApi.createTag 建立再套用。
 */
function TagEditor({
  visitorId,
  sessionId,
  initialTagIds,
}: {
  visitorId: string;
  sessionId: string;
  initialTagIds: string[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: allTags, isLoading } = useTags();

  const [applied, setApplied] = useState<string[]>(initialTagIds);
  const [seed, setSeed] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(false);

  // AI 建議標籤
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [suggestError, setSuggestError] = useState(false);
  const [applyingName, setApplyingName] = useState<string | null>(null);

  // 訪客 / 會話切換 或 伺服器資料變動 → 重植入本地已套用清單並清空 AI 建議
  const seedKey = `${sessionId}:${visitorId}:${initialTagIds.join(",")}`;
  if (seedKey !== seed) {
    setSeed(seedKey);
    setApplied(initialTagIds);
    setPicking(false);
    setError(false);
    setSuggestions([]);
    setSuggestOpen(false);
    setSuggestError(false);
    setApplyingName(null);
    setLoadingSuggest(false);
  }

  const apply = useMutation({
    mutationFn: (tagId: string) => visitorApi.applyTag(tagId, "visitor", visitorId),
    onSuccess: (_data, tagId) => {
      setApplied((a) => (a.includes(tagId) ? a : [...a, tagId]));
      setPicking(false);
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: () => setError(true),
  });

  const tagName = (id: string) => allTags?.find((x) => x.id === id)?.name ?? id;
  const available = (allTags ?? []).filter((x) => !applied.includes(x.id));

  /** 開/關 AI 建議;首次開啟即抓取。 */
  async function toggleSuggest() {
    const next = !suggestOpen;
    setSuggestOpen(next);
    if (next && suggestions.length === 0 && !loadingSuggest) {
      setSuggestError(false);
      setLoadingSuggest(true);
      try {
        const r = await apiFetch<{ suggestions: TagSuggestion[] }>(
          `/api/v1/ai/sessions/${sessionId}/suggest-tags`,
        );
        setSuggestions(r?.suggestions ?? []);
      } catch {
        setSuggestError(true);
        setSuggestions([]);
      } finally {
        setLoadingSuggest(false);
      }
    }
  }

  /** 套用一則 AI 建議:對上既有 tag 直接套;無 tag_id 者先建 tag 再套。成功後從建議清單移除。 */
  async function applySuggestion(s: TagSuggestion) {
    if (applyingName) return;
    setApplyingName(s.name);
    setError(false);
    try {
      let tagId = s.tag_id;
      if (!tagId) {
        const created = (await visitorApi.createTag(s.name)) as { id: string };
        tagId = created.id;
        qc.invalidateQueries({ queryKey: ["tags"] }); // 讓新建 tag 名稱可被 badge 解析
      }
      await apply.mutateAsync(tagId);
      setSuggestions((list) => list.filter((x) => x.name !== s.name));
    } catch {
      setError(true);
    } finally {
      setApplyingName(null);
    }
  }

  // 已套用的既有 tag 不再重複建議
  const visibleSuggestions = suggestions.filter((s) => !(s.tag_id && applied.includes(s.tag_id)));

  return (
    <Section title={t("panel.tags")}>
      <div className="flex flex-wrap items-center gap-1.5">
        {applied.map((id) => (
          <Badge key={id} variant="secondary">
            {tagName(id)}
          </Badge>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => {
            setError(false);
            setPicking((p) => !p);
          }}
        >
          <Plus className="h-3 w-3" /> {t("workspace.contextPanel.addTag")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          aria-pressed={suggestOpen}
          onClick={toggleSuggest}
        >
          <Sparkles className="h-3 w-3 text-brand" />
          {t("aiassist.tags.button", { defaultValue: "AI 建議標籤" })}
        </Button>
      </div>
      {picking && (
        <div className="mt-1.5 rounded-md border border-border p-1.5">
          {isLoading ? (
            <Skeleton className="h-6 w-full" />
          ) : available.length === 0 ? (
            <p className="px-1 py-0.5 text-xs text-muted-foreground">
              {t("workspace.contextPanel.noTagsAvailable", { defaultValue: "沒有可用標籤" })}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {available.map((tg) => (
                <button
                  key={tg.id}
                  disabled={apply.isPending}
                  onClick={() => apply.mutate(tg.id)}
                  className="rounded border border-border px-1.5 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {tg.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* AI 建議標籤:點一下即套用(帶 tag_id 直接套;無者先建再套) */}
      {suggestOpen && (
        <div className="mt-1.5 rounded-md border border-dashed border-brand/40 bg-brand/5 p-1.5">
          {loadingSuggest ? (
            <p className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("aiassist.tags.loading", { defaultValue: "AI 分析中…" })}
            </p>
          ) : suggestError ? (
            <p className="px-1 py-0.5 text-xs text-destructive">
              {t("aiassist.tags.failed", { defaultValue: "AI 建議失敗,請重試" })}
            </p>
          ) : visibleSuggestions.length === 0 ? (
            <p className="px-1 py-0.5 text-xs text-muted-foreground">
              {t("aiassist.tags.empty", { defaultValue: "暫無標籤建議" })}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {visibleSuggestions.map((s) => (
                <button
                  key={s.tag_id ?? `new:${s.name}`}
                  disabled={applyingName !== null || apply.isPending}
                  onClick={() => applySuggestion(s)}
                  title={
                    s.tag_id
                      ? t("aiassist.tags.applyExisting", { defaultValue: "套用既有標籤" })
                      : t("aiassist.tags.createAndApply", { defaultValue: "建立並套用新標籤" })
                  }
                  className="flex items-center gap-1 rounded border border-brand/40 px-1.5 py-0.5 text-xs text-brand hover:bg-brand/10 disabled:opacity-50"
                >
                  {applyingName === s.name ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : s.tag_id ? (
                    <Plus className="h-3 w-3" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{t("common.error")}</p>}
    </Section>
  );
}

/**
 * 黑名單按鈕:切換此渠道訪客身份封鎖狀態(visitorApi.block / unblock)。
 * 以 initialBlocked 植入本地狀態,成功後翻轉並失效 sessions 快取。
 */
function BlacklistButton({
  visitorId,
  initialBlocked,
}: {
  visitorId: string;
  initialBlocked: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { blockVisitor, unblockVisitor } = useCrmMutations();

  const [blocked, setBlocked] = useState(initialBlocked);
  const [seed, setSeed] = useState("");
  const [error, setError] = useState(false);

  const seedKey = `${visitorId}:${initialBlocked}`;
  if (seedKey !== seed) {
    setSeed(seedKey);
    setBlocked(initialBlocked);
    setError(false);
  }

  const pending = blockVisitor.isPending || unblockVisitor.isPending;

  async function toggle() {
    setError(false);
    try {
      if (blocked) {
        await unblockVisitor.mutateAsync(visitorId);
        setBlocked(false);
      } else {
        await blockVisitor.mutateAsync(visitorId);
        setBlocked(true);
      }
      qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch {
      setError(true);
    }
  }

  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        className={`w-full gap-1 ${blocked ? "" : "text-destructive"}`}
        onClick={toggle}
        disabled={pending}
      >
        <Ban className="h-3.5 w-3.5" />
        {blocked
          ? t("workspace.contextPanel.unblacklist", { defaultValue: "解除黑名單" })
          : t("workspace.contextPanel.blacklist")}
      </Button>
      {error && <p className="mt-1 text-xs text-destructive">{t("common.error")}</p>}
    </div>
  );
}

function Row({ k, val, mono, sm }: { k: string; val: string; mono?: boolean; sm?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className={sm ? "text-muted-foreground" : "text-muted-foreground"}>{k}</dt>
      <dd className={`truncate text-right ${mono ? "font-mono text-xs" : ""}`}>{val}</dd>
    </div>
  );
}

type KV = { k: string; v: string };

/**
 * 自訂屬性(CRM attributes):顯示真實資料 + 就地編輯 key-value。
 * 顯示來源為 visitor.custom(由 adapters 從關聯 Contact.attributes 對映);
 * 編輯需有關聯聯絡人(visitor.contact.id)方能 PATCH,故無關聯時僅顯示。
 * 工作台的 session.visitor 不會因 PATCH 自動重抓,故存檔後保留本地列以即時反映。
 */
function CustomAttributes({ visitor }: { visitor: Visitor }) {
  const { t } = useTranslation();
  const { updateContact } = useCrmMutations();
  const contactId = visitor.contact?.id;
  const custom = visitor.custom ?? {};

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<KV[]>([]);
  const [baseline, setBaseline] = useState<KV[]>([]);
  const [seed, setSeed] = useState("");
  const [saveError, setSaveError] = useState(false);

  // 切換訪客 / 伺服器資料變動 → 重植入本地列(以 id + 內容為指紋)
  const seedKey = `${visitor.id}:${JSON.stringify(custom)}`;
  if (seedKey !== seed) {
    const initial = Object.entries(custom).map(([k, v]) => ({ k, v }));
    setSeed(seedKey);
    setRows(initial);
    setBaseline(initial);
    setEditing(false);
    setSaveError(false);
  }

  async function save() {
    if (!contactId) return;
    setSaveError(false);
    const attributes: Record<string, string> = {};
    for (const { k, v } of rows) {
      const key = k.trim();
      if (key) attributes[key] = v;
    }
    try {
      // 僅送 attributes;後端 PATCH exclude_unset,不影響 name/email/phone/note
      await updateContact.mutateAsync({ id: contactId, body: { attributes } });
      const saved = Object.entries(attributes).map(([k, v]) => ({ k, v }));
      setRows(saved);
      setBaseline(saved);
      setEditing(false);
    } catch {
      setSaveError(true);
    }
  }

  function cancel() {
    setRows(baseline);
    setEditing(false);
    setSaveError(false);
  }

  return (
    <Section title={t("workspace.contextPanel.customAttributes")}>
      {editing ? (
        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                value={row.k}
                onChange={(e) =>
                  setRows((rs) => rs.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))
                }
                placeholder={t("contact.keyPlaceholder", { defaultValue: "欄位名稱" })}
                className="h-7 flex-1 text-xs"
              />
              <Input
                value={row.v}
                onChange={(e) =>
                  setRows((rs) => rs.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))
                }
                placeholder={t("contact.valuePlaceholder", { defaultValue: "值" })}
                className="h-7 flex-1 text-xs"
              />
              <Button
                size="icon-sm"
                variant="ghost"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                title={t("contact.removeField", { defaultValue: "刪除欄位" })}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => setRows((rs) => [...rs, { k: "", v: "" }])}
          >
            <Plus className="h-3 w-3" /> {t("contact.addField", { defaultValue: "新增欄位" })}
          </Button>
          {saveError && <p className="text-xs text-destructive">{t("common.error")}</p>}
          <div className="flex justify-end gap-1.5 pt-1">
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={cancel}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={save}
              disabled={updateContact.isPending}
            >
              {updateContact.isPending ? t("modules.visitors.saving") : t("modules.visitors.save")}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          {rows.length > 0 ? (
            <dl className="space-y-1 text-sm">
              {rows.map((row) => (
                <Row key={row.k} k={row.k} val={row.v} />
              ))}
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("contact.noCustom", { defaultValue: "尚無自訂欄位" })}
            </p>
          )}
          {contactId && (
            <Button
              size="sm"
              variant="outline"
              className="mt-1.5 h-6 gap-1 px-2 text-xs"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3 w-3" /> {t("contact.edit", { defaultValue: "編輯" })}
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

function InsightTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useInsight(sessionId);
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data) return <p className="text-sm text-muted-foreground">{t("common.empty")}</p>;

  const sentimentIcon = {
    positive: <Smile className="h-4 w-4 text-success" />,
    neutral: <Meh className="h-4 w-4 text-muted-foreground" />,
    negative: <Frown className="h-4 w-4 text-destructive" />,
  }[data.sentiment];

  return (
    <div>
      <Section title={t("panel.intent")}>
        <Badge variant="brand">{data.intent}</Badge>
      </Section>
      <Section title={t("panel.sentiment")}>
        <div className="flex items-center gap-1.5 text-sm">
          {sentimentIcon}
          {
            {
              positive: t("workspace.contextPanel.sentimentPositive"),
              neutral: t("workspace.contextPanel.sentimentNeutral"),
              negative: t("workspace.contextPanel.sentimentNegative"),
            }[data.sentiment]
          }
        </div>
      </Section>
      <Section title={t("workspace.contextPanel.summary")}>
        <p className="text-sm text-muted-foreground">{data.summary}</p>
      </Section>
      <Section title={t("panel.suggestedActions")}>
        <ul className="space-y-1">
          {data.suggested_actions.map((a) => (
            <li key={a} className="flex items-start gap-1.5 text-sm">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
              {a}
            </li>
          ))}
        </ul>
      </Section>
      {data.risk && (
        <div className="flex items-start gap-1.5 rounded-md bg-warning/10 p-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <b>{t("panel.risk")}:</b> {data.risk}
          </span>
        </div>
      )}
    </div>
  );
}

function KbTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useKbHits(sessionId);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError) return <p className="text-sm text-destructive">{t("common.error")}</p>;
  if (!data || data.length === 0) return <p className="text-sm text-muted-foreground">{t("common.empty")}</p>;
  return (
    <div className="space-y-2">
      {data.map((hit) => (
        <KbHitCard key={hit.id} hit={hit} />
      ))}
    </div>
  );
}

/**
 * 知識庫命中卡:命中內容以「複製」按鈕帶進剪貼簿(輸入框注入需跨元件橋接,
 * 本面板採用複製路徑,坐席貼進輸入框即可)。
 */
function KbHitCard({ hit }: { hit: KbHit }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(hit.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪貼簿不可用時靜默忽略(無 https / 權限);不阻斷面板 */
    }
  }

  return (
    <div className="group rounded-md border border-border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{hit.title}</span>
        <Badge variant="secondary">{Math.round(hit.score * 100)}%</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</p>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">{hit.collection}</span>
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs text-brand" onClick={copy}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied
            ? t("workspace.contextPanel.copied", { defaultValue: "已複製" })
            : t("workspace.contextPanel.copyKb", { defaultValue: "複製" })}
        </Button>
      </div>
    </div>
  );
}

/**
 * 歷史:呼叫 visitorApi.getTimeline(visitor timeline API),顯示該訪客近期會話軌跡
 * (來源渠道 + 各會話狀態 / 處理方 / 建立時間)。空/載入/錯誤齊全。
 */
function HistoryTab({ visitorId }: { visitorId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useVisitorTimeline(visitorId);

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError) return <p className="text-sm text-destructive">{t("common.error")}</p>;

  const sessions = data?.sessions ?? [];
  if (sessions.length === 0)
    return <p className="text-sm text-muted-foreground">{t("common.empty")}</p>;

  const channelName =
    data?.source.channel_name ??
    data?.source.channel_type ??
    t("workspace.contextPanel.channelWeb");

  const statusLabel = (s: string) =>
    ({
      open: t("workspace.contextPanel.historyStatusOpen", { defaultValue: "進行中" }),
      queued: t("workspace.contextPanel.historyStatusQueued", { defaultValue: "排隊中" }),
      closed: t("workspace.contextPanel.historyStatusClosed", { defaultValue: "已結束" }),
    })[s] ?? s;

  const handlerLabel = (h: string) =>
    h === "ai"
      ? "AI"
      : h === "human"
        ? t("workspace.contextPanel.handlerHuman", { defaultValue: "人工" })
        : h;

  const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

  return (
    <div className="space-y-2">
      {sessions.map((h) => (
        <div key={h.id} className="rounded-md border border-border p-2.5 text-sm hover:bg-accent">
          <div className="flex justify-between gap-2">
            <span className="font-medium">{statusLabel(h.status)}</span>
            <span className="text-xs text-muted-foreground">{fmtDate(h.created_at)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {channelName} · {handlerLabel(h.handler_type)}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * 瀏覽軌跡(page trail):顯示訪客最近瀏覽的頁面(標題 / url / 時間,倒序)。
 * 資料來源 fetchVisitorPageViews → GET /api/v1/channel/visitors/{id}/pageviews。
 * url 為訪客端上報,渲染前僅允許 http(s) 開啟(擋 javascript: 等),外連加 noopener。
 * 空 / 載入 / 錯誤齊全。
 */
function PageTrailTab({ visitorId }: { visitorId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["pagetrail", visitorId],
    queryFn: () => fetchVisitorPageViews(visitorId),
    enabled: !!visitorId,
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError)
    return (
      <p className="text-sm text-destructive">
        {t("pagetrail.error", { defaultValue: "載入瀏覽軌跡失敗" })}
      </p>
    );

  const items = data?.pageviews ?? [];
  if (items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {t("pagetrail.empty", { defaultValue: "尚無瀏覽記錄" })}
      </p>
    );

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
  const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };

  return (
    <div className="space-y-2">
      {items.map((p) => {
        const href = safeHref(p.url);
        return (
          <div key={p.id} className="rounded-md border border-border p-2.5 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="truncate font-medium">
                {p.title || t("pagetrail.untitled", { defaultValue: "(無標題)" })}
              </span>
              {href && (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-muted-foreground hover:text-brand"
                  title={p.url}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground" title={p.url}>
              {p.url}
            </p>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span className="truncate">{hostOf(p.url)}</span>
              <span className="shrink-0">{fmt(p.occurred_at)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 搜尋:呼叫 searchApi.query(全域搜尋,type=all)。輸入去抖動 300ms,分組顯示
 * 訊息 / 會話 / 聯絡人。未輸入顯示提示;載入 / 空 / 錯誤齊全。
 */
function SearchTab() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const enabled = debounced.length > 0;
  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ["panelSearch", debounced],
    queryFn: () => searchApi.query(debounced, "all"),
    enabled,
  });

  const total = data
    ? data.messages.length + data.sessions.length + data.contacts.length
    : 0;

  return (
    <div>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("workspace.contextPanel.searchMessagesPlaceholder")}
          className="pl-8"
        />
      </div>

      {!enabled ? (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t("workspace.contextPanel.searchHint")}
        </p>
      ) : isLoading || isFetching ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">{t("common.error")}</p>
      ) : total === 0 || !data ? (
        <p className="mt-4 text-center text-xs text-muted-foreground">{t("common.empty")}</p>
      ) : (
        <div className="space-y-3">
          {data.messages.length > 0 && (
            <SearchGroup title={t("workspace.contextPanel.searchMessages", { defaultValue: "訊息" })}>
              {data.messages.map((m) => (
                <div key={m.id} className="rounded-md border border-border p-2 text-xs">
                  <p className="line-clamp-2">{m.snippet}</p>
                  {m.created_at && (
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(m.created_at).toLocaleString()}
                    </span>
                  )}
                </div>
              ))}
            </SearchGroup>
          )}
          {data.sessions.length > 0 && (
            <SearchGroup title={t("workspace.contextPanel.searchSessions", { defaultValue: "會話" })}>
              {data.sessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-xs">
                  <span className="truncate font-medium">
                    {s.visitor_name ?? s.visitor_external_id ?? s.visitor_id}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{s.status}</span>
                </div>
              ))}
            </SearchGroup>
          )}
          {data.contacts.length > 0 && (
            <SearchGroup title={t("workspace.contextPanel.searchContacts", { defaultValue: "聯絡人" })}>
              {data.contacts.map((c) => (
                <div key={c.id} className="rounded-md border border-border p-2 text-xs">
                  <span className="font-medium">{c.name ?? "—"}</span>
                  {c.email && <span className="ml-1 text-muted-foreground">{c.email}</span>}
                </div>
              ))}
            </SearchGroup>
          )}
        </div>
      )}
    </div>
  );
}

function SearchGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h5>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
