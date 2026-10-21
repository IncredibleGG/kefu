import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  User,
  UserRound,
  MessageSquare,
  Trash2,
  RefreshCw,
  Settings2,
  Download,
  Ticket as TicketIcon,
  CalendarClock,
  AlarmClock,
  BellOff,
  StickyNote,
  GitMerge,
  AlertTriangle,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { downloadFile } from "@/lib/download";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/api/client";
import { ticketApi, iamApi } from "@/api/endpoints";
import {
  CustomFieldInputs,
  FieldSettingsDialog,
  useFieldDefs,
} from "@/pages/settings/FieldSettings";
import type { FieldDefinition } from "@/api/fields";
import { timeAgo } from "@/lib/utils";
import type { StaffLite } from "@/types";

/* ------------------------------ 常數 / 型別 ------------------------------ */
const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const PAGE_SIZE = 20;
const STATUSES = ["open", "pending", "resolved", "closed"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
type TicketStatus = (typeof STATUSES)[number];
type TicketPriority = (typeof PRIORITIES)[number];

/** 對齊後端 ticket._serialize 的回應結構(ticketApi 未帶型別,此處就地定義)。 */
interface Ticket {
  id: string;
  title: string;
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  assignee_staff_id: string | null;
  contact_id: string | null;
  session_id: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  resolved_at: string | null;
  closed_at: string | null;
  due_at: string | null;
  snoozed_until: string | null;
  overdue: boolean;
  merged_into_ticket_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}
interface TicketList {
  items: Ticket[];
  total: number;
  page: number;
  size: number;
}
/** 對齊後端 ticket._serialize_note。 */
interface TicketNote {
  id: string;
  ticket_id: string;
  staff_id: string | null;
  body: string;
  created_at: string | null;
}
interface TicketNoteList {
  items: TicketNote[];
  total: number;
}

/** datetime-local 輸入值(本地時區,無秒)→ 後端 ISO;空字串回 null。 */
function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** 後端 ISO → datetime-local 輸入值(本地時區,yyyy-MM-ddTHH:mm);null 回空字串。 */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

type BadgeVariant = BadgeProps["variant"];
const STATUS_VARIANT: Record<TicketStatus, BadgeVariant> = {
  open: "info",
  pending: "warning",
  resolved: "success",
  closed: "secondary",
};
const PRIORITY_VARIANT: Record<TicketPriority, BadgeVariant> = {
  low: "secondary",
  normal: "outline",
  high: "warning",
  urgent: "destructive",
};

/** 工單狀態機:各狀態的合法後繼(對齊後端 ticket.py _TICKET_TRANSITIONS 守衛,
 *  不含冪等自轉;同狀態一律放行,故 UI 另把當前狀態併入可選項)。 */
const STATUS_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ["pending", "resolved", "closed"],
  pending: ["open", "resolved", "closed"],
  resolved: ["open", "pending", "closed"],
  closed: ["open"],
};

/** 找出未填的必填自訂欄位(FieldSettings 標 * 者);送出前驗證用,回傳未填欄位定義。 */
function missingRequiredFields(
  defs: FieldDefinition[],
  values: Record<string, unknown>,
): FieldDefinition[] {
  return defs.filter((f) => {
    if (!f.required) return false;
    const v = values[f.key];
    // 勾選型必填 = 必須為 true;其餘 = 非 null 且去空白後非空字串(數字 0 視為已填)
    if (f.field_type === "checkbox") return v !== true;
    return v == null || String(v).trim() === "";
  });
}

/* ================================ 主頁 ================================ */
/** 工單管理:列出 / 篩選 / 分頁 / 搜尋工單,開啟詳情改狀態與指派,或新建工單。 */
export function TicketsPage() {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [sortByDue, setSortByDue] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [fieldSettingsOpen, setFieldSettingsOpen] = useState(false);

  // 坐席清單:供指派下拉與 id → 名稱對照
  const staffQuery = useQuery({
    queryKey: ["iam", "staff"],
    queryFn: () => iamApi.staff(),
  });
  const staff = staffQuery.data ?? [];
  const staffMap = useMemo(
    () => new Map(staff.map((s) => [s.id, s.display_name] as const)),
    [staff],
  );

  const listQuery = useQuery({
    queryKey: ["tickets", statusFilter, priorityFilter, assigneeFilter, overdueOnly, sortByDue, page],
    queryFn: async () =>
      (await ticketApi.list({
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
        assignee_staff_id: assigneeFilter || undefined,
        overdue: overdueOnly ? "true" : undefined,
        order_by: sortByDue ? "due" : undefined,
        page,
        size: PAGE_SIZE,
      })) as TicketList,
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 後端列表無 q 參數,故搜尋於目前分頁就地過濾(標題 / 描述 / id)
  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return items;
    return items.filter(
      (it) =>
        it.title.toLowerCase().includes(kw) ||
        (it.description ?? "").toLowerCase().includes(kw) ||
        it.id.toLowerCase().includes(kw),
    );
  }, [items, q]);

  const resetPage = () => setPage(1);

  return (
    <PageShell
      title={t("tickets.title")}
      description={t("tickets.description")}
      actions={
        // 手機(< md):次要動作只留圖示(文字改為螢幕閱讀器可讀),主要動作「新建」保留文字
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="max-md:aspect-square max-md:px-0"
            onClick={() => setFieldSettingsOpen(true)}
          >
            <Settings2 className="h-4 w-4" />
            <span className="max-md:sr-only">{t("fields.settings.open", { defaultValue: "欄位設定" })}</span>
          </Button>
          <Button
            variant="outline"
            className="max-md:aspect-square max-md:px-0"
            onClick={() =>
              // 匯出帶入當前篩選(狀態 / 優先級 / 指派人),對齊後端 tickets.csv 支援的 query
              downloadFile("/api/v1/exports/tickets.csv", "tickets.csv", {
                status: statusFilter || undefined,
                priority: priorityFilter || undefined,
                assignee_staff_id: assigneeFilter || undefined,
              }).catch(() => {})
            }
          >
            <Download className="h-4 w-4" />
            <span className="max-md:sr-only">{t("common.exportCsv", { defaultValue: "匯出 CSV" })}</span>
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> {t("tickets.new")}
          </Button>
        </div>
      }
    >
      {/* 篩選列(手機:搜尋獨佔一列,下拉兩兩一列並撐滿) */}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="relative w-56 max-w-full max-md:w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("tickets.search")}
            className="h-9 pl-8"
          />
        </div>
        <div className="w-36 max-md:min-w-[45%] max-md:flex-1">
          <Label className="mb-1 block text-xs text-muted-foreground">{t("tickets.filters.status")}</Label>
          <select
            className={SELECT_CLS}
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              resetPage();
            }}
          >
            <option value="">{t("tickets.filters.all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`tickets.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="w-36 max-md:min-w-[45%] max-md:flex-1">
          <Label className="mb-1 block text-xs text-muted-foreground">{t("tickets.filters.priority")}</Label>
          <select
            className={SELECT_CLS}
            value={priorityFilter}
            onChange={(e) => {
              setPriorityFilter(e.target.value);
              resetPage();
            }}
          >
            <option value="">{t("tickets.filters.all")}</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`tickets.priority.${p}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="w-44 max-md:min-w-[45%] max-md:flex-1">
          <Label className="mb-1 block text-xs text-muted-foreground">{t("tickets.filters.assignee")}</Label>
          <select
            className={SELECT_CLS}
            value={assigneeFilter}
            onChange={(e) => {
              setAssigneeFilter(e.target.value);
              resetPage();
            }}
          >
            <option value="">{t("tickets.filters.all")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
        </div>
        {/* 逾期 / 到期排序切換 */}
        <div className="flex items-center gap-3 pb-1">
          <label className="flex cursor-pointer items-center gap-1.5 text-sm pointer-coarse:min-h-10">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={overdueOnly}
              onChange={(e) => {
                setOverdueOnly(e.target.checked);
                resetPage();
              }}
            />
            {t("tickets.filters.overdue", { defaultValue: "只看逾期" })}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm pointer-coarse:min-h-10">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={sortByDue}
              onChange={(e) => {
                setSortByDue(e.target.checked);
                resetPage();
              }}
            />
            {t("tickets.filters.sortByDue", { defaultValue: "依到期排序" })}
          </label>
        </div>
      </div>

      {/* 列表 */}
      {listQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : listQuery.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border py-12 text-sm text-muted-foreground">
          <p>{t("tickets.error")}</p>
          <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
            <RefreshCw className="h-4 w-4" /> {t("tickets.retry")}
          </Button>
        </div>
      ) : (
        <>
          {/* 手機(< md):卡片列表;表格只在 ≥ md 顯示 */}
          <TicketCardList rows={rows} staffMap={staffMap} onOpen={setOpenId} />
          <div className="overflow-hidden rounded-lg border border-border max-md:hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">{t("tickets.col.title")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t("tickets.col.status")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t("tickets.col.priority")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t("tickets.col.assignee")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t("tickets.col.due", { defaultValue: "到期" })}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t("tickets.col.relation")}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t("tickets.col.createdAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      <TicketIcon className="mx-auto mb-2 h-6 w-6 opacity-50" />
                      {t("tickets.empty")}
                    </td>
                  </tr>
                )}
                {rows.map((it) => (
                  <tr
                    key={it.id}
                    onClick={() => setOpenId(it.id)}
                    className="cursor-pointer hover:bg-accent"
                  >
                    <td className="px-4 py-2.5 font-medium">{it.title}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant={STATUS_VARIANT[it.status]}>{t(`tickets.status.${it.status}`)}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={PRIORITY_VARIANT[it.priority]}>{t(`tickets.priority.${it.priority}`)}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {it.assignee_staff_id ? (
                        <span className="inline-flex items-center gap-1">
                          <User className="h-3.5 w-3.5 text-muted-foreground" />
                          {staffMap.get(it.assignee_staff_id) ?? it.assignee_staff_id.slice(0, 8)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("tickets.unassigned")}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {it.due_at ? (
                        <div className="flex flex-col gap-0.5">
                          <span
                            className={
                              it.overdue
                                ? "inline-flex items-center gap-1 font-medium text-destructive"
                                : "inline-flex items-center gap-1 text-muted-foreground"
                            }
                          >
                            {it.overdue ? (
                              <AlertTriangle className="h-3.5 w-3.5" />
                            ) : (
                              <CalendarClock className="h-3.5 w-3.5" />
                            )}
                            {timeAgo(it.due_at)}
                          </span>
                          <span className="flex gap-1">
                            {it.overdue && (
                              <Badge variant="destructive">
                                {t("tickets.badge.overdue", { defaultValue: "逾期" })}
                              </Badge>
                            )}
                            {it.snoozed_until && new Date(it.snoozed_until) > new Date() && (
                              <Badge variant="secondary">
                                <BellOff className="h-3 w-3" />{" "}
                                {t("tickets.badge.snoozed", { defaultValue: "已延後" })}
                              </Badge>
                            )}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {it.session_id && (
                          <Badge variant="secondary" className="font-mono">
                            <MessageSquare className="h-3 w-3" /> {it.session_id.slice(0, 8)}
                          </Badge>
                        )}
                        {it.contact_id && (
                          <Badge variant="secondary" className="font-mono">
                            <UserRound className="h-3 w-3" /> {it.contact_id.slice(0, 8)}
                          </Badge>
                        )}
                        {!it.session_id && !it.contact_id && (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {it.created_at ? timeAgo(it.created_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* 分頁 */}
      {!listQuery.isLoading && !listQuery.isError && total > 0 && (
        <div className="mt-3 flex items-center justify-between text-sm max-md:gap-2">
          <span className="text-muted-foreground">
            {t("tickets.page.info", { page, totalPages, total })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {t("tickets.page.prev")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t("tickets.page.next")}
            </Button>
          </div>
        </div>
      )}

      <TicketDetailDialog
        ticketId={openId}
        staff={staff}
        onClose={() => setOpenId(null)}
      />
      <CreateTicketDialog
        open={createOpen}
        staff={staff}
        onClose={() => setCreateOpen(false)}
      />
      <FieldSettingsDialog
        open={fieldSettingsOpen}
        onClose={() => setFieldSettingsOpen(false)}
      />
    </PageShell>
  );
}

/* ========================== 手機卡片列表(< md) ========================== */
/** 手機版工單列表:取代 7 欄表格(只在 < md 渲染),點卡片開啟詳情。
 *  欄位取捨:標題 + 狀態為主,次列放優先級 / 指派人 / 到期 / 延後 / 建立時間;關聯 id 留在詳情。 */
function TicketCardList({
  rows,
  staffMap,
  onOpen,
}: {
  rows: Ticket[];
  staffMap: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border md:hidden">
      {rows.length === 0 && (
        <li className="px-4 py-12 text-center text-sm text-muted-foreground">
          <TicketIcon className="mx-auto mb-2 h-6 w-6 opacity-50" />
          {t("tickets.empty")}
        </li>
      )}
      {rows.map((it) => {
        const snoozed = !!it.snoozed_until && new Date(it.snoozed_until) > new Date();
        return (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => onOpen(it.id)}
              className="flex w-full flex-col gap-2 px-3 py-3 text-left text-sm transition-colors hover:bg-accent active:bg-accent"
            >
              <span className="flex w-full items-start justify-between gap-2">
                <span className="line-clamp-2 min-w-0 break-words font-medium">{it.title}</span>
                <Badge variant={STATUS_VARIANT[it.status]} className="shrink-0">
                  {t(`tickets.status.${it.status}`)}
                </Badge>
              </span>
              <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                <Badge variant={PRIORITY_VARIANT[it.priority]}>{t(`tickets.priority.${it.priority}`)}</Badge>
                <span className="inline-flex min-w-0 items-center gap-1">
                  <User className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {it.assignee_staff_id
                      ? staffMap.get(it.assignee_staff_id) ?? it.assignee_staff_id.slice(0, 8)
                      : t("tickets.unassigned")}
                  </span>
                </span>
                {it.due_at && (
                  <span
                    className={
                      it.overdue
                        ? "inline-flex items-center gap-1 font-medium text-destructive"
                        : "inline-flex items-center gap-1"
                    }
                  >
                    {it.overdue ? (
                      <AlertTriangle className="h-3.5 w-3.5" />
                    ) : (
                      <CalendarClock className="h-3.5 w-3.5" />
                    )}
                    {timeAgo(it.due_at)}
                    {it.overdue && (
                      <Badge variant="destructive">
                        {t("tickets.badge.overdue", { defaultValue: "逾期" })}
                      </Badge>
                    )}
                  </span>
                )}
                {snoozed && (
                  <Badge variant="secondary">
                    <BellOff className="h-3 w-3" />
                    {t("tickets.badge.snoozed", { defaultValue: "已延後" })}
                  </Badge>
                )}
                {it.created_at && <span className="ms-auto">{timeAgo(it.created_at)}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ============================== 詳情對話框 ============================== */
function TicketDetailDialog({
  ticketId,
  staff,
  onClose,
}: {
  ticketId: string | null;
  staff: StaffLite[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const staffMap = useMemo(
    () => new Map(staff.map((s) => [s.id, s.display_name] as const)),
    [staff],
  );

  const { data: ticket, isLoading, isError } = useQuery({
    queryKey: ["ticket", ticketId ?? "none"],
    queryFn: async () => (await ticketApi.get(ticketId!)) as Ticket,
    enabled: !!ticketId,
  });
  const fieldDefs = useFieldDefs("ticket").data ?? [];

  // 狀態 / 指派變更的行內錯誤回饋(專案無 toast 基建,沿用既有 text-destructive 慣例)
  const [actionError, setActionError] = useState<string | null>(null);

  /** 把後端錯誤映成可讀訊息(後端 422 非法流轉 message 為 TICKET_INVALID_TRANSITION)。 */
  function statusErrorMessage(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.message === "TICKET_INVALID_TRANSITION" || e.httpStatus === 422)
        return t("tickets.detail.statusInvalidTransition", {
          defaultValue: "無法切換到該狀態:不是目前狀態的合法流轉",
        });
      if (e.httpStatus === 403)
        return t("tickets.detail.statusForbidden", { defaultValue: "沒有權限變更工單狀態" });
    }
    return t("tickets.detail.statusError", { defaultValue: "狀態變更失敗,請稍後再試" });
  }

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tickets"] });
    if (ticketId) {
      qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      qc.invalidateQueries({ queryKey: ["ticket-notes", ticketId] });
    }
  };
  const statusMut = useMutation({
    mutationFn: (status: string) => ticketApi.setStatus(ticketId!, status),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (e) => setActionError(statusErrorMessage(e)),
  });
  const assignMut = useMutation({
    mutationFn: (assignee: string | null) => ticketApi.assign(ticketId!, assignee),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: () =>
      setActionError(t("tickets.detail.assignError", { defaultValue: "指派失敗,請稍後再試" })),
  });

  // 狀態下拉:僅列「當前狀態(冪等)+ 合法後繼」,避免選到必被後端拒絕的流轉
  const statusOptions = useMemo<TicketStatus[]>(() => {
    const cur = ticket?.status;
    if (!cur) return [];
    const allowed = new Set<TicketStatus>([cur, ...STATUS_TRANSITIONS[cur]]);
    return STATUSES.filter((s) => allowed.has(s));
  }, [ticket?.status]);
  const updateMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => ticketApi.update(ticketId!, body),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: () => ticketApi.remove(ticketId!),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  // 內部備註串
  const notesQuery = useQuery({
    queryKey: ["ticket-notes", ticketId ?? "none"],
    queryFn: async () => (await ticketApi.listNotes(ticketId!)) as TicketNoteList,
    enabled: !!ticketId,
  });
  const [noteBody, setNoteBody] = useState("");
  const addNoteMut = useMutation({
    mutationFn: (body: string) => ticketApi.addNote(ticketId!, body),
    onSuccess: () => {
      setNoteBody("");
      invalidate();
    },
  });

  // 延後(snooze)
  const [snoozeLocal, setSnoozeLocal] = useState("");
  const snoozeMut = useMutation({
    mutationFn: (until: string | null) => ticketApi.snooze(ticketId!, until),
    onSuccess: () => {
      setActionError(null);
      setSnoozeLocal("");
      invalidate();
    },
    onError: () =>
      setActionError(
        t("tickets.detail.snoozeError", { defaultValue: "延後失敗,請確認時間為未來" }),
      ),
  });

  // 合併
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeError, setMergeError] = useState<string | null>(null);
  const mergeMut = useMutation({
    mutationFn: (into: string) => ticketApi.merge(ticketId!, into),
    onSuccess: () => {
      setMergeError(null);
      setMergeTargetId("");
      invalidate();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.message === "TICKET_MERGE_SELF")
        setMergeError(
          t("tickets.detail.mergeSelfError", { defaultValue: "來源與目標不可為同一工單" }),
        );
      else
        setMergeError(
          t("tickets.detail.mergeError", {
            defaultValue: "合併失敗,請確認目標工單存在且同屬一租戶",
          }),
        );
    },
  });

  // 載入工單 → 帶入可編輯欄位(以 id 變更為準)
  const [initId, setInitId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("normal");
  const [attrs, setAttrs] = useState<Record<string, unknown>>({});
  const [dueLocal, setDueLocal] = useState("");
  if (ticket && ticket.id !== initId) {
    setInitId(ticket.id);
    setTitle(ticket.title);
    setDescription(ticket.description ?? "");
    setPriority(ticket.priority);
    setAttrs(ticket.attributes ?? {});
    setDueLocal(isoToLocalInput(ticket.due_at));
    setMergeTargetId("");
    setMergeError(null);
    setSnoozeLocal("");
    setActionError(null);
  }
  const missingRequired = missingRequiredFields(fieldDefs, attrs);

  return (
    <Dialog
      open={!!ticketId}
      onOpenChange={(v) => {
        if (!v) {
          setInitId(null);
          setActionError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("tickets.detail.title")}</DialogTitle>
          <DialogDescription>{t("tickets.detail.description")}</DialogDescription>
        </DialogHeader>

        {isLoading || !ticket ? (
          isError ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("tickets.error")}</p>
          ) : (
            <Skeleton className="h-64 w-full" />
          )
        ) : (
          <div className="space-y-3 text-sm">
            {/* 逾期橫幅 */}
            {ticket.overdue && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t("tickets.detail.overdue", { defaultValue: "此工單已逾期" })}
                {ticket.due_at && <span className="font-medium">({timeAgo(ticket.due_at)})</span>}
              </div>
            )}

            {/* 狀態 + 指派(即時套用);窄手機改單欄,下拉不被擠成半寬 */}
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <div className="space-y-1.5">
                <Label>{t("tickets.detail.changeStatus")}</Label>
                <select
                  className={SELECT_CLS}
                  value={ticket.status}
                  disabled={statusMut.isPending}
                  onChange={(e) => statusMut.mutate(e.target.value)}
                >
                  {statusOptions.map((s) => (
                    <option key={s} value={s}>
                      {t(`tickets.status.${s}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("tickets.detail.assignTo")}</Label>
                <select
                  className={SELECT_CLS}
                  value={ticket.assignee_staff_id ?? ""}
                  disabled={assignMut.isPending}
                  onChange={(e) => assignMut.mutate(e.target.value || null)}
                >
                  <option value="">{t("tickets.unassigned")}</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 狀態 / 指派變更失敗的行內提示 */}
            {actionError && <p className="text-xs text-destructive">{actionError}</p>}

            {/* 可編輯欄位 */}
            <div className="space-y-1.5">
              <Label htmlFor="tk-title">{t("tickets.form.title")}</Label>
              <Input id="tk-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tk-desc">{t("tickets.form.description")}</Label>
              <Textarea
                id="tk-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("tickets.form.descriptionPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tk-prio">{t("tickets.form.priority")}</Label>
              <select
                id="tk-prio"
                className={SELECT_CLS}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`tickets.priority.${p}`)}
                  </option>
                ))}
              </select>
            </div>

            {/* 到期日(隨「儲存」一併送出;清空即移除到期日) */}
            <div className="space-y-1.5">
              <Label htmlFor="tk-due">
                <CalendarClock className="mr-1 inline h-3.5 w-3.5" />
                {t("tickets.detail.dueAt", { defaultValue: "到期日" })}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="tk-due"
                  type="datetime-local"
                  value={dueLocal}
                  onChange={(e) => setDueLocal(e.target.value)}
                  className="flex-1"
                />
                {dueLocal && (
                  <Button variant="ghost" size="sm" onClick={() => setDueLocal("")}>
                    {t("tickets.detail.clearDue", { defaultValue: "清除到期日" })}
                  </Button>
                )}
              </div>
            </div>

            {/* 延後(snooze):即時套用,不隨儲存 */}
            <div className="space-y-1.5 rounded-md border border-border p-3">
              <Label>
                <AlarmClock className="mr-1 inline h-3.5 w-3.5" />
                {t("tickets.detail.snooze", { defaultValue: "延後" })}
              </Label>
              {ticket.snoozed_until && new Date(ticket.snoozed_until) > new Date() ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t("tickets.detail.snoozedUntil", {
                      defaultValue: "已延後至 {{time}}",
                      time: timeAgo(ticket.snoozed_until),
                    })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={snoozeMut.isPending}
                    onClick={() => snoozeMut.mutate(null)}
                  >
                    <BellOff className="h-3.5 w-3.5" />{" "}
                    {t("tickets.detail.cancelSnooze", { defaultValue: "取消延後" })}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Input
                    type="datetime-local"
                    value={snoozeLocal}
                    onChange={(e) => setSnoozeLocal(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!snoozeLocal || snoozeMut.isPending}
                    onClick={() => {
                      const iso = localInputToIso(snoozeLocal);
                      if (iso) snoozeMut.mutate(iso);
                    }}
                  >
                    {t("tickets.detail.snoozeApply", { defaultValue: "套用延後" })}
                  </Button>
                </div>
              )}
            </div>

            {/* 自訂欄位(依 FieldDefinition 動態渲染,值讀寫於 attributes) */}
            <CustomFieldInputs
              fields={fieldDefs}
              values={attrs}
              onChange={setAttrs}
              idPrefix="tk-cf"
            />

            {/* 必填自訂欄位未填時提示並禁止儲存 */}
            {missingRequired.length > 0 && (
              <p className="text-xs text-destructive">
                {t("fields.requiredMissing", { defaultValue: "請先填寫必填欄位" })}:
                {missingRequired.map((f) => f.label).join("、")}
              </p>
            )}

            {/* 關聯與標籤(唯讀) */}
            <div className="grid grid-cols-2 gap-3 rounded-md border border-border p-3 text-xs">
              <div>
                <p className="mb-1 font-semibold text-muted-foreground">{t("tickets.detail.relatedSession")}</p>
                <p className="font-mono">{ticket.session_id ? ticket.session_id.slice(0, 8) : "—"}</p>
              </div>
              <div>
                <p className="mb-1 font-semibold text-muted-foreground">{t("tickets.detail.relatedContact")}</p>
                <p className="font-mono">{ticket.contact_id ? ticket.contact_id.slice(0, 8) : "—"}</p>
              </div>
              <div>
                <p className="mb-1 font-semibold text-muted-foreground">{t("tickets.detail.createdAt")}</p>
                <p>{ticket.created_at ? timeAgo(ticket.created_at) : "—"}</p>
              </div>
              <div>
                <p className="mb-1 font-semibold text-muted-foreground">{t("tickets.detail.updatedAt")}</p>
                <p>{ticket.updated_at ? timeAgo(ticket.updated_at) : "—"}</p>
              </div>
            </div>

            {ticket.tags.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("tickets.detail.tags")}</p>
                <div className="flex flex-wrap gap-1">
                  {ticket.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* 內部備註串(團隊可見,訪客不可見) */}
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center gap-1.5">
                <StickyNote className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">
                  {t("tickets.detail.notes", { defaultValue: "內部備註" })}
                </span>
                <span className="text-xs text-muted-foreground">
                  · {t("tickets.detail.notesHint", { defaultValue: "僅團隊可見,訪客看不到" })}
                </span>
              </div>
              {notesQuery.isLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : notesQuery.isError ? (
                <p className="text-xs text-muted-foreground">
                  {t("tickets.detail.notesError", { defaultValue: "備註載入失敗" })}
                </p>
              ) : (notesQuery.data?.items.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("tickets.detail.notesEmpty", { defaultValue: "尚無內部備註" })}
                </p>
              ) : (
                <ul className="space-y-2">
                  {notesQuery.data?.items.map((n) => (
                    <li key={n.id} className="rounded-md bg-muted/50 px-2.5 py-2 text-xs">
                      <div className="mb-0.5 flex items-center justify-between gap-2 text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {n.staff_id ? staffMap.get(n.staff_id) ?? n.staff_id.slice(0, 8) : "—"}
                        </span>
                        <span>{n.created_at ? timeAgo(n.created_at) : ""}</span>
                      </div>
                      <p className="whitespace-pre-wrap break-words">{n.body}</p>
                    </li>
                  ))}
                </ul>
              )}
              <div className="space-y-1.5">
                <Textarea
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  placeholder={t("tickets.detail.addNotePlaceholder", { defaultValue: "寫下內部備註…" })}
                  rows={2}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!noteBody.trim() || addNoteMut.isPending}
                    onClick={() => addNoteMut.mutate(noteBody.trim())}
                  >
                    {addNoteMut.isPending
                      ? t("tickets.detail.addingNote", { defaultValue: "送出中…" })
                      : t("tickets.detail.addNote", { defaultValue: "新增備註" })}
                  </Button>
                </div>
              </div>
            </div>

            {/* 合併工單:把此工單併入目標工單 */}
            <div className="space-y-1.5 rounded-md border border-border p-3">
              <Label htmlFor="tk-merge">
                <GitMerge className="mr-1 inline h-3.5 w-3.5" />
                {t("tickets.detail.merge", { defaultValue: "合併工單" })}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="tk-merge"
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                  placeholder={t("tickets.detail.mergePlaceholder", {
                    defaultValue: "貼上要併入的目標工單 ID",
                  })}
                  className="flex-1 font-mono"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!mergeTargetId.trim() || mergeMut.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        t("tickets.detail.mergeConfirm", {
                          defaultValue:
                            "確定把此工單併入目標工單?來源工單將被關閉,備註與關聯會轉移到目標。",
                        }),
                      )
                    )
                      mergeMut.mutate(mergeTargetId.trim());
                  }}
                >
                  {mergeMut.isPending
                    ? t("tickets.detail.merging", { defaultValue: "合併中…" })
                    : t("tickets.detail.mergeSubmit", { defaultValue: "合併" })}
                </Button>
              </div>
              {mergeError && <p className="text-xs text-destructive">{mergeError}</p>}
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap justify-between gap-2">
          <Button
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={!ticket || deleteMut.isPending}
            onClick={() => {
              if (ticket && window.confirm(t("tickets.detail.deleteConfirm"))) deleteMut.mutate();
            }}
          >
            <Trash2 className="h-4 w-4" /> {t("tickets.detail.delete")}
          </Button>
          <Button
            disabled={!ticket || updateMut.isPending || !title.trim() || missingRequired.length > 0}
            onClick={() =>
              updateMut.mutate({
                title: title.trim(),
                description: description || null,
                priority,
                attributes: attrs,
                due_at: localInputToIso(dueLocal),
              })
            }
          >
            {updateMut.isPending ? t("tickets.detail.saving") : t("tickets.detail.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================== 新建對話框 ============================== */
function CreateTicketDialog({
  open,
  staff,
  onClose,
}: {
  open: boolean;
  staff: StaffLite[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal");
  const [assignee, setAssignee] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [contactId, setContactId] = useState("");
  const [attrs, setAttrs] = useState<Record<string, unknown>>({});
  const fieldDefs = useFieldDefs("ticket").data ?? [];
  const missingRequired = missingRequiredFields(fieldDefs, attrs);

  function reset() {
    setTitle("");
    setDescription("");
    setPriority("normal");
    setAssignee("");
    setSessionId("");
    setContactId("");
    setAttrs({});
  }

  const createMut = useMutation({
    mutationFn: () =>
      ticketApi.create({
        title: title.trim(),
        description: description || undefined,
        priority,
        assignee_staff_id: assignee || undefined,
        session_id: sessionId.trim() || undefined,
        contact_id: contactId.trim() || undefined,
        attributes: Object.keys(attrs).length ? attrs : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tickets"] });
      reset();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("tickets.create.title")}</DialogTitle>
          <DialogDescription>{t("tickets.create.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="ct-title">{t("tickets.form.title")}</Label>
            <Input
              id="ct-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("tickets.form.titlePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ct-desc">{t("tickets.form.description")}</Label>
            <Textarea
              id="ct-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("tickets.form.descriptionPlaceholder")}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor="ct-prio">{t("tickets.form.priority")}</Label>
              <select
                id="ct-prio"
                className={SELECT_CLS}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`tickets.priority.${p}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-assignee">{t("tickets.form.assignee")}</Label>
              <select
                id="ct-assignee"
                className={SELECT_CLS}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">{t("tickets.unassigned")}</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor="ct-session">{t("tickets.form.sessionId")}</Label>
              <Input
                id="ct-session"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder={t("tickets.form.optional")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-contact">{t("tickets.form.contactId")}</Label>
              <Input
                id="ct-contact"
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                placeholder={t("tickets.form.optional")}
              />
            </div>
          </div>

          {/* 自訂欄位(依 FieldDefinition 動態渲染,值存入 attributes) */}
          <CustomFieldInputs
            fields={fieldDefs}
            values={attrs}
            onChange={setAttrs}
            idPrefix="ct-cf"
          />

          {/* 必填自訂欄位未填時提示並禁止送出 */}
          {missingRequired.length > 0 && (
            <p className="text-xs text-destructive">
              {t("fields.requiredMissing", { defaultValue: "請先填寫必填欄位" })}:
              {missingRequired.map((f) => f.label).join("、")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            {t("tickets.form.cancel")}
          </Button>
          <Button
            disabled={!title.trim() || missingRequired.length > 0 || createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending ? t("tickets.form.submitting") : t("tickets.form.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
